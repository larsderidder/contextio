"""
mitmproxy addon for @contextio/cli.

Captures LLM API traffic from tools that can't be routed through the
contextio proxy (Copilot CLI, etc.) by intercepting HTTPS via mitmproxy.

Writes captures to the same JSON format and directory as @contextio/logger,
with source and session ID in filenames for consistency.

Environment variables:
  CONTEXTIO_CAPTURE_DIR  - output directory (default: ~/.contextio/captures)
  CONTEXTIO_SOURCE       - tool name for filenames (default: "unknown")
  CONTEXTIO_SESSION_ID   - 8-char hex session ID (default: none)
"""

import json
import os
import time
from pathlib import Path
from typing import Optional, Tuple

from mitmproxy import http

CAPTURE_DIR = (
    os.environ.get("CONTEXTIO_CAPTURE_DIR", "").strip()
    or os.path.join(os.path.expanduser("~"), ".contextio", "captures")
)
SOURCE = os.environ.get("CONTEXTIO_SOURCE", "unknown").strip()
SESSION_ID = os.environ.get("CONTEXTIO_SESSION_ID", "").strip()
_SEQ = 0

# Hosts that carry LLM API traffic.
LLM_HOSTS = {
    "api.anthropic.com": "anthropic",
    "api.openai.com": "openai",
    "chatgpt.com": "chatgpt",
    "generativelanguage.googleapis.com": "gemini",
    "models.inference.ai.azure.com": "openai",
    "api.individual.githubcopilot.com": "openai",
    "api.business.githubcopilot.com": "openai",
    "api.enterprise.githubcopilot.com": "openai",
    "openrouter.ai": "openrouter",
    "opencode.ai": "opencode",
}


def _match_provider(host: str) -> Optional[str]:
    """Return the provider name if this host is an LLM API, else None."""
    host = host.lower()
    for pattern, provider in LLM_HOSTS.items():
        if host == pattern or host.endswith("." + pattern):
            return provider
    return None


def _detect_api_format(path: str, provider: str) -> str:
    if provider == "anthropic":
        if "/messages" in path:
            return "anthropic-messages"
        return "unknown"
    if provider in ("openai", "chatgpt"):
        if "/chat/completions" in path:
            return "chat-completions"
        if "/responses" in path:
            return "responses"
        if "/backend-api/" in path:
            return "chatgpt-backend"
        if "/mcp/" in path:
            return "mcp"
        return "unknown"
    if provider in ("openrouter", "opencode"):
        if "/chat/completions" in path:
            return "chat-completions"
        if "/responses" in path:
            return "responses"
        return "unknown"
    if provider == "gemini":
        return "gemini"
    return "unknown"


def _safe_headers(headers) -> dict:
    """Keep only non-sensitive headers."""
    allowed = {
        "content-type",
        "content-encoding",
        "accept",
        "user-agent",
        "x-request-id",
        "openai-beta",
        "anthropic-version",
        "x-ratelimit-limit-requests",
        "x-ratelimit-remaining-requests",
        "x-ratelimit-limit-tokens",
        "x-ratelimit-remaining-tokens",
        "openai-processing-ms",
        "anthropic-ratelimit-requests-limit",
        "anthropic-ratelimit-requests-remaining",
    }
    out = {}
    for k, v in headers.items():
        if k.lower() in allowed:
            out[k] = v
    return out


def _write_capture(capture: dict, source: str, session_id: str) -> None:
    """Write capture JSON with contextio-compatible filename."""
    global _SEQ

    capture_path = Path(CAPTURE_DIR)
    capture_path.mkdir(parents=True, exist_ok=True)

    ts = int(time.time() * 1000)
    seq = f"{_SEQ:06d}"
    _SEQ += 1

    # Match logger filename format: {source}_{sessionId}_{ts}-{seq}.json
    parts = [source]
    if session_id:
        parts.append(session_id)
    parts.append(f"{ts}-{seq}")
    filename = "_".join(parts) + ".json"

    out_file = capture_path / filename
    tmp_file = capture_path / f".{filename}.tmp"

    with tmp_file.open("w", encoding="utf-8") as f:
        json.dump(capture, f, ensure_ascii=True)
    tmp_file.replace(out_file)


def response(flow: http.HTTPFlow) -> None:
    """Capture completed request/response pairs for LLM API calls."""
    if flow.request.method != "POST":
        return

    provider = _match_provider(flow.request.pretty_host)
    if not provider:
        return

    request_body = None
    try:
        request_body = json.loads(flow.request.get_text())
    except Exception:
        pass

    response_body = ""
    response_is_streaming = False
    try:
        response_body = flow.response.get_text()
        content_type = flow.response.headers.get("content-type", "")
        if "text/event-stream" in content_type:
            response_is_streaming = True
    except Exception:
        pass

    start = flow.request.timestamp_start or 0
    end = flow.response.timestamp_end or start
    total_ms = int(max(0, (end - start) * 1000))

    req_raw = flow.request.raw_content or b""
    resp_raw = flow.response.raw_content or b""

    capture = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "sessionId": SESSION_ID or None,
        "method": "POST",
        "path": flow.request.path,
        "source": SOURCE,
        "provider": provider,
        "apiFormat": _detect_api_format(flow.request.path, provider),
        "targetUrl": flow.request.pretty_url,
        "requestHeaders": _safe_headers(flow.request.headers),
        "requestBody": request_body,
        "requestBytes": len(req_raw),
        "responseStatus": flow.response.status_code,
        "responseHeaders": _safe_headers(flow.response.headers),
        "responseBody": response_body,
        "responseIsStreaming": response_is_streaming,
        "responseBytes": len(resp_raw),
        "timings": {
            "send_ms": 0,
            "wait_ms": 0,
            "receive_ms": 0,
            "total_ms": total_ms,
        },
    }

    try:
        _write_capture(capture, SOURCE, SESSION_ID)
    except Exception:
        pass  # silent; we share the tool's terminal
