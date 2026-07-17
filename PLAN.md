# Field guide app — plan

A client-side JS app (GitHub Pages, `field-guide.pdp8.se`) that identifies PDP-11 /
VAX Q-bus and UNIBUS boards. Two eventual halves:

1. **Read** the module number off a board's handle (image recognition).
2. **Look it up** in `field-guide-02.txt` and present what the hardware is.

No build tooling: the app fetches and parses the read-only `field-guide-02.txt` at
runtime, keeping that file the single source of truth. (`field-guide-99.txt`, the
1999 edition, is kept for reference; the app uses the 2002 edition.)

## Core use case

A user with a stack of unknown boards enters/scans their module numbers. The app:
- identifies each board,
- bundles boards into the **option** they belong to (even if some are missing),
- suggests the **system** the options fit into,
- indicates when enough is present to form a complete option / system.

## Data model (from `field-guide-02.txt`, Megan Gentry, 27 Jul 2002)

- Two tables: a **module list** and a **third-party option list** (blank MODULE),
  split by `#####` and spaced-caps headings; file ends at `-*-EndText-*-`.
- Table columns: `MODULE  OPTION  BUS  DESCRIPTION`.
- **MODULE** — board number on the handle (OCR target). A revision suffix (`-YA`,
  `-EB`, …) is a variant of the same board, not a separate board. ~1464 numbers.
- **OPTION** — DEC option name; `--------` means none. ~882 options; many span >1 board.
- **BUS** — `U` UNIBUS, `Q` Qbus, `CTI` CTI-Bus (Professional), `M` M-Bus, `D` D-Bus,
  `Q/U` both, `-` none.
- **DESCRIPTION** — free text; **continuation lines repeat the module number** and hold
  wraps plus `PN:` (part number) and `Refs:` (documentation) metadata.
- Entries are delimited by blank lines (the only reliable boundary in 2002).
- Boards collapse by **base module number** for membership/completeness; revisions are
  listed on the base board's row.
- Abbreviations kept verbatim for now; glossary is a later phase.

## Architecture

- `index.html` — UI shell + styling; three-column layout (input · results · export).
- `core.js` — pure logic: parse, index (by module / base / option), resolve, group,
  export text. No DOM — imported by both the app and the tests.
- `app.js` — fetch, DOM render, and file download; imports `core.js`.
- `test/` — Node built-in test runner (`node --test`), zero dependencies:
  `core.test.js` (fixture unit tests) + `guide.test.js` (real-file integration).
- `field-guide-02.txt` — read-only source data (2002 edition).

## Roadmap

### Phase 1 — list → presentation  (in progress)
- [x] Runtime parser (tolerant of tab/space columns, dupes, wrapped descriptions)
- [x] Indexes: by module, by base (suffix-insensitive), by option
- [x] Input: editable textarea, pre-filled sample stack
- [x] Output: option groups with present/missing members + complete/partial badge
- [x] Standalone-module cards; unknown-number list
- [x] Rough system hints mined from descriptions
- [x] Migrate parser to the 2002 edition (two tables, module-repeat continuations,
      CTI/M/D/- bus codes, PN:/Refs: metadata, third-party list)
- [x] Base-collapse revisions (a board is present if any revision is held)
- [x] Three-column layout (input · results · export)
- [x] Export: plain-text list grouped by option, optional missing boards (marked),
      timestamped, downloadable
- [ ] Curated option→system map (make system suggestion precise) — needs sources.
      Note: current heuristic hints don't distinguish a **system** (CPU/computer) from a
      **peripheral** (e.g. RK06 is a disk drive), so drives appear alongside computers.
      Fixing this needs the functional taxonomy (Phase 3) + the option→system map.
- [ ] Add a favicon (currently 404s)
- [ ] Third-party option list is parsed but not yet surfaced (no module to look up)
- [ ] **Quantities & set allocation.** Duplicate board numbers count as separate copies
      (default: treat each as unique). Given the per-board quantities for an option, pack
      them into as many **complete sets** as possible, then form the remainder into
      partial sets that are as complete as possible. Show the set breakdown (e.g. "2 full
      sets + 2 partial") in the center column and the export.

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
- [x] Hunt for and integrate later versions — 2002 edition found & adopted (likely latest)
