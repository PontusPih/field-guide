"use strict";

// Unit tests for the pure parsing/lookup logic, run against a synthetic fixture
// in the 2002 guide format. Run: `node --test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseHeaderLine, parseGuide, resolve, group, systemHints, busLabel, baseOf, buildExport,
} from "../core.js";

// Fixture mirrors the 2002 format: two tables (module list + third-party list)
// separated by "#####" and a spaced-caps heading; blank-line-separated entries;
// continuation lines that repeat the module number; PN:/Refs: metadata; CTI/M/-
// bus codes; a "--------" (no option) row; a single-board option with a revision
// (MS11-BR), a multi-board option with a revision (KL11), a plain multi-board
// option (RK611); a blank-module third-party row; and the -*-EndText-*- terminator.
const FIXTURE = [
  "-*-Text-*-",
  "",
  "\tM O D U L E   L I S T",
  "",
  "------------------------------------------------------------------------------",
  "MODULE      OPTION     BUS  DESCRIPTION",
  "------      --------   ---  --------------------------------------------------",
  "000034      MCS11-CK   CTI  Bus option RAM (256Kbytes)",
  "000034\t\tPN: 50-15487",
  "000034\t\tRefs: EK-PC100-V1",
  "",
  "000064      --------   CTI  Quad serial line option",
  "",
  "G401        MS11-BR     U   4-Kword 16-bit MOS RAM (11/45)",
  "",
  "G401-YA     MS11-BR     U   4-Kword 18-bit MOS RAM (11/45)",
  "",
  "L2001       KA60        M   80NS CMOS SMP Dual CPU",
  "",
  "M7133       KDF11-UA    U   11/24 CPU board, line clock & 2 SLUs",
  "M7133                       (Revision D or earlier)",
  "",
  "M7736       LA36        -   LA36 HT VT TOF OPTION,DOUBLE",
  "",
  "M780        KL11        U   Teletype transmitter & receiver, 110 baud",
  "",
  "M780-YC     KL11        U   300 baud M780",
  "",
  "M782        KL11        U   Interrupt control, 6-bits",
  "",
  "M7900       RK611       U   RK06/07 Unibus interface",
  "",
  "M7901       RK611       U   RK06/07 register module",
  "",
  "M8190-AE    KDJ11-BF    Q/U  11/83-84 CPU",
  "",
  "#####",
  "",
  "\tT H I R D   P A R T Y   O P T I O N   L I S T",
  "",
  "------------------------------------------------------------------------------",
  "MODULE      OPTION     BUS  DESCRIPTION",
  "------      --------   ---  --------------------------------------------------",
  "            306A        Q   Grant Technology clock/calendar",
  "",
  "            440         Q   Data Systems Design (DSD) disk controller.",
  "                            Emulates RXV21.",
  "",
  "-*-EndText-*-",
].join("\n");

test("parseHeaderLine: option + CTI bus + description", () => {
  assert.deepEqual(parseHeaderLine("000034      MCS11-CK   CTI  Bus option RAM (256Kbytes)"),
    { module: "000034", option: "MCS11-CK", bus: "CTI", description: "Bus option RAM (256Kbytes)" });
});

test("parseHeaderLine: '--------' option column means no option", () => {
  assert.equal(parseHeaderLine("000064      --------   CTI  Quad serial line option").option, "");
});

test("parseHeaderLine: blank MODULE (third-party row)", () => {
  const e = parseHeaderLine("            306A        Q   Grant Technology clock/calendar");
  assert.equal(e.module, "");
  assert.equal(e.option, "306A");
  assert.equal(e.bus, "Q");
});

test("parseHeaderLine: '-' bus normalizes to empty; M-Bus and Q/U recognized", () => {
  assert.equal(parseHeaderLine("M7736  LA36  -  LA36 option").bus, "");
  assert.equal(parseHeaderLine("L2001  KA60  M  Dual CPU").bus, "M");
  assert.equal(parseHeaderLine("M8190-AE  KDJ11-BF  Q/U  CPU").bus, "Q/U");
  assert.equal(parseHeaderLine("M0000  OPT  U/Q  desc").bus, "Q/U");
});

test("busLabel maps all codes; unknown -> 'bus n/a'", () => {
  assert.equal(busLabel("U"), "UNIBUS");
  assert.equal(busLabel("Q"), "Q-bus");
  assert.equal(busLabel("Q/U"), "Q-bus / UNIBUS");
  assert.equal(busLabel("CTI"), "CTI-Bus");
  assert.equal(busLabel("M"), "M-Bus");
  assert.equal(busLabel("D"), "D-Bus");
  assert.equal(busLabel(""), "bus n/a");
});

test("baseOf strips a revision suffix and upper-cases; keeps odd names whole", () => {
  assert.equal(baseOf("G401-YA"), "G401");
  assert.equal(baseOf("M780-YC"), "M780");
  assert.equal(baseOf("m105"), "M105");
  assert.equal(baseOf("000034"), "000034");        // numeric CTI module, no base pattern
  assert.equal(baseOf("MLSI-TM11"), "MLSI-TM11");  // no letters+digits base -> kept whole
});

test("parseGuide: parses both tables, skips sections, stops at EndText", () => {
  const idx = parseGuide(FIXTURE);
  assert.equal(idx.entries.length, 15);              // 13 module-list + 2 third-party
  assert.ok(idx.byModule.has("G401") && idx.byModule.has("G401-YA"));
  assert.equal(idx.byBase.get("G401").length, 2);
  assert.deepEqual(idx.byOption.get("MS11-BR").map((e) => e.module), ["G401", "G401-YA"]);
  assert.ok(!idx.byModule.has("SIGNATURE"));
  assert.ok(!idx.byOption.has(""));                  // "--------" not indexed as an option
});

test("parseGuide: continuation lines merge into description", () => {
  const idx = parseGuide(FIXTURE);
  assert.equal(idx.byModule.get("M7133")[0].description,
    "11/24 CPU board, line clock & 2 SLUs (Revision D or earlier)");
});

test("parseGuide: PN and Refs captured, kept out of the description", () => {
  const e = parseGuide(FIXTURE).byModule.get("000034")[0];
  assert.deepEqual(e.pn, ["50-15487"]);
  assert.deepEqual(e.refs, ["EK-PC100-V1"]);
  assert.equal(e.description, "Bus option RAM (256Kbytes)");
});

test("parseGuide: third-party rows have blank module (option-only)", () => {
  const idx = parseGuide(FIXTURE);
  assert.ok(!idx.byModule.has(""));                  // blank module not indexed
  assert.ok(idx.byOption.has("306A"));
  assert.equal(idx.byOption.get("440")[0].description,
    "Data Systems Design (DSD) disk controller. Emulates RXV21.");
});

test("resolve: exact match, then suffix-insensitive fallback marked approx", () => {
  const idx = parseGuide(FIXTURE);
  const exact = resolve(idx, "g401");
  assert.equal(exact.approx, false);
  assert.deepEqual(exact.entries.map((e) => e.module), ["G401"]);

  const approx = resolve(idx, "G401-ZZ");
  assert.equal(approx.approx, true);
  assert.deepEqual(approx.entries.map((e) => e.module).sort(), ["G401", "G401-YA"]);

  assert.deepEqual(resolve(idx, "M9999").entries, []);
  assert.equal(resolve(idx, "   "), null);
});

test("group: revisions collapse onto one base board (MS11-BR = 1 board)", () => {
  const idx = parseGuide(FIXTURE);
  const g = group(idx, [resolve(idx, "G401-YA")]).options.get("MS11-BR");
  assert.deepEqual(g.knownBases, ["G401"]);
  assert.equal(g.boards[0].present, true);
  assert.deepEqual(g.boards[0].revisions.map((e) => e.module), ["G401-YA"]);
});

test("group: a board counts as present when only a revision is held (the KL11 bug)", () => {
  const idx = parseGuide(FIXTURE);
  const g = group(idx, [resolve(idx, "M780-YC")]).options.get("KL11");
  assert.deepEqual(g.knownBases, ["M780", "M782"]);
  assert.equal(g.boards.find((b) => b.base === "M780").present, true);
  assert.equal(g.boards.find((b) => b.base === "M782").present, false);
  assert.equal(g.presentCount, 1);
  assert.equal(g.complete, false);
});

test("group: complete multi-board option, plus unknown", () => {
  const idx = parseGuide(FIXTURE);
  const full = group(idx, [resolve(idx, "M7900"), resolve(idx, "M7901")]);
  assert.equal(full.options.get("RK611").complete, true);
  assert.deepEqual(group(idx, [resolve(idx, "M9999")]).unknown, ["M9999"]);
});

test("buildExport: grouped, sorted, timestamped; missing hidden then marked", () => {
  const idx = parseGuide(FIXTURE);
  const stack = ["M780-YC", "M782", "M9999"].map((m) => resolve(idx, m));  // both KL11 boards

  const without = buildExport(idx, stack, { includeMissing: false, exportedAt: "2026-07-18 14:30" });
  assert.match(without, /exported at 2026-07-18 14:30/);
  assert.match(without, /KL11 {2}\(UNIBUS\) {2}— complete/);      // both boards present (M780 via rev)
  assert.match(without, /Not found\n {4}M9999/);

  // A stack missing a board: M782 absent, includeMissing marks it.
  const partial = ["M780-YC"].map((m) => resolve(idx, m));
  const hidden = buildExport(idx, partial, { includeMissing: false });
  assert.doesNotMatch(hidden, /M782/);
  const shown = buildExport(idx, partial, { includeMissing: true });
  assert.match(shown, /M782.*<-- MISSING/);
});

test("systemHints: mines model references from descriptions", () => {
  const idx = parseGuide(FIXTURE);
  const hints = Object.fromEntries(systemHints(
    [resolve(idx, "G401"), resolve(idx, "G401-YA"), resolve(idx, "M7133")]));
  assert.equal(hints["PDP-11/45"], 2);   // both MS11-BR rows say (11/45)
  assert.equal(hints["PDP-11/24"], 1);   // the M7133 row
});
