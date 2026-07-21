// Turns the raw V8 coverage dumped by harness.mjs (COVERAGE=1) into the same
// style of line/branch/function report `node --test --experimental-test-coverage`
// prints for the unit suite -- v8-to-istanbul is the converter Node's own
// coverage support is built on, so this reuses it rather than re-deriving
// line/branch percentages from raw byte ranges by hand.
//
// Each *.spec.mjs run (a separate browser instance) dumps its own snapshots
// to .coverage-browser/<uuid>.json; this reads all of them, converts every
// snapshot through v8-to-istanbul, and merges the per-file results with
// istanbul-lib-coverage -- which is what makes summing counts across many
// page reloads someone else's already-correct problem instead of ours.
//
// Run: `npm run test:browser:coverage` (runs the specs with COVERAGE=1, then
// this). Requires the specs to have been run with COVERAGE=1 first.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import v8ToIstanbul from "v8-to-istanbul";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import { COVERAGE_DIR, SITE_ROOT } from "./harness.mjs";

// Only the app's own served modules count -- not test/ (never loaded as a
// script by the pages under test, but excluded explicitly rather than relied
// upon) and not node_modules/.
function isAppScript(pathname) {
  return pathname.endsWith(".js")
    && !pathname.startsWith("/test/")
    && !pathname.startsWith("/node_modules/");
}

async function main() {
  let dumpFiles;
  try {
    dumpFiles = (await readdir(COVERAGE_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    dumpFiles = [];
  }
  if (dumpFiles.length === 0) {
    console.error(
      `No coverage dumps found in ${COVERAGE_DIR}.\n`
      + "Run the specs with COVERAGE=1 first (npm run test:browser:coverage does this).",
    );
    process.exitCode = 1;
    return;
  }

  const coverageMap = libCoverage.createCoverageMap({});
  const sourceCache = new Map(); // local file path -> source text, read once each

  for (const dumpFile of dumpFiles) {
    const snapshots = JSON.parse(await readFile(join(COVERAGE_DIR, dumpFile), "utf8"));
    for (const snapshot of snapshots) {
      for (const entry of snapshot) {
        let pathname;
        try {
          pathname = new URL(entry.url).pathname;
        } catch {
          continue; // not a URL at all (e.g. "" for the page's own inline scope)
        }
        if (!isAppScript(pathname)) continue;

        const localPath = join(SITE_ROOT, pathname);
        const relPath = relative(SITE_ROOT, localPath);
        if (!sourceCache.has(localPath)) {
          try {
            sourceCache.set(localPath, await readFile(localPath, "utf8"));
          } catch {
            continue; // served from somewhere v8-to-istanbul can't read back
          }
        }

        const converter = v8ToIstanbul(relPath, 0, { source: sourceCache.get(localPath) });
        await converter.load();
        converter.applyCoverage(entry.functions);
        coverageMap.merge(converter.toIstanbul());
      }
    }
  }

  if (coverageMap.files().length === 0) {
    console.error("Coverage dumps existed, but none of them covered an app module.");
    process.exitCode = 1;
    return;
  }

  const context = libReport.createContext({ coverageMap, dir: SITE_ROOT });
  reports.create("text", {}).execute(context);
}

main();
