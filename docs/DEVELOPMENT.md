# Development Guide

Everything you need to know to work on this codebase without tripping the
quality gates. The gates are deliberately **fast and hermetic** so they run
comfortably in CI on every push/PR (`ci.yml`) and locally before committing.

## Quality gates

| Gate | Command | What it checks |
| --- | --- | --- |
| Typecheck | `bun run typecheck` | `tsc --noEmit` on **every** hand-written module under `js/` (all 20 carry `// @ts-check`, plus `js/globals.d.ts`). Types only — see below. `check-assets` fails on a module that is missing the pragma, since a file without it is reported on not at all. |
| Lint | `bun run lint` | ESLint (flat config, `eslint.config.js`). Style + static bugs: unused vars, dead code, undeclared globals, complexity… |
| Unit tests | `bun run test:unit` | Bun tests across `tests/unit/` (the count is deliberately not written down here — it changes with every test). One file per module, plus `cardSearch` (index + ranking + snippets), `cardHealth` (diagnostics + the lorebook simulator) and `storage` (the version-history rules). Runs with `--parallel` (see the module-isolation note). |
| Vendored assets | `bun scripts/vendor.mjs --check` | `public/vendor/*` matches `public/vendor/MANIFEST.txt` (sha384 per file). `check-assets` also asserts the directory has no unlisted file and that the 2.7 MB tokenizer stays out of the precached shell. |
| Bundle freshness | `bun scripts/check-assets.mjs` | The five committed build artifacts match a fresh `bun run build`; also checks the SW shell and that the lazy tokenizer stays out of it, the `?v=` cache-busters, the navbar/README/`CACHE_PREFIX` versions, the vendor manifest, and that no module reintroduces `window.AppState`. |
| i18n parity | `bun run i18n:check` | All 27 `js/i18n/*.js` files stay in sync with `en.js` (same keys, no single-brace placeholders, ≥ 70 % coverage). |
| i18n completeness | `bun scripts/i18n-add.mjs --check` | No locale is missing a key that `en.js` has. New keys are appended by `bun run i18n:add` as English placeholders rather than typed 26 times. |
| e2e | `bunx playwright test` | Playwright suite in `tests/*.spec.js`. The config picks a free port automatically (8300 on Windows where 8182 is OS-reserved, 8182 elsewhere) and starts a scripted OpenAI-compatible mock server for the live-model suite — no ports to juggle by hand. |

> **Note on the typecheck scope.** Every hand-written module carries
> `// @ts-check` with `strictNullChecks` **on** — the null-noise of the legacy
> era was cleaned up pass by pass (Passe 5: aiChat/cardManager/editor;
> Passe 6: settings/wizard; Passe 7: ui/aiService/storage/i18n; Passe 8 added
> `noUncheckedIndexedAccess`, so every index access returns `T | undefined` —
> array/NodeList lookups (wizard image slots, apply queue, PNG parser bytes)
> and string indexing (`name[0]` → `name.charAt(0)`) are guarded or narrowed
> locally). Notable
> conventions: DOM lookups are guarded or use non-null helpers (`Ui.$el` for
> static shell elements, wizard's `qs()`), literal-typed fields carry inline
> `@type` JSDoc (`_modal`, `_fetchedImages`, `_pendingRemoteTouched`, …),
> event handlers cast `e.target`/`e` to the concrete element/event type, and
> `marked`/`DOMPurify` (lazy CDN globals) are declared in `globals.d.ts`. The
> hardening also surfaced a real bug: `_mergePendingRemote` read
> `_pendingRemoteTouched` after resetting it to `null`, so the "local edits
> win" cross-tab guard never fired — fixed by capturing the set before the
> reset. The last five modules (cardEngine, exportUtils, animations, tokenizer,
> waifuTab — Passe 9) joined the checked set; only the built `js/*.chunk.js`
> artifacts and `js/app.js` are not type-checked.
>
> Two conventions worth knowing when adding to the checked set:
> `js/globals.d.ts` declares the classic-script globals (`bootstrap`, `Diff`,
> `anime`, `marked`, `DOMPurify`) and widens `Element` for the dynamic-selector
> style the codebase uses. Its `Element` augmentation cannot carry a
> *non-optional* `src`/`hidden`: `HTMLElement` has no `src` of its own, so a
> required member there makes every `HTMLElement → Element` assignment illegal.
> Cast the lookup instead (`/** @type {HTMLImageElement | null} */ (document.querySelector(…))`).

### Module isolation for unit tests

The unit tests stub module dependencies with Bun's `mock.module`. Because Bun
shares **one module registry per process**, mocks would leak across test files
when run sequentially. The `test:unit` script therefore runs with
`--parallel` (one worker per file), which gives each file its own process.

The corollary: a function that is only reachable through a mocked dependency
cannot be unit tested through it. When logic matters, keep it on a pure module
(`cardEngine.cardSignature`, `storage.pushVersion`, `cardHealth.*`) so the test
imports the real thing — `cardManager` delegates to `cardEngine` for exactly
this reason.

## State, indexes and derived data

- **The two stores** — `CardState` (cards, active card, dirty flag, batch
  selection) and `ChatState` (history, sessions, models, loading). Nothing else
  holds mutable app state; `check-assets` fails the build on `window.AppState`,
  and it also fails a module that uses a `window.X` while importing `X`.
- **The search index** (`cardSearch.js`) is rebuilt from the same storage events
  the tooltip cache uses (`stce:card-saved`, `stce:card-deleted`,
  `stce:cards-cleared`) rather than from call sites, so an import, an AI apply
  and an editor autosave all keep it correct. It is built in an idle callback
  after the first render and refilled on demand (`ensure()`) when a search runs
  before it is warm.
- **The version history** (`storage.js` + the `snapshots` IndexedDB store) is
  written by `upsertCard` — the single write funnel — so no save path can
  forget it. `pushVersion` is the pure decision half (dedup by content
  signature, cap, strip the image bytes) and is covered by unit tests; the
  IndexedDB plumbing around it is covered by the e2e suite.
- **Card health** (`cardHealth.js`) is pure and returns issues carrying an i18n
  key plus values, never rendered strings, so it can be rendered in the modal,
  logged, or asserted in a test without a DOM.

Storage schema changes bump `CardStorage.DB.version` and add the store inside
`onupgradeneeded` (v2 added `snapshots`). A new store must also be cleared by
`clearAll()` — "Clear all data" silently keeping one store is the kind of bug
that only shows up when a user expects a clean slate.


## ESLint configuration

`eslint.config.js` is a flat config with one block per environment:

- `js/**` — browser globals + the CDN script-tag globals the app reads lazily
  (`anime`, `marked`, `DOMPurify`). **Only** this block bans `console.log` /
  `console.info` / `console.debug` (`no-console`, with `error`/`warn` allowed).
- `public/sw.js` — worker globals (`self`, `caches`, `importScripts`).
- `server.js`, `playwright.config.js`, `scripts/**`, `tests/**` — Node/Bun
  globals (+ browser globals in tests, which stub a DOM). CLI scripts are
  allowed to `console.log` — that's their job.
- `js/app.js` — ignored: committed build artifact.

### Conventions the config encodes

- **Silent error handling** is written `catch (_) {}` and is accepted
  (`caughtErrors: 'all'`, `caughtErrorsIgnorePattern: '^_'`). A caught error
  that is genuinely unused must be named `_`; anything else is a violation.
  Nested silent catches use `catch (__)` to avoid shadowing.
- **`eqeqeq: ['error', 'smart']`** — strict equality, except where a
  comparison is intentionally loose (`== null`).
- **`no-empty`** with `allowEmptyCatch` — an empty `catch {}` is allowed, any
  other empty block is not.

### Hardened rules (added in 2.7.x)

| Rule | Setting | Why |
| --- | --- | --- |
| `prefer-const` / `no-var` | error | Modern bindings; the remaining `var`s were hoisting-free locals. |
| `radix` | error | `parseInt` must declare its base — the codebase was decimal-only. |
| `no-eval` / `no-implied-eval` | error | No string-to-code paths. |
| `no-promise-executor-return` | error | A value returned from a `new Promise(resolve => …)` executor is silently dropped — usually a missing brace. |
| `no-unreachable-loop` | error | Loops that can never iterate are almost always bugs. |
| `no-shadow` | error | Shadowing hides the outer binding (e.g. the `el` Greek-locale import vs the `el` DOM callbacks). |
| `max-depth` | error, **5** | Nesting ceiling. Zero violations today after extracting import-dedupe helpers. |
| `complexity` | error, **30** | Cyclomatic complexity cap, tuned just above today's worst functions. New code should stay well under it; the historical 30+ functions were decomposed when the rule landed. |
| `no-console` | error (browser only) | Stray `console.log` in `js/**` is debug noise; `error`/`warn` stay for real diagnostics. |

### Rules deliberately **not** enabled

- **`curly`** — the legacy codebase uses single-line `if (x) doThing();` in
  ~700 places. Enforcing braces everywhere would be a mechanical churn with no
  bug-fixing value; `no-else-return`-style safety nets are better introduced
  piecemeal. The rule can be revisited if the codebase moves to Prettier-style
  formatting.
- **`prefer-template`** — ~300 string-concatenation sites are legacy, but
  functionally correct and readable. Turning them into template literals is
  pure churn without behavioral benefit.

These two are intentionally absent rather than set to `warn`: a `warn`-level
rule with hundreds of hits just teaches everyone to ignore lint output.

## Build & release

- `bun run build` regenerates the committed bundle artifacts (see the table
  below). They must be regenerated whenever `js/**` sources change —
  `check-assets` fails CI otherwise.
- `bun scripts/vendor.mjs` (re)downloads the pinned third-party assets into
  `public/vendor/` and rewrites `public/vendor/MANIFEST.txt`. Run it **only**
  when intentionally bumping one of the pinned versions in that script; the
  manifest hash makes an unexpected upstream change visible.
- The build is **minified** (`minify: true`): the shared chunk is the biggest
  asset the browser parses on boot. Byte-stability is preserved (bun's minifier
  is deterministic for a given version, which `.bun-version` pins), so
  `check-assets`' "committed === fresh build" comparison keeps working. Readable
  code is always one `bun run build` away from the sources.
- Releases: `bun scripts/release.mjs X.Y.Z` bumps `package.json`, the SW cache
  prefix, the `?v=NNN` cache-busters and inserts the `CHANGELOG.md` entry.
  Then tag + GitHub release as documented in the changelog workflow.

### Bundle layout & code splitting (implemented)

The app is built as a **code-split ESM bundle** (`bun run build`, see
`scripts/build.mjs`):

| Artifact | Size | Role |
| --- | --- | --- |
| `js/app.js` | ~24 B | ESM entry — imports the shared chunk. |
| `js/app.chunk.js` | ~1.1 MB | Minified shared code — every module except the lazy three. |
| `js/wizard.chunk.js` | ~22 KB | Card-creation wizard — `import()`ed on first open. |
| `js/waifuTab.chunk.js` | ~9 KB | Waifu Image tab — `import()`ed on first open. |
| `js/commandPalette.chunk.js` | ~7 KB | `Ctrl+K` palette — `import()`ed on the first keypress. |
| `public/vendor/*` (11 files) | ~3.7 MB | Pinned third-party assets, precached except `gpt-tokenizer.js`. |

### Third-party code is vendored, not fetched from a CDN

The app used to load Bootstrap, bootstrap-icons, jsdiff, anime.js, marked and
DOMPurify straight from jsdelivr/cdnjs — and the BPE tokenizer from `esm.sh`.
Every one of those is **remote code executed in the page**, and the offline PWA
only worked because the service worker had cached the responses at runtime
(hence the "app is unstyled right after an update" bug, v2 #26). They are now
pinned, hashed, committed under `public/vendor/` and served same-origin:

- `script-src` is `'self'` **only** — no third-party origin can execute code.
- The shell precaches all of them except `vendor/gpt-tokenizer.js` (~2.7 MB),
  which stays a lazy fetch emitted on first token count and cached at runtime
  (`RUNTIME_FILES` in public/sw.js) so "used once → works offline" still holds.
- Google Fonts is the single remaining cross-origin dependency (fonts are data,
  not code); its stylesheet also depends on the CDN runtime cache.

Names are **deterministic** (no content hashes), so the committed artifacts
are diffable against a fresh build and the service worker precaches the exact
list. The split is wired end to end:

- `js/ui.js` owns the lazy entry points. A click on `#btnWizardNav` `import()`s
  `wizard.js` and calls `show()`; the first `shown.bs.tab` of the Waifu pane
  imports `waifuTab.js` and inits it; the first `Ctrl+K` imports
  `commandPalette.js` and calls `show()`. `wizard.js` self-initializes in
  `show()` (`if (!this._modal) this.init()`), so the AI quick action
  (`aiChat.js` `newcard`) loads the chunk on demand too. The old circular
  import `aiChat ↔ wizard` is gone — wizard → aiChat is one-way now.
- `public/sw.js` precaches all five artifacts, so opening the wizard, the waifu
  tab or the palette **offline** works on first try (`shell.spec.js` covers
  exactly that for the first two).
- `scripts/check-assets.mjs` rebuilds fresh and diffs **every** artifact
  (entry + chunks), flags leftover `.chunk.js` files that the build no longer
  produces, and verifies all artifacts are in `SHELL_FILES`.

Why only these three? A lazy chunk must not read another module at *evaluation*
time — only inside a handler — or it breaks when it loads before the shared
chunk. `wizard.js`, `waifuTab.js` and `commandPalette.js` are written that way
(the palette in particular defers everything into handlers, including the
`bootstrap.Modal` construction). `settings.js` / `editor.js` would need a larger refactor
(their eval-time global reads) for a smaller gain.