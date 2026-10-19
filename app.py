"""Phase 2A server-only document API."""

import asyncio
import json
import os
import threading
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Annotated, Protocol
from urllib.parse import urlparse
from uuid import uuid4

import firebase_admin
from firebase_admin import auth, credentials, firestore
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from fastapi.exception_handlers import http_exception_handler
from starlette.requests import Request as BodyRequest
from starlette.datastructures import UploadFile
from starlette.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from backend.documents import DocumentRepository, DocumentService, safe_manifest
from backend.storage import SupabaseStorage
from backend.validation import (ClamAVScanner, DOCUMENT_TYPES, MAX_FILE_SIZE,
                                MAX_REQUEST_SIZE, bounded_body)

FIREBASE_PROJECT = "nampol-recruitment"
ADMIN_ROLES = frozenset({"admin", "recruiter", "super_admin"})
LOCAL_ORIGINS = ("http://localhost:8000", "http://127.0.0.1:8000")


@dataclass(frozen=True)
class Settings:
    supabase_url: str
    supabase_secret_key: str = field(repr=False)
    bucket: str = "applicant-documents"
    firebase_project: str = FIREBASE_PROJECT

    def __post_init__(self):
        parsed = urlparse(self.supabase_url)
        if (parsed.scheme != "https" or not parsed.hostname
                or parsed.username or parsed.password or parsed.query
                or parsed.fragment or parsed.path not in ("", "/")):
            raise ValueError("SUPABASE_URL must be an HTTPS project origin.")
        if not self.supabase_secret_key.startswith("sb_secret_"):
            raise ValueError("SUPABASE_SECRET_KEY must be a server secret key.")
        if self.bucket != "applicant-documents" or self.firebase_project != FIREBASE_PROJECT:
            raise ValueError("Unexpected storage bucket or Firebase project.")

    @classmethod
    def from_environment(cls):
        return cls(
            supabase_url=os.environ.get("SUPABASE_URL", ""),
            supabase_secret_key=os.environ.get("SUPABASE_SECRET_KEY", ""),
            bucket=os.environ.get("SUPABASE_BUCKET", "applicant-documents"),
            firebase_project=os.environ.get("FIREBASE_PROJECT_ID", FIREBASE_PROJECT),
        )


@dataclass(frozen=True)
class Principal:
    uid: str


class RecordReader(Protocol):
    def read(self, collection: str, identifier: str) -> dict | None: ...


def valid_identifier(value):
    if not isinstance(value, str) or not value or "/" in value or value in (".", ".."):
        raise HTTPException(403, "Access denied.")
    return value


class FirestoreRecords:
    def __init__(self, client):
        self.client = client

    def read(self, collection, identifier):
        snapshot = self.client.collection(collection).document(valid_identifier(identifier)).get()
        return snapshot.to_dict() if snapshot.exists else None


class Authorization:
    def __init__(self, records: RecordReader):
        self.records = records

    def applicant(self, principal: Principal, owner_uid: str):
        if principal.uid != valid_identifier(owner_uid):
            raise HTTPException(403, "Access denied.")
        record = self.records.read("users", principal.uid)
        if (not record or record.get("role") != "applicant"
                or record.get("accountStatus") != "active"
                or record.get("profileCompleted") is not True):
            raise HTTPException(403, "Access denied.")
        return record

    def administrator(self, principal: Principal, region: str):
        record = self.records.read("admins", principal.uid)
        if (not record or record.get("active") is not True
                or record.get("role") not in ADMIN_ROLES):
            raise HTTPException(403, "Access denied.")
        if record["role"] != "super_admin" and (
                not isinstance(region, str) or not region.strip()
                or record.get("region") != region):
            raise HTTPException(403, "Access denied.")
        return record

    def application_documents(self, principal: Principal, application_id: str):
        application = self.records.read("applications", valid_identifier(application_id))
        if not application:
            raise HTTPException(404, "Resource not found.")
        owner = valid_identifier(application.get("applicantId"))
        if owner == principal.uid:
            self.applicant(principal, owner)
        else:
            self.administrator(principal, application.get("region"))
        return application


class ManifestRepository(Protocol):
    def create_pending(self, owner_uid: str) -> dict: ...
    def get_owned(self, owner_uid: str, set_id: str) -> dict | None: ...


class FirestoreManifestRepository:
    """Trusted persistence only; callers must authorize before invoking it.

    Each set has a new immutable identifier. No prototype metadata is imported.
    Publishing ready sets and binding applications belong to the upload phase.
    """

    COLLECTION = "serverDocumentSets"

    def __init__(self, client):
        self.client = client

    def create_pending(self, owner_uid):
        owner_uid = valid_identifier(owner_uid)
        set_id = uuid4().hex
        record = {
            "setId": set_id, "ownerUid": owner_uid, "schemaVersion": 1,
            "state": "pending", "documents": {},
            "createdAt": datetime.now(timezone.utc),
        }
        self.client.collection(self.COLLECTION).document(set_id).create(record)
        return record

    def get_owned(self, owner_uid, set_id):
        valid_identifier(owner_uid)
        snapshot = self.client.collection(self.COLLECTION).document(valid_identifier(set_id)).get()
        if not snapshot.exists:
            return None
        record = snapshot.to_dict()
        if record.get("ownerUid") != owner_uid:
            raise HTTPException(403, "Access denied.")
        return record


def verify_firebase_token(token, firebase_app):
    try:
        claims = auth.verify_id_token(token, app=firebase_app, check_revoked=True)
    except (auth.InvalidIdTokenError, auth.ExpiredIdTokenError,
            auth.RevokedIdTokenError, auth.UserDisabledError,
            auth.UserNotFoundError, ValueError):
        raise HTTPException(401, "Invalid or expired authentication.") from None
    except Exception:
        raise HTTPException(503, "Authentication service unavailable.") from None
    if (claims.get("aud") != FIREBASE_PROJECT
            or claims.get("iss") != f"https://securetoken.google.com/{FIREBASE_PROJECT}"):
        raise HTTPException(401, "Invalid or expired authentication.")
    uid = claims.get("uid")
    if not isinstance(uid, str) or not uid or "/" in uid:
        raise HTTPException(401, "Invalid or expired authentication.")
    if claims.get("email_verified") is not True:
        raise HTTPException(403, "Verified email required.")
    return Principal(uid)


bearer = HTTPBearer(auto_error=False)


def current_principal(
    request: Request,
    credential: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
):
    if credential is None or credential.scheme.lower() != "bearer":
        raise HTTPException(401, "Authentication required.")
    principal = verify_firebase_token(credential.credentials, request.app.state.firebase_app)
    request.state.principal = principal
    return principal


def create_app(initialize_services=True):
    @asynccontextmanager
    async def lifespan(application):
        firebase_app = None
        storage = None
        if initialize_services:
            try:
                settings = Settings.from_environment()
                # ADC may use an external GOOGLE_APPLICATION_CREDENTIALS file.
                # Never load credentials from the repository or browser inputs.
                if os.environ.get("FIREBASE_AUTH_EMULATOR_HOST") or os.environ.get("FIRESTORE_EMULATOR_HOST"):
                    raise ValueError("Emulator configuration is not allowed in this backend.")
                firebase_app = firebase_admin.initialize_app(
                    credentials.ApplicationDefault(),
                    {"projectId": settings.firebase_project}, name="nampol-document-api",
                )
                client = firestore.client(app=firebase_app)
                application.state.settings = settings
                application.state.firebase_app = firebase_app
                application.state.authorization = Authorization(FirestoreRecords(client))
                application.state.manifests = FirestoreManifestRepository(client)
                storage = SupabaseStorage(settings)
                application.state.documents = DocumentService(
                    application.state.authorization, DocumentRepository(client),
                    storage, ClamAVScanner(),
                )
            except Exception:
                if firebase_app is not None:
                    firebase_admin.delete_app(firebase_app)
                raise RuntimeError("Backend configuration or credentials are unavailable. See BACKEND.md.") from None
        try:
            yield
        finally:
            if storage is not None:
                storage.close()
            if firebase_app is not None:
                firebase_admin.delete_app(firebase_app)

    application = FastAPI(title="NamPol Document API", lifespan=lifespan,
                          docs_url=None, redoc_url=None, openapi_url=None)
    application.add_middleware(
        CORSMiddleware, allow_origins=list(LOCAL_ORIGINS),
        allow_credentials=False, allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )
    application.state.upload_slots = threading.BoundedSemaphore(2)

    @application.exception_handler(Exception)
    async def service_failure(request, exception):
        return JSONResponse(status_code=503, content={"detail": "Document service unavailable."})

    @application.exception_handler(HTTPException)
    async def rejected_request(request, exception):
        actor = getattr(request.state, "principal", None)
        service = getattr(request.app.state, "documents", None)
        if actor and service and exception.status_code in (403, 413, 422):
            try:
                await run_in_threadpool(service.repository.audit, {
                    "actorUid": actor.uid, "action": "DOCUMENT_REQUEST_REJECTED",
                    "region": "", "timestamp": datetime.now(timezone.utc),
                    "outcome": "denied", "statusCode": exception.status_code,
                })
            except Exception:
                pass
        return await http_exception_handler(request, exception)

    def documents(request: Request):
        service = getattr(request.app.state, "documents", None)
        if service is None:
            raise HTTPException(503, "Document service unavailable.")
        return service

    actor_dependency = Annotated[Principal, Depends(current_principal)]
    service_dependency = Annotated[DocumentService, Depends(documents)]

    @application.post("/api/me/document-sets", status_code=201)
    async def upload_documents(request: Request, actor: actor_dependency, service: service_dependency):
        await run_in_threadpool(service.authorization.applicant, actor, actor.uid)
        if not request.app.state.upload_slots.acquire(blocking=False):
            raise HTTPException(429, "Upload capacity reached. Please retry later.")
        try:
            try:
                async with asyncio.timeout(30):
                    body = await bounded_body(request, MAX_REQUEST_SIZE)
                async def receive():
                    return {"type": "http.request", "body": body, "more_body": False}
                parsed_request = BodyRequest(request.scope, receive=receive)
                async with parsed_request.form(max_files=3, max_fields=0, max_part_size=MAX_FILE_SIZE) as form:
                    entries = list(form.multi_items())
                    if len(entries) != 3 or {name for name, _ in entries} != set(DOCUMENT_TYPES):
                        raise HTTPException(422, "Exactly three required file fields must be supplied.")
                    files = {}
                    for kind, value in entries:
                        if not isinstance(value, UploadFile):
                            raise HTTPException(422, "Invalid file field.")
                        content = await value.read(MAX_FILE_SIZE + 1)
                        if len(content) > MAX_FILE_SIZE:
                            raise HTTPException(413, "Each document must be 5 MiB or smaller.")
                        files[kind] = (content, value.content_type)
            except HTTPException:
                raise
            except TimeoutError:
                raise HTTPException(408, "Upload request timed out.") from None
            except Exception:
                raise HTTPException(422, "Invalid multipart upload.") from None
            return await run_in_threadpool(service.upload, actor, files)
        finally:
            request.app.state.upload_slots.release()

    @application.get("/api/me/document-sets")
    def list_documents(actor: actor_dependency, service: service_dependency):
        service.authorization.applicant(actor, actor.uid)
        return {"sets": [safe_manifest(record) for record in service.repository.list_owned(actor.uid)]}

    @application.get("/api/me/document-sets/{set_id}")
    def own_manifest(set_id: str, actor: actor_dependency, service: service_dependency):
        service.authorization.applicant(actor, actor.uid)
        return safe_manifest(service.repository.owned(actor.uid, set_id))

    def attachment(service, actor, record, kind, region, application_id=""):
        content, item = service.download(actor, record, kind, region, application_id)
        # Generated filenames only, never the submitted filename or a storage path.
        extension = {"application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png"}[item["mimeType"]]
        return Response(content, media_type=item["mimeType"], headers={
            "Content-Disposition": f'attachment; filename="{kind}.{extension}"',
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        })

    @application.get("/api/me/document-sets/{set_id}/{kind}/download")
    def own_download(set_id: str, kind: str, actor: actor_dependency, service: service_dependency):
        profile = service.authorization.applicant(actor, actor.uid)
        record = service.repository.owned(actor.uid, set_id)
        return attachment(service, actor, record, kind, profile.get("region", ""))

    @application.post("/api/applications/{application_id}/document-binding")
    async def bind_documents(application_id: str, request: Request, actor: actor_dependency, service: service_dependency):
        await run_in_threadpool(service.authorization.applicant, actor, actor.uid)
        valid_identifier(application_id)
        try:
            async with asyncio.timeout(10):
                body = json.loads(await bounded_body(request, 2048))
            if not isinstance(body, dict) or set(body) != {"setId"}:
                raise ValueError()
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(422, "Supply only setId in the binding request.") from None
        return await run_in_threadpool(service.repository.bind, actor, application_id, body["setId"])

    @application.get("/api/applications/{application_id}/documents")
    def application_manifest(application_id: str, actor: actor_dependency, service: service_dependency):
        record = service.authorization.application_documents(actor, application_id)
        return safe_manifest(service.repository.bound(application_id, record["applicantId"]))

    @application.get("/api/applications/{application_id}/documents/{kind}/download")
    def application_download(application_id: str, kind: str, actor: actor_dependency, service: service_dependency):
        record = service.authorization.application_documents(actor, application_id)
        manifest = service.repository.bound(application_id, record["applicantId"])
        return attachment(service, actor, manifest, kind, record.get("region", ""), application_id)

    @application.get("/health")
    def health():
        return {"status": "ok", "phase": "2A"}

    return application


app = create_app()
