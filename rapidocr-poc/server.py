#!/usr/bin/env python3
"""Local backend for the RapidOCR POC.

Serves the static frontend (poc.html/poc.js) and a POST /ocr endpoint that
runs the full RapidOCR detection+recognition pipeline on an uploaded image
and returns the found boxes as JSON.
"""
import json
import os
import resource
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from rapidocr_onnxruntime import RapidOCR

STATIC_DIR = Path(__file__).resolve().parent
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


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def do_GET(self):
        if self.path == "/healthz":
            body = b"ok"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/":
            self.path = "/poc.html"
        super().do_GET()

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
        self.end_headers()
        self.wfile.write(body)


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"RapidOCR POC server on http://0.0.0.0:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
