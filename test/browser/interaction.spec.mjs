// Characterization spec for direct pointer interaction on the canvas: draw,
// select/deselect, resize, move, and the three ways to delete a box. Written
// against the current, working behaviour of ocr.js -- pinning it down before
// the deferred restructure (state module + subscribe/emit) touches anything,
// per refactor-plan.md's "Deferred" section.
//
// Box geometry and recognition state are only observable through the
// persisted session (see fixtures.mjs's readState) or the rendered DOM; there
// is no other window into ocr.js's module-scoped `detections`.
//
// One behaviour worth calling out because it is easy to assume otherwise:
// drawing a box leaves it selected (ocr.js's pointerup handler for "draw" sets
// selectedId to the box just pushed). A click on an already-selected box's
// body deselects it -- it does not re-select. The tests below draw and then
// exercise select state from there, rather than clicking to "select" a box
// that is already selected.
//
// Run: `npm run test:browser`

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { launch, findChrome } from "./harness.mjs";
import {
  bootApp, loadSyntheticPhoto, stageRect, dragFrac, clickFrac, readState, boundsOf,
} from "./fixtures.mjs";

const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
const isSelected = (page) => page.evaluate(`!document.getElementById("deleteSelected").disabled`);

const chromePath = await findChrome();

describe("canvas interaction", { skip: chromePath ? false : "no Chrome found" }, () => {
  let browser;
  let page;
  let origin;
  let rect;

  before(async () => {
    browser = await launch();
    page = browser.page;
    origin = browser.origin;
  });

  after(async () => {
    await browser?.close();
  });

  // Fresh session and photo before every test, so one test's drawn boxes
  // can't leak state into the next.
  beforeEach(async () => {
    await bootApp(page, origin, {});
    await loadSyntheticPhoto(page);
    rect = await stageRect(page);
  });

  // Box spans fractional (0.15, 0.15)-(0.45, 0.35) of the stage; (0.30, 0.25)
  // is its center, (0.30, ~0.128) is where its delete-X floats (see
  // deleteHotspotDisplayPos: top-center, 14 display px above the box).
  async function drawBox() {
    await dragFrac(page, rect, 0.15, 0.15, 0.45, 0.35);
    await page.waitFor(`document.querySelectorAll("#results li").length === 1`, "box to be drawn");
  }

  test("a plain drag on empty canvas draws a new pending box, already selected", async () => {
    await drawBox();
    const state = await readState(page);
    assert.equal(state.detections.length, 1);
    assert.equal(state.detections[0].score, null, "a freshly drawn box has no score yet");
    assert.equal(state.detections[0].attempted, undefined, "and has never been sent for recognition");
    assert.equal(state.detections[0].source, "manual");
    assert.equal(await isSelected(page), true, "drawing a box should leave it selected");

    const label = await page.evaluate(
      `document.querySelector("#results .result-label").textContent`);
    assert.match(label, /not yet recognized/);
  });

  test("clicking a selected box's body deselects it; clicking again reselects", async () => {
    await drawBox();
    assert.equal(await isSelected(page), true, "test setup: draw should leave it selected");

    await clickFrac(page, rect, 0.30, 0.25);
    assert.equal(await isSelected(page), false, "a click on the selected box's body should deselect it");

    await clickFrac(page, rect, 0.30, 0.25);
    assert.equal(await isSelected(page), true, "clicking the now-unselected box should select it");
  });

  test("clicking empty canvas deselects the current selection", async () => {
    await drawBox();
    assert.equal(await isSelected(page), true, "test setup: draw should leave it selected");

    await clickFrac(page, rect, 0.9, 0.9); // empty canvas, well outside the box
    assert.equal(await isSelected(page), false, "clicking empty canvas should deselect");
  });

  test("dragging a selected box's corner handle resizes it, pinning the opposite corner",
    async () => {
      await drawBox(); // leaves it selected, so its resize handles are already live
      const before_ = boundsOf((await readState(page)).detections[0].box);

      // Grab the top-left handle (where the box was drawn from) and drag it
      // further out.
      await dragFrac(page, rect, 0.15, 0.15, 0.08, 0.08);

      const after_ = boundsOf((await readState(page)).detections[0].box);
      assert.ok(after_.minX < before_.minX && after_.minY < before_.minY,
        "the grabbed corner should have moved outward");
      assert.ok(near(after_.maxX, before_.maxX) && near(after_.maxY, before_.maxY),
        "the opposite corner should stay pinned");
    });

  // A second corner, deliberately not the one above: the app identifies which
  // handle was grabbed by its position (nearestWithinRadius over cornersOf),
  // so a test that only ever drags the top-left handle can't tell "resize
  // from wherever was grabbed" apart from "always resize from the top-left" --
  // the same gap step 7's mutation testing found in resizedBounds() itself.
  test("dragging the opposite (bottom-right) handle resizes from that corner instead",
    async () => {
      await drawBox();
      const before_ = boundsOf((await readState(page)).detections[0].box);

      await dragFrac(page, rect, 0.45, 0.35, 0.52, 0.42);

      const after_ = boundsOf((await readState(page)).detections[0].box);
      assert.ok(after_.maxX > before_.maxX && after_.maxY > before_.maxY,
        "the grabbed (bottom-right) corner should have moved outward");
      assert.ok(near(after_.minX, before_.minX) && near(after_.minY, before_.minY),
        "the top-left corner should stay pinned this time");
    });

  test("dragging a selected box's body moves it without changing its size", async () => {
    await drawBox(); // leaves it selected, so its body is already draggable as "move"
    const before_ = boundsOf((await readState(page)).detections[0].box);

    await dragFrac(page, rect, 0.30, 0.25, 0.55, 0.55);

    const after_ = boundsOf((await readState(page)).detections[0].box);
    const dx = after_.minX - before_.minX;
    const dy = after_.minY - before_.minY;
    assert.ok(dx > 5 && dy > 5, `expected the box to shift, got dx=${dx} dy=${dy}`);
    assert.ok(near(after_.maxX - after_.minX, before_.maxX - before_.minX),
      "width should be preserved by a move");
    assert.ok(near(after_.maxY - after_.minY, before_.maxY - before_.minY),
      "height should be preserved by a move");
  });

  test("editing a recognized box's geometry marks it pending again, discarding the recognition",
    async () => {
      await drawBox();
      // Simulate a prior recognition directly in the page: applyEditedBox()
      // isn't exported, so this writes the same fields rather than calling it.
      await page.evaluate(`
        (async () => {
          const req = indexedDB.open("field-guide-scan", 1);
          await new Promise((resolve) => { req.onsuccess = resolve; });
          const db = req.result;
          const tx = db.transaction("session", "readwrite");
          const store = tx.objectStore("session");
          const g = store.get("state");
          await new Promise((resolve) => { g.onsuccess = resolve; });
          const state = g.result;
          state.detections[0].text = "M7270";
          state.detections[0].score = 0.9;
          store.put(state, "state");
          await new Promise((resolve) => { tx.oncomplete = resolve; });
        })()
      `);
      // Reload so ocr.js's in-memory detections reflect the edited state above.
      // Nothing is selected right after a restore (unlike right after a draw).
      await page.goto(`${origin}/ocr.html`);
      await page.waitFor(`document.querySelectorAll("#results li").length === 1`, "restore");

      await clickFrac(page, rect, 0.30, 0.25); // select the restored, recognized box
      await dragFrac(page, rect, 0.30, 0.25, 0.55, 0.55); // move it

      const detection = (await readState(page)).detections[0];
      assert.equal(detection.score, null, "moving a recognized box should clear its score");
      assert.equal(detection.text, null);
      assert.equal(detection.source, "manual");
    });

  test("Delete key removes the selected box", async () => {
    await drawBox(); // leaves it selected
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete" });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete" });
    await page.waitFor(`document.querySelectorAll("#results li").length === 0`,
      "the box to be removed");
  });

  test("the canvas delete hotspot removes the selected box", async () => {
    await drawBox(); // leaves it selected, so its delete-X is already visible
    await clickFrac(page, rect, 0.30, 0.128);
    await page.waitFor(`document.querySelectorAll("#results li").length === 0`,
      "the box to be removed by its delete-X");
  });

  test("the results list's delete button removes that row's box", async () => {
    await drawBox();
    await page.evaluate(`document.querySelector("#results .icon-btn[title='Delete this box']").click()`);
    await page.waitFor(`document.querySelectorAll("#results li").length === 0`,
      "the box to be removed by the list button");
  });

  test("no page errors were logged across any of the above", () => {
    assert.deepEqual(page.consoleErrors, []);
  });
});
