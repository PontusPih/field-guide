"use strict";

// Field guide — pure logic (no DOM, no fetch). Imported by app.js (browser) and
// by the test suite (Node). Keeps the read-only field-guide-99.txt the source of
// truth: parsing turns it into lookup indexes at runtime.

export function isBus(s) {
  return s === "U" || s === "Q" || s === "Q/U" || s === "U/Q";
}
export function normBus(s) {
  return s === "U/Q" ? "Q/U" : s;   // some rows list both buses
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
  return bus || "bus n/a";
}

// Split one table row into its columns. BUS is the lone U / Q / Q/U token, which
// anchors the optional OPTION (before it) and the DESCRIPTION (after it). The bus
// sits at token 0 (no option) or token 1 (one-word option); a few rows have a
// comma-wrapped two-word option, so also allow token 2 when token 0 ends in ",".
// Some rows genuinely omit the bus — then token 0 is the option, the rest is text.
export function parseEntryLine(line) {
  const m = line.match(/^(\S+)\s+([\s\S]*)$/);
  if (!m) return null;
  const module = m[1];
  const rest = m[2].trim();
  if (!rest) return null;
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
  const description = descTokens.join(" ").replace(/^-\s+/, "");   // drop a dash bullet
  return { module, option, bus, description };
}

function add(map, key, entry) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(entry);
}

// Parse the whole guide into indexes. Returns { entries, byModule, byBase, byOption }.
export function parseGuide(text) {
  const byModule = new Map();   // MODULE (upper) -> [entry]
  const byBase = new Map();     // base module (before first '-', upper) -> [entry]
  const byOption = new Map();   // OPTION -> [entry]
  const entries = [];

  const lines = text.split("\n");
  let i = lines.findIndex((l) => /^-{4,}\s+-{4,}\s+-{2,}/.test(l));   // rule under header
  if (i < 0) i = 0;
  i += 1;

  let current = null;
  const flush = () => {
    if (!current) return;
    entries.push(current);
    add(byModule, current.module.toUpperCase(), current);
    add(byBase, baseOf(current.module), current);
    if (current.option) add(byOption, current.option, current);
    current = null;
  };

  for (; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, "");
    if (/^--\s*$/.test(line)) break;          // signature block — end of table
    if (line.trim() === "") { flush(); continue; }
    if (/^\s/.test(line)) {                    // continuation of previous description
      if (current) current.description += " " + line.trim();
      continue;
    }
    flush();
    current = parseEntryLine(line);
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
