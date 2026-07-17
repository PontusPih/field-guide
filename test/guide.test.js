"use strict";

// Integration tests against the real field-guide-99.txt — guard invariants that
// matter for the app and catch regressions if the file is updated. Run: `node --test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseGuide, resolve, group, isBus } from "../core.js";

const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(here, "..", "field-guide-99.txt"), "utf8");
const idx = parseGuide(text);

test("guide parses into a plausible number of modules and options", () => {
  assert.ok(idx.byModule.size > 1000, `only ${idx.byModule.size} modules`);
  assert.ok(idx.byOption.size > 300, `only ${idx.byOption.size} options`);
});

test("every entry has a module and a recognized-or-absent bus", () => {
  for (const e of idx.entries) {
    assert.ok(e.module, "entry with empty module");
    assert.ok(e.bus === "" || isBus(e.bus), `bad bus '${e.bus}' on ${e.module}`);
  }
});

test("RK611 groups as a complete 5-board option", () => {
  const stack = ["M7900", "M7901", "M7902", "M7903", "M7904"].map((m) => resolve(idx, m));
  const g = group(idx, stack).options.get("RK611");
  assert.deepEqual(g.knownBases, ["M7900", "M7901", "M7902", "M7903", "M7904"]);
  assert.equal(g.complete, true);
});

test("KL11 has 3 boards; M780 baud revisions are not separate members", () => {
  const g = group(idx, [resolve(idx, "M780")]).options.get("KL11");
  assert.deepEqual(g.knownBases, ["M105", "M780", "M782"]);   // not M780-YB, -YC, …
  const m780 = g.boards.find((b) => b.base === "M780");
  assert.equal(m780.present, true);                            // present via the bare M780
  assert.ok(m780.revisions.length >= 5);                       // the baud-rate variants
});

test("revision-suffixed module resolves exactly", () => {
  const r = resolve(idx, "G401-YA");
  assert.equal(r.approx, false);
  assert.equal(r.entries[0].option, "MS11-BR");
});

test("previously-dirty rows now parse their bus", () => {
  assert.equal(resolve(idx, "M7973").entries[0].bus, "U");     // comma-wrapped option
  assert.equal(resolve(idx, "M8190-AE").entries[0].bus, "Q/U"); // both buses
});

test("unknown number resolves to no entries", () => {
  assert.deepEqual(resolve(idx, "M9999").entries, []);
});
