"use strict";

// Field guide app — DOM + fetch. All parsing/lookup logic lives in core.js.
// The input box's contents are remembered across navigation (see
// REMEMBERED_INPUT_KEY below), so this stays useful after a detour to Scan
// or the landing page rather than resetting to the sample list.

import { parseGuide, resolve, group, systemHints, busLabel, buildExport } from "./core.js";

const GUIDE_URL = "field-guide-02.txt";

// Numbers handed off from ocr.js's "Handoff to identify" button land here.
const SCAN_HANDOFF_KEY = "fieldGuideScan";

// Remembers what's in the input box across navigation (or closing the tab
// entirely) so leaving Identify and coming back — e.g. via the Scan
// shortcut — doesn't lose your list. Plain text, so localStorage (unlike
// ocr.js's IndexedDB use for the scan photo) is more than enough.
const REMEMBERED_INPUT_KEY = "fieldGuideIdentifyInput";

// A demo stack showing the main cases:
//  - a complete multi-module option (RK611 = M7900..M7904)
//  - a partial option (KA11, the 11/20 CPU set — only a few boards present)
//  - a revision suffix (G401-YA)
//  - a standalone board (M105, a KL11 device selector)
//  - an unknown number (M9999)
const SAMPLE = [
  "M7900", "M7901", "M7902", "M7903", "M7904",
  "M224", "M225", "M721",
  "G401-YA",
  "M105",
  "M9999",
].join("\n");

let idx = null;            // { entries, byModule, byBase, byOption }
let lastResolved = [];     // result of the most recent lookup (for export)

// --- rendering ----------------------------------------------------------

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}
function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// One board row. Duplicate copies (count > 1 — the same board scanned/typed
// more than once) get a "×N" badge alongside its description.
function boardRowHtml(b) {
  let html = `<span class="num">${esc(b.base)}</span> ` +
    `<span class="desc">${esc(b.canonical.description)}</span>`;
  if (b.count > 1) html += ` <span class="qty">×${b.count}</span>`;
  if (b.revisions.length) {
    const revs = b.revisions.map((r) => esc(r.module.slice(b.base.length))).join(", ");
    html += ` <span class="revs">rev: ${revs}</span>`;
  }
  return html;
}

function appendBoardRows(card, boards) {
  for (const b of boards) {
    const row = el("div", "mod" + (b.present ? "" : " missing"));
    row.innerHTML = boardRowHtml(b);
    card.appendChild(row);
  }
}

// One option can render as two cards: the primary listing (complete sets, or
// today's familiar x/y-present partial when no full set can be assembled yet)
// and, only when duplicate boards are left over after forming g.fullSets
// complete sets, a second "leftover" card — shaped exactly like a normal
// partial option, since from here it just IS one: the boards that didn't
// make it into a complete set, some present (surplus copies) and some
// "missing" (fully used up by the complete sets already pulled out).
function appendOptionCards(out, name, g) {
  const card = el("div", "option");
  const badge = g.knownBases.length > 1
    ? `<span class="badge ${g.complete ? "complete" : "partial"}">${
        g.complete
          ? (g.fullSets > 1 ? `×${g.fullSets} complete options` : "complete option")
          : `${g.presentCount}/${g.knownBases.length} boards`}</span>`
    : (g.boards[0].count > 1 ? `<span class="badge qty">×${g.boards[0].count}</span>` : "");
  card.appendChild(el("h2", null,
    `${esc(name)} <span class="badge bus">${busLabel(g.bus)}</span>${badge}`));
  appendBoardRows(card, g.boards);
  out.appendChild(card);

  if (g.leftover) {
    const leftCard = el("div", "option leftover");
    const leftBadge =
      `<span class="badge partial">${g.leftover.presentCount}/${g.knownBases.length} boards</span>`;
    leftCard.appendChild(el("h2", null,
      `${esc(name)} <small>remaining</small> <span class="badge bus">${busLabel(g.bus)}</span>${leftBadge}`));
    appendBoardRows(leftCard, g.leftover.boards);
    out.appendChild(leftCard);
  }
}

function render(resolvedList) {
  const out = document.getElementById("results");
  out.innerHTML = "";
  const { options, standalone, unknown } = group(idx, resolvedList);

  // Options (grouped by board; revisions collapse onto their base board).
  for (const [name, g] of options) {
    appendOptionCards(out, name, g);
  }

  // Standalone modules (no option grouping).
  if (standalone.length) {
    const card = el("div", "option");
    card.appendChild(el("h2", null, "Individual modules"));
    for (const e of standalone) {
      const row = el("div", "mod");
      row.innerHTML = `<span class="num">${esc(e.module)}</span> ` +
        `<span class="badge bus">${busLabel(e.bus)}</span> ` +
        `<span class="desc">${esc(e.description)}</span>`;
      card.appendChild(row);
    }
    out.appendChild(card);
  }

  // System hints.
  const hints = systemHints(resolvedList);
  if (hints.length) {
    const box = el("div", "hints");
    box.appendChild(el("h2", null, "System hints"));
    box.appendChild(el("div", null,
      hints.map(([k, n]) => `${esc(k)} <small>(${n})</small>`).join(" · ")));
    box.appendChild(el("p", null,
      "<small>Heuristic — mined from board descriptions. A curated option→system map " +
      "will make this precise.</small>"));
    out.appendChild(box);
  }

  // Unknown numbers.
  if (unknown.length) {
    const card = el("div", "option");
    card.appendChild(el("h2", null, "Not found"));
    card.appendChild(el("div", "unknown mod", unknown.map(esc).join(", ")));
    out.appendChild(card);
  }

  if (!options.size && !standalone.length && !unknown.length) {
    out.appendChild(el("p", null, "Nothing to look up."));
  }
}

function runLookup() {
  const raw = document.getElementById("input").value.split(/\r?\n/);
  lastResolved = raw.map((q) => resolve(idx, q)).filter(Boolean);
  render(lastResolved);
  updatePreview();
}

// Current export text (also what the Output button downloads).
function currentExport() {
  const includeMissing = document.getElementById("include-missing").checked;
  return buildExport(idx, lastResolved, { includeMissing, exportedAt: timestamp() });
}

function updatePreview() {
  if (!idx) return;
  document.getElementById("export-preview").textContent = currentExport();
}

// --- export -------------------------------------------------------------

function pad2(n) { return String(n).padStart(2, "0"); }
function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function runExport() {
  if (!idx) return;
  downloadText("field-guide-export.txt", currentExport());
}

// --- boot ---------------------------------------------------------------

// A scan handed off from ocr.js wins first (consumed once — removed so a
// later plain visit doesn't keep reusing it); otherwise fall back to
// whatever was last remembered, then finally the built-in sample. Whichever
// wins is also what gets remembered, so a first-ever visit (sample) and a
// scan handoff both become "the remembered state" for next time too.
// Explicit null checks (not ||): a remembered value of "" — the Clear button
// — must stay empty, not fall through to the sample like a falsy "" would.
const inputEl = document.getElementById("input");
const handoff = sessionStorage.getItem(SCAN_HANDOFF_KEY);
if (handoff != null) sessionStorage.removeItem(SCAN_HANDOFF_KEY);
const remembered = localStorage.getItem(REMEMBERED_INPUT_KEY);
inputEl.value = handoff != null ? handoff : (remembered != null ? remembered : SAMPLE);
localStorage.setItem(REMEMBERED_INPUT_KEY, inputEl.value);

inputEl.addEventListener("input", () => {
  localStorage.setItem(REMEMBERED_INPUT_KEY, inputEl.value);
});

function clearInput() {
  if (!inputEl.value.trim()) return;
  if (!confirm("Clear the module list?")) return;
  inputEl.value = "";
  localStorage.setItem(REMEMBERED_INPUT_KEY, "");
  runLookup();
}
document.getElementById("clear").addEventListener("click", clearInput);

document.getElementById("lookup").addEventListener("click", runLookup);
document.getElementById("download").addEventListener("click", runExport);
document.getElementById("include-missing").addEventListener("change", updatePreview);

fetch(GUIDE_URL)
  .then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); })
  .then((text) => {
    idx = parseGuide(text);
    document.getElementById("status").textContent =
      `Loaded ${idx.byModule.size} module numbers across ${idx.byOption.size} options.`;
    runLookup();
  })
  .catch((err) => {
    document.getElementById("status").textContent =
      "Failed to load field guide: " + err.message;
  });
