# Changelog

All notable changes to **ST Card Editor** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and versions
follow [Semantic Versioning](https://semver.org/).

## [2.4.0] - 2026-08-29

### Added
- **Editable AI prompts** — Settings → **AI Prompts** now exposes every prompt the app
  uses (assistant, full-card, wizard, all quick actions, tags, greetings and per-field
  system instructions) in one place, driven by a single registry so defaults stay in sync.
  Includes **Restore defaults**, and **Export / Import** so prompt settings can be shared
  (export fills in built-in defaults; values equal to a default are reverted on import).
- **Apply navigation** — every pending AI change joins a queue; the diff modal adds
  **Prev / Next** and a **"Change N of M"** counter so you can approve several responses
  without closing and re-clicking.
- **"Applied" marker** — applying a change badges that chat message/section with
  **Applied ✓** and disables its apply button.
- **Installable PWA** — web app manifest + `any`/`maskable` icons + `apple-touch-icon`,
  so the editor can be added to the home screen.
- **AI Suggest tags** — one-click quick action that asks the model for a JSON tag array
  and **merges** the suggestions into the existing tags (never replaces curated ones).
- **End-to-end Playwright smoke suite** (`tests/`) covering the regression classes found by
  earlier bug hunts; wired into a new CI `check` job on every push and PR.
- **Dependabot** for GitHub Actions and npm dev dependencies.
- **Smarter format fallback** — recognizes llama.cpp-style servers that reject
  `response_format: json_object` with `"error": "<string>"` and retries as plain text.

### Fixed
- **Multi-field chat responses collapsed to ~0px** — an `overflow: hidden` card inside the
  flex-column scroll list hid the field-edit content and its **Review & Apply** button once
  the transcript grew. Height now resolves from content.
- **Every PNG export was corrupt** — the deduped chara-chunk rewrite dropped the 8-byte PNG
  signature, so exported cards failed to re-import. Signature is restored.
- **Stale chat sessions forked duplicates** — an expired session was both refreshed and
  duplicated instead of left alone; now only the new session is created.
- **Multi-file import via Browse only imported the first file** (`input.value` reset emptied
  the live `FileList` mid-iteration). The file list is snapshotted up front.
- **Spec-conformant lorebook entries lost keywords** — `keys` / `secondary_keys` /
  `insertion_order` / `enabled` (per character-card-spec-v2) are now read like
  `key` / `keysecondary` / `order` / `disable`.
- **Apply queue leaked stale changes** — pending changes survived clearing/retrying the chat;
  they are now pruned with the transcript.
- **Low-contrast counter** in the diff modal — the "Change N of M" label now uses
  near-white text on a subtle pill (readable in dark/light themes).
- Various restore points for toast eviction, sort modes, lorebook render, and key seeding.

## [2.3.0] - 2026-08-02
- Released the stable + `dev` GitHub Pages pipeline, per-field undo/redo, i18n wording,
  token-count accuracy, hardened proxy/CSP/API-key storage, and dupe-safe imports.