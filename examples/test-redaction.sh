#!/usr/bin/env bash
#
# Test redaction by sending a request with sensitive data through the proxy.
#
# Usage:
#   1. Start the proxy:  contextio proxy --redact --port 4040
#   2. Run this script:  ./examples/test-redaction.sh
#
# The script sends a fake Anthropic API request containing PII and secrets,
# then shows what the proxy forwarded. Since there's no real upstream, the
# proxy will return a 502, but the capture file shows the redacted request.

PORT="${CONTEXTIO_PORT:-4040}"
URL="http://127.0.0.1:${PORT}/v1/messages"

echo "Sending test request to ${URL}..."
echo ""

curl -s -X POST "${URL}" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [
      {
        "role": "user",
        "content": "Hello, my name is John Smith. My email is john.smith@example.com and my SSN is 123-45-6789. I work at Project Atlas. My AWS key is AKIAIOSFODNN7EXAMPLE. My credit card number is 4111-1111-1111-1111 for payment. Please call me at (555) 123-4567. Here is my private key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBALRiMLAHudeSA/x3hB2f+2NRkJQm\n-----END RSA PRIVATE KEY-----"
      }
    ]
  }' 2>&1 || true

echo ""
echo ""
echo "Check the latest capture file in ~/.contextio/captures/ to see what was redacted."
echo "You can use: ls -t ~/.contextio/captures/ | head -1 | xargs -I{} cat ~/.contextio/captures/{} | python3 -m json.tool"
