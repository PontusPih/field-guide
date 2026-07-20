#!/usr/bin/env python3
"""OCR backend for the field guide's Scan tool (ocr.html/ocr.js).

RapidOCR only runs in Python, so this stays a separate service from the
static, client-side app on GitHub Pages. A POST /ocr endpoint runs the full
RapidOCR detection+recognition pipeline on an uploaded image and returns the
found boxes as JSON; no frontend is served from here.

OCR requests are handed to a small pool of persistent worker threads over a
queue, rather than run inline on the request-handling thread. Each worker
loads its own RapidOCR() once and reuses it for every job, which keeps
glibc's per-thread malloc arenas stable across requests instead of growing
one on every new thread (see backend/README.md). Health checks and other
lightweight requests are served immediately by ThreadingHTTPServer even
while a scan is in progress, since the heavy allocation now happens only on
the dedicated worker thread(s), never on a request thread.
"""
import json
import os
import queue
import resource
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from rapidocr_onnxruntime import RapidOCR

VERSION = "0.1.0"
# Render sets this automatically (build time and runtime) from the connected
# repo's HEAD; nothing to plumb through the Dockerfile. Off Render (local
# runs, other hosts) there's no .git in the image to fall back on, so this
# just reads "unknown".
COMMIT_SHA = os.environ.get("RENDER_GIT_COMMIT", "unknown")[:7]

PORT = int(os.environ.get("PORT", 8642))
NUM_WORKERS = int(os.environ.get("OCR_WORKERS", 1))
OCR_QUEUE_MAXSIZE = int(os.environ.get("OCR_QUEUE_MAXSIZE", 2))

job_queue = queue.Queue(maxsize=OCR_QUEUE_MAXSIZE)


class QueueFullError(Exception):
    pass


def run_ocr(engine, image_bytes):
    """Run the full RapidOCR pipeline on raw image bytes.

    Returns a JSON-serializable list of {box, text, score}, ordered as
    RapidOCR found them. Empty list if no text was detected.
    """
    mem_before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    result, _elapse = engine(image_bytes)
    mem_after = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    print(
        f"[{threading.current_thread().name}] OCR: {len(image_bytes)} bytes in, "
        f"peak RSS {mem_before / 1024:.0f}MB -> {mem_after / 1024:.0f}MB"
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


def ocr_worker():
    engine = RapidOCR()
    while True:
        image_bytes, result_queue = job_queue.get()
        try:
            result_queue.put(("ok", run_ocr(engine, image_bytes)))
        except Exception as e:
            result_queue.put(("error", str(e)))


def submit_ocr(image_bytes):
    """Queue image_bytes for OCR and block until a worker finishes it.

    Raises QueueFullError immediately, without blocking, if OCR_QUEUE_MAXSIZE
    requests are already waiting on a worker.
    """
    result_queue = queue.Queue(maxsize=1)
    try:
        job_queue.put_nowait((image_bytes, result_queue))
    except queue.Full:
        raise QueueFullError("OCR queue is full, try again shortly")
    status, payload = result_queue.get()
    if status == "error":
        raise RuntimeError(payload)
    return payload


def start_workers(n):
    for i in range(n):
        threading.Thread(
            target=ocr_worker, name=f"ocr-worker-{i}", daemon=True
        ).start()


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

    def send_json_error(self, status, message, retry_after=None):
        # self.send_error() never sends CORS headers, so a cross-origin
        # caller (ocr.js on GitHub Pages) can't read the status code at all
        # -- fetch() just rejects with an opaque network error. Build error
        # responses manually so /ocr failures are visible to the frontend.
        body = json.dumps({"error": message}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if retry_after is not None:
            self.send_header("Retry-After", str(retry_after))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

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
            detections = submit_ocr(image_bytes)
        except QueueFullError as e:
            self.send_json_error(503, str(e), retry_after=5)
            return
        except Exception as e:
            self.send_json_error(400, f"OCR failed: {e}")
            return

        body = json.dumps(detections).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)


def main():
    start_workers(NUM_WORKERS)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(
        f"OCR backend v{VERSION} ({COMMIT_SHA}) on http://0.0.0.0:{PORT} "
        f"({NUM_WORKERS} OCR worker(s))"
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
