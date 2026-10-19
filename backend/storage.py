"""Private Supabase REST adapter; credentials never enter responses."""

from urllib.parse import quote

import httpx
from fastapi import HTTPException

MAX_FILE_SIZE = 5 * 1024 * 1024
MIMES = {"application/pdf", "image/jpeg", "image/png"}


class SupabaseStorage:
    def __init__(self, settings, client=None):
        self.bucket = settings.bucket
        self.client = client or httpx.Client(
            base_url=settings.supabase_url.rstrip("/") + "/storage/v1/",
            headers={"apikey": settings.supabase_secret_key},
            timeout=30, follow_redirects=False, trust_env=False,
        )

    def close(self):
        self.client.close()

    def _check_private(self):
        try:
            response = self.client.get("bucket/" + self.bucket)
            response.raise_for_status()
            bucket = response.json()
            if bucket.get("public") is not False:
                raise ValueError()
        except Exception:
            raise HTTPException(503, "Private storage is unavailable or bucket is not private.") from None

    def _path(self, path):
        if not path or any(part in ("", ".", "..") for part in path.split("/")):
            raise HTTPException(503, "Invalid storage manifest.")
        return self.bucket + "/" + quote(path, safe="/")

    def upload(self, path, content, mime):
        self._check_private()
        if not 0 < len(content) <= MAX_FILE_SIZE or mime not in MIMES:
            raise HTTPException(422, "Invalid document.")
        try:
            response = self.client.post("object/" + self._path(path), content=content,
                                        headers={"Content-Type": mime, "x-upsert": "false"})
            response.raise_for_status()
        except Exception:
            raise HTTPException(503, "Document storage failed.") from None

    def download(self, path):
        self._check_private()
        try:
            with self.client.stream("GET", "object/authenticated/" + self._path(path)) as response:
                response.raise_for_status()
                content = bytearray()
                for chunk in response.iter_bytes(65536):
                    if len(content) + len(chunk) > MAX_FILE_SIZE:
                        raise ValueError()
                    content.extend(chunk)
                return bytes(content)
        except Exception:
            raise HTTPException(503, "Document storage failed.") from None

    def delete(self, path):
        self._check_private()
        try:
            self._path(path)
            response = self.client.request("DELETE", "object/" + self.bucket, json={"prefixes": [path]})
            response.raise_for_status()
        except Exception:
            raise HTTPException(503, "Document cleanup requires retry.") from None
