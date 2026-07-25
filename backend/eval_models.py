#!/usr/bin/env python3
"""Dev benchmark: compare RapidOCR model combinations on the sample board photos.

Not part of the server -- a throwaway tool for choosing which det/rec tier and
version to pin (the memory-vs-accuracy tradeoff). Run ONE combo per invocation,
so getrusage's peak RSS (monotonic within a process) reflects just that combo:

    for c in v6-tiny v6-small v6-medium v5-mobile v5-server v4-mobile; do
        .venv/bin/python eval_models.py "$c"
    done

Bare `eval_models.py` (no arg) lists the combos. Runs on the full-resolution
sample photos, so the peak RSS is the worst case the 512MB tier must survive.
"""
import resource
import sys
import time
from pathlib import Path

from rapidocr import RapidOCR
from rapidocr.utils.typings import ModelType, OCRVersion

FG_DIR = Path(__file__).resolve().parent.parent
# (image, the printed labels we expect to read back) -- same fixtures the
# regression tests assert on.
CASES = [
    (FG_DIR / "IMG_1527.jpg", {"M8295"}),
    (FG_DIR / "IMG_1529.jpg", {"L0002", "L0010", "L0004"}),
]

# label -> RapidOCR(params=...). The model_type vocabulary differs by version:
# PP-OCRv6 has tiny/small/medium, PP-OCRv4/v5 have mobile/server.
COMBOS = {
    "v6-tiny":   {"Det.ocr_version": "PP-OCRv6", "Rec.ocr_version": "PP-OCRv6", "Det.model_type": "tiny",   "Rec.model_type": "tiny"},
    "v6-small":  {"Det.ocr_version": "PP-OCRv6", "Rec.ocr_version": "PP-OCRv6", "Det.model_type": "small",  "Rec.model_type": "small"},
    "v6-medium": {"Det.ocr_version": "PP-OCRv6", "Rec.ocr_version": "PP-OCRv6", "Det.model_type": "medium", "Rec.model_type": "medium"},
    "v5-mobile": {"Det.ocr_version": "PP-OCRv5", "Rec.ocr_version": "PP-OCRv5", "Det.model_type": "mobile", "Rec.model_type": "mobile"},
    "v5-server": {"Det.ocr_version": "PP-OCRv5", "Rec.ocr_version": "PP-OCRv5", "Det.model_type": "server", "Rec.model_type": "server"},
    "v4-mobile": {"Det.ocr_version": "PP-OCRv4", "Rec.ocr_version": "PP-OCRv4", "Det.model_type": "mobile", "Rec.model_type": "mobile"},
}


def rss_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMBOS:
        print("combos:", ", ".join(COMBOS))
        print("usage: eval_models.py <combo>")
        return 1

    name = sys.argv[1]
    # ocr_version/model_type must be passed as Enum instances (their .value is
    # the string used here).
    params = {}
    for k, v in COMBOS[name].items():
        params[k] = OCRVersion(v) if k.endswith("ocr_version") else ModelType(v) if k.endswith("model_type") else v
    engine = RapidOCR(params=params)
    for img, expected in CASES:
        t0 = time.time()
        result = engine(str(img))
        dt = time.time() - t0
        got = {t: s for t, s in zip(result.txts or (), result.scores or ()) if t in expected}
        miss = sorted(expected - set(got))
        scores = {t: round(s, 3) for t, s in got.items()}
        print(
            f"{name:10} {img.name:13} found {len(got)}/{len(expected)} {scores} "
            f"miss {miss or '-'} {dt:5.2f}s peakRSS {rss_mb():.0f}MB"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
