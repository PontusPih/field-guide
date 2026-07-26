// Spec for the five Clear-family operations (PLAN.md, "Multi-image
// workflow"): Clear image and Drop image are exercised in list-actions.spec.mjs
// and this file respectively; Clear batch is covered in session.spec.mjs
// (its "and a reload does not bring them back" behaviour predates the
// five-operation split). This file covers what's specific to the newer three:
// Drop image's batch-membership-only effect, Finish batch's no-confirm
// safety, and Clear all's wider reach (the whole ledger, not just the
// current batch) versus Clear batch.
//
// Run: `npm run test:browser`

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { launch, findChrome } from "./harness.mjs";
import {
  bootApp, loadSyntheticPhoto, loadSyntheticPhotos, stageRect, dragFrac,
  readImageName, readAllLabels,
} from "./fixtures.mjs";

const chromePath = await findChrome();

// Clicks a Clear-menu item by id, opening the menu first (mirrors what a real
// click does: open, then choose).
async function clickMenuItem(page, id) {
  await page.evaluate(`
    document.getElementById("clearMenuToggle").click();
    document.getElementById(${JSON.stringify(id)}).click();
    true
  `);
}

const readLabelsInLedger = (page) => page.evaluate(`
  new Promise((resolve, reject) => {
    const req = indexedDB.open("field-guide-scan", 2);
    req.onsuccess = () => {
      const g = req.result.transaction("labels", "readonly").objectStore("labels").getAllKeys();
      g.onsuccess = () => resolve(g.result.length);
      g.onerror = () => reject(g.error);
    };
    req.onerror = () => reject(req.error);
  })
`);

describe("Clear-family operations", { skip: chromePath ? false : "no Chrome found" }, () => {
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

  test("Drop image removes only the active image from the batch; its ledger entry survives, the next image becomes active",
    async () => {
      await loadSyntheticPhotos(page, [{ name: "A.png", text: "A-TEXT" }, { name: "B.png", text: "B-TEXT" }]);
      assert.equal(await readImageName(page), "A.png", "test setup: A is active (first selected)");
      const shaOfA = (await readAllLabels(page))[0].sha256;

      page.dialogAccept = true; // confirm() the "Drop … from the batch?" prompt
      await clickMenuItem(page, "dropImage");

      // dropImage()'s own deleteImage()/persistBatchMeta() calls aren't
      // awaited by the click handler (fire-and-forget, like every other
      // persist here) -- wait for the batch record to actually reflect B as
      // active rather than racing those writes.
      await page.waitFor(`
        new Promise((resolve, reject) => {
          const req = indexedDB.open("field-guide-scan", 2);
          req.onsuccess = () => {
            const g = req.result.transaction("batch", "readonly").objectStore("batch").get("current");
            g.onsuccess = () => resolve((g.result?.order?.length ?? 0) === 1);
            g.onerror = () => reject(g.error);
          };
          req.onerror = () => reject(req.error);
        })
      `, "the batch to reflect A's removal");

      assert.equal(await readImageName(page), "B.png", "B should become active once A is dropped");
      const labels = await readAllLabels(page);
      assert.equal(labels.length, 1, "only B should remain in the batch");
      assert.equal(labels[0].filename, "B.png");

      // A's ground truth is untouched even though it left the batch.
      const aStillLabeled = await page.evaluate(`
        new Promise((resolve, reject) => {
          const req = indexedDB.open("field-guide-scan", 2);
          req.onsuccess = () => {
            const g = req.result.transaction("labels", "readonly").objectStore("labels")
              .get(${JSON.stringify(shaOfA)});
            g.onsuccess = () => resolve(g.result !== undefined);
            g.onerror = () => reject(g.error);
          };
          req.onerror = () => reject(req.error);
        })
      `);
      assert.equal(aStillLabeled, true, "A's ledger entry should survive being dropped from the batch");
    });

  test("Finish batch empties the batch without confirmation, and every image's ground truth reattaches later",
    async () => {
      await loadSyntheticPhoto(page, { name: "A.png", text: "A-TEXT" });
      const rect = await stageRect(page);
      await dragFrac(page, rect, 0.15, 0.15, 0.45, 0.35);
      await page.waitFor(`document.querySelectorAll("#results li").length === 1`, "box drawn");

      page.dialogAccept = false; // Finish batch must not even ask -- if it did, this would block/no-op
      await page.evaluate(`document.getElementById("finishBatch").click(); true`);

      assert.equal(await page.evaluate(`document.getElementById("runOcr").disabled`), true,
        "the batch should be empty");
      assert.equal((await readAllLabels(page)).length, 0, "no image should remain loaded");

      // Re-select the same image; its box should reattach from the ledger.
      await loadSyntheticPhoto(page, { name: "A.png", text: "A-TEXT" });
      const labels = await readAllLabels(page);
      assert.equal(labels.length, 1);
      assert.equal(labels[0].detections.length, 1, "A's box should reattach after Finish batch");
    });

  test("Clear all wipes the entire ledger, including images not in the current batch -- unlike Clear batch",
    async () => {
      // Label A, then move on without it in the current batch.
      await loadSyntheticPhoto(page, { name: "A.png", text: "A-TEXT" });
      const rect = await stageRect(page);
      await dragFrac(page, rect, 0.15, 0.15, 0.45, 0.35);
      await page.waitFor(`document.querySelectorAll("#results li").length === 1`, "box drawn");

      await loadSyntheticPhoto(page, { name: "B.png", text: "B-TEXT" });
      assert.equal(await readLabelsInLedger(page), 2, "test setup: both A and B are in the ledger");

      page.dialogAccept = true; // confirm() the "Clear everything…" prompt
      await clickMenuItem(page, "clearAll");

      // clearAll()'s own emptyBatch()/clearAllLabels() chain isn't awaited by
      // the click handler (fire-and-forget, like every other persist here) --
      // wait for the ledger to actually empty rather than racing the delete.
      await page.waitFor(`
        new Promise((resolve, reject) => {
          const req = indexedDB.open("field-guide-scan", 2);
          req.onsuccess = () => {
            const g = req.result.transaction("labels", "readonly").objectStore("labels").getAllKeys();
            g.onsuccess = () => resolve(g.result.length === 0);
            g.onerror = () => reject(g.error);
          };
          req.onerror = () => reject(req.error);
        })
      `, "the entire ledger to be cleared");

      assert.equal(await page.evaluate(`document.getElementById("runOcr").disabled`), true);
    });

  test("the Clear menu opens on toggle, and closes on an outside click without triggering an action",
    async () => {
      await loadSyntheticPhoto(page);
      // Checks the actual rendered display, not just the `hidden` DOM property:
      // a CSS rule that sets `display` unconditionally on .dropdown-menu would
      // leave the property correctly toggled while the menu stayed visually
      // shown regardless (author CSS beats the UA stylesheet's own
      // `[hidden] { display: none }`) -- exactly the bug this once had.
      const isOpen = () => page.evaluate(
        `getComputedStyle(document.getElementById("clearMenuItems")).display !== "none"`);

      assert.equal(await isOpen(), false, "the menu must start closed, before any click");

      await page.evaluate(`document.getElementById("clearMenuToggle").click(); true`);
      assert.equal(await isOpen(), true, "clicking the toggle should open the menu");

      // Click somewhere outside the menu (the heading is a safe, inert target).
      await page.evaluate(`document.querySelector("h1").click(); true`);
      assert.equal(await isOpen(), false, "clicking outside should close the menu");
      // Nothing should have been cleared -- the photo is still loaded.
      assert.equal(await page.evaluate(`document.getElementById("runOcr").disabled`), false);
    });

  test("no page errors were logged across any of the above", () => {
    assert.deepEqual(page.consoleErrors, []);
  });
});
