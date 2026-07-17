"use strict";

// Field guide app — DOM + fetch. All parsing/lookup logic lives in core.js.

import { parseGuide, resolve, group, systemHints, busLabel, buildExport } from "./core.js";

const GUIDE_URL = "field-guide-02.txt";

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

function render(resolvedList) {
  const out = document.getElementById("results");
  out.innerHTML = "";
  const { options, standalone, unknown } = group(idx, resolvedList);

  // Options (grouped by board; revisions collapse onto their base board).
  for (const [name, g] of options) {
    const card = el("div", "option");
    const badge = g.knownBases.length > 1
      ? `<span class="badge ${g.complete ? "complete" : "partial"}">${
          g.complete ? "complete option" : `${g.presentCount}/${g.knownBases.length} boards`}</span>`
      : "";
    card.appendChild(el("h2", null,
      `${esc(name)} <span class="badge bus">${busLabel(g.bus)}</span>${badge}`));

    for (const b of g.boards) {
      const row = el("div", "mod" + (b.present ? "" : " missing"));
      let html = `<span class="num">${esc(b.base)}</span> ` +
        `<span class="desc">${esc(b.canonical.description)}</span>`;
      if (b.revisions.length) {
        const revs = b.revisions.map((r) => esc(r.module.slice(b.base.length))).join(", ");
        html += ` <span class="revs">rev: ${revs}</span>`;
      }
      row.innerHTML = html;
      card.appendChild(row);
    }
    out.appendChild(card);
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

document.getElementById("input").value = SAMPLE;
document.getElementById("lookup").addEventListener("click", runLookup);
document.getElementById("output").addEventListener("click", runExport);
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
