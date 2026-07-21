// Characterization spec for cancelling a scan and resuming it: plain cancel
// mid-drain, and the harder case step 3 of refactor-plan.md fixed -- clicking
// Run OCR again while the cancelled drain is still tearing down must carry
// that work into the next drain, not throw it away.
//
// The carry-over race only reproduces if the worker is still suspended
// awaiting a tile's response when the second click lands. All three clicks
// (Run OCR, Cancel, Run OCR again) are therefore dispatched inside one
// Runtime.evaluate call: JS run-to-completion guarantees they all fire before
// the event loop gets a chance to resume the suspended worker, which a
// sequence of separate CDP round-trips could not guarantee. The stub's own
// delay adds a further safety margin, matching how this was verified by hand
// during step 3.
//
// Run: `npm run test:browser`

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { launch, findChrome } from "./harness.mjs";
import { bootApp, loadSyntheticPhoto, stageRect, dragFrac, scanIdle } from "./fixtures.mjs";

const chromePath = await findChrome();

// Delays every stubbed /ocr response, so the worker is reliably still
// suspended awaiting a tile's result when the test's next action fires.
async function stubOcrDelayed(page, delayMs = 150) {
  await page.evaluate(`
    window.__ocrCalls = 0;
    const realFetch = window.fetch.bind(window);
    window.fetch = (url, opts) => {
      if (!String(url).includes("/ocr")) return realFetch(url, opts);
      const n = ++window.__ocrCalls;
      return new Promise((resolve) => {
        setTimeout(() => {
          const found = [{
            box: [[10, 10], [60, 10], [60, 30], [10, 30]],
            text: "T" + n,
            score: 0.9,
          }];
          resolve(new Response(JSON.stringify(found), {
            status: 200, headers: { "content-type": "application/json" },
          }));
        }, ${delayMs});
      });
    };
    true
  `);
}

describe("scan cancel and resume", { skip: chromePath ? false : "no Chrome found" }, () => {
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
    // The dev default (Infinity tile size) makes one Run OCR click enqueue
    // exactly one tile -- the simplest queue state to reason a race about.
    await bootApp(page, origin, {});
  });

  test("cancelling mid-scan stops the worker and reports what was left unscanned", async () => {
    await stubOcrDelayed(page, 300);
    await loadSyntheticPhoto(page);

    await page.evaluate(`document.getElementById("runOcr").click(); true`);
    // Both flags flip together, synchronously, inside the same
    // updateButtons() call -- checked in one poll so there's no round-trip
    // gap in which the (stubbed, time-limited) scan could finish between
    // confirming it started and checking rotation was disabled meanwhile.
    // A separate follow-up check here previously raced the stub's delay
    // under SLOWMO, and could in principle have raced it anywhere, given a
    // slow enough machine.
    await page.waitFor(
      `!document.getElementById("cancelScan").disabled && document.getElementById("rotateLeft").disabled`,
      "scan to start with rotation disabled",
    );

    await page.evaluate(`document.getElementById("cancelScan").click(); true`);
    await scanIdle(page);

    const status = await page.evaluate(`document.getElementById("status").textContent`);
    assert.match(status, /cancelled/);
    assert.equal(await page.evaluate(`document.getElementById("rotateLeft").disabled`), false,
      "rotation should be re-enabled once the scan has stopped");
  });

  test("clicking Run OCR again while a cancelled scan is still tearing down carries " +
    "the new work into the next drain, rather than discarding it", async () => {
    await stubOcrDelayed(page, 150);
    await loadSyntheticPhoto(page);

    await page.evaluate(`
      document.getElementById("runOcr").click();
      document.getElementById("cancelScan").click();
      document.getElementById("runOcr").click();
      true
    `);

    await scanIdle(page);
    assert.equal(await page.evaluate("window.__ocrCalls"), 2,
      "the tile enqueued during teardown should still be sent, not thrown away");
  });

  test("cancelling a manual region's scan leaves its box retryable, not stuck", async () => {
    // recognizePendingBoxes() skips a box whose placeholder already exists
    // (its own guard against a second click overwriting the first click's
    // bookkeeping) -- so clicking it again immediately after cancelling,
    // while the placeholder from the first click is still live, is a no-op
    // by design. The property actually worth pinning down is what happens
    // afterwards: does the box come out of this retryable, or does its
    // placeholder wedge it in limbo?
    await stubOcrDelayed(page, 150);
    await loadSyntheticPhoto(page);
    const rect = await stageRect(page);
    await dragFrac(page, rect, 0.15, 0.15, 0.45, 0.35);
    await page.waitFor(`document.querySelectorAll("#results li").length === 1`, "box drawn");

    await page.evaluate(`
      document.getElementById("recognizePending").click();
      document.getElementById("cancelScan").click();
      true
    `);
    await scanIdle(page);

    assert.equal(await page.evaluate(`document.getElementById("recognizePending").disabled`), false,
      "the box should be recognized as pending-and-available again, not wedged behind a stale placeholder");

    // Now retry for real, with the stub answering normally.
    await page.evaluate(`document.getElementById("recognizePending").click(); true`);
    await scanIdle(page);

    const label = await page.evaluate(
      `document.querySelector("#results .result-label").textContent`);
    assert.match(label, /T\d/, "the retried box should end up recognized");
  });

  test("no page errors were logged across any of the above", () => {
    assert.deepEqual(page.consoleErrors, []);
  });
});
