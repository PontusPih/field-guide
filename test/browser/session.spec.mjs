// Characterization spec for session persistence: reload restoring a photo and
// its boxes, Clear (the whole session) vs Clear boxes (photo kept), and
// rotation remapping box coordinates. Written against the current, working
// behaviour of ocr.js before the deferred restructure touches it
// (refactor-plan.md, "Deferred").
//
// Run: `npm run test:browser`

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { launch, findChrome } from "./harness.mjs";
import {
  bootApp, loadSyntheticPhoto, stageRect, dragFrac, readState, readImageName, boundsOf,
} from "./fixtures.mjs";

const chromePath = await findChrome();

describe("session persistence", { skip: chromePath ? false : "no Chrome found" }, () => {
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
  });

  test("reloading restores the loaded photo and its drawn boxes", async () => {
    await loadSyntheticPhoto(page, { name: "board-photo.png" });
    const rect = await stageRect(page);
    await dragFrac(page, rect, 0.15, 0.15, 0.45, 0.35);
    await page.waitFor(`document.querySelectorAll("#results li").length === 1`, "box drawn");
    const before_ = (await readState(page)).detections[0].box;

    await page.goto(`${origin}/ocr.html`);
    await page.waitFor(`document.querySelectorAll("#results li").length === 1`, "session restore");

    assert.equal(await readImageName(page), "board-photo.png",
      "the File object, not just its bytes, should round-trip (name included)");
    assert.equal(await page.evaluate(`document.getElementById("runOcr").disabled`), false,
      "a restored photo should re-enable Run OCR");

    const after_ = (await readState(page)).detections[0].box;
    assert.deepEqual(after_, before_, "the drawn box's geometry should survive the reload exactly");

    const statusText = await page.evaluate(`document.getElementById("status").textContent`);
    assert.match(statusText, /Restored "board-photo\.png"/);
    assert.match(statusText, /1 box/);
  });

  test("reloading with no prior session leaves the app in its empty state", async () => {
    // bootApp() already cleared IndexedDB; reload again to be sure a second
    // restoreSession() run against a still-empty store doesn't misbehave.
    await page.goto(`${origin}/ocr.html`);
    await page.waitFor(`!!document.getElementById("runOcr")`, "app boot");
    assert.equal(await page.evaluate(`document.getElementById("runOcr").disabled`), true,
      "no photo should be loaded");
    assert.equal(await page.evaluate(`document.querySelectorAll("#results li").length`), 0);
  });

  test("Clear removes the photo and every box, and a reload does not bring them back",
    async () => {
      await loadSyntheticPhoto(page);
      const rect = await stageRect(page);
      await dragFrac(page, rect, 0.15, 0.15, 0.45, 0.35);
      await page.waitFor(`document.querySelectorAll("#results li").length === 1`, "box drawn");

      page.dialogAccept = true; // confirm() the "Clear the loaded photo and all boxes?" prompt
      await page.evaluate(`document.getElementById("clearScan").click(); true`);

      assert.equal(await page.evaluate(`document.getElementById("runOcr").disabled`), true,
        "Clear should drop the photo, not just the boxes");
      assert.equal(await page.evaluate(`document.querySelectorAll("#results li").length`), 0);

      // clearSession()'s IndexedDB delete is awaited *after* its synchronous
      // UI reset, so it can still be in flight once the assertions above
      // pass. Reloading before it lands would race the delete -- wait for the
      // storage to actually be empty first.
      await page.waitFor(`
        new Promise((resolve, reject) => {
          const req = indexedDB.open("field-guide-scan", 1);
          req.onsuccess = () => {
            const g = req.result.transaction("session", "readonly").objectStore("session").get("image");
            g.onsuccess = () => resolve(g.result === undefined);
            g.onerror = () => reject(g.error);
          };
          req.onerror = () => reject(req.error);
        })
      `, "the stored image to be cleared");

      await page.goto(`${origin}/ocr.html`);
      await page.waitFor(`!!document.getElementById("runOcr")`, "app boot");
      assert.equal(await page.evaluate(`document.getElementById("runOcr").disabled`), true,
        "the cleared session should not come back after reload");
      assert.equal(await readImageName(page), null, "no image should remain in storage");
    });

  test("rotating remaps a box's coordinates to match the rotated image", async () => {
    // A non-square photo so a 90-degree rotation is unambiguous: a box near
    // the top-left of a wide image should end up near the top-right of the
    // now-tall one.
    await loadSyntheticPhoto(page, { w: 900, h: 400 });
    const rect = await stageRect(page);
    await dragFrac(page, rect, 0.10, 0.10, 0.30, 0.30);
    await page.waitFor(`document.querySelectorAll("#results li").length === 1`, "box drawn");
    const before_ = boundsOf((await readState(page)).detections[0].box);

    await page.evaluate(`document.getElementById("rotateRight").click(); true`);

    const state = await readState(page);
    assert.equal(state.rotation, 90);
    const after_ = boundsOf(state.detections[0].box);
    // rotatePoint for a +90 rotation is (x,y) -> (oldH - y, x): a box near the
    // pre-rotation top-left should land near the post-rotation top-right.
    assert.ok(after_.minX > before_.minX,
      `expected the box to move toward the right edge, got minX ${after_.minX} (was ${before_.minX})`);
  });

  test("no page errors were logged across any of the above", () => {
    assert.deepEqual(page.consoleErrors, []);
  });
});
