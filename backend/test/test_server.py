#!/usr/bin/env python3
"""Regression tests for the RapidOCR POC backend.

Runs against the real sample photos already in field-guide/, encoding the
detections found during the PaddleOCR/RapidOCR investigation. Run with:
    .venv/bin/python -m unittest discover -s test -v
"""
import io
import json
import socket
import sys
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from rapidocr_onnxruntime import RapidOCR  # noqa: E402

import server  # noqa: E402
from server import Handler, check_dimensions, run_ocr, start_workers  # noqa: E402

FIELD_GUIDE_DIR = Path(__file__).resolve().parent.parent.parent
IMG_1527 = FIELD_GUIDE_DIR / "IMG_1527.jpg"
IMG_1529 = FIELD_GUIDE_DIR / "IMG_1529.jpg"

# Crop of IMG_1527.jpg around its M8295 label (full box: x 998-1034, y
# 1594-1662), used wherever a test needs to stay under server.py's
# MAX_DIMENSION gate while still exercising real recognition. Margin chosen
# empirically: too tight (~30px) clips the label and finds nothing; too
# loose (a few hundred px) dilutes it among unrelated board texture and det
# picks up noise instead (found "tth" at 0.65 rather than M8295) -- an
# 80px margin recovers M8295 at the same 0.996 confidence as the full image.
M8295_CROP_BOX = (918, 1514, 1114, 1742)


def find(detections, text):
    return next((d for d in detections if d["text"] == text), None)


def crop_bytes(path, box, fmt="JPEG"):
    with Image.open(path) as img:
        buf = io.BytesIO()
        img.crop(box).save(buf, format=fmt)
        return buf.getvalue()


class CheckDimensionsTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(setattr, server, "MAX_DIMENSION", server.MAX_DIMENSION)

    def test_oversized_image_rejected_by_default(self):
        server.MAX_DIMENSION = 1200
        with self.assertRaises(server.ImageTooLargeError):
            check_dimensions(IMG_1527.read_bytes())  # 2400x1800

    def test_zero_disables_the_check(self):
        server.MAX_DIMENSION = 0
        check_dimensions(IMG_1527.read_bytes())  # would raise if the gate were still active

    def test_negative_also_disables_the_check(self):
        server.MAX_DIMENSION = -1
        check_dimensions(IMG_1527.read_bytes())


class RunOcrTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # run_ocr() takes an engine explicitly (each queue worker owns its
        # own in server.py); tests share one instance rather than reloading
        # models per test.
        cls.engine = RapidOCR()

    def test_img1527_reads_printed_label(self):
        detections = run_ocr(self.engine, IMG_1527.read_bytes())
        hit = find(detections, "M8295")
        self.assertIsNotNone(hit, f"expected M8295 in {detections}")
        self.assertGreater(hit["score"], 0.9)
        self.assertEqual(len(hit["box"]), 4)

    def test_img1529_reads_printed_labels(self):
        detections = run_ocr(self.engine, IMG_1529.read_bytes())
        texts = [d["text"] for d in detections]
        for expected in ("L0002", "L0010", "L0004"):
            self.assertIn(expected, texts)
        l0010_hits = [d for d in detections if d["text"] == "L0010"]
        self.assertGreater(find(detections, "L0002")["score"], 0.8)
        self.assertGreater(l0010_hits[0]["score"], 0.8)

    def test_blank_image_finds_nothing(self):
        blank = Image.new("RGB", (200, 200), (255, 255, 255))
        buf = io.BytesIO()
        blank.save(buf, format="PNG")
        detections = run_ocr(self.engine, buf.getvalue())
        self.assertEqual(detections, [])


class HttpEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # /ocr hands work off to the worker pool over a queue (see
        # server.py) -- without a worker running, submit_ocr() blocks on
        # result_queue.get() forever, since nothing is ever consuming
        # job_queue. main() normally starts this; the test server built here
        # bypasses main() so it must start one explicitly.
        start_workers(1)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join()

    def test_get_healthz_returns_ok(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/healthz")
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.read(), b"ok")

    def test_post_ocr_returns_expected_json(self):
        # A tile-sized crop, not the full photo -- real clients are expected
        # to tile large selections down to ~MAX_DIMENSION before POSTing
        # (see PLAN.md, "Tiled scanning for large images"), and server.py
        # now hard-rejects anything bigger (see the 413 test below).
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/ocr",
            data=crop_bytes(IMG_1527, M8295_CROP_BOX),
            method="POST",
        )
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers["Content-Type"], "application/json")
            detections = json.loads(resp.read())
        self.assertIsNotNone(find(detections, "M8295"))

    def test_post_oversized_image_returns_413(self):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/ocr",
            data=IMG_1527.read_bytes(),  # full 2400x1800, over MAX_DIMENSION
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 413)

    def test_post_body_over_upload_cap_returns_413(self):
        # The byte gate rejects on the declared Content-Length, before any read
        # or decode -- so a body well under MAX_DIMENSION's pixel gate but over
        # the byte cap is still refused. Shrunk here so the test needn't send
        # megabytes; do_POST reads the module global per request.
        self.addCleanup(setattr, server, "MAX_UPLOAD_BYTES", server.MAX_UPLOAD_BYTES)
        server.MAX_UPLOAD_BYTES = 100
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/ocr",
            data=b"x" * 500,
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 413)

    def test_post_invalid_content_length_returns_400(self):
        # urllib computes Content-Length itself, so a non-numeric value needs a
        # hand-built request over a raw socket.
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as s:
            s.sendall(
                b"POST /ocr HTTP/1.1\r\n"
                b"Host: localhost\r\n"
                b"Content-Length: notanumber\r\n"
                b"\r\n"
            )
            status_line = s.recv(4096).split(b"\r\n", 1)[0]
        self.assertIn(b"400", status_line)

    def test_handler_has_a_socket_timeout(self):
        # Guards against the http.server default (None = never time out), the
        # slowloris exposure SOCKET_TIMEOUT exists to close.
        self.assertIsNotNone(server.Handler.timeout)

    def _preflight(self, origin):
        # The preflight OPTIONS is where the CORS decision is observable without
        # running OCR (the Scan tool's image/png POST is non-simple, so a real
        # browser sends this first).
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/ocr",
            method="OPTIONS",
            headers={"Origin": origin, "Access-Control-Request-Method": "POST"},
        )
        with urllib.request.urlopen(req) as resp:
            return resp.status, resp.headers

    def _restrict_to(self, *origins):
        self.addCleanup(setattr, server, "ALLOWED_ORIGINS", server.ALLOWED_ORIGINS)
        self.addCleanup(setattr, server, "ALLOW_ANY_ORIGIN", server.ALLOW_ANY_ORIGIN)
        server.ALLOWED_ORIGINS = list(origins)
        server.ALLOW_ANY_ORIGIN = False

    def test_preflight_from_allowed_origin_is_reflected(self):
        self._restrict_to("https://good.example")
        status, headers = self._preflight("https://good.example")
        self.assertEqual(status, 204)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "https://good.example")
        self.assertIn("Origin", headers.get("Vary", ""))  # reflected origin must Vary

    def test_preflight_from_disallowed_origin_has_no_cors(self):
        self._restrict_to("https://good.example")
        status, headers = self._preflight("https://evil.example")
        self.assertEqual(status, 204)
        # No ACAO header -> the browser blocks the actual POST at the preflight.
        self.assertIsNone(headers.get("Access-Control-Allow-Origin"))

    def test_preflight_from_localhost_is_allowed_without_config(self):
        self._restrict_to("https://good.example")  # localhost deliberately not listed
        _, headers = self._preflight("http://localhost:5173")
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "http://localhost:5173")

    def test_star_allows_any_origin(self):
        self.addCleanup(setattr, server, "ALLOW_ANY_ORIGIN", server.ALLOW_ANY_ORIGIN)
        server.ALLOW_ANY_ORIGIN = True
        _, headers = self._preflight("https://anything.example")
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")

    def test_get_unknown_path_returns_404(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/nope")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 404)

    def test_post_empty_body_returns_400(self):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/ocr", data=b"", method="POST"
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 400)


if __name__ == "__main__":
    unittest.main()
