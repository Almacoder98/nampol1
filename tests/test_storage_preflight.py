"""Storage readiness/error contracts using real HTTP adapter and offline responses."""
import io
import socket
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import httpx
from fastapi import HTTPException

from app import Settings
from backend import preflight
from backend.storage import SupabaseStorage


class StorageReadinessTests(unittest.TestCase):
    def adapter(self, handler):
        settings = Settings('https://example.supabase.co', 'sb_secret_test_private')
        client = httpx.Client(base_url=settings.supabase_url + '/storage/v1/',
                             transport=httpx.MockTransport(handler))
        self.addCleanup(client.close)
        return SupabaseStorage(settings, client)

    def test_status_connection_and_privacy_errors_are_safe_and_specific(self):
        cases = [(401, {}, 'storage_credentials_error'),
                 (403, {}, 'storage_credentials_error'),
                 (404, {}, 'storage_bucket_missing'),
                 (400, {}, 'storage_request_error'),
                 (503, {}, 'storage_service_error'),
                 (200, {'public': True}, 'storage_bucket_not_private')]
        for status, body, code in cases:
            with self.subTest(code=code):
                adapter = self.adapter(lambda request: httpx.Response(
                    status, json={**body, 'message': 'private upstream sb_secret_test_private'}))
                with self.assertLogs('nampol.storage', level='WARNING') as logs:
                    with self.assertRaises(HTTPException) as caught:
                        adapter._check_private()
                self.assertEqual(caught.exception.status_code, 503)
                self.assertEqual(caught.exception.detail['code'], code)
                self.assertNotIn('sb_secret_test_private', str(caught.exception.detail) + str(logs.output))
                self.assertNotIn('private upstream', str(logs.output))
        for error, code in [(httpx.ConnectError('private host'), 'storage_connection_error'),
                            (httpx.ReadTimeout('private key'), 'storage_timeout')]:
            def fail(request):
                raise error
            with self.assertRaises(HTTPException) as caught:
                self.adapter(fail)._check_private()
            self.assertEqual(caught.exception.detail['code'], code)

    def test_preflight_only_reads_bucket_and_emits_fixed_codes(self):
        for status, body, expected in [(200, {'public': False}, 'storage_ready'),
                                       (401, {}, 'storage_credentials_error'),
                                       (200, {'public': True}, 'storage_bucket_not_private')]:
            calls = []
            def handler(request):
                calls.append((request.method, request.url.path))
                return httpx.Response(status, json=body)
            adapter = self.adapter(handler)
            with patch('backend.preflight.Settings.from_environment'), patch('backend.preflight.check_project_endpoint'), patch('backend.preflight.SupabaseStorage', return_value=adapter):
                output = io.StringIO()
                with redirect_stdout(output):
                    result = preflight.main()
            self.assertEqual(result, 0 if expected == 'storage_ready' else 1)
            self.assertEqual(output.getvalue().strip(), expected)
            self.assertEqual(calls, [('GET', '/storage/v1/bucket/applicant-documents')])

    def test_endpoint_dns_https_and_no_credential_transmission(self):
        with patch('backend.preflight.socket.getaddrinfo', side_effect=socket.gaierror(11001, 'private host')):
            with self.assertRaises(HTTPException) as caught:
                preflight.check_project_endpoint('https://example.supabase.co')
        self.assertEqual(caught.exception.detail['code'], 'storage_dns_error')
        for error, code in [(httpx.ConnectError('private TLS detail'), 'storage_https_error'),
                            (httpx.ReadTimeout('private timeout'), 'storage_timeout')]:
            def fail(request):
                raise error
            client = httpx.Client(transport=httpx.MockTransport(fail))
            with patch('backend.preflight.socket.getaddrinfo'), patch('backend.preflight.httpx.Client', return_value=client):
                with self.assertRaises(HTTPException) as caught:
                    preflight.check_project_endpoint('https://example.supabase.co')
            self.assertEqual(caught.exception.detail['code'], code)
            self.assertNotIn('private', str(caught.exception.detail))
        def connected(request):
            self.assertEqual(request.url.path, '/')
            self.assertNotIn('apikey', request.headers)
            self.assertNotIn('authorization', request.headers)
            return httpx.Response(404)
        client = httpx.Client(transport=httpx.MockTransport(connected))
        with patch('backend.preflight.socket.getaddrinfo'), patch('backend.preflight.httpx.Client', return_value=client):
            preflight.check_project_endpoint('https://example.supabase.co')

    def test_preflight_never_prints_configuration_exception(self):
        with patch('backend.preflight.Settings.from_environment', side_effect=ValueError('private credential')):
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(preflight.main(), 1)
        self.assertEqual(output.getvalue(), 'storage_configuration_error\n')


if __name__ == '__main__':
    unittest.main()
