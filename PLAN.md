# Field guide app — plan

A client-side JS app (GitHub Pages, `field-guide.pdp8.se`) that identifies PDP-11 /
VAX Q-bus and UNIBUS boards. Two eventual halves:

1. **Read** the module number off a board's handle (image recognition).
2. **Look it up** in `field-guide-99.txt` and present what the hardware is.

No build tooling: the app fetches and parses the read-only `field-guide-99.txt` at
runtime, keeping that file the single source of truth.

## Core use case

A user with a stack of unknown boards enters/scans their module numbers. The app:
- identifies each board,
- bundles boards into the **option** they belong to (even if some are missing),
- suggests the **system** the options fit into,
- indicates when enough is present to form a complete option / system.

## Data model (from `field-guide-99.txt`)

- Table columns: `MODULE  OPTION  BUS  DESCRIPTION`. Body starts after the rule under
  the header; ends at the `--` signature block.
- **MODULE** — board number on the handle (OCR target); prefixes M/G/H/A/W/L, optional
  revision suffix e.g. `-YA`. ~1115 numbers.
- **OPTION** — DEC option name; may be blank. ~500 options; 143 span >1 module.
- **BUS** — `U` = UNIBUS, `Q` = Q-bus.
- **DESCRIPTION** — free text; wraps onto indented continuation lines.
- Option membership is inferred from the shared OPTION name; `(N of M)` markers exist
  but are rare, so "missing parts" is best-effort (reliable only where the guide lists
  the full set).
- Abbreviations kept verbatim for now; glossary is a later phase.

## Architecture

- `index.html` — UI shell + styling.
- `app.js` — fetch, parse, index (by module / base / option), lookup, render.
- `field-guide-99.txt` — read-only source data.

## Roadmap

### Phase 1 — list → presentation  (in progress)
- [x] Runtime parser (tolerant of tab/space columns, dupes, wrapped descriptions)
- [x] Indexes: by module, by base (suffix-insensitive), by option
- [x] Input: editable textarea, pre-filled sample stack
- [x] Output: option groups with present/missing members + complete/partial badge
- [x] Standalone-module cards; unknown-number list
- [x] Rough system hints mined from descriptions
- [ ] Curated option→system map (make system suggestion precise) — needs sources
- [x] Handle the dirty rows (recovered 7/17; 10 are genuinely bus-less)
- [ ] Add a favicon (currently 404s)

### Phase 2 — image recognition
- [ ] Capture / upload a board photo
- [ ] OCR the handle text (module number, optional revision)
- [ ] Feed recognized numbers into the Phase-1 lookup

### Phase 3 — presentation depth
- [ ] Abbreviation glossary / expansions
- [ ] Functional taxonomy (memory, disk ctrl, serial, A/D, CPU, …)
- [ ] Complete-system detection & indication

### Phase 4 — backplane layout
Once a set of cards is identified they usually pair with a specific **backplane** and
must be placed in a defined slot order. Show the backplane and where each card goes.
- [ ] Source backplane data (slot count, per-slot rules, card→slot mapping) — extra sources
- [ ] Map identified options/cards to their backplane(s)
- [ ] Render a backplane diagram with recommended card placement
- [ ] Flag misfits (card that doesn't belong / slot conflicts)

### Phase 5 — more cards & other series
Currently PDP-11 only (this one guide). Extend coverage and add other DEC series.
- [ ] Generalize the data model to multiple **series-tagged** source guides
- [ ] Add more PDP-11 cards as sources surface
- [ ] Add PDP-8 (and other series) guides; tag results by series
- [ ] Series filter / auto-detect series from a mixed stack

### Later / side effects
- [ ] Export a cleaned, normalized version of the field guide
- [ ] Hunt for and integrate later versions of the field guide
