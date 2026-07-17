"use strict";

// Unit tests for the pure parsing/lookup logic, run against a synthetic fixture
// so they don't depend on the real guide's contents. Run: `node --test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseEntryLine, parseGuide, resolve, group, systemHints, busLabel, baseOf,
} from "../core.js";

// Fixture mirrors the real format: header + rule, blank-separated entries, a
// tab-indented row, a comma-wrapped option, a Q/U row, a bus-less row, a wrapped
// description, a single-board option with a revision (MS11-BR: G401 + G401-YA),
// a multi-board option where one board has a revision (KL11: M780 + rev, M782),
// a plain multi-board option (RK611), and a trailing signature block to ignore.
const FIXTURE = [
  "MODULE      OPTION     BUS  DESCRIPTION",
  "------      --------   ---  ------------------------------------------",
  "A012        ADV11-A     Q   16-channel 12-bit A/D",
  "",
  "G102        \t\tU   Sense inhibit card for 11/15",
  "",
  "G401        MS11-BR     U   4-Kword 16-bit MOS RAM (11/45)",
  "G401-YA     MS11-BR     U   4-Kword 18-bit MOS RAM (11/45)",
  "",
  "M7973       VT30-C, -D U   VT30 timing and CSR",
  "",
  "M8190-AE    KDJ11-BF    Q/U   11/83-84 CPU J11 CPU 18MHz",
  "",
  "M7700       RK05        unit-sel/photoamp/sector-counter",
  "",
  "M7081       LA120       - LA120 control, hex",
  "                            with a wrapped second line",
  "",
  "M780        KL11        U   Teletype transmitter & receiver, 110 baud",
  "M780-YC     KL11        U   300 baud M780",
  "M782        KL11        U   Interrupt control, 6-bits",
  "",
  "M7900       RK611       U   RK06/07 Unibus interface",
  "M7901       RK611       U   RK06/07 register module",
  "",
  "-- ",
  " Signature block <sig@example.com> must not be parsed",
].join("\n");

test("parseEntryLine: option + bus + description", () => {
  assert.deepEqual(parseEntryLine("A012        ADV11-A     Q   16-channel 12-bit A/D"),
    { module: "A012", option: "ADV11-A", bus: "Q", description: "16-channel 12-bit A/D" });
});

test("parseEntryLine: blank option (bus is first token)", () => {
  const e = parseEntryLine("G102        \t\tU   Sense inhibit card for 11/15");
  assert.equal(e.option, "");
  assert.equal(e.bus, "U");
  assert.equal(e.description, "Sense inhibit card for 11/15");
});

test("parseEntryLine: comma-wrapped two-word option with buried bus", () => {
  const e = parseEntryLine("M7973       VT30-C, -D U   VT30 timing and CSR");
  assert.equal(e.option, "VT30-C, -D");
  assert.equal(e.bus, "U");
  assert.equal(e.description, "VT30 timing and CSR");
});

test("parseEntryLine: Q/U both-bus, and U/Q normalizes to Q/U", () => {
  assert.equal(parseEntryLine("M8190-AE  KDJ11-BF  Q/U  11/83-84 CPU").bus, "Q/U");
  assert.equal(parseEntryLine("M0000  OPT  U/Q  desc").bus, "Q/U");
});

test("parseEntryLine: bus genuinely absent", () => {
  const e = parseEntryLine("M7700       RK05        unit-sel/photoamp/sector-counter");
  assert.equal(e.option, "RK05");
  assert.equal(e.bus, "");
  assert.equal(e.description, "unit-sel/photoamp/sector-counter");
});

test("parseEntryLine: leading dash bullet is stripped from description", () => {
  assert.equal(parseEntryLine("M7081  LA120  - LA120 control").description, "LA120 control");
});

test("busLabel maps codes; unknown -> 'bus n/a'", () => {
  assert.equal(busLabel("U"), "UNIBUS");
  assert.equal(busLabel("Q"), "Q-bus");
  assert.equal(busLabel("Q/U"), "Q-bus / UNIBUS");
  assert.equal(busLabel(""), "bus n/a");
});

test("baseOf strips a revision suffix and upper-cases; keeps odd names whole", () => {
  assert.equal(baseOf("G401-YA"), "G401");
  assert.equal(baseOf("M780-YC"), "M780");
  assert.equal(baseOf("m105"), "M105");
  assert.equal(baseOf("MLSI-TM11"), "MLSI-TM11");   // no letters+digits base -> kept whole
});

test("parseGuide: parses body, ignores signature, indexes correctly", () => {
  const idx = parseGuide(FIXTURE);
  assert.equal(idx.entries.length, 13);                      // signature not counted
  assert.ok(idx.byModule.has("G401") && idx.byModule.has("G401-YA"));
  assert.equal(idx.byBase.get("G401").length, 2);            // both share base G401
  assert.deepEqual(idx.byOption.get("MS11-BR").map((e) => e.module), ["G401", "G401-YA"]);
  assert.ok(!idx.byModule.has("SIGNATURE"));
});

test("parseGuide: wrapped description lines are joined", () => {
  const idx = parseGuide(FIXTURE);
  assert.equal(idx.byModule.get("M7081")[0].description,
    "LA120 control, hex with a wrapped second line");
});

test("resolve: exact match, then suffix-insensitive fallback marked approx", () => {
  const idx = parseGuide(FIXTURE);
  const exact = resolve(idx, "g401");
  assert.equal(exact.approx, false);
  assert.deepEqual(exact.entries.map((e) => e.module), ["G401"]);

  const approx = resolve(idx, "G401-ZZ");                    // suffix not present
  assert.equal(approx.approx, true);
  assert.deepEqual(approx.entries.map((e) => e.module).sort(), ["G401", "G401-YA"]);

  assert.deepEqual(resolve(idx, "M9999").entries, []);       // unknown
  assert.equal(resolve(idx, "   "), null);                   // empty query
});

test("group: revisions collapse onto one base board (MS11-BR = 1 board)", () => {
  const idx = parseGuide(FIXTURE);
  const g = group(idx, [resolve(idx, "G401-YA")]).options.get("MS11-BR");
  assert.deepEqual(g.knownBases, ["G401"]);       // G401 + G401-YA = one board
  assert.equal(g.boards[0].present, true);
  assert.deepEqual(g.boards[0].revisions.map((e) => e.module), ["G401-YA"]);
});

test("group: a board counts as present when only a revision is held (the KL11 bug)", () => {
  const idx = parseGuide(FIXTURE);
  // Hold only M780-YC (a revision of M780) — M780 must read present, not missing.
  const g = group(idx, [resolve(idx, "M780-YC")]).options.get("KL11");
  assert.deepEqual(g.knownBases, ["M780", "M782"]);   // revisions are not separate boards
  const m780 = g.boards.find((b) => b.base === "M780");
  assert.equal(m780.present, true);
  assert.equal(g.boards.find((b) => b.base === "M782").present, false);
  assert.equal(g.presentCount, 1);
  assert.equal(g.complete, false);
});

test("group: complete multi-board option, plus standalone and unknown", () => {
  const idx = parseGuide(FIXTURE);
  const full = group(idx, [resolve(idx, "M7900"), resolve(idx, "M7901")]);
  assert.equal(full.options.get("RK611").complete, true);

  const withUnknown = group(idx, [resolve(idx, "M9999")]);
  assert.deepEqual(withUnknown.unknown, ["M9999"]);
});

test("systemHints: mines model references from descriptions", () => {
  const idx = parseGuide(FIXTURE);
  const hints = Object.fromEntries(systemHints(
    [resolve(idx, "G401"), resolve(idx, "G401-YA"), resolve(idx, "G102")]));
  assert.equal(hints["PDP-11/45"], 2);   // both MS11-BR rows say (11/45)
  assert.equal(hints["PDP-11/15"], 1);   // the G102 row
});
