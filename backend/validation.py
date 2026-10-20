"""Bounded byte validation and fail-closed ClamAV INSTREAM scanning."""

import hashlib
import io
import logging
import os
import socket
import struct
import warnings

from fastapi import HTTPException
from PIL import Image
from pypdf import PdfReader

from backend.storage import MAX_FILE_SIZE

DOCUMENT_TYPES = ("cv", "identification", "certificate")
MAX_REQUEST_SIZE = 3 * MAX_FILE_SIZE + 65536

# Parser diagnostics may contain attacker-controlled PDF tokens/content.
pdf_logger = logging.getLogger("pypdf")
pdf_logger.handlers = [logging.NullHandler()]
pdf_logger.propagate = False


async def bounded_body(request, maximum):
    length = request.headers.get("content-length")
    if length:
        try:
            if int(length) < 0 or int(length) > maximum:
                raise HTTPException(413, "Request exceeds the size limit.")
        except ValueError:
            raise HTTPException(400, "Invalid request size.") from None
    content = bytearray()
    async for chunk in request.stream():
        if len(content) + len(chunk) > maximum:
            raise HTTPException(413, "Request exceeds the size limit.")
        content.extend(chunk)
    return bytes(content)


class ClamAVScanner:
    def __init__(self):
        self.port = os.environ.get("CLAMAV_PORT")

    def scan(self, content):
        if not self.port:
            raise HTTPException(503, "Malware scanning unavailable: configure local ClamAV and CLAMAV_PORT.")
        try:
            with socket.create_connection(("127.0.0.1", int(self.port)), timeout=20) as connection:
                connection.sendall(b"zINSTREAM\0")
                for offset in range(0, len(content), 65536):
                    chunk = content[offset:offset + 65536]
                    connection.sendall(struct.pack("!I", len(chunk)) + chunk)
                connection.sendall(struct.pack("!I", 0))
                result = bytearray()
                while b"\0" not in result:
                    chunk = connection.recv(1024)
                    if not chunk or len(result) + len(chunk) > 4096:
                        raise ValueError()
                    result.extend(chunk)
            result = bytes(result).split(b"\0", 1)[0]
            if result.endswith(b" FOUND"):
                raise HTTPException(422, "Document rejected by malware scanning.")
            if result != b"stream: OK":
                raise ValueError()
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, "Malware scanning unavailable; no files were released.") from None


def validate_document(kind, content, claimed_mime, scanner):
    if kind not in DOCUMENT_TYPES or not content:
        raise HTTPException(422, "Required document is empty or invalid.")
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(413, "Each document must be 5 MiB or smaller.")
    # Scan before invoking parsers; unscanned bytes are never stored or published.
    scanner.scan(content)
    try:
        if content.startswith(b"%PDF-"):
            mime, extension = "application/pdf", "pdf"
            if not content.rstrip().endswith(b"%%EOF"):
                raise ValueError()
            reader = PdfReader(io.BytesIO(content), strict=True)
            if reader.is_encrypted or not 0 < len(reader.pages) <= 200:
                raise ValueError()
            # Reject active/embedded content, including encoded PDF name tokens.
            inspected = 0
            seen = set()
            def inspect(value):
                nonlocal inspected
                if id(value) in seen:
                    return
                seen.add(id(value))
                inspected += 1
                if inspected > 20000:
                    raise ValueError()
                if hasattr(value, "get_object"):
                    resolved = value.get_object()
                    if resolved is not value:
                        inspect(resolved)
                        return
                if isinstance(value, dict):
                    if set(value) & {"/JS", "/JavaScript", "/OpenAction", "/AA", "/EmbeddedFiles", "/EF", "/Launch", "/XFA", "/RichMedia"}:
                        raise ValueError()
                    for item in value.values():
                        inspect(item)
                elif isinstance(value, (list, tuple)):
                    for item in value:
                        inspect(item)
            inspect(reader.trailer)
        elif content.startswith(b"\x89PNG\r\n\x1a\n") or content.startswith(b"\xff\xd8\xff"):
            if kind == "cv":
                raise ValueError()
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(content)) as image:
                    if image.format not in ("PNG", "JPEG") or image.width * image.height > 20000000:
                        raise ValueError()
                    mime, extension = ("image/png", "png") if image.format == "PNG" else ("image/jpeg", "jpg")
                    image.verify()
                with Image.open(io.BytesIO(content)) as image:
                    image.load()
        else:
            raise ValueError()
        if claimed_mime != mime:
            raise ValueError()
    except Exception:
        raise HTTPException(422, "Invalid file format, MIME type, or unsafe document content.") from None
    return {"fileName": f"{kind}.{extension}", "fileSize": len(content),
            "mimeType": mime, "sha256": hashlib.sha256(content).hexdigest(),
            "scanStatus": "clean"}
