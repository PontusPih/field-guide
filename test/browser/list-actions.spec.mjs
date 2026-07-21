// Characterization spec for the results list's bulk actions: Prune
// overlapping, Prune empty, and Clear boxes. Written against the current,
// working behaviour of ocr.js before the deferred restructure touches it
// (refactor-plan.md, "Deferred").
//
// Boxes are placed directly into the persisted session and the page reloaded
// to pick them up, rather than drawn by hand -- these tests are about what
// the buttons do to a given set of detections, not about drawing gestures
// (covered in interaction.spec.mjs).
//
// Run: `npm run test:browser`

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { launch, findChrome } from "./harness.mjs";
import { bootApp, loadSyntheticPhoto, readState } from "./fixtures.mjs";

const chromePath = await findChrome();

describe("list bulk actions", { skip: chromePath ? false : "no Chrome found" }, () => {
  let browser;
  let page;
  let origin;

  before(async () => {
    browser = await launch();
    page = browser.page;
    origin = browser.origin;
  });

  after(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    await bootApp(page, origin, {});
    await loadSyntheticPhoto(page);
  });

  // Writes `detections` straight into the persisted session and reloads, so
  // ocr.js's in-memory state picks them up via restoreSession(). Bypasses
  // drawing/recognition entirely -- these tests are about what the buttons do
  // to a given detection list, not how that list came to exist.
  async function seedDetections(detections) {
    await page.evaluate(`
      (async () => {
        const req = indexedDB.open("field-guide-scan", 1);
        await new Promise((resolve) => { req.onsuccess = resolve; });
        const db = req.result;
        const tx = db.transaction("session", "readwrite");
        tx.objectStore("session").put(
          { rotation: 0, detections: ${JSON.stringify(detections)} }, "state");
        await new Promise((resolve) => { tx.oncomplete = resolve; });
      })()
    `);
    await page.goto(`${origin}/ocr.html`);
    await page.waitFor(
      `document.querySelectorAll("#results li").length === ${detections.length}`, "session restore");
  }

  test("Prune overlapping keeps the higher-scoring box of an overlapping pair", async () => {
    await seedDetections([
      { id: 1, box: [[10, 10], [110, 10], [110, 60], [10, 60]], text: "low", score: 0.4, source: "auto" },
      // Overlaps box 1's bounds; higher score should survive.
      { id: 2, box: [[50, 30], [150, 30], [150, 80], [50, 80]], text: "high", score: 0.95, source: "auto" },
      // Disjoint from both -- pruning overlap must leave it alone.
      { id: 3, box: [[300, 300], [350, 300], [350, 340], [300, 340]], text: "alone", score: 0.7, source: "auto" },
    ]);

    assert.equal(await page.evaluate(`document.getElementById("pruneOverlapping").disabled`), false,
      "an overlapping pair should make Prune overlapping available");

    await page.evaluate(`document.getElementById("pruneOverlapping").click(); true`);

    const remaining = (await readState(page)).detections.map((d) => d.text).sort();
    assert.deepEqual(remaining, ["alone", "high"],
      "the lower-scoring overlapping box should be removed, the disjoint one kept");
  });

  test("Prune overlapping is a no-op, and disabled, when nothing overlaps", async () => {
    await seedDetections([
      { id: 1, box: [[10, 10], [60, 10], [60, 40], [10, 40]], text: "a", score: 0.9, source: "auto" },
      { id: 2, box: [[300, 300], [350, 300], [350, 340], [300, 340]], text: "b", score: 0.8, source: "auto" },
    ]);
    assert.equal(await page.evaluate(`document.getElementById("pruneOverlapping").disabled`), true);

    await page.evaluate(`document.getElementById("pruneOverlapping").click(); true`);
    assert.equal((await readState(page)).detections.length, 2, "nothing should have been removed");
  });

  test("Prune empty removes only boxes that were tried and found nothing", async () => {
    await seedDetections([
      // score == null, attempted true: tried, found nothing -- "empty".
      { id: 1, box: [[10, 10], [60, 10], [60, 40], [10, 40]], text: null, score: null, attempted: true, source: "manual" },
      // score == null, attempted false: never tried -- must survive Prune empty.
      { id: 2, box: [[100, 10], [150, 10], [150, 40], [100, 40]], text: null, score: null, attempted: false, source: "manual" },
      // Recognized -- must survive Prune empty regardless of score.
      { id: 3, box: [[200, 10], [250, 10], [250, 40], [200, 40]], text: "found", score: 0.6, source: "auto" },
    ]);

    assert.equal(await page.evaluate(`document.getElementById("pruneEmpty").disabled`), false);
    await page.evaluate(`document.getElementById("pruneEmpty").click(); true`);

    const remaining = (await readState(page)).detections;
    assert.equal(remaining.length, 2, "only the tried-and-empty box should be removed");
    assert.ok(remaining.every((d) => d.id !== 1));
    assert.ok(remaining.some((d) => d.id === 2), "never-tried box should survive");
    assert.ok(remaining.some((d) => d.id === 3), "recognized box should survive");
  });

  test("Prune empty is disabled when there is nothing to prune", async () => {
    await seedDetections([
      { id: 1, box: [[10, 10], [60, 10], [60, 40], [10, 40]], text: null, score: null, attempted: false, source: "manual" },
    ]);
    assert.equal(await page.evaluate(`document.getElementById("pruneEmpty").disabled`), true,
      "a never-tried (not yet recognized) box should not count as empty");
  });

  test("Clear boxes removes every detection but keeps the loaded photo", async () => {
    await seedDetections([
      { id: 1, box: [[10, 10], [60, 10], [60, 40], [10, 40]], text: "a", score: 0.9, source: "auto" },
      { id: 2, box: [[100, 10], [150, 10], [150, 40], [100, 40]], text: "b", score: 0.8, source: "auto" },
    ]);

    page.dialogAccept = true; // confirm() the "Clear all boxes?" prompt
    await page.evaluate(`document.getElementById("clearBoxes").click(); true`);
    await page.waitFor(`document.querySelectorAll("#results li").length === 0`, "boxes cleared");

    assert.equal((await readState(page)).detections.length, 0);
    assert.equal(await page.evaluate(`document.getElementById("runOcr").disabled`), false,
      "the photo itself should still be loaded");
  });

  test("Clear boxes does nothing if the confirmation is declined", async () => {
    await seedDetections([
      { id: 1, box: [[10, 10], [60, 10], [60, 40], [10, 40]], text: "a", score: 0.9, source: "auto" },
    ]);

    page.dialogAccept = false; // decline the confirm()
    // Runtime.evaluate's response only arrives once the whole click handler
    // returns, and confirm() blocks synchronously until the dialog is
    // answered -- so by the time this resolves, clearDetections() has already
    // read `false` back and returned. No wait beyond that is needed.
    await page.evaluate(`document.getElementById("clearBoxes").click(); true`);
    page.dialogAccept = true;

    assert.equal((await readState(page)).detections.length, 1, "declining should leave the box in place");
  });

  test("no page errors were logged across any of the above", () => {
    assert.deepEqual(page.consoleErrors, []);
  });
});
