# Ground-truth labels — format & eval contract

The bridge between two tools that must not drift:

- **Producer** — the Scan tool (`ocr.js`), which after the label-editing and multi-image
  work can export a human-verified `{image → boxes → correct label}` dataset.
- **Consumer** — the model evaluation harness (an extension of `backend/eval_models.py`),
  which runs every candidate OCR model over the labeled images and scores each against
  this ground truth.

This file fixes the JSON shape and the matching rules before either side is built. It is a
spec, not code; the values in examples are illustrative.

## The file

- **One JSON file**, `hasso/labels.json` (the eval set lives in `hasso/`). A single file,
  not per-image sidecars, so the dataset is one reviewable, diffable artifact.
- Written by the Scan tool's "Download labels" action and committed to the repo.
- **Re-labeling is idempotent by `sha256`:** re-exporting an image replaces that image's
  entry wholesale (its `boxes` list is authoritative, not merged box-by-box). Images absent
  from a later export are left untouched in the file — the tool merges its current images
  into the existing file rather than overwriting it.

## Schema

```json
{
  "version": 1,
  "created": "2026-07-25T22:40:00Z",
  "image_dir": "hasso",
  "images": [
    {
      "file": "IMG_0579.jpg",
      "sha256": "9f2b…64 hex chars…",
      "rotation": 90,
      "width": 1800,
      "height": 2400,
      "boxes": [
        { "box": [[812, 1504], [1002, 1490], [1010, 1560], [820, 1574]],
          "label": "M8295", "origin": "manual" },
        { "box": [[430, 620], [560, 618], "…"], "label": "", "origin": "manual" }
      ]
    }
  ]
}
```

Field by field:

| Field | Meaning |
| --- | --- |
| `version` | Schema version (int). Bump on any breaking change; consumer checks it. |
| `created` | ISO-8601 UTC timestamp the browser stamps at export. |
| `image_dir` | Repo-relative directory the `file`s live in. The eval resolves `image_dir/file`. |
| `images[].file` | Filename within `image_dir`. Human-facing source identity, and what "source noted in export" (PLAN.md multi-image) prints. |
| `images[].sha256` | Hex digest of the image bytes. Stable identity — the re-label key and the dedup key, independent of filename. Already computed for session persistence. |
| `images[].rotation` | `0\|90\|180\|270` applied while labeling. **Boxes are in this rotated space.** The eval rotates the image by `rotation` before running a model, so it matches what the human saw. |
| `images[].width`/`height` | Pixel dimensions of the image **at `rotation`**. Makes the box coordinate space unambiguous and lets the consumer normalize to fractions if it wants resolution independence. |
| `boxes[].box` | Four `[x, y]` points in the rotated-image pixel space — the same "source coords" the Scan tool stores today. |
| `boxes[].label` | The correct text. **Empty string = a negative box:** the user marks a region that holds no readable module label, to test false-positive suppression. Tools may omit negatives if not used. |
| `boxes[].origin` | `"auto"` (OCR read it correctly and the user accepted) or `"manual"` (the user typed or corrected it). Provenance only — both are authoritative ground truth. |

## Matching rules (the eval's contract)

For each image entry, the eval rotates the image by `rotation`, runs a model, and gets
predicted boxes with text + score. Then, per image:

1. **Locate.** Reduce each 4-point box (predicted and ground-truth) to its axis-aligned
   bounding box. Match predicted↔ground-truth greedily by **IoU ≥ 0.5**. If a ground-truth
   box has no IoU match, fall back to "a predicted box whose centroid lies inside the
   ground-truth bbox" — tolerates tight or rotated boxes that clip the IoU.
2. **Read.** For a located pair, compare text with `norm(a) == norm(b)` where
   `norm(s) = "".join(s.split()).upper()` (drop all whitespace, upper-case). Module numbers
   carry no internal spaces, so this is safe and forgiving of stray OCR spacing/case.
3. **Classify** each positive ground-truth box:
   - **HIT** — located and text correct.
   - **MISREAD** — located but text wrong (e.g. `M8295` → `M2295`).
   - **MISS** — not located (detection failure).
   Predicted boxes matching no ground-truth box are **FALSE_POSITIVE**; a predicted box
   overlapping a negative (`label: ""`) box with any text is a **FALSE_POSITIVE_ON_NEGATIVE**.

**Per-model metrics** (aggregated over all images):

- `read_accuracy` = HIT / total positive ground-truth boxes — the end-to-end number that
  decides the model.
- `detection_recall` = (HIT + MISREAD) / total positive — how often the box was found at all.
- `misread_rate` = MISREAD / (HIT + MISREAD).
- `false_positives` per image (incl. on negatives).
- `median_latency` and `peak_rss` per image, as in the current `eval_models.py`.

A model is only worth offering to the user if `read_accuracy` beats the pinned `v4-mobile`
by a meaningful margin at acceptable latency/memory.

### Location-free text cross-check

Alongside the box matching above, compare the two **bags** (multisets) of texts per image —
ground-truth labels vs predicted texts, each through `norm()`, positives only. Bag, not set,
because a real pile can hold several of the same board, so duplicates count:
`|A ∩ B| = Σ over distinct text t of min(count_A(t), count_B(t))`.

- `text_recall` = |GT ∩ pred| / |GT| — were the right labels read *anywhere* on the image?
- `text_precision` = |GT ∩ pred| / |pred| — did it invent labels that aren't there?

This exists to **separate recognition from localization.** The location-based
`detection_recall` counts a box as failed both when the model can't read it *and* when the
model reads it correctly but its box doesn't overlap the ground-truth box (poor
localization, too-strict IoU, or approximate ground-truth boxes). So the diagnostic pairing:

- **high `text_recall` + low `detection_recall`** → the model is reading the right labels but
  the boxes aren't lining up. That's an *overlap/localization* signal — loosen the IoU
  threshold or inspect box shapes, don't blame the model's reading.
- **low `text_recall`** → a genuine *recognition* failure, independent of any box geometry.

(Optional refinement: character-level edit distance between a MISREAD's predicted text and
its ground-truth label grades *how* wrong a misread is — a one-character `M8295`→`M2295` slip
versus garbage — but the bag comparison above is the primary cross-check.)

## Responsibilities

- **Producer (`ocr.js`)** guarantees: `sha256` matches the bytes in `image_dir/file`;
  `box` coordinates are in the `rotation` space with the stated `width`/`height`; every box
  has a `label` (possibly `""`) and an `origin`. It merges into an existing `labels.json` by
  `sha256`.
- **Consumer (eval harness)** guarantees: it checks `version`; rotates each image by
  `rotation` before inference; applies the matching rules above unchanged; and never mutates
  `labels.json`.

## Open questions (decide before implementation)

- **Negatives.** Include negative (`label: ""`) boxes at all, or only positive labels? They
  make false-positive suppression measurable but add labeling effort. Default: support the
  field, don't require it.
- **IoU threshold.** `0.5` is the standard start; board labels are small, so this may need
  tuning against real data once labeling has produced some.
- **`origin` weighting.** The eval treats `auto` and `manual` equally. Revisit only if
  `auto`-accepted boxes prove less trustworthy than hand-typed ones.
