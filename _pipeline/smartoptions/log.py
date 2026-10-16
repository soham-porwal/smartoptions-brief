"""Build event log: one JSON line per event in logs/build-<date>.jsonl. Fail-safe: a logging
failure goes to stderr and never crashes the caller.

Severities: OK (produced results) | SUSPECT (succeeded but produced zero output) |
WARN (degraded/partial) | FAIL (raised / HTTP error). Never report SUSPECT as OK.
"""
from __future__ import annotations

import json
import errno
import os
import sys
import threading
import time
from datetime import date
from pathlib import Path

from .contract import utc_now

SEVERITIES = ("OK", "SUSPECT", "WARN", "FAIL")
LOG_DIR = Path(__file__).resolve().parent.parent / "logs"
_WRITE_LOCK = threading.Lock()


def _append(path: Path, payload: bytes) -> None:
    """Serialize complete records across threads and cooperating processes.

    Windows locks byte zero (even on an empty file); POSIX uses flock. The
    descriptor is unbuffered and O_APPEND, so neither buffered seeks nor partial
    writes can overwrite a concurrent record. Lock errors reach event's stderr.
    """
    with _WRITE_LOCK:
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_APPEND | getattr(os, "O_BINARY", 0), 0o666)
        locked = False
        try:
            if os.name == "nt":
                import msvcrt
                deadline = time.monotonic() + 10
                while True:
                    try:
                        os.lseek(fd, 0, os.SEEK_SET)
                        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                        break
                    except OSError as exc:
                        if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK) or time.monotonic() >= deadline:
                            raise
                        time.sleep(0.005)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX)
            locked = True
            remaining = memoryview(payload)
            while remaining:
                written = os.write(fd, remaining)
                if written <= 0:
                    raise OSError("log append made no progress")
                remaining = remaining[written:]
        finally:
            try:
                if locked:
                    if os.name == "nt":
                        os.lseek(fd, 0, os.SEEK_SET)
                        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                    else:
                        fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)


def event(stage: str, source: str, severity: str, detail: str = "", count: int | None = None,
          log_dir: Path | None = None) -> None:
    if severity not in SEVERITIES:
        severity = "WARN"
        detail = f"(bad severity passed) {detail}"
    if severity == "OK" and count == 0:
        severity = "SUSPECT"
    rec = {"ts": utc_now(), "stage": stage, "source": source, "severity": severity,
           "count": count, "detail": detail[:2000]}
    try:
        d = log_dir or LOG_DIR
        d.mkdir(parents=True, exist_ok=True)
        _append(d / f"build-{date.today().isoformat()}.jsonl", (json.dumps(rec) + "\n").encode("utf-8"))
    except Exception as e:  # logging must never crash the build
        print(f"[smartoptions.log] could not write log: {e!r} rec={rec}", file=sys.stderr)
    if severity in ("FAIL", "SUSPECT"):
        print(f"[{severity}] {stage}/{source}: {detail[:300]}", file=sys.stderr)
