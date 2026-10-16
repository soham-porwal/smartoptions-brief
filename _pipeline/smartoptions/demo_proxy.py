"""Temporary, capped Anthropic relay for the two SmartOptions demo sites.

Origin filtering is a browser guard, not authentication. This service is for a
short supervised demo, with process-local budgets and a mandatory UTC expiry.
Bind only to loopback; place a temporary HTTPS tunnel in front of it. Restarting
resets the budgets. Never use this relay as an unattended production service.
"""
from __future__ import annotations

import argparse
from collections import defaultdict, deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import sys
import threading
import time
from urllib.parse import urlsplit

import requests

from .log import event

UPSTREAM = "https://api.anthropic.com/v1/messages"
ORIGINS = frozenset({"https://samsej.github.io", "https://soham-porwal.github.io"})
MAX_BODY = 180 * 1024
MAX_RESPONSE = 2 * 1024 * 1024
MODEL_RE = re.compile(r"claude-[a-z0-9][a-z0-9.-]{0,100}\Z")
FIELDS = frozenset({"model", "messages", "system", "tools", "tool_choice", "max_tokens", "temperature", "top_p", "top_k", "stop_sequences", "stream", "output_config"})


class SafeError(Exception):
    """A fixed, public error code/message; never wrap upstream exception text."""

    def __init__(self, status: int, message: str):
        self.status, self.message = status, message
        super().__init__(message)


def parse_expiry(value: str) -> datetime:
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None:
            raise ValueError()
        return result.astimezone(timezone.utc)
    except (TypeError, ValueError):
        raise ValueError("expires-at must be an ISO timestamp with a timezone") from None


def read_key(path: Path | None) -> str:
    """Read an environment key or the Anthropic section of an existing Markdown file."""
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key and path is not None:
        try:
            markdown = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            raise ValueError("Unable to read the configured key file") from None
        lines = markdown.splitlines()
        section_level = None
        section = []
        for line in lines:
            heading = re.match(r"^(#{1,6})\s+(.*)", line)
            if heading:
                level = len(heading.group(1))
                if section_level is not None and level <= section_level:
                    break
                if section_level is None and "anthropic" in heading.group(2).lower():
                    section_level = level
            if section_level is not None:
                section.append(line)
        found = re.findall(r"(?<![\w-])sk-ant-[A-Za-z0-9_-]+", "\n".join(section))
        if len(set(found)) == 1:
            key = found[0]
    if not re.fullmatch(r"sk-ant-[A-Za-z0-9_-]{8,}", key):
        raise ValueError("No valid Anthropic key found in the environment or Anthropic section")
    return key


def envelope(raw: bytes, model: str) -> dict:
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeError):
        raise SafeError(400, "Malformed JSON") from None
    if not isinstance(body, dict) or set(body) - FIELDS:
        raise SafeError(400, "Unsupported message envelope")
    if body.get("stream", False) is not False:
        raise SafeError(400, "Streaming is not supported by this demo")
    requested = body.get("model", model)
    if not isinstance(requested, str) or not MODEL_RE.fullmatch(requested):
        raise SafeError(400, "Unsupported model")
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages or len(messages) > 100:
        raise SafeError(400, "Provide between 1 and 100 messages")
    for message in messages:
        if not isinstance(message, dict) or set(message) - {"role", "content"}:
            raise SafeError(400, "Invalid message")
        if message.get("role") not in {"user", "assistant"} or not isinstance(message.get("content"), (str, list)):
            raise SafeError(400, "Invalid message")
    tokens = body.get("max_tokens", 1024)
    if isinstance(tokens, bool) or not isinstance(tokens, int) or tokens < 1:
        raise SafeError(400, "Invalid output token budget")
    for name in ("temperature", "top_p"):
        if name in body and (isinstance(body[name], bool) or not isinstance(body[name], (int, float)) or not math.isfinite(body[name]) or not 0 <= body[name] <= 1):
            raise SafeError(400, "Invalid sampling setting")
    if "top_k" in body and (isinstance(body["top_k"], bool) or not isinstance(body["top_k"], int) or body["top_k"] < 0):
        raise SafeError(400, "Invalid sampling setting")
    if "system" in body and not isinstance(body["system"], (str, list)):
        raise SafeError(400, "Invalid system message")
    if "tools" in body and (not isinstance(body["tools"], list) or len(body["tools"]) > 32):
        raise SafeError(400, "Invalid tool definitions")
    for tool in body.get("tools", []):
        # This dashboard executes its own data tools in the browser. Built-in
        # provider tools can trigger separately billed searches or other actions.
        if not isinstance(tool, dict) or "type" in tool or not isinstance(tool.get("name"), str) or not isinstance(tool.get("input_schema"), dict):
            raise SafeError(400, "Only dashboard function tools are supported")
    if "tool_choice" in body and not isinstance(body["tool_choice"], dict):
        raise SafeError(400, "Invalid tool choice")
    if "stop_sequences" in body and (not isinstance(body["stop_sequences"], list) or not all(isinstance(s, str) for s in body["stop_sequences"])):
        raise SafeError(400, "Invalid stop sequences")
    if "output_config" in body and body["output_config"] != {"effort": "low"}:
        raise SafeError(400, "The demo supports low reasoning effort only")
    body.update(model=model, max_tokens=min(tokens, 4096), output_config={"effort": "low"})
    body.pop("stream", None)
    return body


class Relay:
    def __init__(self, key: str, model: str, expires_at: datetime, *, allow_localhost: bool = False,
                 max_calls: int = 60, max_total_bytes: int = 3 * 1024 * 1024,
                 calls_per_minute: int = 12, max_concurrency: int = 2,
                 log_dir: Path | None = None, provider=None, now=None):
        self.now = now or (lambda: datetime.now(timezone.utc))
        if not key or not isinstance(model, str) or not MODEL_RE.fullmatch(model):
            raise ValueError("A key and a valid configured Claude model are required")
        if expires_at.tzinfo is None or expires_at <= self.now():
            raise ValueError("Demo expiry must be in the future with a timezone")
        if any(isinstance(n, bool) or not isinstance(n, int) or n < 1 for n in (max_calls, max_total_bytes, calls_per_minute, max_concurrency)):
            raise ValueError("Demo budgets must be positive integers")
        self._key, self.model, self.expires_at = key, model, expires_at
        self.allow_localhost = allow_localhost
        self.max_calls, self.max_total_bytes = max_calls, max_total_bytes
        self.calls_per_minute, self.max_concurrency = calls_per_minute, max_concurrency
        self.calls = self.total_bytes = self.active = 0
        self.lock = threading.Lock()
        self.rate = defaultdict(deque)
        self.provider = provider or requests.post
        self.log_dir = log_dir or (Path(__file__).resolve().parent.parent / "logs" / "demo-proxy-receipts")

    def receipt(self, severity: str, status: int, reason: str, *, size: int = 0, usage=None):
        # Only fixed public reasons and numeric metadata enter the durable log.
        usage = usage if isinstance(usage, dict) else {}
        tokens = {k: usage[k] for k in ("input_tokens", "output_tokens") if isinstance(usage.get(k), int) and not isinstance(usage.get(k), bool)}
        event("demo_proxy", "anthropic", severity,
              json.dumps({"status": status, "reason": reason, "bytes": size, "calls": self.calls,
                          "model": self.model, **tokens}), count=1, log_dir=self.log_dir)

    def allowed(self, origin: str | None) -> bool:
        if origin in ORIGINS:
            return True
        if not origin or not self.allow_localhost:
            return False
        try:
            u = urlsplit(origin)
            return u.scheme in {"http", "https"} and u.hostname in {"localhost", "127.0.0.1"} and not u.username and not u.password and not u.path and not u.query and not u.fragment
        except ValueError:
            return False

    def healthy(self):
        with self.lock:
            enabled = self.now() < self.expires_at and self.calls < self.max_calls and self.total_bytes < self.max_total_bytes
            return {"enabled": enabled, "expires_at": self.expires_at.isoformat(), "model": self.model}

    def reserve_bytes(self, size: int):
        with self.lock:
            if self.now() >= self.expires_at:
                raise SafeError(410, "The demo session has expired")
            if self.total_bytes + size > self.max_total_bytes:
                raise SafeError(429, "The demo request budget has been reached")
            self.total_bytes += size

    def forward(self, body: dict, size: int, ip: str) -> dict:
        with self.lock:
            if self.now() >= self.expires_at:
                raise SafeError(410, "The demo session has expired")
            now = time.monotonic()
            recent = self.rate[ip]
            while recent and recent[0] <= now - 60:
                recent.popleft()
            if len(recent) >= self.calls_per_minute:
                raise SafeError(429, "Please wait a minute before asking again")
            if self.calls >= self.max_calls:
                raise SafeError(429, "The demo call budget has been reached")
            if self.active >= self.max_concurrency:
                raise SafeError(429, "The demo is busy; please try again shortly")
            self.calls += 1
            self.active += 1
            recent.append(now)
        response = None
        try:
            response = self.provider(UPSTREAM, json=body, headers={"x-api-key": self._key, "anthropic-version": "2023-06-01", "content-type": "application/json"}, timeout=(10, 60), allow_redirects=False)
            status = response.status_code
            if status != 200:
                message = {
                    401: "The demo provider key was rejected; contact the demo host",
                    402: "The demo provider account needs credits; contact the demo host",
                    403: "The demo provider account cannot access this model",
                    429: "The demo provider is rate limited or needs credits; try later or contact the host",
                }.get(status, "The AI provider could not complete this request; please try again later")
                # A credit error may use 400. Inspect only the error type, never expose its text.
                if status == 400:
                    try:
                        err = response.json().get("error", {})
                        if err.get("type") in {"credit_balance_error", "billing_error"} or "credit balance" in str(err.get("message", "")).lower():
                            message = "The demo provider account needs credits; contact the demo host"
                    except (ValueError, AttributeError, TypeError):
                        pass
                self.receipt("FAIL", status, "provider_rejected", size=size)
                raise SafeError(status if status in {400, 401, 402, 403, 429} else 502, message)
            if len(response.content) > MAX_RESPONSE:
                raise ValueError("response size")
            result = response.json()
            if not isinstance(result, dict) or result.get("type") != "message" or not isinstance(result.get("content"), list) or not result["content"]:
                self.receipt("SUSPECT", 502, "provider_empty_or_invalid", size=size)
                raise SafeError(502, "The AI provider returned no usable answer")
            self.receipt("OK", 200, "provider_completed", size=size, usage=result.get("usage"))
            return result
        except SafeError:
            raise
        except Exception:
            # Never log exception repr, request bodies, response bodies or URLs.
            self.receipt("FAIL", 502, "provider_unavailable", size=size)
            raise SafeError(502, "The AI provider is unavailable; please try again later") from None
        finally:
            if response is not None:
                try:
                    response.close()
                except Exception:
                    self.receipt("WARN", 200, "provider_close_failed")
            with self.lock:
                self.active -= 1


def make_server(relay: Relay, port: int = 18891) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        server_version = "SmartOptionsDemo/1"

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_args):
            pass  # Default access logs include untrusted paths and are unnecessary.

        def send_json(self, status: int, payload: dict):
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            origin = self.headers.get("Origin")
            if relay.allowed(origin):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            try:
                self.wfile.write(raw)
            except (OSError, TimeoutError):
                relay.receipt("WARN", status, "client_disconnected")

        def deny(self, error: SafeError):
            relay.receipt("WARN", error.status, "request_denied")
            self.send_json(error.status, {"type": "error", "error": {"type": "demo_proxy_error", "message": error.message}})

        def do_GET(self):
            if self.path == "/health":
                self.send_json(200, relay.healthy())
            else:
                self.deny(SafeError(404, "Unknown endpoint"))

        def do_OPTIONS(self):
            if self.path != "/v1/messages":
                return self.deny(SafeError(404, "Unknown endpoint"))
            if not relay.allowed(self.headers.get("Origin")):
                return self.deny(SafeError(403, "Origin is not allowed"))
            names = {h.strip().lower() for h in self.headers.get("Access-Control-Request-Headers", "").split(",") if h.strip()}
            if self.headers.get("Access-Control-Request-Method") != "POST" or names - {"content-type"}:
                return self.deny(SafeError(403, "Preflight is not allowed"))
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Access-Control-Allow-Methods", "POST")
            self.send_header("Access-Control-Allow-Headers", "content-type")
            self.send_header("Access-Control-Max-Age", "300")
            self.send_header("Vary", "Origin")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self):
            try:
                if self.path != "/v1/messages":
                    raise SafeError(404, "Unknown endpoint")
                if not relay.allowed(self.headers.get("Origin")):
                    raise SafeError(403, "Origin is not allowed")
                if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) != 1:
                    raise SafeError(400, "Provide one Content-Length")
                try:
                    size = int(self.headers.get("Content-Length", ""))
                except ValueError:
                    raise SafeError(400, "Invalid Content-Length") from None
                if size < 1 or size > MAX_BODY:
                    raise SafeError(413, "The demo message is too large")
                if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                    raise SafeError(415, "Use application/json")
                relay.reserve_bytes(size)
                raw = self.rfile.read(size)
                if len(raw) != size:
                    raise SafeError(400, "Incomplete request")
                body = envelope(raw, relay.model)
                result = relay.forward(body, size, self.client_address[0])
                self.send_json(200, result)
            except SafeError as error:
                self.deny(error)
            except (OSError, TimeoutError):
                self.deny(SafeError(408, "The request timed out"))
            except Exception:
                relay.receipt("FAIL", 500, "internal_error")
                self.deny(SafeError(500, "The demo could not process this request"))

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    return server


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key-file", type=Path)
    parser.add_argument("--model", required=True)
    parser.add_argument("--expires-at", required=True)
    parser.add_argument("--port", type=int, default=18891)
    parser.add_argument("--allow-localhost", action="store_true")
    args = parser.parse_args(argv)
    server = None
    try:
        if not 1 <= args.port <= 65535:
            raise ValueError("Port must be between 1 and 65535")
        relay = Relay(read_key(args.key_file), args.model, parse_expiry(args.expires_at), allow_localhost=args.allow_localhost)
        server = make_server(relay, args.port)
        relay.receipt("OK", 200, "startup_validated")
        print(f"SmartOptions demo relay on 127.0.0.1:{args.port}; expires {relay.expires_at.isoformat()}; model {relay.model}", flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        if server:
            relay.receipt("WARN", 200, "operator_shutdown")
        return 0
    except Exception:
        # Do not echo paths, credentials or exception strings from startup.
        event("demo_proxy", "startup", "FAIL", "Startup validation or listener failed", count=1,
              log_dir=Path(__file__).resolve().parent.parent / "logs" / "demo-proxy-receipts")
        print("Demo relay could not start. Check the key source, model, future UTC expiry and loopback port.", file=sys.stderr)
        return 1
    finally:
        if server:
            server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
