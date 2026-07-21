// Integration tests against the real field-guide-02.txt (2002 edition) — guard
// invariants that matter for the app and catch regressions if the file is
// updated. Run: `node --test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseGuide, resolve, group, isBus } from "../core.js";

const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(here, "..", "field-guide-02.txt"), "utf8");
const idx = parseGuide(text);

test("guide parses into a plausible number of modules and options", () => {
  assert.ok(idx.byModule.size > 1400, `only ${idx.byModule.size} modules`);
  assert.ok(idx.byOption.size > 800, `only ${idx.byOption.size} options`);
});

test("every entry has a recognized-or-absent bus", () => {
  for (const e of idx.entries) {
    assert.ok(e.bus === "" || isBus(e.bus), `bad bus '${e.bus}' on ${e.module || e.option}`);
  }
});

test("blank-module (third-party) rows are not indexed by module", () => {
  assert.ok(!idx.byModule.has(""));
});

test("2002-only content parses: CTI bus, M-Bus, PN/Refs metadata", () => {
  const cti = idx.byModule.get("000034")[0];
  assert.equal(cti.bus, "CTI");
  assert.deepEqual(cti.pn, ["50-15487"]);
  assert.ok(cti.refs.length >= 1);
  assert.equal(idx.byModule.get("L2001")[0].bus, "M");   // M-Bus VAX module
});

test("continuation lines that repeat the module merge into description", () => {
  assert.match(idx.byModule.get("M7133")[0].description, /Revision D or earlier/);
});

test("RK611 groups as a complete 5-board option", () => {
  const stack = ["M7900", "M7901", "M7902", "M7903", "M7904"].map((m) => resolve(idx, m));
  const g = group(idx, stack).options.get("RK611");
  assert.deepEqual(g.knownBases, ["M7900", "M7901", "M7902", "M7903", "M7904"]);
  assert.equal(g.complete, true);
});

test("revision-suffixed module resolves exactly", () => {
  const r = resolve(idx, "G401-YA");
  assert.equal(r.approx, false);
  assert.equal(r.entries[0].option, "MS11-BR");
});

test("unknown number resolves to no entries", () => {
  assert.deepEqual(resolve(idx, "M9999").entries, []);
});
