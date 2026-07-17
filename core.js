"use strict";

// Field guide — pure logic (no DOM, no fetch). Imported by app.js (browser) and
// by the test suite (Node). Keeps the read-only field-guide-99.txt the source of
// truth: parsing turns it into lookup indexes at runtime.

// Bus codes used in the 2002 guide: U=UNIBUS, Q=Qbus, CTI=CTI-Bus (Professional),
// M=M-Bus, D=D-Bus, Q/U=both, "-"=no bus. normBus folds "-" to "" (no bus).
const BUS_CODES = new Set(["U", "Q", "Q/U", "U/Q", "CTI", "M", "D", "-"]);
export function isBus(s) {
  return BUS_CODES.has(s);
}
export function normBus(s) {
  if (s === "U/Q") return "Q/U";
  if (s === "-") return "";
  return s;
}
// The base module number identifies the board; anything after it is a revision.
// DEC numbers are letters+digits (M780, G401), so the base is that leading run;
// a suffix (-YA, -EB, …) is a revision. Third-party names without that shape
// (e.g. MLSI-TM11) have no revision and are kept whole.
export function baseOf(mod) {
  const up = String(mod).toUpperCase();
  const m = up.match(/^[A-Z]+\d+/);
  return m ? m[0] : up;
}
export function busLabel(bus) {
  if (bus === "U") return "UNIBUS";
  if (bus === "Q") return "Q-bus";
  if (bus === "Q/U") return "Q-bus / UNIBUS";
  if (bus === "CTI") return "CTI-Bus";
  if (bus === "M") return "M-Bus";
  if (bus === "D") return "D-Bus";
  return bus || "bus n/a";
}

// Parse the first line of an entry block into its columns. BUS is the lone bus
// token, which anchors the optional OPTION (before it) and DESCRIPTION (after it).
// The bus sits at token 0 (no option) or token 1 (one-word option); a comma-wrapped
// two-word option puts it at token 2. A line starting with whitespace has a blank
// MODULE (third-party list). "--------" in the option column means no option.
export function parseHeaderLine(line) {
  let module, rest;
  if (/^\s/.test(line)) {
    module = "";
    rest = line.trim();
  } else {
    const m = line.match(/^(\S+)\s+([\s\S]*)$/);
    if (!m) return { module: line.trim(), option: "", bus: "", description: "" };
    module = m[1];
    rest = m[2].trim();
  }
  if (!rest) return { module, option: "", bus: "", description: "" };

  const t = rest.split(/\s+/);
  let k = -1;
  if (isBus(t[0])) k = 0;
  else if (isBus(t[1])) k = 1;
  else if (t[0] && t[0].endsWith(",") && isBus(t[2])) k = 2;

  let option, bus, descTokens;
  if (k >= 0) {
    option = t.slice(0, k).join(" ");
    bus = normBus(t[k]);
    descTokens = t.slice(k + 1);
  } else {
    option = t[0] || "";
    bus = "";
    descTokens = t.slice(1);
  }
  if (/^-+$/.test(option)) option = "";        // "--------" placeholder = no option
  return { module, option, bus, description: descTokens.join(" ") };
}

function add(map, key, entry) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(entry);
}

// A line is not part of an entry: section dividers, headings, header row, rules.
function isSkippable(l) {
  return /^#/.test(l)
    || /^-{4,}\s+-{4,}/.test(l)
    || /^-{20,}\s*$/.test(l)
    || /^MODULE\s+OPTION/.test(l)
    || /^\s*[A-Z]( [A-Z])+/.test(l);          // spaced-caps heading, e.g. "M O D U L E"
}

// Parse the whole guide into indexes. Returns { entries, byModule, byBase, byOption }.
// Entries are blocks of consecutive non-blank lines: the first line carries the
// columns; later lines repeat the module (or are indented) and hold description
// wraps, "PN:" part numbers, and "Refs:" documentation references.
export function parseGuide(text) {
  const byModule = new Map();   // MODULE (upper) -> [entry]
  const byBase = new Map();     // base module (upper) -> [entry]
  const byOption = new Map();   // OPTION -> [entry]
  const entries = [];

  const lines = text.split("\n");
  let i = lines.findIndex((l) => /^-{4,}\s+-{4,}\s+-{2,}/.test(l));   // rule under header
  if (i < 0) i = 0;
  i += 1;

  let block = [];
  const flush = () => {
    if (!block.length) return;
    const head = parseHeaderLine(block[0]);
    const entry = {
      module: head.module, option: head.option, bus: head.bus,
      description: head.description, pn: [], refs: [],
    };
    for (let j = 1; j < block.length; j++) {
      let s = block[j];
      if (entry.module && s.startsWith(entry.module)) s = s.slice(entry.module.length);
      s = s.trim();
      if (!s) continue;
      if (/^PN:/i.test(s)) entry.pn.push(s.replace(/^PN:\s*/i, ""));
      else if (/^Refs:/i.test(s)) entry.refs.push(s.replace(/^Refs:\s*/i, ""));
      else entry.description += (entry.description ? " " : "") + s;
    }
    entries.push(entry);
    if (entry.module) {                          // third-party rows have no module
      add(byModule, entry.module.toUpperCase(), entry);
      add(byBase, baseOf(entry.module), entry);
    }
    if (entry.option) add(byOption, entry.option, entry);
    block = [];
  };

  for (; i < lines.length; i++) {
    const raw = lines[i].replace(/\s+$/, "");
    if (/^-\*-EndText/.test(raw)) { flush(); break; }
    if (raw.trim() === "") { flush(); continue; }
    if (isSkippable(raw)) { flush(); continue; }
    block.push(raw);
  }
  flush();

  return { entries, byModule, byBase, byOption };
}

// Resolve one user-entered number to matching guide entries. Falls back to a
// suffix-insensitive base match (marked approx) when the exact number is absent.
export function resolve(idx, query) {
  const q = String(query).trim().toUpperCase();
  if (!q) return null;
  if (idx.byModule.has(q)) return { query: q, entries: idx.byModule.get(q), approx: false };
  const base = baseOf(q);
  if (idx.byBase.has(base)) return { query: q, entries: idx.byBase.get(base), approx: true };
  return { query: q, entries: [], approx: false };
}

// Group resolved entries by option. A board is identified by its base module
// number; revisions (suffixes) collapse onto that board rather than counting as
// separate members. Each option gets its board list (present/missing, with
// revisions listed) and a complete flag. Also returns standalone modules and
// unknown numbers.
export function group(idx, resolvedList) {
  const options = new Map();
  const standalone = [];
  const unknown = [];

  for (const r of resolvedList) {
    if (!r) continue;
    if (r.entries.length === 0) { unknown.push(r.query); continue; }
    for (const e of r.entries) {
      if (e.option) {
        if (!options.has(e.option)) options.set(e.option, { presentBases: new Set() });
        options.get(e.option).presentBases.add(baseOf(e.module));
      } else {
        standalone.push(e);
      }
    }
  }

  for (const [name, g] of options) {
    const members = idx.byOption.get(name) || [];

    // Collapse members onto their base board; the bare (suffix-less) entry is the
    // board's canonical description, the rest are revisions.
    const boards = new Map();
    for (const e of members) {
      const b = baseOf(e.module);
      if (!boards.has(b)) boards.set(b, { base: b, canonical: null, entries: [] });
      const bd = boards.get(b);
      bd.entries.push(e);
      if (e.module.toUpperCase() === b) bd.canonical = e;
    }

    const boardList = [...boards.values()].map((bd) => {
      const canonical = bd.canonical || bd.entries[0];
      const revisions = bd.entries.filter((e) => e !== canonical);
      return { base: bd.base, canonical, revisions, present: g.presentBases.has(bd.base) };
    }).sort((a, b) => a.base.localeCompare(b.base));

    g.boards = boardList;
    g.knownBases = boardList.map((b) => b.base);
    g.presentCount = boardList.filter((b) => b.present).length;
    g.complete = boardList.length > 1 && boardList.every((b) => b.present);
    g.bus = members[0] ? members[0].bus : "";
  }

  return { options, standalone, unknown };
}

// Plain-text export of the looked-up modules, grouped by option and sorted.
// Missing boards are included (clearly marked) only when includeMissing is set.
// exportedAt is passed in (the browser stamps it) so this stays pure/testable.
export function buildExport(idx, resolvedList, { includeMissing = false, exportedAt = "" } = {}) {
  const { options, standalone, unknown } = group(idx, resolvedList);
  const lines = [`Field guide export — exported at ${exportedAt}`, ""];

  for (const name of [...options.keys()].sort((a, b) => a.localeCompare(b))) {
    const g = options.get(name);
    const status = g.knownBases.length > 1
      ? (g.complete ? "complete" : `${g.presentCount}/${g.knownBases.length} boards`)
      : "";
    lines.push(`${name}  (${busLabel(g.bus)})${status ? "  — " + status : ""}`);
    for (const b of g.boards) {
      if (!b.present && !includeMissing) continue;
      const rev = b.revisions.length
        ? `  [rev: ${b.revisions.map((r) => r.module.slice(b.base.length)).join(", ")}]`
        : "";
      const mark = b.present ? "" : "   <-- MISSING";
      lines.push(`    ${b.base}  ${b.canonical.description}${rev}${mark}`);
    }
    lines.push("");
  }

  if (standalone.length) {
    lines.push("Individual modules");
    for (const e of standalone) {
      lines.push(`    ${e.module}  (${busLabel(e.bus)})  ${e.description}`);
    }
    lines.push("");
  }

  if (unknown.length) {
    lines.push("Not found");
    lines.push("    " + unknown.join(", "));
    lines.push("");
  }

  return lines.join("\n");
}

// Mine PDP-11 / VAX model references from descriptions as a rough system hint.
export function systemHints(resolvedList) {
  const counts = new Map();
  const bump = (k) => counts.set(k, (counts.get(k) || 0) + 1);
  for (const r of resolvedList) {
    if (!r) continue;
    for (const e of r.entries) {
      const d = e.description || "";
      for (const m of d.matchAll(/\b11\/\d{2,3}\b/g)) bump("PDP-" + m[0]);
      for (const m of d.matchAll(/\buVAX(?:-[IV]+)?\b/gi)) bump(m[0].toUpperCase());
      for (const m of d.matchAll(/\bRK0[67]\b/g)) bump(m[0]);
      for (const m of d.matchAll(/\bRL0[12]\b/g)) bump(m[0]);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
