#!/usr/bin/env python3
"""Regression tests for the RapidOCR POC backend.

Runs against the real sample photos already in field-guide/, encoding the
detections found during the PaddleOCR/RapidOCR investigation. Run with:
    .venv/bin/python -m unittest discover -s test -v
"""
import io
import json
import sys
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server import Handler, run_ocr  # noqa: E402

FIELD_GUIDE_DIR = Path(__file__).resolve().parent.parent.parent
IMG_1527 = FIELD_GUIDE_DIR / "IMG_1527.jpg"
IMG_1529 = FIELD_GUIDE_DIR / "IMG_1529.jpg"


def find(detections, text):
    return next((d for d in detections if d["text"] == text), None)


class RunOcrTests(unittest.TestCase):
    def test_img1527_reads_printed_label(self):
        detections = run_ocr(IMG_1527.read_bytes())
        hit = find(detections, "M8295")
        self.assertIsNotNone(hit, f"expected M8295 in {detections}")
        self.assertGreater(hit["score"], 0.9)
        self.assertEqual(len(hit["box"]), 4)

    def test_img1529_reads_printed_labels(self):
        detections = run_ocr(IMG_1529.read_bytes())
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
        detections = run_ocr(buf.getvalue())
        self.assertEqual(detections, [])


class HttpEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join()

    def test_post_ocr_returns_expected_json(self):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/ocr",
            data=IMG_1527.read_bytes(),
            method="POST",
        )
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers["Content-Type"], "application/json")
            detections = json.loads(resp.read())
        self.assertIsNotNone(find(detections, "M8295"))

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
