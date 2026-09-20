#!/usr/bin/env python3
"""Synthetic provider for NOT-177 probe 10. Answers EVERY request with a fixed status.

usage: mock-provider.py <port> <status> [retry-after-seconds]

The response body is invented (`{"error": {...}}`); Meta's real error bodies were never
observed, so only the client's reaction to the status/Retry-After is evidence.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT, STATUS = int(sys.argv[1]), int(sys.argv[2])
RETRY_AFTER = sys.argv[3] if len(sys.argv) > 3 else None


class Handler(BaseHTTPRequestHandler):
    def _respond(self):
        length = int(self.headers.get("content-length") or 0)
        if length:
            self.rfile.read(length)
        body = json.dumps({"error": {"message": "synthetic mock error", "code": STATUS}}).encode()
        self.send_response(STATUS)
        self.send_header("content-type", "application/json")
        if RETRY_AFTER:
            self.send_header("retry-after", RETRY_AFTER)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

    do_GET = do_POST = do_PUT = do_DELETE = _respond


HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
