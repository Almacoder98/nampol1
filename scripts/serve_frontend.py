"""Serve an explicit public snapshot; never expose the repository root."""
from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import socket
import stat
from urllib.parse import unquote, urlsplit

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DOCUMENT_ACCESS_TEST = 'Frontend/document-access-test.html'
PUBLIC_FILES = (
    'index.html',
    'Frontend/admin.html',
    'Frontend/admin_login.html',
    'Frontend/apply.html',
    'Frontend/dashboard.html',
    'Frontend/documents.html',
    'Frontend/index.html',
    'Frontend/login.html',
    'Frontend/profile.html',
    'Frontend/register.html',
    'Frontend/status.html',
    'Frontend/nampol_logo.webp',
    'css/style.css',
    'js/admin.js',
    'js/audit.js',
    'js/auth.js',
    'js/documents.js',
    'js/firebase-config.js',
    'js/admin-access.js',
    'js/session-guard.js',
    'js/screening.js',
    'js/review-documents.js',
    'js/review-profile.js',
    'js/shortlisting.js',
    'js/application-status.js',
    'js/firestore.js',
    'js/jobs.js',
    'js/profile.js',
    'js/storage.js',
)


def checked_path(root: Path, relative: str) -> Path:
    """Reject links/junctions at every component, and enforce containment."""
    root = root.resolve(strict=True)
    candidate = root
    for part in Path(relative).parts:
        if part in ('', '.', '..') or Path(part).is_absolute() or ':' in part:
            raise ValueError('Invalid public path.')
        candidate = candidate / part
        if candidate.is_symlink() or candidate.is_junction():
            raise ValueError('Links and junctions are not permitted in public paths.')
    if not candidate.resolve().is_relative_to(root):
        raise ValueError('Public path escapes its root.')
    return candidate


def prepare_public(project_root: Path = PROJECT_ROOT) -> Path:
    project_root = project_root.resolve(strict=True)
    # Read only named frontend sources. Validate every source before replacing output.
    sources = {}
    for relative in PUBLIC_FILES:
        source = checked_path(project_root, relative)
        if not source.is_file():
            raise ValueError(f'Required public file is missing: {relative}')
        sources[relative] = source.read_bytes()
    public = checked_path(project_root, 'public')
    # Before recursive removal, verify the absolute target is exactly the intended
    # generated directory inside this project. shutil.rmtree does not follow child
    # symlinks (or directory junctions on supported Python versions).
    expected = project_root / 'public'
    if public.resolve() != expected or not public.is_relative_to(project_root):
        raise ValueError('Unsafe generated directory.')
    if public.exists():
        if not public.is_dir():
            raise ValueError('The public output path must be a directory.')
        def remove_readonly(function, path, error):
            # OneDrive can mark generated directories read-only on Windows.
            # Change attributes only inside the already verified output root.
            target = Path(path)
            if (not isinstance(error, PermissionError)
                    or target.is_symlink() or target.is_junction()
                    or not target.resolve().is_relative_to(expected)):
                raise error
            target.chmod(stat.S_IREAD | stat.S_IWRITE)
            function(path)
        shutil.rmtree(public, onexc=remove_readonly)
    public.mkdir()
    for relative, content in sources.items():
        destination = public / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
    return public


def load_public_assets(public: Path) -> dict[str, tuple[bytes, str]]:
    # Refuse a linked output root, including Windows junctions.
    if public.is_symlink() or public.is_junction():
        raise ValueError('The public root must not be a link or junction.')
    public = public.resolve(strict=True)
    assets = {}
    types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
             '.css': 'text/css; charset=utf-8', '.webp': 'image/webp'}
    for relative in PUBLIC_FILES:
        file = checked_path(public, relative)
        if not file.is_file():
            raise ValueError(f'Required public file is missing: {relative}')
        assets['/' + relative] = (file.read_bytes(), types.get(file.suffix, 'application/octet-stream'))
    return assets


def create_server(public: Path, port: int = 8000, *, enable_document_access_test=False) -> ThreadingHTTPServer:
    # Snapshot public files once. Requests never open filesystem paths, so later
    # replacement of a file with a symlink cannot expose files outside public/.
    assets = load_public_assets(public)
    # Development-only asset: never copy it into the deployable public snapshot.
    diagnostic_path = '/' + DOCUMENT_ACCESS_TEST
    if enable_document_access_test:
        diagnostic = checked_path(PROJECT_ROOT, DOCUMENT_ACCESS_TEST)
        assets[diagnostic_path] = (diagnostic.read_bytes(), 'text/html; charset=utf-8')

    class PublicHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.serve_asset(head=False)

        def do_HEAD(self):
            self.serve_asset(head=True)

        def serve_asset(self, head):
            try:
                if not self.path.startswith('/') or self.path.startswith('//'):
                    raise ValueError()
                path = unquote(urlsplit(self.path).path, errors='strict')
                if any(c in path for c in ('\\', '\x00', ':')):
                    raise ValueError()
                if any(part in ('.', '..') for part in path.split('/')):
                    raise ValueError()
            except (ValueError, UnicodeError):
                self.send_error(404, 'Not found')
                return
            if path == '/Frontend':
                self.send_response(301)
                self.send_header('Location', '/Frontend/')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            path = {'/': '/index.html', '/Frontend/': '/Frontend/index.html'}.get(path, path)
            if path == diagnostic_path and (
                    self.headers.get('Host') != '127.0.0.1:8000'
                    or self.client_address[0] != '127.0.0.1'):
                self.send_error(404, 'Not found')
                return
            asset = assets.get(path)
            if asset is None:
                self.send_error(404, 'Not found')
                return
            content, content_type = asset
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            if not head:
                self.wfile.write(content)

        def log_message(self, format, *args):
            # Avoid logging query strings (e.g. authentication action codes).
            pass

    class LoopbackHTTPServer(ThreadingHTTPServer):
        allow_reuse_address = False
        allow_reuse_port = False

        def server_bind(self):
            # Windows SO_REUSEADDR can permit a second listener on an occupied
            # port. Exclusive binding preserves the user's existing server.
            if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            super().server_bind()

    return LoopbackHTTPServer(('127.0.0.1', port), PublicHandler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000, help='Loopback port (default: 8000).')
    parser.add_argument('--prepare-only', action='store_true', help='Generate public/ without starting a server.')
    parser.add_argument('--enable-document-access-test', action='store_true',
                        help='Serve the temporary in-memory diagnostic on 127.0.0.1:8000 only.')
    options = parser.parse_args()
    if not 0 <= options.port <= 65535:
        parser.error('Port must be between 0 and 65535.')
    if options.enable_document_access_test and (options.prepare_only or options.port != 8000):
        parser.error('The diagnostic requires local serving on port 8000, without --prepare-only.')
    try:
        if options.prepare_only:
            public = prepare_public()
            print(f'Prepared {len(PUBLIC_FILES)} allowlisted public files in {public}.')
            return 0
        # Never stop another server; binding fails if this port is already occupied.
        public = prepare_public()
        server = create_server(public, options.port,
                               enable_document_access_test=options.enable_document_access_test)
    except (OSError, ValueError):
        print('Could not prepare/start the frontend server. Check required public files,')
        print('link/junction restrictions, and whether the requested port is already in use.')
        print('No existing server was stopped. Use --port 8002 for parallel testing.')
        return 1
    print(f'Serving public frontend at http://localhost:{server.server_port}/Frontend/')
    print('Bound to 127.0.0.1 only. Restart after source changes to refresh public/.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
