"""Real HTTP tests for the public frontend boundary; no cloud access."""
import http.client
from html.parser import HTMLParser
from pathlib import Path
import shutil
from uuid import uuid4
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

from scripts.serve_frontend import DOCUMENT_ACCESS_TEST, PUBLIC_FILES, PROJECT_ROOT, create_server, load_public_assets, prepare_public


class FrontendServerTests(unittest.TestCase):
    def setUp(self):
        # Windows sandbox identities cannot use tempfile's owner-only directory ACL.
        # Keep isolated fixtures in a uniquely named workspace directory instead.
        self.root = PROJECT_ROOT / ('.frontend-server-test-' + uuid4().hex)
        self.root.mkdir()
        self.addCleanup(self.clean_fixture)
        for relative in PUBLIC_FILES:
            file = self.root / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes((PROJECT_ROOT / relative).read_bytes())
        self.secret = b'PRIVATE_TEST_SENTINEL_NOT_A_REAL_CREDENTIAL'
        for relative in ['.env', '.git/config', 'serviceAccountKey.json', 'backend/private.py', 'server.log']:
            file = self.root / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(self.secret)
        self.public = prepare_public(self.root)
        self.server = create_server(self.public, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def clean_fixture(self):
        target = self.root.resolve()
        if (target.parent != PROJECT_ROOT.resolve()
                or not target.name.startswith('.frontend-server-test-')
                or self.root.is_symlink() or self.root.is_junction()):
            raise ValueError('Unsafe test cleanup target.')
        shutil.rmtree(target)

    def request(self, path, method='GET'):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            connection.request(method, path)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_generation_contains_only_allowlisted_bytes_and_removes_stale_files(self):
        (self.public / '.env').write_bytes(self.secret)
        (self.public / 'backend').mkdir()
        (self.public / 'backend/private.py').write_bytes(self.secret)
        prepare_public(self.root)
        files = {p.relative_to(self.public).as_posix() for p in self.public.rglob('*') if p.is_file()}
        self.assertEqual(files, set(PUBLIC_FILES))
        for relative in files:
            self.assertEqual((self.public / relative).read_bytes(), (self.root / relative).read_bytes())

    def test_diagnostic_is_memory_only_opt_in_and_restricted_to_local_host(self):
        self.assertNotIn(DOCUMENT_ACCESS_TEST, PUBLIC_FILES)
        self.assertFalse((self.public / DOCUMENT_ACCESS_TEST).exists())
        self.assertEqual(self.request('/' + DOCUMENT_ACCESS_TEST)[0], 404)
        server = create_server(self.public, 0, enable_document_access_test=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for host, expected in [('127.0.0.1:8000', 200), ('example.com', 404), ('localhost:8000', 404)]:
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                try:
                    connection.request('GET', '/' + DOCUMENT_ACCESS_TEST, headers={'Host': host})
                    response = connection.getresponse()
                    self.assertEqual(response.status, expected)
                    response.read()
                finally:
                    connection.close()
            self.assertFalse((self.public / DOCUMENT_ACCESS_TEST).exists())
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_regeneration_handles_readonly_generated_directories(self):
        import stat
        (self.public / 'css').chmod(stat.S_IREAD)
        prepare_public(self.root)
        self.assertEqual((self.public / 'css/style.css').read_bytes(),
                         (self.root / 'css/style.css').read_bytes())
        self.assertEqual((self.root / '.env').read_bytes(), self.secret)

    def test_all_public_pages_assets_root_and_head(self):
        for relative in PUBLIC_FILES:
            with self.subTest(relative=relative):
                status, headers, data = self.request('/' + relative)
                self.assertEqual(status, 200)
                self.assertEqual(data, (self.root / relative).read_bytes())
                self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
                self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(self.request('/')[2], (self.root / 'index.html').read_bytes())
        self.assertEqual(self.request('/Frontend/')[2], (self.root / 'Frontend/index.html').read_bytes())
        self.assertEqual(self.request('/Frontend')[0], 301)
        status, headers, body = self.request('/js/admin.js?version=1', 'HEAD')
        self.assertEqual(status, 200)
        self.assertIn('javascript', headers['Content-Type'])
        self.assertEqual(body, b'')

    def test_private_paths_and_directory_listings_are_denied(self):
        paths = ['/.env', '/.git/config', '/serviceAccountKey.json', '/backend/private.py',
                 '/app.py', '/firebase.json', '/firestore.rules', '/storage.rules',
                 '/README.md', '/BACKEND.md', '/server.log', '/tests/', '/.venv/',
                 '/public/', '/js/', '/css/', '/scripts/serve_frontend.py']
        for path in paths:
            for method in ['GET', 'HEAD']:
                with self.subTest(path=path, method=method):
                    status, _, data = self.request(path, method)
                    self.assertIn(status, (403, 404))
                    self.assertNotIn(self.secret, data)

    def test_raw_encoded_and_windows_traversal_is_denied(self):
        for path in ['/../.env', '/Frontend/../../.env', '/%2e%2e/.env',
                     '/Frontend/%2e%2e/%2e%2e/.env', '/%252e%252e/.env',
                     '/js/..%5c..%5c.env', '/C:/Windows/win.ini',
                     '/js/admin.js%00', '/%2eenv', '/js/../index.html']:
            with self.subTest(path=path):
                status, _, data = self.request(path)
                self.assertIn(status, (403, 404))
                self.assertNotIn(self.secret, data)

    def test_unlisted_files_added_to_public_are_never_served(self):
        (self.public / '.env').write_bytes(self.secret)
        (self.public / 'js/private.js').write_bytes(self.secret)
        for path in ['/.env', '/js/private.js']:
            self.assertEqual(self.request(path)[0], 404)
        # An unlisted file is still not exposed even after restarting the HTTP handler.
        other = create_server(self.public, 0)
        try:
            self.assertNotIn('/js/private.js', load_public_assets(self.public))
        finally:
            other.server_close()

    def make_link(self, link, target, directory=False):
        try:
            link.symlink_to(target, target_is_directory=directory)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f'Symlink creation is unavailable: {type(error).__name__}')

    def test_snapshot_does_not_read_replaced_files_after_start(self):
        original = (self.public / 'js/admin.js').read_bytes()
        (self.public / 'js/admin.js').write_bytes(self.secret)
        self.assertEqual(self.request('/js/admin.js')[2], original)

    def test_link_and_junction_guards_without_os_link_privileges(self):
        for method in ['is_symlink', 'is_junction']:
            for target, operation in [
                (self.root / 'js', lambda: prepare_public(self.root)),
                (self.public, lambda: load_public_assets(self.public)),
                (self.public / 'js/admin.js', lambda: load_public_assets(self.public))
            ]:
                with self.subTest(method=method, target=target):
                    with patch.object(Path, method, lambda path: path == target):
                        with self.assertRaises(ValueError):
                            operation()
        self.assertEqual((self.root / '.env').read_bytes(), self.secret)

    def test_source_symlinks_are_rejected(self):
        source = self.root / 'js/admin.js'
        original = source.read_bytes()
        source.unlink()
        self.make_link(source, self.root / '.env')
        with self.assertRaises(ValueError):
            prepare_public(self.root)
        self.assertEqual((self.public / 'js/admin.js').read_bytes(), original)

    def test_public_asset_symlinks_are_rejected_at_startup(self):
        asset = self.public / 'js/admin.js'
        asset.unlink()
        self.make_link(asset, self.root / '.env')
        with self.assertRaises(ValueError):
            create_server(self.public, 0)

    def test_link_replacement_after_start_cannot_leak_private_bytes(self):
        asset = self.public / 'js/admin.js'
        original = asset.read_bytes()
        asset.unlink()
        self.make_link(asset, self.root / '.env')
        self.assertEqual(self.request('/js/admin.js')[2], original)

    def test_public_root_symlink_is_rejected_without_modifying_target(self):
        link = self.root / 'linked-public'
        self.make_link(link, self.root, directory=True)
        with self.assertRaises(ValueError):
            load_public_assets(link)
        self.assertEqual((self.root / '.env').read_bytes(), self.secret)

    def test_bound_only_to_loopback_and_occupied_port_fails(self):
        self.assertEqual(self.server.server_address[0], '127.0.0.1')
        with self.assertRaises(OSError):
            create_server(self.public, self.server.server_port)
        self.assertEqual(self.request('/Frontend/admin.html')[0], 200)

    def test_existing_html_links_and_javascript_imports_resolve(self):
        import posixpath
        import re
        class Links(HTMLParser):
            def __init__(self):
                super().__init__()
                self.links = []
            def handle_starttag(self, tag, attrs):
                self.links.extend(value for name, value in attrs if name in ('href', 'src') and value)
        for relative in PUBLIC_FILES:
            file = self.root / relative
            if relative.endswith('.html'):
                parser = Links()
                parser.feed(file.read_text(encoding='utf-8'))
                links = parser.links
            elif relative.endswith('.js'):
                links = re.findall(r'from\s+[\"\']([^\"\']+)[\"\']', file.read_text(encoding='utf-8'))
            else:
                continue
            for link in links:
                url = urlsplit(link)
                if url.scheme or url.netloc or not url.path:
                    continue
                destination = posixpath.normpath(posixpath.join(posixpath.dirname(relative), url.path))
                with self.subTest(source=relative, target=destination):
                    self.assertIn(destination, PUBLIC_FILES)
                    self.assertEqual(self.request('/' + destination)[0], 200)


if __name__ == '__main__':
    unittest.main()
