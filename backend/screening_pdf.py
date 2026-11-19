"""Isolated, resource-limited PDF text worker. No files, credentials or network."""
import io
import json
import os
import sys


def restrict_resources():
    if os.name != 'nt':
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
        return
    import ctypes as c
    from ctypes import wintypes as w
    class Basic(c.Structure):
        _fields_ = [('process_time', c.c_longlong), ('job_time', c.c_longlong),
                    ('flags', w.DWORD), ('minimum', c.c_size_t), ('maximum', c.c_size_t),
                    ('active', w.DWORD), ('affinity', c.c_size_t), ('priority', w.DWORD), ('scheduling', w.DWORD)]
    class IO(c.Structure):
        _fields_ = [(name, c.c_ulonglong) for name in ('read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes')]
    class Extended(c.Structure):
        _fields_ = [('basic', Basic), ('io', IO), ('process_memory', c.c_size_t),
                    ('job_memory', c.c_size_t), ('peak_process', c.c_size_t), ('peak_job', c.c_size_t)]
    kernel = c.WinDLL('kernel32', use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]
    kernel.CreateJobObjectW.restype = w.HANDLE
    kernel.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
    kernel.GetCurrentProcess.restype = w.HANDLE
    handle = kernel.CreateJobObjectW(None, None)
    limits = Extended(); limits.basic.flags = 0x100; limits.process_memory = 256 * 1024 * 1024
    if not handle or not kernel.SetInformationJobObject(handle, 9, c.byref(limits), c.sizeof(limits)):
        raise RuntimeError('Resource isolation unavailable')
    if not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        raise RuntimeError('Resource isolation unavailable')
    # The OS closes this process-owned handle on exit. Never run without limits.


def main():
    try:
        restrict_resources()
        import logging
        logging.disable(logging.CRITICAL)
        from pypdf import PdfReader
        content = sys.stdin.buffer.read(5 * 1024 * 1024 + 1)
        if len(content) > 5 * 1024 * 1024:
            raise ValueError()
        reader = PdfReader(io.BytesIO(content), strict=True)
        if reader.is_encrypted or not 0 < len(reader.pages) <= 50:
            raise ValueError()
        parts = []; count = 0
        for page in reader.pages:
            text = page.extract_text() or ''
            count += len(text)
            if count > 100000:
                raise ValueError()
            parts.append(text)
        print(json.dumps({'text': '\n'.join(parts), 'complete': True}))
    except Exception:
        # Never print PDF content, parser diagnostics or personal information.
        print(json.dumps({'text': '', 'complete': False}))


if __name__ == '__main__':
    main()
