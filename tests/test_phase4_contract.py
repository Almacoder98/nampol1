"""Read-only route, authorization and public-build integration contracts."""
from pathlib import Path
import re
import unittest
from fastapi.testclient import TestClient
from app import create_app
from scripts.serve_frontend import PUBLIC_FILES

ROOT = Path(__file__).resolve().parents[1]


class Phase4ContractTests(unittest.TestCase):
    def test_all_client_modules_and_protected_pages_are_in_public_snapshot(self):
        public = set(PUBLIC_FILES)
        for relative in PUBLIC_FILES:
            path = ROOT / relative
            self.assertTrue(path.is_file(), relative)
            if path.suffix not in ('.js', '.html'): continue
            text = path.read_text(encoding='utf-8')
            for target in re.findall(r'\bfrom\s+[\'"]([^\'"]+)[\'"]', text):
                if not target.startswith('.'): continue
                resolved = (path.parent / target).resolve().relative_to(ROOT).as_posix()
                self.assertIn(resolved, public, (relative, target))
        for page in ('profile', 'documents', 'apply', 'dashboard', 'status', 'admin'):
            self.assertNotIn('session-guard.js', (ROOT / f'Frontend/{page}.html').read_text(encoding='utf-8'))
        self.assertFalse(any(p.startswith(('demo/', 'output/', 'tests/', 'backend/')) for p in public))

    def test_every_private_endpoint_rejects_unsigned_direct_requests(self):
        app = create_app(False)
        with TestClient(app, raise_server_exceptions=False) as client:
            for route in app.routes:
                if not route.path.startswith('/api/'): continue
                path = re.sub(r'\{[^}]+\}', 'synthetic', route.path)
                for method in route.methods & {'GET', 'POST'}:
                    result = client.request(method, path, json={})
                    self.assertIn(result.status_code, (401, 403), (method, path, result.text))

    def test_review_and_document_clients_match_actual_api_contract(self):
        routes = {(method, route.path) for route in create_app(False).routes
                  if hasattr(route, 'methods') for method in route.methods}
        contracts = {
            'js/documents.js': [('POST', '/api/me/document-sets')],
            'js/firestore.js': [('GET', '/api/me/document-sets')],
            'js/profile.js': [('GET', '/api/me/document-sets')],
            'js/admin-access.js': [('GET', '/api/admin/session'), ('POST', '/api/admin/activate')],
            'js/shortlisting.js': [('GET', '/api/admin/applications/{application_id}/shortlist'),
                ('POST', '/api/admin/applications/{application_id}/shortlist'),
                ('GET', '/api/admin/vacancies/{vacancy_id}/shortlist')],
            'js/review-documents.js': [('GET', '/api/applications/{application_id}/documents'),
                ('GET', '/api/applications/{application_id}/documents/{kind}/download')],
            'js/screening.js': [('GET', '/api/admin/applications/{application_id}/screening'),
                ('GET', '/api/admin/applications/{application_id}/profile'),
                ('POST', '/api/admin/applications/{application_id}/screening'),
                ('GET', '/api/admin/applications/{application_id}/notification')]
        }
        for module, endpoints in contracts.items():
            source = (ROOT / module).read_text(encoding='utf-8')
            self.assertIn('/api/', source, module)
            for endpoint in endpoints: self.assertIn(endpoint, routes, (module, endpoint))
        for page in ('dashboard', 'status'):
            self.assertIn('watchApplicantApplications(user', (ROOT / f'Frontend/{page}.html').read_text(encoding='utf-8'))
        admin = (ROOT / 'Frontend/admin.html').read_text(encoding='utf-8')
        for helper in ('createReviewDocumentViewer', 'screeningRequest', 'notificationRequest', 'startApplicationReview', 'reviewApplication'):
            self.assertIn(helper, admin)


if __name__ == '__main__': unittest.main()
