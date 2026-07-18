"use strict";

// Unit tests for the pure view-transform/hit-test math used by poc.js.
// Run: `node --test rapidocr-poc/test/geometry.test.js`

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toSource, toDisplay, pointInPolygon, hitTestBoxes, distance, nearestWithinRadius,
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
