// Unit tests for detection display and overlap resolution.
// Run: `node --test` (or `node --test test/detections.test.js`)

import { test } from "node:test";
import assert from "node:assert/strict";
import { colorFor, canvasLabelFor, listLabelFor, glyphFor, selectNonOverlapping } from "../detections.js";

const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

test("colorFor: confidence bands", () => {
  assert.equal(colorFor({ score: 0.95 }), "#2ecc71"); // green
  assert.equal(colorFor({ score: 0.9 }), "#2ecc71");  // boundary is inclusive
  assert.equal(colorFor({ score: 0.7 }), "#f1c40f");  // yellow
  assert.equal(colorFor({ score: 0.5 }), "#f1c40f");  // boundary is inclusive
  assert.equal(colorFor({ score: 0.2 }), "#e74c3c");  // red
});

test("colorFor: a score of 0 is still a recognized box, not a pending one", () => {
  // 0 is falsy, so anything testing truthiness rather than != null would
  // wrongly colour this as "never tried".
  assert.equal(colorFor({ score: 0 }), "#e74c3c");
});

test("colorFor: pending versus tried-and-empty", () => {
  assert.equal(colorFor({ score: null, attempted: false }), "#888");
  assert.equal(colorFor({ score: null, attempted: true }), "#c0392b");
});

test("canvasLabelFor: recognized boxes show their text alone", () => {
  assert.equal(canvasLabelFor({ score: 0.8, text: "M7800" }), "M7800");
});

test("canvasLabelFor: unrecognized boxes describe their state", () => {
  assert.equal(canvasLabelFor({ score: null, attempted: false }), "not yet recognized");
  assert.equal(canvasLabelFor({ score: null, attempted: true }), "no text found");
});

test("canvasLabelFor: a region whose tiles errored stays distinct from both settled states", () => {
  const failed = { score: null, attempted: false, scanFailed: true };
  assert.equal(canvasLabelFor(failed), "failed — try again");
  // attempted wins if both were ever true at once -- a settled empty result
  // should never be overridden back into "retry" wording.
  assert.equal(canvasLabelFor({ score: null, attempted: true, scanFailed: true }), "no text found");
});

test("colorFor: a hand-entered label gets its own colour, overriding OCR state", () => {
  assert.equal(colorFor({ manual: true, text: "M7800", score: null }), "#3498db");
  // manual wins even over a leftover score, since the two never coexist by design
  assert.equal(colorFor({ manual: true, text: "M7800", score: 0.2 }), "#3498db");
});

test("canvasLabelFor/listLabelFor: a manual label shows its text; blank reads as no label", () => {
  const labelled = { manual: true, text: "M7800", score: null };
  assert.equal(canvasLabelFor(labelled), "M7800");
  assert.equal(listLabelFor(labelled), "M7800"); // manual shown by the glyph, not the text
  const negative = { manual: true, text: "", score: null };
  assert.equal(canvasLabelFor(negative), "(no label)");
  assert.equal(listLabelFor(negative), "(no label)");
});

test("selectNonOverlapping: a manual label outranks an overlapping higher OCR score", () => {
  const items = [
    { box: [[0, 0], [10, 0], [10, 10], [0, 10]], score: 0.99, text: "OCR" },
    { box: [[2, 2], [12, 2], [12, 12], [2, 12]], score: null, manual: true, text: "HAND" },
  ];
  const kept = selectNonOverlapping(items);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].text, "HAND"); // the verified label survives, not the auto guess
});

test("listLabelFor: recognized boxes show just the text; the score is on the glyph/tooltip", () => {
  assert.equal(listLabelFor({ score: 0.8, text: "M7800" }), "M7800");
});

test("glyphFor: pencil for a hand label, filled dot for OCR, hollow for anything unsettled", () => {
  assert.equal(glyphFor({ manual: true, text: "M7800" }), "✎");
  assert.equal(glyphFor({ score: 0.9, text: "M7800" }), "●");
  assert.equal(glyphFor({ score: null, attempted: true }), "○");   // empty
  assert.equal(glyphFor({ score: null, attempted: false }), "○");  // pending
});

test("listLabelFor: unrecognized boxes match the canvas wording", () => {
  const pending = { score: null, attempted: false };
  const empty = { score: null, attempted: true };
  const failed = { score: null, attempted: false, scanFailed: true };
  assert.equal(listLabelFor(pending), canvasLabelFor(pending));
  assert.equal(listLabelFor(empty), canvasLabelFor(empty));
  assert.equal(listLabelFor(failed), canvasLabelFor(failed));
});

test("selectNonOverlapping: keeps the higher-scored box from an overlapping pair", () => {
  const items = [
    { box: box(0, 0, 10, 10), score: 0.6, tag: "low" },
    { box: box(5, 5, 15, 15), score: 0.9, tag: "high" },
  ];
  const kept = selectNonOverlapping(items);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].tag, "high");
});

test("selectNonOverlapping: disjoint boxes are both kept regardless of score", () => {
  const items = [
    { box: box(0, 0, 10, 10), score: 0.1 },
    { box: box(100, 100, 110, 110), score: 0.9 },
  ];
  assert.equal(selectNonOverlapping(items).length, 2);
});

test("selectNonOverlapping: null score ranks lowest and loses on overlap", () => {
  const items = [
    { box: box(0, 0, 10, 10), score: null, tag: "pending" },
    { box: box(5, 5, 15, 15), score: 0.5, tag: "scored" },
  ];
  const kept = selectNonOverlapping(items);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].tag, "scored");
});

test("selectNonOverlapping: boxes touching at an edge do not count as overlapping", () => {
  // overlapArea is 0 for a shared edge, so both survive — the boundary that
  // decides whether two adjacent labels get merged into one.
  const items = [
    { box: box(0, 0, 10, 10), score: 0.9 },
    { box: box(10, 0, 20, 10), score: 0.5 },
  ];
  assert.equal(selectNonOverlapping(items).length, 2);
});

test("selectNonOverlapping: leaves the input array untouched", () => {
  const items = [
    { box: box(0, 0, 10, 10), score: 0.1 },
    { box: box(5, 5, 15, 15), score: 0.9 },
  ];
  const before = items.map((i) => i.score);
  selectNonOverlapping(items);
  assert.deepEqual(items.map((i) => i.score), before); // sorts a copy, not in place
});
