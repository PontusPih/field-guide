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
import io
import json
import os
import queue
import resource
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
from PIL import Image
from rapidocr_onnxruntime import RapidOCR

VERSION = "0.1.0"
# Render sets RENDER_GIT_COMMIT itself (build time and runtime), no Dockerfile
# involvement. GIT_COMMIT is the Dockerfile's own build-arg, for images built
# outside Render (see Dockerfile). Neither exists for a bare `python
# server.py` outside Docker, hence the final "unknown".
COMMIT_SHA = os.environ.get("RENDER_GIT_COMMIT", os.environ.get("GIT_COMMIT", "unknown"))[:7]

PORT = int(os.environ.get("PORT", 8642))
NUM_WORKERS = int(os.environ.get("OCR_WORKERS", 1))
OCR_QUEUE_MAXSIZE = int(os.environ.get("OCR_QUEUE_MAXSIZE", 2))

# Hard ceiling on uploaded image dimensions, checked before any RapidOCR work
# happens. ocr.js is expected to tile large selections into ~736px pieces
# client-side (see PLAN.md, "Tiled scanning for large images") and this is
# the backstop for that -- independent of whether the client's tiling logic
# is correct, since RapidOCR's own max_side_len resize alone isn't a safe
# hard limit for arbitrary aspect ratios (a very elongated image can get
# scaled below Det's internal 736px short-side floor by max_side_len, then
# scaled back *up* past max_side_len by that floor, defeating it).
MAX_DIMENSION = int(os.environ.get("OCR_MAX_DIMENSION", 1200))

# -1 matches RapidOCR/onnxruntime's own "unset, auto-detect" sentinel, so
# these are safe to pass through unconditionally. Auto-detect is unreliable
# in a container (os.cpu_count() sees the host's full core count, not any
# cgroup limit), so a real deployment should pin these explicitly to match
# the host it's actually running on.
INTRA_OP_THREADS = int(os.environ.get("OCR_INTRA_OP_THREADS", -1))
INTER_OP_THREADS = int(os.environ.get("OCR_INTER_OP_THREADS", -1))

# OpenCV has its own internal thread pool, separate from onnxruntime's and
# not affected by the two settings above. -1 leaves OpenCV's own default
# (auto-detected, same container caveat as above) untouched.
CV2_THREADS = int(os.environ.get("OCR_CV2_THREADS", -1))
if CV2_THREADS != -1:
    cv2.setNumThreads(CV2_THREADS)

job_queue = queue.Queue(maxsize=OCR_QUEUE_MAXSIZE)


class QueueFullError(Exception):
    pass


class ImageTooLargeError(Exception):
    pass


def check_dimensions(image_bytes):
    """Raise ImageTooLargeError if either side exceeds MAX_DIMENSION.

    Uses PIL's lazy header read (no pixel decode) so this stays cheap even
    for a hostile oversized upload.
    """
    with Image.open(io.BytesIO(image_bytes)) as img:
        width, height = img.size
    if max(width, height) > MAX_DIMENSION:
        raise ImageTooLargeError(
            f"image {width}x{height} exceeds the {MAX_DIMENSION}px max dimension"
        )


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
    engine = RapidOCR(
        intra_op_num_threads=INTRA_OP_THREADS, inter_op_num_threads=INTER_OP_THREADS
    )
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
            check_dimensions(image_bytes)
        except ImageTooLargeError as e:
            self.send_json_error(413, str(e))
            return
        except Exception as e:
            self.send_json_error(400, f"could not read image: {e}")
            return

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
        f"({NUM_WORKERS} OCR worker(s), max_dimension={MAX_DIMENSION}px, "
        f"intra_op={INTRA_OP_THREADS}, inter_op={INTER_OP_THREADS}, "
        f"cv2_threads={CV2_THREADS})"
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
