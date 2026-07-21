// Unit tests for detection display and overlap resolution.
// Run: `node --test` (or `node --test test/detections.test.js`)

import { test } from "node:test";
import assert from "node:assert/strict";
import { colorFor, canvasLabelFor, listLabelFor, selectNonOverlapping } from "../detections.js";

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

test("listLabelFor: recognized boxes carry the score to three decimals", () => {
  assert.equal(listLabelFor({ score: 0.8, text: "M7800" }), "M7800  (score 0.800)");
});

test("listLabelFor: unrecognized boxes match the canvas wording", () => {
  const pending = { score: null, attempted: false };
  const empty = { score: null, attempted: true };
  assert.equal(listLabelFor(pending), canvasLabelFor(pending));
  assert.equal(listLabelFor(empty), canvasLabelFor(empty));
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
