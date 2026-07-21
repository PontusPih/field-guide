// Browser-test harness: a headless Chrome driven over the DevTools Protocol,
// with no dependencies beyond Node itself (WebSocket is global since Node 22).
//
// Owns every resource it uses and releases it in `close()`:
//   - a static file server on an OS-assigned port, so it can never collide
//     with a dev server the author is already running
//   - a Chrome profile in a fresh temp dir, removed after the process exits
//   - a Chrome instance on an OS-assigned debugging port
//
// Waits poll for an observable condition and fail by name on timeout. There
// are no fixed sleeps: a sleep long enough to be reliable on a loaded machine
// is long enough to hide a regression on an idle one.
//
// Used by the *.spec.mjs files here. Run them with `npm run test:browser`, or
// `HEADED=1 npm run test:browser` to watch a real, visible Chrome window
// instead of running headless. Add `SLOWMO=250` (ms) to pause after every
// action so there's actually something to watch. `npm run test:browser`
// itself runs spec files one at a time (--test-concurrency=1), so a headed
// run shows one window's worth of activity rather than several at once.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm, access, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const SITE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const COVERAGE_DIR = fileURLToPath(new URL("../../.coverage-browser/", import.meta.url));

// Chrome is looked up by name rather than configured: the spec skips itself
// when none is found, so a machine without one still gets a green `npm test`.
const CHROME_CANDIDATES = [
  "/snap/bin/chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

async function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not this one
    }
  }
  return null;
}

// A snap-packaged Chrome runs with a private /tmp, so a profile created in the
// host's /tmp is invisible to it -- the browser starts, writes its
// DevToolsActivePort into its own namespace, and the harness waits forever for
// a file that will never appear. Snap's home interface can reach $HOME, but not
// hidden directories under it, so the profile goes in a visible one. It is
// removed in close() either way.
function profileParentFor(chromePath) {
  return chromePath.includes("/snap/") ? homedir() : tmpdir();
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// Serves SITE_ROOT on an OS-assigned port. Paths are normalized and confined
// to the root, so a traversing request gets 403 rather than a file.
function startStaticServer() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (path.includes("..")) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      const body = await readFile(join(SITE_ROOT, path));
      res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SLOWMO=<ms> pauses after a physical input action (mouse/keyboard dispatch,
// page navigation) resolves, so a HEADED=1 run is slow enough to actually
// watch a drag or click land instead of flashing past. Deliberately not
// applied to Runtime.evaluate: specs use it for both real UI actions
// (element.click()) and pure state reads/polling, and several specs stub a
// short in-page timer (e.g. a fake network delay) to force a specific
// ordering. Slowing every evaluate() shrinks how much real time that
// in-page timer gets before the test's next check lands -- which broke a
// scan-cancellation spec at SLOWMO=250, since the polling round-trips ate
// into the 300ms window the test needed the scan to still be running.
const SLOWMO_MS = Number(process.env.SLOWMO) || 0;
const SLOWMO_METHODS = new Set([
  "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Page.navigate",
]);

// COVERAGE=1 collects raw V8 coverage of the app code exercised during the
// run and dumps it to .coverage-browser/ for `coverage-report.mjs` to merge
// and print afterward. Off by default: precise coverage adds instrumentation
// overhead, and most runs don't want a dump directory left behind.
const COVERAGE_ON = process.env.COVERAGE === "1";

// Chrome writes its assigned port to DevToolsActivePort once the debugging
// socket is listening; polling for that file is what replaces "sleep and hope
// it booted".
async function readDevToolsPort(profileDir, timeoutMs = 20000) {
  const portFile = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [port] = readFileSync(portFile, "utf8").split("\n");
      if (port) return Number(port);
    } catch {
      // not written yet
    }
    await sleep(50);
  }
  throw new Error(`Chrome never wrote DevToolsActivePort in ${profileDir}`);
}

// A CDP session against one tab. `send` is request/response by id; `evaluate`
// runs an expression in the page and unwraps thrown exceptions into rejections.
class Page {
  #ws;
  #nextId = 0;
  #pending = new Map();
  consoleErrors = [];
  // clearSession()/clearDetections() both gate on window.confirm(); a dialog
  // left unhandled blocks the page indefinitely, so one is always answered
  // automatically. A spec that needs to answer "Cancel" instead sets this to
  // false before the click that triggers it.
  dialogAccept = true;
  // Raw V8 coverage snapshots (Profiler.takePreciseCoverage()'s own result
  // shape), one per navigation plus a final one at close() -- a full page
  // reload discards the previous scripts' counters, so coverage has to be
  // grabbed just before each reload rather than once at the end. Left empty,
  // at zero cost, unless COVERAGE=1.
  coverageSnapshots = [];

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (m) => this.#onMessage(JSON.parse(m.data)));
  }

  #onMessage(msg) {
    if (msg.id != null) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      this.consoleErrors.push(d.exception?.description ?? d.text);
    }
    // Log.entryAdded carries the failing resource in `url`, not in `text` --
    // `text` is the generic "Failed to load resource" and never names it.
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      const { text, url } = msg.params.entry;
      if (!/favicon/i.test(url ?? "")) this.consoleErrors.push(`${text} [${url ?? "no url"}]`);
    }
    if (msg.method === "Page.javascriptDialogOpening") {
      this.send("Page.handleJavaScriptDialog", { accept: this.dialogAccept });
    }
  }

  async send(method, params = {}) {
    const id = ++this.#nextId;
    this.#ws.send(JSON.stringify({ id, method, params }));
    const result = await new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    if (SLOWMO_MS > 0 && SLOWMO_METHODS.has(method)) await sleep(SLOWMO_MS);
    return result;
  }

  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }

  // Polls `expression` until it is truthy. `label` names the wait, so a
  // timeout says what the page failed to reach rather than just "timed out".
  async waitFor(expression, label, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression)) return;
        lastError = null;
      } catch (err) {
        lastError = err; // e.g. navigation mid-poll; keep trying until the deadline
      }
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
  }

  async goto(url) {
    // A full navigation discards the previous scripts' coverage counters, so
    // whatever ran since the last snapshot (or since coverage started) has to
    // be captured now or it's lost.
    if (COVERAGE_ON) await this.#snapshotCoverage();
    await this.send("Page.navigate", { url });
    await this.waitFor("document.readyState === 'complete'", `${url} to load`);
  }

  async #snapshotCoverage() {
    const { result } = await this.send("Profiler.takePreciseCoverage");
    this.coverageSnapshots.push(result);
  }
}

// Launches everything and returns the pieces a spec needs. `close()` is safe
// to call from an `after` hook whether or not the spec failed.
async function launch() {
  const chromePath = await findChrome();
  if (!chromePath) throw new Error("no Chrome found");

  const server = await startStaticServer();
  const profileDir = await mkdtemp(join(profileParentFor(chromePath), "field-guide-test-"));

  // HEADED=1 opens a real, visible browser window instead of running
  // headless -- useful for watching a spec run rather than reading its
  // output after the fact. Headless-only flags are skipped in that mode:
  // --disable-gpu exists to dodge headless-specific rendering issues and has
  // no reason to apply to a normal window.
  const headed = process.env.HEADED === "1";
  const chrome = spawn(chromePath, [
    ...(headed ? ["--window-size=1400,1000"] : ["--headless=new", "--disable-gpu"]),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "about:blank",
  ], { stdio: "ignore" });

  const exited = new Promise((resolve) => chrome.once("exit", resolve));

  let page;
  try {
    const port = await readDevToolsPort(profileDir);
    const target = await (
      await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
    ).json();

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
    });

    page = new Page(ws);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Log.enable");
    await page.send("DOM.enable");
    await page.send("Network.enable");
    // Without this the page can be served a stale module from Chrome's HTTP
    // cache, and the spec then passes against code that is no longer on disk.
    await page.send("Network.setCacheDisabled", { cacheDisabled: true });
    // A viewport large enough that the canvas is not letterboxed down to a
    // few dozen px, which would make pointer coordinates meaningless.
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    if (COVERAGE_ON) {
      await page.send("Profiler.enable");
      // detailed: per-function ranges, not just per-script totals; callCount
      // (not just true/false) is what lets separate snapshots be summed
      // rather than merely OR'd together.
      await page.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    }
  } catch (err) {
    chrome.kill();
    await exited;
    await rm(profileDir, { recursive: true, force: true });
    await server.close();
    throw err;
  }

  return {
    page,
    origin: server.origin,
    async close() {
      // The page that was loaded when the spec finished never got a
      // pre-navigation snapshot -- take one last one before it's lost.
      if (COVERAGE_ON) {
        await page.send("Profiler.takePreciseCoverage").then(
          ({ result }) => page.coverageSnapshots.push(result),
        );
        await mkdir(COVERAGE_DIR, { recursive: true });
        await writeFile(
          join(COVERAGE_DIR, `${randomUUID()}.json`),
          JSON.stringify(page.coverageSnapshots),
        );
      }
      chrome.kill();
      // Chrome rewrites its profile on shutdown, so removing the directory
      // before the process is gone leaves it behind.
      await exited;
      await server.close();
      await rm(profileDir, { recursive: true, force: true });
    },
  };
}

export { launch, findChrome, COVERAGE_DIR, SITE_ROOT };
