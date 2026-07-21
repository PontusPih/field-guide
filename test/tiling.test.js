// Unit tests for the OCR region tiling used by ocr.js.
// Run: `node --test` (or `node --test test/tiling.test.js`)

import { test } from "node:test";
import assert from "node:assert/strict";
import { axisTiles, tileGrid } from "../tiling.js";

test("axisTiles: region within singleCellFactor of tile size stays one cell", () => {
  // 800 <= 736 * 1.4 (1030.4) -- the near-tile-sized degenerate case that
  // motivated this threshold in the first place (see PLAN.md).
  assert.deepEqual(axisTiles(800, 736), [{ start: 0, length: 800 }]);
});

test("axisTiles: a region smaller than the tile is also a single cell", () => {
  assert.deepEqual(axisTiles(200, 736), [{ start: 0, length: 200 }]);
});

test("axisTiles: last cell snaps to the far edge, never a sliver", () => {
  const cells = axisTiles(1800, 736, { overlapFrac: 0.15 });
  assert.equal(cells.length, 3);
  assert.equal(cells[0].start, 0);
  assert.equal(cells[cells.length - 1].start + cells[cells.length - 1].length, 1800);
  for (const c of cells) assert.equal(c.length, 736); // every cell is full-size
});

test("axisTiles: cells step by tile * (1 - overlapFrac) until the snapped last one", () => {
  const cells = axisTiles(3000, 736, { overlapFrac: 0.15 });
  const step = Math.floor(736 * 0.85);
  for (let i = 0; i < cells.length - 2; i++) {
    assert.equal(cells[i + 1].start - cells[i].start, step);
  }
});

test("tileGrid: small region is a single tile matching its own size", () => {
  assert.deepEqual(tileGrid(400, 300, 736), [[0, 0, 400, 300]]);
});

test("tileGrid: rows and columns computed independently (elongated region)", () => {
  // Wide and short: many columns, one row.
  const wide = tileGrid(3000, 400, 736);
  assert.ok(wide.every(([, y0, , y1]) => y0 === 0 && y1 === 400));
  assert.ok(wide.length > 1);

  // Tall and narrow: one column, many rows.
  const tall = tileGrid(400, 3000, 736);
  assert.ok(tall.every(([x0, , x1]) => x0 === 0 && x1 === 400));
  assert.ok(tall.length > 1);
});

test("tileGrid: large region tiles both axes and covers the full area", () => {
  const boxes = tileGrid(1800, 1800, 736, { overlapFrac: 0.15 });
  assert.equal(boxes.length, 9); // 3x3
  const maxX = Math.max(...boxes.map((b) => b[2]));
  const maxY = Math.max(...boxes.map((b) => b[3]));
  assert.equal(maxX, 1800);
  assert.equal(maxY, 1800);
});
