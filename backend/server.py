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
from urllib.parse import urlparse

import cv2
from PIL import Image
from rapidocr import RapidOCR
# The params-batch API validates model_type/ocr_version as Enum instances, not
# strings; their .value is the human string, so ModelType("tiny") round-trips.
from rapidocr.utils.typings import ModelType, OCRVersion

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
# The default (1200) is sized for Render's 512MB free tier and should stay
# the default everywhere memory is actually constrained -- it's not meant to
# be silently relaxed just because a request happens to come from a dev
# machine (the backend has no reliable way to tell). OCR_MAX_DIMENSION=0 (or
# any non-positive value) disables the check entirely -- an explicit local
# opt-out, e.g. for a dev machine with real memory headroom where ocr.js's
# own tile size is also raised (see backend/README.md).
MAX_DIMENSION = int(os.environ.get("OCR_MAX_DIMENSION", 1200))

# Hard ceiling on the request body size, enforced from the client-declared
# Content-Length *before* a single byte is read into memory. This is the
# backstop that keeps a hostile or malformed upload from being buffered in
# full on a memory-constrained instance (Render's 512MB free tier): a client
# is free to declare a multi-gigabyte Content-Length, and self.rfile.read()
# would otherwise allocate all of it before check_dimensions() -- which only
# inspects pixel dimensions, and only post-read -- ever runs. Sized well above
# a legitimate ~MAX_DIMENSION tile (a few hundred KB) but far below anything
# that threatens the heap. OCR_MAX_UPLOAD_BYTES=0 (or any non-positive value)
# disables the check, the same explicit local opt-out as OCR_MAX_DIMENSION --
# a dev machine sending large untiled images raises or disables both.
MAX_UPLOAD_BYTES = int(os.environ.get("OCR_MAX_UPLOAD_BYTES", 10 * 1024 * 1024))

# Per-connection socket timeout, in seconds. http.server leaves this None,
# which lets a client hold a worker thread open indefinitely by dribbling its
# headers or body one byte at a time (slowloris); ThreadingHTTPServer caps
# neither the thread count nor a connection's lifetime on its own, so a handful
# of stalled connections exhaust threads at near-zero cost. A finite timeout
# drops a connection that goes idle mid-request instead of pinning a thread.
SOCKET_TIMEOUT = int(os.environ.get("OCR_SOCKET_TIMEOUT", 30))

# Origins whose browser JS may read /ocr responses cross-origin (comma-separated
# in the env var), reflected back one at a time rather than answered with a
# blanket "*". CORS is browser-enforced only -- it cannot stop a non-browser
# client (curl, a script) from calling the endpoint -- but restricting it does
# defeat the browser-relayed abuse it otherwise enables: any web page could
# drive this backend from its visitors' browsers and read the result (free OCR,
# distributed across residential IPs to evade per-IP limits). The Scan tool's
# request is already non-simple (image/png body), so it is preflighted; an
# origin that fails the OPTIONS check never gets to send the POST at all.
# localhost / 127.0.0.1 on any port are always allowed, so a local dev frontend
# needs no override. Set OCR_ALLOWED_ORIGINS="*" to allow any origin (the prior
# blanket behavior; a deliberate opt-out). Real call-rate abuse is a rate-limit
# concern for the edge/proxy, not something CORS addresses -- see security.md.
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get("OCR_ALLOWED_ORIGINS", "https://field-guide.pdp8.se").split(",")
    if o.strip()
]
ALLOW_ANY_ORIGIN = "*" in ALLOWED_ORIGINS


def is_localhost_origin(origin):
    """True for an http(s)://localhost[:port] or 127.0.0.1 origin -- always
    allowed, so a dev frontend on any local port works without configuration."""
    try:
        return urlparse(origin).hostname in ("localhost", "127.0.0.1")
    except ValueError:
        return False

# -1 matches RapidOCR/onnxruntime's own "unset, auto-detect" sentinel; a value
# other than -1 is passed through to the engine (see build_engine()). Auto-detect
# is unreliable in a container (os.cpu_count() sees the host's full core count,
# not any cgroup limit), so a real deployment should pin these explicitly to
# match the host it's actually running on.
INTRA_OP_THREADS = int(os.environ.get("OCR_INTRA_OP_THREADS", -1))
INTER_OP_THREADS = int(os.environ.get("OCR_INTER_OP_THREADS", -1))

# Where RapidOCR 3.x reads/writes its model files (config key Global.model_root_dir).
# rapidocr 3.x downloads models on demand rather than bundling them; the Docker
# image pre-downloads them into this dir at build time and points here at
# runtime, so the running container needs no network to fetch models (see
# Dockerfile). Empty = use rapidocr's own default location (a local dev run just
# downloads to the package dir on first use).
MODEL_ROOT_DIR = os.environ.get("OCR_MODEL_ROOT_DIR", "")

# Model selection (RapidOCR 3.x config keys). Pinned to PP-OCRv4 "mobile" for
# det and rec -- rapidocr's own 3.x default is PP-OCRv6 "small", which on this
# app's small stylized board-label digits was both less accurate (misread
# M8295 as M2295) and heavier than v4; the eval_models.py sweep found v4-mobile
# the only combo reading every sample label correctly while staying fast and
# under the memory ceiling. It is also the same model family the retired
# rapidocr-onnxruntime 1.4.4 used, so this migration keeps the proven accuracy.
# Overridable via env to re-benchmark; model_type vocab depends on the version
# (PP-OCRv6: tiny/small/medium, PP-OCRv4/v5: mobile/server). The Docker bake and
# this runtime read the same env, so the baked models match what runs.
DET_MODEL_TYPE = os.environ.get("OCR_DET_MODEL_TYPE", "mobile")
REC_MODEL_TYPE = os.environ.get("OCR_REC_MODEL_TYPE", "mobile")
DET_OCR_VERSION = os.environ.get("OCR_DET_VERSION", "PP-OCRv4")
REC_OCR_VERSION = os.environ.get("OCR_REC_VERSION", "PP-OCRv4")
# Text-line orientation classifier. Board labels are rarely rotated 180°, so
# disabling it (OCR_USE_CLS=0) drops a model and a pipeline stage -- a
# memory/latency win worth measuring against any accuracy cost.
CLS_DISABLED = os.environ.get("OCR_USE_CLS", "").strip().lower() in ("0", "false", "no", "off")

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

    MAX_DIMENSION <= 0 disables the check entirely. Uses PIL's lazy header
    read (no pixel decode) so this stays cheap even for a hostile oversized
    upload.
    """
    if MAX_DIMENSION <= 0:
        return
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
    result = engine(image_bytes, use_cls=False) if CLS_DISABLED else engine(image_bytes)
    mem_after = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    print(
        f"[{threading.current_thread().name}] OCR: {len(image_bytes)} bytes in, "
        f"peak RSS {mem_before / 1024:.0f}MB -> {mem_after / 1024:.0f}MB"
    )
    # RapidOCR 3.x returns a RapidOCROutput with parallel boxes/txts/scores
    # (all None when nothing was detected), rather than 1.x's (list, elapse)
    # tuple of [box, text, score] rows.
    if result.boxes is None:
        return []
    return [
        {
            "box": [[float(x), float(y)] for x, y in box],
            "text": text,
            "score": float(score),
        }
        for box, text, score in zip(result.boxes, result.txts, result.scores)
    ]


def build_engine():
    # RapidOCR 3.x is configured through a params dict of dotted config keys,
    # not constructor kwargs. Only non-default values are passed, so the plain
    # RapidOCR() default path is used unless something is explicitly pinned.
    params = {}
    if MODEL_ROOT_DIR:
        params["Global.model_root_dir"] = MODEL_ROOT_DIR
    if INTRA_OP_THREADS != -1:
        params["EngineConfig.onnxruntime.intra_op_num_threads"] = INTRA_OP_THREADS
    if INTER_OP_THREADS != -1:
        params["EngineConfig.onnxruntime.inter_op_num_threads"] = INTER_OP_THREADS
    if DET_OCR_VERSION:
        params["Det.ocr_version"] = OCRVersion(DET_OCR_VERSION)
    if REC_OCR_VERSION:
        params["Rec.ocr_version"] = OCRVersion(REC_OCR_VERSION)
    if DET_MODEL_TYPE:
        params["Det.model_type"] = ModelType(DET_MODEL_TYPE)
    if REC_MODEL_TYPE:
        params["Rec.model_type"] = ModelType(REC_MODEL_TYPE)
    return RapidOCR(params=params) if params else RapidOCR()


def ocr_worker():
    engine = build_engine()
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
    # Applied to the connection socket by socketserver.StreamRequestHandler;
    # None (http.server's default) means "never time out" -- see SOCKET_TIMEOUT.
    timeout = SOCKET_TIMEOUT

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

    def allowed_cors_origin(self):
        """The Access-Control-Allow-Origin value to send for this request, or
        None to send no CORS headers at all. None covers both a request with no
        Origin (same-origin or a non-browser client, which needs no CORS) and a
        cross-origin caller not on the allow-list (whose browser is then denied
        the read)."""
        origin = self.headers.get("Origin")
        if origin is None:
            return None
        if ALLOW_ANY_ORIGIN:
            return "*"
        if origin in ALLOWED_ORIGINS or is_localhost_origin(origin):
            return origin
        return None

    def send_cors_headers(self):
        # ocr.js runs on a different origin from this backend, so /ocr and its
        # preflight carry CORS headers -- but only reflecting an allow-listed
        # origin, not a blanket "*". See ALLOWED_ORIGINS.
        allow = self.allowed_cors_origin()
        if allow is None:
            return
        self.send_header("Access-Control-Allow-Origin", allow)
        # A reflected (non-"*") origin means the response varies by request
        # Origin; without this a shared cache could serve one origin's allowed
        # response to another.
        if allow != "*":
            self.send_header("Vary", "Origin")
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

        # Parsed before reading, and the body size gated on it, so an oversized
        # or malformed upload is rejected without ever being buffered. A body
        # that lies (fewer bytes than declared) is bounded by the socket
        # timeout above, not by this length.
        length_header = self.headers.get("Content-Length")
        try:
            length = int(length_header) if length_header is not None else 0
        except ValueError:
            self.send_json_error(400, "invalid Content-Length header")
            return
        if length == 0:
            self.send_json_error(400, "empty body")
            return
        if MAX_UPLOAD_BYTES > 0 and length > MAX_UPLOAD_BYTES:
            self.send_json_error(
                413, f"body of {length} bytes exceeds the {MAX_UPLOAD_BYTES}-byte upload limit"
            )
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
    origins = "* (any)" if ALLOW_ANY_ORIGIN else ", ".join(ALLOWED_ORIGINS) + " (+localhost)"
    print(
        f"OCR backend v{VERSION} ({COMMIT_SHA}) on http://0.0.0.0:{PORT} "
        f"({NUM_WORKERS} OCR worker(s), max_dimension={MAX_DIMENSION}px, "
        f"max_upload={MAX_UPLOAD_BYTES}B, socket_timeout={SOCKET_TIMEOUT}s, "
        f"intra_op={INTRA_OP_THREADS}, inter_op={INTER_OP_THREADS}, "
        f"cv2_threads={CV2_THREADS}, model_root_dir={MODEL_ROOT_DIR or '(default)'})\n"
        f"  CORS allowed origins: {origins}"
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
