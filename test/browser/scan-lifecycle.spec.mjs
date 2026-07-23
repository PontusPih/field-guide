// Characterization spec for cancelling a scan and resuming it: plain cancel
// mid-drain, and the harder case step 3 of refactor-plan.md fixed -- clicking
// OCR full photo again while the cancelled drain is still tearing down must carry
// that work into the next drain, not throw it away.
//
// The carry-over race only reproduces if the worker is still suspended
// awaiting a tile's response when the second click lands. All three clicks
// (OCR full photo, Cancel, OCR full photo again) are therefore dispatched inside one
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
    // The dev default (Infinity tile size) makes one OCR full photo click enqueue
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

  test("clicking OCR full photo again while a cancelled scan is still tearing down carries " +
    "the new work into the next drain, rather than discarding it", async () => {
    await stubOcrDelayed(page, 150);
    await loadSyntheticPhoto(page);

    const disabledRightAfterCancel = await page.evaluate(`
      (() => {
        document.getElementById("runOcr").click();
        document.getElementById("cancelScan").click();
        const disabled = document.getElementById("runOcr").disabled;
        document.getElementById("runOcr").click();
        return disabled;
      })()
    `);
    assert.equal(disabledRightAfterCancel, false,
      "cancelScan() must re-enable OCR full photo synchronously, without waiting for " +
      "the aborted drain's async teardown to clear scanAbortController -- otherwise " +
      "the third click above would be inert and this test would be exercising nothing");

    await scanIdle(page);
    assert.equal(await page.evaluate("window.__ocrCalls"), 2,
      "the tile enqueued during teardown should still be sent, not thrown away");
  });

  test("OCR full photo disables itself while a scan is outstanding, so repeat clicks " +
    "can't queue duplicate whole-photo scans", async () => {
    await stubOcrDelayed(page, 300);
    await loadSyntheticPhoto(page);

    await page.evaluate(`document.getElementById("runOcr").click(); true`);
    await page.waitFor(`document.getElementById("runOcr").disabled`,
      "OCR full photo to disable once its scan starts");

    // A disabled button ignores click() the same as a real click -- this
    // should be a no-op, not a second whole-photo enqueue.
    await page.evaluate(`document.getElementById("runOcr").click(); true`);
    await scanIdle(page);

    assert.equal(await page.evaluate("window.__ocrCalls"), 1,
      "the disabled second click must not have queued a duplicate whole-photo scan");
    assert.equal(await page.evaluate(`document.getElementById("runOcr").disabled`), false,
      "OCR full photo should re-enable once the scan finishes");
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

  test("a manual region whose tile errors (503) stays retryable, not settled as empty", async () => {
    // refactor-plan.md step 8: a transient backend failure must not present as
    // a genuine "no text found" -- the box should stay pending and available.
    await page.evaluate(`
      window.__realFetch = window.fetch.bind(window);
      window.fetch = (url, opts) => {
        if (!String(url).includes("/ocr")) return window.__realFetch(url, opts);
        return Promise.resolve(new Response("queue full", { status: 503 }));
      };
      true
    `);
    await loadSyntheticPhoto(page);
    const rect = await stageRect(page);
    await dragFrac(page, rect, 0.15, 0.15, 0.45, 0.35);
    await page.waitFor(`document.querySelectorAll("#results li").length === 1`, "box drawn");

    await page.evaluate(`document.getElementById("recognizePending").click(); true`);
    await scanIdle(page);

    assert.equal(await page.evaluate(`document.getElementById("recognizePending").disabled`), false,
      "a region that only ever errored must stay eligible for another attempt");
    assert.equal(await page.evaluate(`document.getElementById("pruneEmpty").disabled`), true,
      "an errored region is not a settled empty result, so Prune empty must not touch it");
    const label = await page.evaluate(`document.querySelector("#results .result-label").textContent`);
    assert.match(label, /failed.*try again/,
      "the box must read distinctly from a never-tried box, or the fix is invisible");

    // Retry for real, with the stub now answering normally -- confirms the
    // region isn't wedged, just held open.
    await page.evaluate(`
      window.fetch = (url, opts) => {
        if (!String(url).includes("/ocr")) return window.__realFetch(url, opts);
        const found = [{ box: [[10, 10], [60, 10], [60, 30], [10, 30]], text: "T1", score: 0.9 }];
        return Promise.resolve(new Response(JSON.stringify(found), {
          status: 200, headers: { "content-type": "application/json" },
        }));
      };
      true
    `);
    await page.evaluate(`document.getElementById("recognizePending").click(); true`);
    await scanIdle(page);

    const resolved = await page.evaluate(`document.querySelector("#results .result-label").textContent`);
    assert.match(resolved, /T1/, "the retried box should end up recognized");
  });

  test("no page errors were logged across any of the above", () => {
    assert.deepEqual(page.consoleErrors, []);
  });
});
