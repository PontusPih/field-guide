// What a detection looks like and how overlapping ones are resolved.
//
// A detection is `{ id, box, text, score, attempted, scanFailed, manual, source }`.
// The states that matter, and every function here reads them the same way:
//
//   manual                           text was entered/corrected by hand --
//                                    authoritative, sticky through edits and
//                                    rescans (score stays null; text may be ""
//                                    to mark a region as holding no label)
//   score != null                    recognized by OCR; score is the confidence
//   score == null, !attempted        drawn but not yet sent for recognition
//   score == null, !attempted,
//                  scanFailed        sent, a tile errored, none found text --
//                                    stays retryable, not a settled result
//   score == null, attempted         sent, and the backend found no text
//
// `manual` is checked first everywhere: a hand-entered label overrides whatever
// OCR state the box was in. `scanFailed` is manual-region-only (see ocr.js's
// ensureWorkerRunning) and is always paired with `!attempted`: a region either
// settles as "no text found" or stays open for retry, never both.
//
// Pure and DOM-free, so it is testable with `node --test`. Canvas and rect
// math live in geometry.js; this is the layer above it.

import { boundsOf, overlapArea } from "./geometry.js";

// Outline colour. Hand-entered labels get their own blue so the labeling pass
// can tell them from OCR reads at a glance; otherwise keyed to confidence:
// green >= 0.9, yellow >= 0.5, red below.
function colorFor(detection) {
  if (detection.manual) return "#3498db";
  if (detection.score != null) {
    if (detection.score >= 0.9) return "#2ecc71";
    if (detection.score >= 0.5) return "#f1c40f";
    return "#e74c3c";
  }
  return detection.attempted ? "#c0392b" : "#888"; // tried-and-failed vs never-tried
}

// Canvas hover label: text only. The score shows in the results list.
function canvasLabelFor(detection) {
  if (detection.manual) return detection.text || "(no label)";
  if (detection.score != null) return detection.text;
  if (detection.attempted) return "no text found";
  return detection.scanFailed ? "failed — try again" : "not yet recognized";
}

// Results-list text. The numeric score is not shown here -- the status glyph's
// colour carries the confidence band, and the exact score is on the row's
// tooltip -- so a recognized box reads as its text alone, like the canvas label.
function listLabelFor(detection) {
  if (detection.manual) return detection.text || "(no label)";
  if (detection.score != null) return detection.text;
  if (detection.attempted) return "no text found";
  return detection.scanFailed ? "failed — try again" : "not yet recognized";
}

// Compact status glyph for the results list: a pencil for a hand-entered label,
// a filled dot for an OCR read (coloured by confidence via colorFor), a hollow
// dot for anything not yet settled (pending, empty, or failed -- colour tells
// those apart).
function glyphFor(detection) {
  if (detection.manual) return "✎";
  if (detection.score != null) return "●";
  return "○";
}

// Greedy best-first selection: keep an item unless its box's bounds overlap one
// already kept. `items` is any array of `{box, score, manual}`. Hand-entered
// labels outrank every OCR score, so a verified label is never pruned in favour
// of an overlapping auto guess; among the rest, higher score wins, null lowest.
// Backs ocr.js's "Prune overlapping".
function selectNonOverlapping(items) {
  const rank = (x) => (x.manual ? 2 : x.score ?? -1);
  const sorted = [...items].sort((a, b) => rank(b) - rank(a));
  const kept = [];
  for (const item of sorted) {
    const bounds = boundsOf(item.box);
    const overlapsKept = kept.some((k) => overlapArea(bounds, boundsOf(k.box)) > 0);
    if (!overlapsKept) kept.push(item);
  }
  return kept;
}

export { colorFor, canvasLabelFor, listLabelFor, glyphFor, selectNonOverlapping };
