"""
mitmproxy addon for contextio.

Rewrites intercepted HTTPS requests to route through the contextio
proxy. mitmproxy handles TLS termination; the contextio proxy handles
redaction, logging, and forwarding to the real API.

No capture logic here. That all lives in the Node.js plugin pipeline.

Environment variables:
  CONTEXTIO_PROXY_URL  - contextio proxy base URL (required)
  CONTEXTIO_SOURCE     - tool name for source tagging (default: "unknown")
  CONTEXTIO_SESSION_ID - session ID for source tagging (default: "")
"""

import os

from mitmproxy import http

PROXY_URL = os.environ.get("CONTEXTIO_PROXY_URL", "").strip()
SOURCE = os.environ.get("CONTEXTIO_SOURCE", "unknown").strip()
SESSION_ID = os.environ.get("CONTEXTIO_SESSION_ID", "").strip()


def request(flow: http.HTTPFlow) -> None:
    """Rewrite the request to route through the contextio proxy."""
    if not PROXY_URL:
        return

    # Build source-tagged path: /{source}/{sessionId}{original_path}
    source_prefix = f"/{SOURCE}"
    if SESSION_ID:
        source_prefix += f"/{SESSION_ID}"

    flow.request.url = PROXY_URL + source_prefix + flow.request.path
