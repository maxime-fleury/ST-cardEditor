# Changelog

All notable changes to **ST Card Editor** are documented here.
Format roughly follows [Keep a Changelog](https://keepachangelog.com/) and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.5.5] - 2026-09-04

### Fixed
- **i18n unicode corruption (2.5.4 regression):** the 6-new-languages commit
  rewrote `js/i18n.js` through a wrong encoding, mangling every non-ASCII
  character in all 27 locales — Latin accents became broken bytes, and
  Cyrillic/CJK/Greek/Thai etc. were replaced with literal `?` (e.g. French
  showed `d�finie`, Thai showed `?????????`). Translations are now split into
  **one file per language** (`js/i18n/<lang>.js`), the 21 original locales
  were restored from the last clean revision, and the 6 new locales
  (ro/cs/sv/th/pt-pt/tl) were recovered/re-translated with correct diacritics
  and full Thai text.

## [2.5.4] - 2026-09-04

### Added
- **6 new languages** — Romanian, Czech, Swedish, Thai, Portuguese (PT),  and Filipino, selectable in the language dropdown and the translate dialog.
  Note: this release shipped with the unicode corruption fixed in 2.5.5.

## [2.5.3] - 2026-08-30

### Fixed
- Chat transcript could **stack duplicate messages** when switching cards mid-chat, and card metadata could go stale after a grouped (multi-card) AI reply failed — transcript and session state now reset/sync correctly in both cases.
- **Token budget badge** went stale when editing alternate greetings or lorebook entries; it now re-counts after every greeting/lorebook change, and no longer over-counts while the Extensions JSON is invalid (rejected text was being counted as data).
- **Token auto-fill chips** stayed clickable in Preview mode, silently editing a hidden field; they now hide in Preview and return in Edit. Each token insert is a genuine native edit, so **Ctrl+Z in the field reverts exactly the inserted token**.
- **Library letter-groups** that are collapsed stay collapsed across search, filter, and sort re-renders within a session.
- **Drag-to-reorder** no longer snaps back the first time the sort dropdown and applied order disagree (they now default consistently), is safely ignored while auto-sorting, and tolerates drag-start events that carry no `dataTransfer`.

## [2.5.1] - 2026-08-30

### Added
- **Raw JSON Extensions editor** (Advanced tab) — edit the V2/V3 `extensions`
  object directly with inline JSON validation. Invalid JSON is surfaced and
  never written to the card, and changes participate in per-field undo/redo.
- **`{{char}}` / `{{user}}` token auto-fill** — one-click chips next to the
  First Message and Scenario fields insert the token at the cursor.
- **Whole-card token budget** — a badge in the editor header shows estimated
  tokens and characters across every field, alternate greetings, lorebook
  entries, and the extensions JSON (warns when it exceeds the output-token
  limit).

### Fixed
- Card library defaulted to a mismatch: the sort dropdown showed **Manual**
  while cards were actually sorted alphabetically, so **drag-to-reorder snapped
  back** on first use. Manual is now the true default, and the chosen sort mode
  is remembered between sessions.
- Waifu tab: **Fetch** could keep re-running the last “Girls + Boys” mixed pack
  instead of the selected source/gender search; it now always performs a
  normal source fetch.
- Waifu tab: AniList characters with an unknown (null) gender were labelled
  “Male”; they now show the requested filter or `?` instead of a wrong label.

## [2.5.0] - 2026-08-30

### Added — Appearance design system (Settings → Appearance)
- **Accent preset gallery** — six curated accent themes (Slate, Cosmic Purple,
  Magenta, Emerald, Solar, Ocean) with live swatches, on top of the existing
  free color picker and light/dark theme accent overrides.
- **Glass density** control (Subtle / Default / Bold) for the panel translucency.
- **Card radius** control (Compact / Rounded / Pill).
- **Edge vignette** toggle.
- All appearance preferences are persisted, applied immediately on
  startup/theme-switch, and carried through workspace export/import.

### Added — Collapsible panels & Focus mode
- **Collapse buttons** in both the Card Library and AI Assistant headers that
  turn a panel into a slim icon rail; an **edge chevron** appears to expand it
  back.
- **Focus / Immersive mode** — one button in the navbar (or `Alt+F`) collapses
  both side panels while you edit; `Ctrl+\` toggles just the AI panel.
- Per-side collapse state is persisted across reloads.
- New rows in the Shortcuts modal for the new bindings.

### Added — Unified motion layer
- **Hover lift** on library card rows, a **soft glow** on the active editor tab,
  and a **shimmer skeleton** while the AI streams a response.
- Everything is gated behind `prefers-reduced-motion` like the existing 3D tilt.

### Added — Predictable editing feedback
- **Per-field counters** are now lint-style pills that flip **amber** (>75% of
  the output-token limit) then **red** (over), with an explanatory tooltip.
- An **amber “modified” dot** appears on the active card while edits are
  unsaved (alongside the existing Save-button dirty state + “Saved” flash).

### Added — Offline & release hygiene
- **`js/waifuTab.js`** is now precached by the service worker (fixes an offline
  regression where the Waifu tab went missing when offline).
- New **`scripts/check-assets.mjs`** CI guard verifies every referenced asset
  exists, is in the SW shell, has uniform `?v=` cache-busters, and that the
  navbar badge, README badge and SW `CACHE_PREFIX` all match the version in
  `package.json` (single source of truth).
- Version centralized at **2.5.0** and bumped uniformly across package.json,
  README, the cache prefix and all cache-busters.

### Changed — ES modules & single-bundle build
- All `js/*.js` files are now **ES modules** (each exposes its API and still
  sets its `window` global for the classic consumers), replacing the previous
  plain-global scripts.
- `i18n.js` **exports its `translations` object**, and `check-i18n.mjs` now
  imports the real module instead of regex-parsing the 12k-line dictionary — so
  the parity check can never drift from runtime behavior.
- New **`bun run build`** step (`scripts/build.mjs`) bundles the whole app into
  **one entry module, `js/app.js`**, loaded by a single `<script>` tag with one
  `?v=` buster. This removes the load-order coupling between 13 separate
  script tags and lets the SW shell and cache-busters derive from a single
  source of truth.
- `check-assets.mjs` verifies the committed bundle is **fresh** (byte-identical
  to a rebuild from current sources), so a forgotten rebuild fails CI instead of
  shipping stale logic.

### Added — Unit tests
- `bun test tests/unit` — 14 tests (33ms) for tokenizer heuristics and the
  card parsing/PNG-chunk engine, far cheaper than the browser suite.
- Playwright regression tests for appearance presets and
  collapse/focus/dirty-dot; full suite **11 passed, 2 skipped** (live-model).

### Fixed
- Library header overflow clipped the collapse button on long localized titles
  (now truncated with an ellipsis).
- Native dropdowns (language, glass density, radius, provider, model) rendered
  with a white popup in dark mode — fixed via `color-scheme` plus dark
  `form-select`/`option` styling across all browsers.

[Unreleased]: https://github.com/maxime-fleury/ST-cardEditor/compare/v2.5.5...HEAD
[2.5.5]: https://github.com/maxime-fleury/ST-cardEditor/releases/tag/v2.5.5
[2.5.4]: https://github.com/maxime-fleury/ST-cardEditor/releases/tag/v2.5.4
[2.5.3]: https://github.com/maxime-fleury/ST-cardEditor/releases/tag/v2.5.3
[2.5.1]: https://github.com/maxime-fleury/ST-cardEditor/releases/tag/v2.5.1
[2.5.0]: https://github.com/maxime-fleury/ST-cardEditor/releases/tag/v2.5.0