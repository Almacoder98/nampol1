"""Server-owned persistence and document orchestration."""

import hashlib
import re
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import HTTPException
from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from backend.validation import DOCUMENT_TYPES, validate_document


def now():
    return datetime.now(timezone.utc)


def set_identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value):
        raise HTTPException(404, "Resource not found.")
    return value


def safe_manifest(record):
    return {key: record[key] for key in ("setId", "schemaVersion", "state", "createdAt")} | {
        "documents": {kind: {key: item[key] for key in ("fileName", "fileSize", "mimeType", "scanStatus")}
                      for kind, item in record.get("documents", {}).items()}}


class DocumentRepository:
    SETS = "serverDocumentSets"
    BINDINGS = "serverApplicationDocumentBindings"

    def __init__(self, client):
        self.client = client

    def event(self, actor, action, region, **details):
        return {"actorUid": actor.uid, "action": action, "region": region,
                "timestamp": now(), **details}

    def audit(self, event):
        self.client.collection("auditLogs").document().create(event)

    def create(self, owner, documents, region):
        set_id = uuid4().hex
        owner_path = hashlib.sha256(owner.encode()).hexdigest()
        documents = {kind: {**item, "objectPath": f"{owner_path}/{set_id}/{kind}/{uuid4().hex}"}
                     for kind, item in documents.items()}
        record = {"ownerUid": owner, "setId": set_id, "schemaVersion": 1,
                  "state": "pending", "createdAt": now(), "documents": documents,
                  "region": region, "cleanupRequired": False}
        self.client.collection(self.SETS).document(set_id).create(record)
        return record

    def owned(self, owner, set_id):
        snapshot = self.client.collection(self.SETS).document(set_identifier(set_id)).get()
        if not snapshot.exists:
            raise HTTPException(404, "Resource not found.")
        record = snapshot.to_dict()
        if record.get("ownerUid") != owner:
            raise HTTPException(403, "Access denied.")
        return record

    def list_owned(self, owner):
        query = self.client.collection(self.SETS).where(filter=FieldFilter("ownerUid", "==", owner)).limit(50)
        return [item.to_dict() for item in query.stream()]

    def publish(self, record, event):
        reference = self.client.collection(self.SETS).document(record["setId"])
        applicant_ref = self.client.collection("applicantDocuments").document(record["ownerUid"])
        profile_ref = self.client.collection("users").document(record["ownerUid"])
        audit_ref = self.client.collection("auditLogs").document()
        @firestore.transactional
        def commit(transaction):
            current = reference.get(transaction=transaction).to_dict()
            applicant_snapshot = applicant_ref.get(transaction=transaction)
            profile = profile_ref.get(transaction=transaction).to_dict()
            if not current or current["state"] != "pending" or current["ownerUid"] != record["ownerUid"]:
                raise HTTPException(409, "Document set cannot be published.")
            if set(current["documents"]) != set(DOCUMENT_TYPES) or any(
                    item.get("scanStatus") != "clean" for item in current["documents"].values()):
                raise HTTPException(409, "Document validation incomplete.")
            if (not profile or profile.get("role") != "applicant"
                    or profile.get("accountStatus") != "active" or profile.get("profileCompleted") is not True):
                raise HTTPException(403, "Access denied.")
            # Compatibility record for existing profile/application/admin screens.
            # Only safe metadata is copied; storage paths remain server-only.
            timestamp = now()
            applicant_record = {
                "applicantId": record["ownerUid"], "setId": record["setId"],
                "documentsValidated": True, "prototypeMode": False,
                "storageMode": "server-private", "updatedAt": timestamp,
                **{kind: {**{key: item[key] for key in ("fileName", "fileSize", "mimeType", "scanStatus")},
                          "setId": record["setId"], "documentType": kind,
                          "uploaded": True, "storageMode": "server-private"}
                   for kind, item in current["documents"].items()},
            }
            if applicant_snapshot.exists:
                transaction.update(applicant_ref, applicant_record)
            else:
                transaction.create(applicant_ref, applicant_record)
            transaction.update(profile_ref, {
                "documentsUploaded": True, "documentStorageMode": "server-private",
                "documentsUpdatedAt": timestamp, "updatedAt": timestamp,
            })
            transaction.update(reference, {"state": "ready", "readyAt": now()})
            transaction.create(audit_ref, event)
        commit(self.client.transaction())
        return {**record, "state": "ready"}

    def abort(self, record):
        """Guard ambiguous publish failures: never delete a committed ready set."""
        reference = self.client.collection(self.SETS).document(record["setId"])
        @firestore.transactional
        def commit(transaction):
            snapshot = reference.get(transaction=transaction)
            if not snapshot.exists or snapshot.to_dict()["state"] == "ready":
                return False
            transaction.update(reference, {"state": "failed", "cleanupRequired": True})
            return True
        return commit(self.client.transaction())

    def cleanup_completed(self, record):
        self.client.collection(self.SETS).document(record["setId"]).update({"cleanupRequired": False})

    def bind(self, actor, application_id, set_id):
        application_ref = self.client.collection("applications").document(application_id)
        set_ref = self.client.collection(self.SETS).document(set_identifier(set_id))
        binding_ref = self.client.collection(self.BINDINGS).document(application_id)
        audit_ref = self.client.collection("auditLogs").document()
        @firestore.transactional
        def commit(transaction):
            application_snapshot = application_ref.get(transaction=transaction)
            manifest_snapshot = set_ref.get(transaction=transaction)
            binding_snapshot = binding_ref.get(transaction=transaction)
            profile_snapshot = self.client.collection("users").document(actor.uid).get(transaction=transaction)
            application = application_snapshot.to_dict() if application_snapshot.exists else None
            manifest = manifest_snapshot.to_dict() if manifest_snapshot.exists else None
            profile = profile_snapshot.to_dict() if profile_snapshot.exists else None
            if (not application or application.get("applicantId") != actor.uid
                    or not profile or profile.get("role") != "applicant"
                    or profile.get("accountStatus") != "active" or profile.get("profileCompleted") is not True):
                raise HTTPException(403, "Access denied.")
            if not manifest or manifest.get("ownerUid") != actor.uid or manifest.get("state") != "ready":
                raise HTTPException(409, "A ready, owned document set is required.")
            if application.get("documentSetId") != set_id:
                raise HTTPException(409, "Only the document set recorded at submission can be bound.")
            if binding_snapshot.exists:
                binding = binding_snapshot.to_dict()
                if binding.get("setId") != set_id or binding.get("ownerUid") != actor.uid:
                    raise HTTPException(409, "Application document binding is immutable.")
                return binding
            # Historical or reviewed applications are not retroactively rebound.
            if application.get("status") != "Submitted":
                raise HTTPException(409, "Only submitted, unbound applications can be bound.")
            binding = {"applicationId": application_id, "setId": set_id,
                       "ownerUid": actor.uid, "boundAt": now()}
            transaction.create(binding_ref, binding)
            transaction.create(audit_ref, self.event(actor, "DOCUMENT_SET_BOUND", application.get("region", ""),
                               applicationId=application_id, setId=set_id, outcome="success"))
            return binding
        return commit(self.client.transaction())

    def bound(self, application_id, owner):
        snapshot = self.client.collection(self.BINDINGS).document(application_id).get()
        if not snapshot.exists:
            raise HTTPException(404, "Application has no stored document binding.")
        binding = snapshot.to_dict()
        if binding.get("ownerUid") != owner:
            raise HTTPException(403, "Access denied.")
        return self.owned(owner, binding["setId"])

    def ensure_binding(self, actor, application_id):
        """Repair only a recorded immutable source; never choose the latest upload."""
        @firestore.transactional
        def commit(transaction):
            app = self.client.collection('applications').document(application_id).get(transaction=transaction).to_dict()
            if not app:
                raise HTTPException(404, 'Resource not found.')
            class Records:
                def read(inner, collection, uid):
                    return self.client.collection(collection).document(uid).get(transaction=transaction).to_dict()
            from backend.admin_security import active_admin
            if actor.uid == app.get('applicantId'):
                profile = Records().read('users', actor.uid)
                if not profile or profile.get('role') != 'applicant' or profile.get('accountStatus') != 'active' or profile.get('profileCompleted') is not True:
                    raise HTTPException(403, 'Access denied.')
                role = 'applicant'
            else:
                admin = active_admin(Records(), actor.uid)
                if admin['role'] != 'super_admin' and admin.get('region') != app.get('region'):
                    raise HTTPException(403, 'Access denied.')
                role = admin['role']
            set_id = set_identifier(app.get('documentSetId'))
            manifest = self.client.collection(self.SETS).document(set_id).get(transaction=transaction).to_dict()
            if (not manifest or manifest.get('ownerUid') != app['applicantId'] or manifest.get('state') != 'ready'
                    or any(manifest.get('documents', {}).get(kind, {}).get('scanStatus') != 'clean'
                        or manifest.get('documents', {}).get(kind, {}).get('mimeType') != 'application/pdf' for kind in DOCUMENT_TYPES)):
                raise HTTPException(409, 'The submitted ready PDF set is unavailable. Contact support; it cannot be replaced.')
            reference = self.client.collection(self.BINDINGS).document(application_id)
            binding = reference.get(transaction=transaction).to_dict()
            if binding:
                if binding.get('setId') != set_id or binding.get('ownerUid') != app['applicantId'] or binding.get('applicationId') != application_id:
                    raise HTTPException(409, 'Application document binding mismatch.')
                return manifest
            transaction.create(reference, {'applicationId': application_id, 'ownerUid': app['applicantId'], 'setId': set_id, 'boundAt': now()})
            transaction.create(self.client.collection('auditLogs').document(uuid4().hex),
                self.event(actor, 'DOCUMENT_BINDING_REPAIRED', app.get('region', ''),
                           actorRole=role, applicationId=application_id, setId=set_id, outcome='success'))
            return manifest
        return commit(self.client.transaction())


class DocumentService:
    def __init__(self, authorization, repository, storage, scanner):
        self.authorization, self.repository = authorization, repository
        self.storage, self.scanner = storage, scanner

    def upload(self, actor, files):
        profile = self.authorization.applicant(actor, actor.uid)
        if set(files) != set(DOCUMENT_TYPES):
            raise HTTPException(422, "Exactly three required documents must be supplied.")
        region = profile.get("region", "")
        self.repository.audit(self.repository.event(actor, "DOCUMENT_UPLOAD_STARTED", region, outcome="started", actorRole="applicant"))
        record = None
        try:
            metadata = {kind: validate_document(kind, content, mime, self.scanner)
                        for kind, (content, mime) in files.items()}
            record = self.repository.create(actor.uid, metadata, region)
            for kind, item in record["documents"].items():
                self.storage.upload(item["objectPath"], files[kind][0], item["mimeType"])
            # Eligibility may have changed while scanning/uploading.
            self.authorization.applicant(actor, actor.uid)
            event = self.repository.event(actor, "DOCUMENT_UPLOAD_READY", region,
                                          setId=record["setId"], outcome="success", actorRole="applicant")
            return safe_manifest(self.repository.publish(record, event))
        except Exception:
            if record:
                try:
                    if self.repository.abort(record):
                        for item in record["documents"].values():
                            self.storage.delete(item["objectPath"])
                        self.repository.cleanup_completed(record)
                except Exception:
                    # Pending/failed manifests retain object paths for reconciliation.
                    pass
            try:
                self.repository.audit(self.repository.event(actor, "DOCUMENT_UPLOAD_FAILED", region,
                                                           outcome="failed", actorRole="applicant", setId=record["setId"] if record else ""))
            except Exception:
                pass
            raise

    def download(self, actor, record, kind, region, application_id=""):
        if application_id:
            application = self.authorization.application_documents(actor, application_id)
            if application["applicantId"] != record["ownerUid"]:
                raise HTTPException(403, "Access denied.")
            if application.get('documentSetId') != record.get('setId'):
                raise HTTPException(409, 'Document set does not match the submitted application.')
            region = application.get("region", "")
            role = "applicant" if actor.uid == record["ownerUid"] else self.authorization.administrator(actor, region)["role"]
        else:
            self.authorization.applicant(actor, record["ownerUid"])
            role = "applicant"
        if kind not in DOCUMENT_TYPES or record.get("state") != "ready":
            raise HTTPException(404, "Ready document not found.")
        item = record.get("documents", {}).get(kind)
        if not item or item.get("scanStatus") != "clean":
            raise HTTPException(409, "Document validation incomplete.")
        event = self.repository.event(actor, "DOCUMENT_DOWNLOAD_AUTHORIZED", region,
                                      setId=record["setId"], documentType=kind,
                                      applicationId=application_id, outcome="authorized", actorRole=role)
        self.repository.audit(event)
        try:
            content = self.storage.download(item["objectPath"])
            if len(content) != item["fileSize"] or hashlib.sha256(content).hexdigest() != item["sha256"]:
                raise HTTPException(503, "Stored document integrity check failed.")
        except Exception:
            self.repository.audit({**event, "action": "DOCUMENT_DOWNLOAD_FAILED", "outcome": "failed"})
            raise
        self.repository.audit({**event, "action": "DOCUMENT_DOWNLOAD_PREPARED", "outcome": "prepared"})
        return content, item
