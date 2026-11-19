"""Read-only storage readiness for the local launcher. Prints fixed codes only."""
import socket
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException

from app import Settings
from backend.storage import SupabaseStorage


def check_project_endpoint(url):
    """Validate DNS and TLS without sending the API key or following redirects."""
    try:
        parsed = urlparse(url)
        socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
    except OSError:
        raise HTTPException(503, {"code": "storage_dns_error"}) from None
    try:
        with httpx.Client(trust_env=False, timeout=10, follow_redirects=False) as client:
            # A root 404 still proves HTTPS connectivity; bucket authentication
            # and privacy are checked separately through the existing adapter.
            client.get(url.rstrip('/') + '/')
    except httpx.TimeoutException:
        raise HTTPException(503, {"code": "storage_timeout"}) from None
    except httpx.RequestError:
        raise HTTPException(503, {"code": "storage_https_error"}) from None


def main():
    storage = None
    try:
        settings = Settings.from_environment()
        check_project_endpoint(settings.supabase_url)
        storage = SupabaseStorage(settings)
        storage._check_private()
        print("storage_ready")
        return 0
    except HTTPException as error:
        code = error.detail.get("code") if isinstance(error.detail, dict) else None
        allowed = {"storage_dns_error", "storage_https_error", "storage_credentials_error", "storage_bucket_missing", "storage_request_error",
                   "storage_connection_error", "storage_timeout", "storage_service_error",
                   "storage_bucket_not_private"}
        print(code if code in allowed else "storage_service_error")
        return 1
    except Exception:
        print("storage_configuration_error")
        return 1
    finally:
        if storage is not None:
            try:
                storage.close()
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
