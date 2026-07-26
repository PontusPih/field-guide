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
// The results list bolds its row for the selected detection (results-list.js);
// that's the DOM-observable proxy for selection state.
const isSelected = (page) => page.evaluate(
  `document.querySelector("#results li")?.style.fontWeight === "bold"`,
);

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

  test("selecting a box on the canvas scrolls its results-list row into view", async () => {
    // #resultsPanel has max-height: 650px and overflow-y: auto (ocr.html); 20
    // boxes comfortably overflow it, so row 1 and row 20 can't both be
    // visible at once. Laid out in two columns, alternating, rather than one
    // tight vertical stack: each newly-drawn box is left selected with resize
    // handles showing at its corners (RESIZE_HANDLE_HIT_RADIUS px), and boxes
    // stacked close together in a single column put the next draw's start
    // point within that radius of the previous box's handle -- turning the
    // "new box" drag into a resize of the previous one instead. Alternating
    // columns keeps every consecutive pair of draws far apart.
    const count = 20;
    const boxCenters = [];
    for (let i = 0; i < count; i++) {
      const x0 = i % 2 === 0 ? 0.05 : 0.55;
      const y0 = 0.02 + Math.floor(i / 2) * 0.09;
      await dragFrac(page, rect, x0, y0, x0 + 0.08, y0 + 0.06);
      boxCenters.push({ x: x0 + 0.04, y: y0 + 0.03 });
    }
    await page.waitFor(`document.querySelectorAll("#results li").length === ${count}`, "all boxes drawn");

    const rowVisible = (index) => page.evaluate(`
      (() => {
        const panel = document.getElementById("resultsPanel").getBoundingClientRect();
        const row = document.querySelectorAll("#results li")[${index}].getBoundingClientRect();
        return row.top >= panel.top && row.bottom <= panel.bottom;
      })()
    `);

    // Drawing box 20 left it selected, which already scrolled its own row
    // into view -- confirming the panel actually is scrolled away from row 1,
    // so selecting row 1 next is a real test of the scroll, not a no-op.
    assert.equal(await rowVisible(0), false,
      "row 1 should be scrolled out of view after row 20 was scrolled into view");

    // Shrink the viewport (restored after) so #resultsPanel (max-height 650px)
    // cannot possibly fit inside it -- at the suite's normal 1400x1000, the
    // page never actually needs to scroll for the panel to be fully visible,
    // so scrolling the page here wouldn't exercise anything. This is the
    // exact scenario that exposed a real bug: native scrollIntoView() walks
    // *every* scrollable ancestor, not just #resultsPanel, so it would drag
    // the page's own scroll position along too if the row also needed that.
    // Fixed by computing the delta and adjusting #resultsPanel's scrollTop
    // directly (results-list.js) instead of calling scrollIntoView() at all.
    await page.send("Emulation.setDeviceMetricsOverride",
      { width: 1400, height: 400, deviceScaleFactor: 1, mobile: false });
    try {
      await page.evaluate(`window.scrollTo(0, 200); true`);
      const pageScrollBefore = await page.evaluate(`window.scrollY`);
      assert.ok(pageScrollBefore > 0, "test setup: the page itself should be scrolled");

      // The resize/scroll above moved the canvas's on-screen position, so
      // `rect` (captured in beforeEach, before either) is stale --
      // getBoundingClientRect() is viewport-relative, and re-fetching it is
      // what dragFrac/clickFrac's fractional coordinates need to still land
      // on the right box. boxCenters (fractions of rect) stay valid as-is.
      const shrunkRect = await stageRect(page);

      // Click box 1 directly on the canvas (not in the list).
      await clickFrac(page, shrunkRect, boxCenters[0].x, boxCenters[0].y);

      assert.equal(await rowVisible(0), true,
        "selecting box 1 on the canvas should scroll its results-list row into view");
      assert.equal(await page.evaluate(`window.scrollY`), pageScrollBefore,
        "selecting a box must not also scroll the whole page");
    } finally {
      // Later tests in this file share the same page/browser instance and
      // assume the suite's normal viewport.
      await page.send("Emulation.setDeviceMetricsOverride",
        { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    }
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
      // isn't exported, so this writes the same fields rather than calling it,
      // into the active image's persisted label entry.
      await page.evaluate(`
        (async () => {
          const req = indexedDB.open("field-guide-scan", 2);
          await new Promise((resolve) => { req.onsuccess = resolve; });
          const db = req.result;
          const active = await new Promise((resolve, reject) => {
            const g = db.transaction("batch", "readonly").objectStore("batch").get("current");
            g.onsuccess = () => resolve(g.result.active);
            g.onerror = () => reject(g.error);
          });
          const tx = db.transaction("labels", "readwrite");
          const store = tx.objectStore("labels");
          const g = store.get(active);
          await new Promise((resolve) => { g.onsuccess = resolve; });
          const label = g.result;
          label.detections[0].text = "M7270";
          label.detections[0].score = 0.9;
          store.put(label, active);
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
