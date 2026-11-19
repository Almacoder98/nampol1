import unittest
from unittest.mock import Mock, patch

from fastapi import Depends, HTTPException
from fastapi.testclient import TestClient
from firebase_admin import auth
from firebase_admin import exceptions as firebase_errors

from app import (Authorization, FIREBASE_PROJECT, FirestoreManifestRepository,
                 Principal, Settings, create_app, current_principal,
                 verify_firebase_token)


class BackendTests(unittest.TestCase):
    def test_auth_rejection_log_identifies_clock_without_exposing_token_or_sdk_message(self):
        failure = auth.InvalidIdTokenError("Token used too early: private-sdk-detail")
        with patch("app.auth.verify_id_token", side_effect=failure):
            with self.assertLogs("nampol.auth", level="WARNING") as captured:
                with self.assertRaises(HTTPException) as caught:
                    verify_firebase_token("private-token", None)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(caught.exception.detail["code"], "auth_clock_error")
        logged = " ".join(captured.output)
        self.assertIn("reason=server_clock_behind_token", logged)
        self.assertNotIn("private-token", logged)
        self.assertNotIn("private-sdk-detail", logged)

    def test_auth_rejection_log_distinguishes_revoked_and_disabled_accounts(self):
        for failure, reason in ((auth.RevokedIdTokenError("private"), "revoked"),
                                (auth.UserDisabledError("private"), "user_disabled")):
            with patch("app.auth.verify_id_token", side_effect=failure):
                with self.assertLogs("nampol.auth", level="WARNING") as captured:
                    with self.assertRaises(HTTPException):
                        verify_firebase_token("private-token", None)
            self.assertIn("reason=" + reason, " ".join(captured.output))
            self.assertNotIn("private", " ".join(captured.output))

    def claims(self, **changes):
        return {"uid": "alice", "aud": FIREBASE_PROJECT,
                "iss": f"https://securetoken.google.com/{FIREBASE_PROJECT}",
                "email_verified": True, "firebase": {"sign_in_provider": "password"}, **changes}

    def test_token_verification_and_revocation_option(self):
        with patch("app.auth.verify_id_token", return_value=self.claims()) as verify:
            self.assertEqual(verify_firebase_token("token", "sdk-app"), Principal("alice"))
            verify.assert_called_once_with("token", app="sdk-app", check_revoked=True)

    def test_denied_tokens(self):
        for error in (auth.InvalidIdTokenError, auth.ExpiredIdTokenError,
                      auth.RevokedIdTokenError, auth.UserDisabledError):
            failure = error("private detail", None) if error == auth.ExpiredIdTokenError else error("private detail")
            with self.subTest(error=error), patch("app.auth.verify_id_token", side_effect=failure):
                with self.assertRaises(HTTPException) as caught:
                    verify_firebase_token("token", None)
                self.assertEqual(caught.exception.status_code, 401)
                self.assertNotIn("private", caught.exception.detail)
        for changes in ({"aud": "wrong"}, {"iss": "wrong"}, {"uid": ""}, {"email_verified": False}):
            with patch("app.auth.verify_id_token", return_value=self.claims(**changes)):
                with self.assertRaises(HTTPException):
                    verify_firebase_token("token", None)

    def test_verification_outage_fails_closed(self):
        with patch("app.auth.verify_id_token", side_effect=RuntimeError("secret")):
            with self.assertRaises(HTTPException) as caught:
                verify_firebase_token("token", None)
            self.assertEqual(caught.exception.status_code, 503)

    def test_expiry_project_and_backend_permissions_are_distinct(self):
        cases = (
            (auth.ExpiredIdTokenError("private", None), 401, "session_expired", "expired"),
            (auth.InvalidIdTokenError("incorrect audience private"), 503, "auth_project_error", "audience_mismatch"),
            (auth.InvalidIdTokenError("incorrect issuer private"), 503, "auth_project_error", "issuer_mismatch"),
            (firebase_errors.PermissionDeniedError("private"), 503, "auth_backend_error", "backend_credentials_or_permission"),
            (firebase_errors.UnauthenticatedError("private"), 503, "auth_backend_error", "backend_credentials_or_permission"),
        )
        for failure, status, code, reason in cases:
            with self.subTest(code=code), patch("app.auth.verify_id_token", side_effect=failure):
                with self.assertLogs("nampol.auth", level="WARNING") as captured:
                    with self.assertRaises(HTTPException) as caught:
                        verify_firebase_token("private-token", None)
                self.assertEqual(caught.exception.status_code, status)
                self.assertEqual(caught.exception.detail["code"], code)
                self.assertIn("reason=" + reason, " ".join(captured.output))
                self.assertNotIn("private", str(caught.exception.detail) + " ".join(captured.output))

    def test_authentication_failure_rejects_upload_before_document_service(self):
        application = create_app(False)
        application.state.firebase_app = "mock-sdk-app"
        application.state.documents = Mock()
        with TestClient(application) as client:
            for failure, status, code in (
                (auth.InvalidIdTokenError("Token used too early"), 503, "auth_clock_error"),
                (auth.ExpiredIdTokenError("expired", None), 401, "session_expired"),
                (firebase_errors.PermissionDeniedError("private"), 503, "auth_backend_error"),
            ):
                with patch("app.auth.verify_id_token", side_effect=failure):
                    response = client.post("/api/me/document-sets", content=b"synthetic-invalid-body",
                                           headers={"Authorization": "Bearer private-token"})
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json()["detail"]["code"], code)
        application.state.documents.authorization.applicant.assert_not_called()
        application.state.documents.upload.assert_not_called()

    def test_applicant_checks(self):
        records = Mock()
        checks = Authorization(records)
        good = {"role": "applicant", "accountStatus": "active", "profileCompleted": True}
        records.read.return_value = good
        self.assertEqual(checks.applicant(Principal("alice"), "alice"), good)
        for record in (None, {**good, "role": "admin"}, {**good, "accountStatus": "disabled"}, {**good, "profileCompleted": False}):
            records.read.return_value = record
            with self.assertRaises(HTTPException):
                checks.applicant(Principal("alice"), "alice")
        with self.assertRaises(HTTPException):
            checks.applicant(Principal("alice"), "bob")

    def test_current_admin_roles_and_regions(self):
        records = Mock()
        checks = Authorization(records)
        for role in ("admin", "recruiter", "super_admin"):
            import hashlib
            index_id = hashlib.sha256(b'NAMPOL-001').hexdigest()
            record = {"active": True, "role": role, "region": "Khomas", "provisioningVersion": 1,
                      "staffNumber": "NAMPOL-001", "staffCodeId": index_id}
            records.read.side_effect = lambda collection, uid: (record if collection == 'admins' else
                {'uid': 'staff', 'staffNumber': 'NAMPOL-001', 'state': 'active'})
            checks.administrator(Principal("staff"), "Khomas")
            if role == "super_admin":
                checks.administrator(Principal("staff"), "Erongo")
            else:
                for region in ("Erongo", "", None):
                    with self.assertRaises(HTTPException):
                        checks.administrator(Principal("staff"), region)
        for record in (None, {"active": False, "role": "super_admin"}, {"active": True, "role": "applicant"}):
            records.read.side_effect = None
            records.read.return_value = record
            with self.assertRaises(HTTPException):
                checks.administrator(Principal("staff"), "Khomas")

    def test_application_scope_is_loaded_from_firestore(self):
        records = Mock()
        records.read.side_effect = lambda collection, uid: (
            {"applicantId": "alice", "region": "Erongo"} if collection == "applications"
            else {"active": True, "role": "admin", "region": "Khomas"})
        with self.assertRaises(HTTPException):
            Authorization(records).application_documents(Principal("staff"), "application")

    def test_manifest_versions_and_ownership(self):
        client = Mock()
        repository = FirestoreManifestRepository(client)
        first = repository.create_pending("alice")
        second = repository.create_pending("alice")
        self.assertNotEqual(first["setId"], second["setId"])
        self.assertEqual(first["state"], "pending")
        client.collection.assert_called_with("serverDocumentSets")
        self.assertEqual(client.collection.return_value.document.return_value.create.call_count, 2)
        snapshot = client.collection.return_value.document.return_value.get.return_value
        snapshot.exists = True
        snapshot.to_dict.return_value = first
        self.assertEqual(repository.get_owned("alice", first["setId"]), first)
        with self.assertRaises(HTTPException):
            repository.get_owned("bob", first["setId"])

    def test_health_cors_and_missing_bearer(self):
        application = create_app(initialize_services=False)
        @application.get("/test-protected")
        def protected(principal=Depends(current_principal)):
            return {"uid": principal.uid}
        with TestClient(application) as client:
            self.assertEqual(client.get("/health").json(), {"status": "ok", "phase": "2A"})
            self.assertEqual(client.get("/test-protected").status_code, 401)
            application.state.firebase_app = "mock-sdk-app"
            with patch("app.auth.verify_id_token", return_value=self.claims()):
                self.assertEqual(client.get("/test-protected", headers={"Authorization": "Bearer test"}).json(), {"uid": "alice"})
            for origin in ("http://localhost:8000", "http://127.0.0.1:8000"):
                response = client.options("/health", headers={"Origin": origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "Authorization"})
                self.assertEqual(response.headers["access-control-allow-origin"], origin)
            response = client.options("/health", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
            self.assertEqual(response.status_code, 400)
            self.assertNotIn("access-control-allow-origin", response.headers)
            self.assertEqual(client.post("/api/me/document-sets").status_code, 401)

    def test_configuration_redacts_secret_and_rejects_wrong_project(self):
        settings = Settings("https://example.supabase.co", "sb_secret_test")
        self.assertNotIn("sb_secret_test", repr(settings))
        with self.assertRaises(ValueError):
            Settings("https://example.supabase.co", "sb_secret_test", firebase_project="other")
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(ValueError):
                Settings.from_environment()

    def test_startup_requires_configuration_without_sdk_initialization(self):
        with patch.dict("os.environ", {}, clear=True), patch("app.firebase_admin.initialize_app") as initialize:
            with self.assertRaises(RuntimeError) as caught:
                with TestClient(create_app()):
                    pass
            self.assertNotIn("sb_secret", str(caught.exception))
            initialize.assert_not_called()


if __name__ == "__main__":
    unittest.main()
