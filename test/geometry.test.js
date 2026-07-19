"use strict";

// Unit tests for the pure view-transform/hit-test math used by ocr.js.
// Run: `node --test` (or `node --test test/geometry.test.js`)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toSource, toDisplay, pointInPolygon, hitTestBoxes, distance, nearestWithinRadius,
  boundsOf, overlapArea,
} from "../geometry.js";

test("toSource/toDisplay round-trip at scale 1, no offset", () => {
  const view = { scale: 1, x: 0, y: 0 };
  const p = { x: 42, y: 17 };
  assert.deepEqual(toSource(p, view), { x: 42, y: 17 });
  assert.deepEqual(toDisplay(p, view), { x: 42, y: 17 });
});

test("toSource/toDisplay account for zoom and pan offset", () => {
  const view = { scale: 2, x: 100, y: 50 };
  // display (0,0) should map to source (view.x, view.y)
  assert.deepEqual(toSource({ x: 0, y: 0 }, view), { x: 100, y: 50 });
  // a display point further out scales down by 1/scale before adding the offset
  assert.deepEqual(toSource({ x: 20, y: 10 }, view), { x: 110, y: 55 });
});

test("toDisplay is the exact inverse of toSource", () => {
  const view = { scale: 3.5, x: 12, y: -8 };
  const sourcePoint = { x: 200, y: 340 };
  const displayPoint = toDisplay(sourcePoint, view);
  const roundTripped = toSource(displayPoint, view);
  assert.ok(Math.abs(roundTripped.x - sourcePoint.x) < 1e-9);
  assert.ok(Math.abs(roundTripped.y - sourcePoint.y) < 1e-9);
});

test("toDisplay applies the letterbox offset (image narrower than canvas)", () => {
  const view = { scale: 1, x: 0, y: 0, offsetX: 50, offsetY: 0 };
  // source (0,0), which sits at the image's edge, should render 50px in
  // from the canvas's left edge — not flush against it.
  assert.deepEqual(toDisplay({ x: 0, y: 0 }, view), { x: 50, y: 0 });
});

test("toSource subtracts the letterbox offset before unscaling", () => {
  const view = { scale: 2, x: 0, y: 0, offsetX: 50, offsetY: 20 };
  // a click exactly on the offset origin should land on source (0,0), not
  // somewhere shifted by the letterbox bar's width.
  assert.deepEqual(toSource({ x: 50, y: 20 }, view), { x: 0, y: 0 });
});

test("toSource/toDisplay round-trip correctly with a letterbox offset", () => {
  const view = { scale: 1.7, x: 30, y: 5, offsetX: 40, offsetY: 15 };
  const sourcePoint = { x: 120, y: 90 };
  const roundTripped = toSource(toDisplay(sourcePoint, view), view);
  assert.ok(Math.abs(roundTripped.x - sourcePoint.x) < 1e-9);
  assert.ok(Math.abs(roundTripped.y - sourcePoint.y) < 1e-9);
});

test("offsetX/offsetY default to 0 when absent (no letterbox)", () => {
  const view = { scale: 2, x: 10, y: 10 };
  assert.deepEqual(toDisplay({ x: 10, y: 10 }, view), { x: 0, y: 0 });
});

test("pointInPolygon: inside and outside an axis-aligned rectangle", () => {
  const rect = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(pointInPolygon({ x: 5, y: 5 }, rect), true);
  assert.equal(pointInPolygon({ x: 15, y: 5 }, rect), false);
  assert.equal(pointInPolygon({ x: -1, y: 5 }, rect), false);
});

test("pointInPolygon: works on a tilted quadrilateral (detector-style box)", () => {
  // a box tilted slightly clockwise, similar to real RapidOCR detection output
  const quad = [[10, 2], [50, 0], [52, 20], [12, 22]];
  assert.equal(pointInPolygon({ x: 30, y: 10 }, quad), true);
  assert.equal(pointInPolygon({ x: 30, y: 30 }, quad), false);
});

test("hitTestBoxes returns -1 when nothing is hit", () => {
  const boxes = [{ box: [[0, 0], [10, 0], [10, 10], [0, 10]] }];
  assert.equal(hitTestBoxes({ x: 100, y: 100 }, boxes), -1);
});

test("hitTestBoxes returns the topmost (last) box when boxes overlap", () => {
  const boxes = [
    { box: [[0, 0], [10, 0], [10, 10], [0, 10]] },
    { box: [[5, 5], [15, 5], [15, 15], [5, 15]] },
  ];
  // (7,7) is inside both — the later box in the array should win
  assert.equal(hitTestBoxes({ x: 7, y: 7 }, boxes), 1);
  // (2,2) is only inside the first box
  assert.equal(hitTestBoxes({ x: 2, y: 2 }, boxes), 0);
});

test("distance measures a simple 3-4-5 triangle", () => {
  assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
});

test("nearestWithinRadius picks the closest candidate inside the radius", () => {
  const candidates = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10.5, y: 0 }];
  assert.equal(nearestWithinRadius({ x: 10, y: 1 }, candidates, 5), 1);
});

test("nearestWithinRadius returns -1 when everything is out of range", () => {
  const candidates = [{ x: 100, y: 100 }];
  assert.equal(nearestWithinRadius({ x: 0, y: 0 }, candidates, 5), -1);
});

test("boundsOf computes the axis-aligned bounding box of a tilted quad", () => {
  const quad = [[10, 2], [50, 0], [52, 20], [12, 22]];
  assert.deepEqual(boundsOf(quad), { minX: 10, minY: 0, maxX: 52, maxY: 22 });
});

test("overlapArea is 0 for disjoint rects", () => {
  const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const b = { minX: 20, minY: 20, maxX: 30, maxY: 30 };
  assert.equal(overlapArea(a, b), 0);
});

test("overlapArea is 0 for rects that only touch at an edge", () => {
  const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const b = { minX: 10, minY: 0, maxX: 20, maxY: 10 };
  assert.equal(overlapArea(a, b), 0);
});

test("overlapArea computes the intersection area of overlapping rects", () => {
  const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const b = { minX: 5, minY: 5, maxX: 15, maxY: 15 };
  assert.equal(overlapArea(a, b), 25); // 5x5 overlap square
});

test("overlapArea handles one rect fully containing another", () => {
  const outer = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const inner = { minX: 10, minY: 10, maxX: 20, maxY: 20 };
  assert.equal(overlapArea(outer, inner), 100); // inner's full 10x10 area
});
