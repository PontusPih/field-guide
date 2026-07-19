#!/usr/bin/env python3
"""OCR backend for the field guide's Scan tool (ocr.html/ocr.js).

RapidOCR only runs in Python, so this stays a separate service from the
static, client-side app on GitHub Pages. A POST /ocr endpoint runs the full
RapidOCR detection+recognition pipeline on an uploaded image and returns the
found boxes as JSON; no frontend is served from here.
"""
import json
import os
import resource
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from rapidocr_onnxruntime import RapidOCR

PORT = int(os.environ.get("PORT", 8642))

engine = RapidOCR()


def run_ocr(image_bytes):
    """Run the full RapidOCR pipeline on raw image bytes.

    Returns a JSON-serializable list of {box, text, score}, ordered as
    RapidOCR found them. Empty list if no text was detected.
    """
    mem_before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    result, _elapse = engine(image_bytes)
    mem_after = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    print(
        f"OCR: {len(image_bytes)} bytes in, peak RSS "
        f"{mem_before / 1024:.0f}MB -> {mem_after / 1024:.0f}MB"
    )
    if result is None:
        return []
    return [
        {
            "box": [[float(x), float(y)] for x, y in box],
            "text": text,
            "score": float(score),
        }
        for box, text, score in result
    ]


class Handler(BaseHTTPRequestHandler):
    def send_text(self, status, body):
        body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # No frontend lives here — just a health/liveness surface. "/" stays
        # a cheap 200 so it still works as PLAN.md's pre-flight/cold-start
        # ping (models are loaded before serve_forever() below, so any
        # response at all implies they're warm).
        if self.path == "/healthz":
            self.send_text(200, "ok")
        elif self.path == "/":
            self.send_text(200, "field guide OCR backend")
        else:
            self.send_error(404, "Not found")

    def send_cors_headers(self):
        # ocr.js runs on GitHub Pages, a different origin from this backend.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        if self.path != "/ocr":
            self.send_error(404, "Not found")
            return

        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            self.send_error(400, "Empty body")
            return
        image_bytes = self.rfile.read(length)

        try:
            detections = run_ocr(image_bytes)
        except Exception as e:
            self.send_error(400, f"OCR failed: {e}")
            return

        body = json.dumps(detections).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"OCR backend on http://0.0.0.0:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
