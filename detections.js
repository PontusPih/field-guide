// What a detection looks like and how overlapping ones are resolved.
//
// A detection is `{ id, box, text, score, attempted, source }`. Three states
// matter throughout, and every function here reads them the same way:
//
//   score != null              recognized; score is the confidence
//   score == null, !attempted  drawn but not yet sent for recognition
//   score == null, attempted   sent, and the backend found no text
//
// Pure and DOM-free, so it is testable with `node --test`. Canvas and rect
// math live in geometry.js; this is the layer above it.

import { boundsOf, overlapArea } from "./geometry.js";

// Outline colour, keyed to confidence: green >= 0.9, yellow >= 0.5, red below.
function colorFor(detection) {
  if (detection.score != null) {
    if (detection.score >= 0.9) return "#2ecc71";
    if (detection.score >= 0.5) return "#f1c40f";
    return "#e74c3c";
  }
  return detection.attempted ? "#c0392b" : "#888"; // tried-and-failed vs never-tried
}

// Canvas hover label: text only. The score shows in the results list.
function canvasLabelFor(detection) {
  if (detection.score != null) return detection.text;
  return detection.attempted ? "no text found" : "not yet recognized";
}

function listLabelFor(detection) {
  if (detection.score != null) return `${detection.text}  (score ${detection.score.toFixed(3)})`;
  return detection.attempted ? "no text found" : "not yet recognized";
}

// Greedy highest-score-first selection: keep an item unless its box's bounds
// overlap one already kept. `items` is any array of `{box, score}` (score may
// be null/undefined, ranked lowest). Backs ocr.js's "Prune overlapping".
function selectNonOverlapping(items) {
  const sorted = [...items].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const kept = [];
  for (const item of sorted) {
    const bounds = boundsOf(item.box);
    const overlapsKept = kept.some((k) => overlapArea(bounds, boundsOf(k.box)) > 0);
    if (!overlapsKept) kept.push(item);
  }
  return kept;
}

export { colorFor, canvasLabelFor, listLabelFor, selectNonOverlapping };
