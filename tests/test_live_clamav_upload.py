"""Opt-in HTTP orchestration tests with real clamd and in-memory cloud fixtures.

These do not verify live Firebase authentication, Firestore, or Supabase.
Run with NAMPOL_LIVE_CLAMAV_TEST=1 and CLAMAV_PORT=3310.
"""
import os
import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

import test_documents as fixtures
from app import Authorization, Principal, create_app, current_principal
from backend.documents import DocumentRepository, DocumentService
from backend.validation import ClamAVScanner


@unittest.skipUnless(os.environ.get("NAMPOL_LIVE_CLAMAV_TEST") == "1", "Live ClamAV test is opt-in")
class LiveClamAVUploadTests(unittest.TestCase):
    def setUp(self):
        transaction_patch = patch("backend.documents.firestore.transactional", fixtures.transactional)
        transaction_patch.start()
        self.addCleanup(transaction_patch.stop)
        self.db = fixtures.Database()
        self.db.data[("users", "synthetic-applicant")] = {
            "role": "applicant", "accountStatus": "active",
            "profileCompleted": True, "region": "Khomas",
        }
        self.repository = DocumentRepository(self.db)
        self.scanner = Mock(wraps=ClamAVScanner())
        self.objects = {}
        self.storage = Mock()
        self.storage.upload.side_effect = lambda path, content, mime: self.objects.update({path: content})
        self.storage.download.side_effect = lambda path: self.objects[path]
        self.service = DocumentService(Authorization(self.db), self.repository, self.storage, self.scanner)
        self.application = create_app(False)
        self.application.state.documents = self.service
        # Explicit test identity: this is not real Firebase sign-in.
        self.application.dependency_overrides[current_principal] = lambda: Principal("synthetic-applicant")

    def multipart(self, cv=None):
        content = fixtures.pdf()
        return {kind: (f"synthetic-{kind}.pdf", cv if kind == "cv" and cv is not None else content,
                       "application/pdf") for kind in ("cv", "identification", "certificate")}

    def test_real_scanner_upload_manifest_linkage_and_download(self):
        with TestClient(self.application, raise_server_exceptions=False) as client:
            response = client.post("/api/me/document-sets", files=self.multipart())
            self.assertEqual(response.status_code, 201, response.text)
            manifest = response.json()
            self.assertEqual(manifest["state"], "ready")
            self.assertEqual(self.scanner.scan.call_count, 3)
            self.assertEqual(len(self.objects), 3)
            metadata = self.db.read("applicantDocuments", "synthetic-applicant")
            self.assertEqual(metadata["setId"], manifest["setId"])
            for kind in ("cv", "identification", "certificate"):
                self.assertEqual(manifest["documents"][kind]["scanStatus"], "clean")
                self.assertEqual(metadata[kind]["setId"], manifest["setId"])
            self.assertNotIn("objectPath", response.text)
            listed = client.get("/api/me/document-sets").json()["sets"]
            self.assertEqual([item["setId"] for item in listed], [manifest["setId"]])
            download = client.get(f'/api/me/document-sets/{manifest["setId"]}/cv/download')
            self.assertEqual(download.status_code, 200)
            self.assertEqual(download.content, fixtures.pdf())
            self.assertEqual(download.headers["cache-control"], "no-store")

    def test_real_scanner_malformed_pdf_never_reaches_storage(self):
        with TestClient(self.application, raise_server_exceptions=False) as client:
            response = client.post("/api/me/document-sets", files=self.multipart(b"%PDF-invalid\n%%EOF"))
            self.assertEqual(response.status_code, 422, response.text)
            self.assertEqual(self.scanner.scan.call_count, 1)
            self.storage.upload.assert_not_called()
            self.assertIsNone(self.db.read("applicantDocuments", "synthetic-applicant"))
            self.assertEqual(self.repository.list_owned("synthetic-applicant"), [])
