import copy
import hashlib
import io
import json
import threading
import unittest
from unittest.mock import Mock, patch

import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfWriter

from app import Authorization, Principal, Settings, create_app, current_principal
from backend.documents import DocumentRepository, DocumentService
from backend.storage import MAX_FILE_SIZE, SupabaseStorage
from backend.validation import ClamAVScanner, MAX_REQUEST_SIZE, bounded_body, validate_document


def pdf():
    stream = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.write(stream)
    return stream.getvalue()


class Snapshot:
    def __init__(self, value):
        self.exists = value is not None
        self.value = copy.deepcopy(value)

    def to_dict(self):
        return copy.deepcopy(self.value)


class Reference:
    def __init__(self, db, collection, identifier):
        self.db, self.key = db, (collection, identifier)

    def get(self, transaction=None):
        return Snapshot(self.db.data.get(self.key))

    def create(self, value):
        if self.key in self.db.data:
            raise RuntimeError("already exists")
        self.db.data[self.key] = copy.deepcopy(value)

    def update(self, value):
        self.db.data[self.key].update(copy.deepcopy(value))


class Collection:
    def __init__(self, db, name):
        self.db, self.name = db, name
        self.owner = None
        self.maximum = 50

    def document(self, identifier=None):
        return Reference(self.db, self.name, identifier or str(len(self.db.data)) + "-event")

    def where(self, filter):
        self.owner = filter.value
        return self

    def limit(self, maximum):
        self.maximum = maximum
        return self

    def stream(self):
        return [Snapshot(value) for (collection, _), value in self.db.data.items()
                if collection == self.name and value.get("ownerUid") == self.owner][:self.maximum]


class Transaction:
    def __init__(self, db):
        self.db, self.operations = db, []

    def create(self, reference, value):
        self.operations.append((reference, "create", value))

    def update(self, reference, value):
        self.operations.append((reference, "update", value))


class Database:
    def __init__(self):
        self.data = {}
        self.lock = threading.Lock()

    def collection(self, name):
        return Collection(self, name)

    def transaction(self):
        return Transaction(self)

    def read(self, collection, uid):
        return copy.deepcopy(self.data.get((collection, uid)))


def transactional(function):
    def wrapped(transaction):
        with transaction.db.lock:
            result = function(transaction)
            before = copy.deepcopy(transaction.db.data)
            try:
                for reference, operation, value in transaction.operations:
                    getattr(reference, operation)(value)
            except Exception:
                transaction.db.data = before
                raise
            return result
    return wrapped


class DocumentTests(unittest.TestCase):
    def setUp(self):
        self.patch = patch("backend.documents.firestore.transactional", transactional)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.db = Database()
        self.db.data[("users", "alice")] = {"role": "applicant", "accountStatus": "active", "profileCompleted": True, "region": "Khomas"}
        self.db.data[("users", "bob")] = {**self.db.data[("users", "alice")]}
        self.db.data[("applications", "application")] = {"applicantId": "alice", "region": "Khomas", "status": "Submitted"}
        self.storage = Mock()
        self.scanner = Mock()
        self.repository = DocumentRepository(self.db)
        self.service = DocumentService(Authorization(self.db), self.repository, self.storage, self.scanner)
        self.actor = Principal("alice")
        self.content = pdf()
        self.files = {kind: (self.content, "application/pdf") for kind in ("cv", "identification", "certificate")}

    def upload(self):
        result = self.service.upload(self.actor, self.files)
        self.storage.download.return_value = self.content
        self.db.data[("applications", "application")].setdefault("documentSetId", result["setId"])
        return result

    def client(self, actor=None):
        application = create_app(False)
        application.state.documents = self.service
        application.dependency_overrides[current_principal] = lambda: actor or self.actor
        return TestClient(application, raise_server_exceptions=False)

    def test_upload_validates_scans_and_publishes_versioned_sets(self):
        first, second = self.upload(), self.upload()
        self.assertNotEqual(first["setId"], second["setId"])
        self.assertEqual(first["state"], "ready")
        self.assertEqual(self.scanner.scan.call_count, 6)
        self.assertEqual(self.storage.upload.call_count, 6)
        self.assertNotIn("objectPath", json.dumps(first, default=str))
        self.assertEqual(len(self.repository.list_owned("alice")), 2)
        self.assertEqual(self.repository.list_owned("bob"), [])

    def test_publish_updates_compatibility_records_with_same_set_atomically(self):
        for _ in range(2):
            result = self.upload()
            metadata = self.db.read("applicantDocuments", "alice")
            self.assertEqual(metadata["setId"], result["setId"])
            self.assertTrue(metadata["documentsValidated"])
            self.assertFalse(metadata["prototypeMode"])
            for kind in self.files:
                self.assertEqual(metadata[kind]["setId"], result["setId"])
                self.assertTrue(metadata[kind]["uploaded"])
                self.assertEqual(metadata[kind]["scanStatus"], "clean")
            self.assertNotIn("objectPath", json.dumps(metadata, default=str))
            profile = self.db.read("users", "alice")
            self.assertTrue(profile["documentsUploaded"])
            self.assertEqual(profile["documentStorageMode"], "server-private")

    def test_publish_transaction_failure_preserves_previous_applicant_record(self):
        previous = self.upload()
        original = Reference.update
        def fail_profile(reference, value):
            if reference.key == ("users", "alice"):
                raise RuntimeError("profile persistence failed")
            return original(reference, value)
        with patch.object(Reference, "update", fail_profile):
            with self.assertRaises(RuntimeError):
                self.upload()
        self.assertEqual(self.db.read("applicantDocuments", "alice")["setId"], previous["setId"])
        ready = [item for item in self.repository.list_owned("alice") if item["state"] == "ready"]
        self.assertEqual([item["setId"] for item in ready], [previous["setId"]])

    def test_scan_outage_never_stores_or_marks_ready(self):
        self.scanner.scan.side_effect = HTTPException(503, "Scanner unavailable")
        with self.assertRaises(HTTPException):
            self.upload()
        self.storage.upload.assert_not_called()
        self.assertFalse(any(key[0] == self.repository.SETS for key in self.db.data))
        self.assertIsNone(self.db.read("applicantDocuments", "alice"))
        self.assertNotIn("documentsUploaded", self.db.read("users", "alice"))

    def test_partial_storage_failure_cleans_all_generated_paths(self):
        self.storage.upload.side_effect = [None, HTTPException(503, "Storage unavailable")]
        with self.assertRaises(HTTPException):
            self.upload()
        record = self.repository.list_owned("alice")[0]
        self.assertEqual(record["state"], "failed")
        self.assertFalse(record["cleanupRequired"])
        self.assertEqual(self.storage.delete.call_count, 3)

    def test_failed_cleanup_retains_reconciliation_marker(self):
        self.storage.upload.side_effect = HTTPException(503, "Storage unavailable")
        self.storage.delete.side_effect = HTTPException(503, "Cleanup unavailable")
        with self.assertRaises(HTTPException):
            self.upload()
        self.assertTrue(self.repository.list_owned("alice")[0]["cleanupRequired"])

    def test_ambiguous_publish_does_not_delete_ready_files(self):
        original = self.repository.publish
        def commit_then_timeout(record, event):
            original(record, event)
            raise RuntimeError("network timeout")
        with patch.object(self.repository, "publish", commit_then_timeout):
            with self.assertRaises(RuntimeError):
                self.upload()
        self.assertEqual(self.repository.list_owned("alice")[0]["state"], "ready")
        self.storage.delete.assert_not_called()

    def test_manifest_and_binding_ownership_and_immutability(self):
        first, second = self.upload(), self.upload()
        binding = self.repository.bind(self.actor, "application", first["setId"])
        self.assertEqual(self.repository.bind(self.actor, "application", first["setId"]), binding)
        with self.assertRaises(HTTPException) as caught:
            self.repository.bind(self.actor, "application", second["setId"])
        self.assertEqual(caught.exception.status_code, 409)
        with self.assertRaises(HTTPException):
            self.repository.bind(Principal("bob"), "application", first["setId"])
        with self.assertRaises(HTTPException):
            self.repository.owned("bob", first["setId"])
        self.assertEqual(self.repository.bound("application", "alice")["setId"], first["setId"])

    def test_unready_and_reviewed_applications_cannot_bind(self):
        result = self.upload()
        self.db.data[(self.repository.SETS, result["setId"])]["state"] = "pending"
        with self.assertRaises(HTTPException):
            self.repository.bind(self.actor, "application", result["setId"])
        self.db.data[(self.repository.SETS, result["setId"])]["state"] = "ready"
        self.db.data[("applications", "application")]["status"] = "Under Review"
        with self.assertRaises(HTTPException):
            self.repository.bind(self.actor, "application", result["setId"])

    def test_ready_manifest_cannot_be_republished_or_aborted(self):
        result = self.upload()
        record = self.repository.owned("alice", result["setId"])
        with self.assertRaises(HTTPException):
            self.repository.publish(record, {})
        self.assertFalse(self.repository.abort(record))
        self.assertEqual(self.repository.owned("alice", result["setId"])["state"], "ready")

    def test_deactivated_owner_is_denied_after_upload(self):
        result = self.upload()
        self.db.data[("users", "alice")]["accountStatus"] = "disabled"
        with self.client() as client:
            self.assertEqual(client.get(f'/api/me/document-sets/{result["setId"]}/cv/download').status_code, 403)
        self.storage.download.assert_not_called()

    def test_upload_concurrency_limit(self):
        application = create_app(False)
        application.state.documents = self.service
        application.dependency_overrides[current_principal] = lambda: self.actor
        application.state.upload_slots.acquire()
        application.state.upload_slots.acquire()
        with TestClient(application) as client:
            self.assertEqual(client.post("/api/me/document-sets", content=b"ignored").status_code, 429)

    def test_audit_outage_blocks_upload_and_download(self):
        with patch.object(self.repository, "audit", side_effect=RuntimeError("offline")):
            with self.assertRaises(RuntimeError):
                self.upload()
        self.storage.upload.assert_not_called()
        result = self.upload()
        with patch.object(self.repository, "audit", side_effect=RuntimeError("offline")):
            with self.assertRaises(RuntimeError):
                self.service.download(self.actor, self.repository.owned("alice", result["setId"]), "cv", "Khomas")
        self.storage.download.assert_not_called()

    def test_download_integrity_failure(self):
        result = self.upload()
        self.storage.download.return_value = b"tampered"
        with self.assertRaises(HTTPException):
            self.service.download(self.actor, self.repository.owned("alice", result["setId"]), "cv", "Khomas")

    def test_owner_endpoints_and_attachment_headers(self):
        result = self.upload()
        with self.client() as client:
            self.assertEqual(client.get("/api/me/document-sets").status_code, 200)
            response = client.get(f'/api/me/document-sets/{result["setId"]}/cv/download')
            self.assertEqual(response.content, self.content)
            self.assertEqual(response.headers["cache-control"], "no-store")
            self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        with self.client(Principal("bob")) as client:
            self.assertEqual(client.get(f'/api/me/document-sets/{result["setId"]}/cv/download').status_code, 403)

    def test_binding_and_regional_admin_endpoints(self):
        result = self.upload()
        with self.client() as client:
            response = client.post("/api/applications/application/document-binding", json={"setId": result["setId"]})
            self.assertEqual(response.status_code, 200)
        for role, region, active, expected in (("admin", "Khomas", True, 200), ("recruiter", "Erongo", True, 403),
                                              ("super_admin", "Erongo", True, 200), ("admin", "Khomas", False, 403)):
            index_id = hashlib.sha256(b'NAMPOL-001').hexdigest()
            self.db.data[("admins", "staff")] = {"role": role, "region": region, "active": active,
                "provisioningVersion": 1, "staffNumber": "NAMPOL-001", "staffCodeId": index_id}
            self.db.data[("adminStaffCodes", index_id)] = {'uid': 'staff', 'staffNumber': 'NAMPOL-001', 'state': 'active'}
            with self.client(Principal("staff")) as client:
                response = client.get("/api/applications/application/documents/cv/download")
                self.assertEqual(response.status_code, expected)

    def test_multipart_upload_duplicates_and_size_limits(self):
        with self.client() as client:
            files = [(kind, ("private-name.pdf", self.content, "application/pdf")) for kind in self.files]
            response = client.post("/api/me/document-sets", files=files)
            self.assertEqual(response.status_code, 201, response.text)
            self.assertNotIn("private-name", response.text)
            response = client.post("/api/me/document-sets", files=[files[0], files[0], files[2]])
            self.assertEqual(response.status_code, 422)
            response = client.post("/api/me/document-sets", content=b"x", headers={"Content-Length": str(MAX_REQUEST_SIZE + 1)})
            self.assertEqual(response.status_code, 413)
            oversized = [("cv", ("large.pdf", b"x" * (MAX_FILE_SIZE + 1), "application/pdf")), *files[1:]]
            self.assertEqual(client.post("/api/me/document-sets", files=oversized).status_code, 413)

    def test_prototype_flags_do_not_enable_download(self):
        self.db.data[("applicantDocuments", "alice")] = {"documentsValidated": True}
        with self.client() as client:
            response = client.get("/api/applications/application/documents/cv/download")
            self.assertEqual(response.status_code, 404)
        self.storage.download.assert_not_called()


class ValidationTests(unittest.TestCase):
    def test_valid_pdf_and_png(self):
        scanner = Mock()
        self.assertEqual(validate_document("cv", pdf(), "application/pdf", scanner)["mimeType"], "application/pdf")
        stream = io.BytesIO()
        Image.new("RGB", (10, 10)).save(stream, format="PNG")
        self.assertEqual(validate_document("identification", stream.getvalue(), "image/png", scanner)["mimeType"], "image/png")
        with self.assertRaises(HTTPException):
            validate_document("cv", stream.getvalue(), "image/png", scanner)

    def test_empty_oversized_mime_spoof_and_malformed(self):
        for content, mime in ((b"", "application/pdf"), (b"x" * (MAX_FILE_SIZE + 1), "application/pdf"),
                              (pdf(), "image/png"), (b"%PDF-1.7\nmalformed\n%%EOF", "application/pdf")):
            with self.assertRaises(HTTPException):
                validate_document("cv", content, mime, Mock())

    def test_encrypted_and_active_pdf(self):
        for active in (False, True):
            stream = io.BytesIO()
            writer = PdfWriter()
            writer.add_blank_page(width=100, height=100)
            if active:
                writer.add_js("app.alert('test');")
            else:
                writer.encrypt("test")
            writer.write(stream)
            with self.assertRaises(HTTPException):
                validate_document("cv", stream.getvalue(), "application/pdf", Mock())

    def test_scanner_missing_malware_and_error(self):
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(HTTPException) as caught:
                ClamAVScanner().scan(b"sample")
            self.assertEqual(caught.exception.status_code, 503)
        for response, expected in ((b"stream: OK\0", None), (b"stream: Test FOUND\0", 422), (b"stream: ERROR\0", 503)):
            connection = Mock()
            connection.__enter__ = Mock(return_value=connection)
            connection.__exit__ = Mock(return_value=False)
            connection.recv.return_value = response
            with patch.dict("os.environ", {"CLAMAV_PORT": "3310"}), patch("backend.validation.socket.create_connection", return_value=connection):
                if expected:
                    with self.assertRaises(HTTPException) as caught:
                        ClamAVScanner().scan(b"sample")
                    self.assertEqual(caught.exception.status_code, expected)
                else:
                    ClamAVScanner().scan(b"sample")


class StorageTests(unittest.TestCase):
    def adapter(self, handler):
        client = httpx.Client(base_url="https://test.supabase.co/storage/v1/", transport=httpx.MockTransport(handler))
        self.addCleanup(client.close)
        return SupabaseStorage(Settings("https://test.supabase.co", "sb_secret_SYNTHETIC_TEST"), client)

    def test_private_check_upload_no_overwrite_download_delete(self):
        requests = []
        def handler(request):
            requests.append(request)
            if "/bucket/" in request.url.path:
                return httpx.Response(200, json={"public": False})
            return httpx.Response(200, content=b"sample")
        adapter = self.adapter(handler)
        adapter.upload("owner/set/cv", b"sample", "application/pdf")
        self.assertEqual(requests[1].headers["x-upsert"], "false")
        self.assertEqual(adapter.download("owner/set/cv"), b"sample")
        adapter.delete("owner/set/cv")
        self.assertEqual(json.loads(requests[-1].content), {"prefixes": ["owner/set/cv"]})

    def test_public_bucket_and_storage_failure_fail_closed(self):
        adapter = self.adapter(lambda request: httpx.Response(200, json={"public": True}))
        with self.assertRaises(HTTPException):
            adapter.upload("owner/set/cv", b"sample", "application/pdf")
        def handler(request):
            return httpx.Response(200, json={"public": False}) if "/bucket/" in request.url.path else httpx.Response(500, text="sensitive upstream detail")
        adapter = self.adapter(handler)
        with self.assertRaises(HTTPException) as caught:
            adapter.download("owner/set/cv")
        self.assertNotIn("sensitive", caught.exception.detail)


class BodyTests(unittest.IsolatedAsyncioTestCase):
    async def test_chunked_requests_are_bounded_without_content_length(self):
        class Request:
            headers = {}
            async def stream(self):
                yield b"123"
                yield b"456"
        with self.assertRaises(HTTPException) as caught:
            await bounded_body(Request(), 5)
        self.assertEqual(caught.exception.status_code, 413)
