# Development Guide

Everything you need to know to work on this codebase without tripping the
quality gates. The gates are deliberately **fast and hermetic** so they run
comfortably in CI on every push/PR (`ci.yml`) and locally before committing.

## Quality gates

| Gate | Command | What it checks |
| --- | --- | --- |
| Typecheck | `bun run typecheck` | `tsc --noEmit` on the `// @ts-check` modules (`aiChat.js`, `cardManager.js`, `editor.js`, `cardEngine.js`, plus `js/globals.d.ts`). Types only — see below. |
| Lint | `bun run lint` | ESLint (flat config, `eslint.config.js`). Style + static bugs: unused vars, dead code, undeclared globals, complexity… |
| Unit tests | `bun run test:unit` | 136 Bun tests across `tests/unit/` (cardEngine, tokenizer, aiService, i18n, cardManager, editor, exportUtils, settings, aiChat, chatState, intentLearner). Runs with `--parallel` (see the module-isolation note). |
| Bundle freshness | `bun scripts/check-assets.mjs` | `js/app.js` (committed build artifact) matches a fresh `bun run build`; also checks SW shell, version cache-busters and the `CACHE_PREFIX`. |
| i18n parity | `bun run i18n:check` | All 27 `js/i18n/*.js` files stay in sync with `en.js` (same keys, no single-brace placeholders, ≥ 75 % coverage). |
| e2e | `bunx playwright test` | Playwright suite in `tests/*.spec.js`. The config picks a free port automatically (8300 on Windows where 8182 is OS-reserved, 8182 elsewhere) and starts a scripted OpenAI-compatible mock server for the live-model suite — no ports to juggle by hand. |

> **Note on the typecheck scope.** Every module in the shared bundle carries
> `// @ts-check` with `strictNullChecks` **on** — the null-noise of the legacy
> era was cleaned up pass by pass (Passe 5: aiChat/cardManager/editor;
> Passe 6: settings/wizard; Passe 7: ui/aiService/storage/i18n). Notable
> conventions: DOM lookups are guarded or use non-null helpers (`Ui.$el` for
> static shell elements, wizard's `qs()`), literal-typed fields carry inline
> `@type` JSDoc (`_modal`, `_fetchedImages`, `_pendingRemoteTouched`, …),
> event handlers cast `e.target`/`e` to the concrete element/event type, and
> `marked`/`DOMPurify` (lazy CDN globals) are declared in `globals.d.ts`. The
> hardening also surfaced a real bug: `_mergePendingRemote` read
> `_pendingRemoteTouched` after resetting it to `null`, so the "local edits
> win" cross-tab guard never fired — fixed by capturing the set before the
> reset. Only the lazy `wizard.chunk.js`/`waifuTab.chunk.js` and the built
> `js/*.chunk.js` artifacts are not type-checked.

### Module isolation for unit tests

The unit tests stub module dependencies with Bun's `mock.module`. Because Bun
shares **one module registry per process**, mocks would leak across test files
when run sequentially. The `test:unit` script therefore runs with
`--parallel` (one worker per file), which gives each file its own process.

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

- `bun run build` regenerates `js/app.js` (single-bundle artifact, ~1.2 MB).
  It is committed and must be regenerated whenever `js/**` sources change —
  `check-assets` fails CI otherwise.
- Releases: `bun scripts/release.mjs X.Y.Z` bumps `package.json`, the SW cache
  prefix, the `?v=NNN` cache-busters and inserts the `CHANGELOG.md` entry.
  Then tag + GitHub release as documented in the changelog workflow.

### Bundle layout & code splitting (implemented)

The app is built as a **code-split ESM bundle** (`bun run build`, see
`scripts/build.mjs`):

| Artifact | Size | Role |
| --- | --- | --- |
| `js/app.js` | ~24 B | ESM entry — imports the shared chunk. |
| `js/app.chunk.js` | ~1.17 MB | Shared code — every module except the two lazy ones. |
| `js/wizard.chunk.js` | ~33 KB | Card-creation wizard — `import()`ed on first open. |
| `js/waifuTab.chunk.js` | ~14 KB | Waifu Image tab — `import()`ed on first open. |

Names are **deterministic** (no content hashes), so the committed artifacts
are diffable against a fresh build and the service worker precaches the exact
list. The split is wired end to end:

- `js/ui.js` owns the two lazy entry points: a click on `#btnWizardNav`
  `import()`s `wizard.js` and calls `show()`; the first `shown.bs.tab` of the
  Waifu pane imports `waifuTab.js` and inits it. `wizard.js` self-initializes
  in `show()` (`if (!this._modal) this.init()`), so the AI quick action
  (`aiChat.js` `newcard`) loads the chunk on demand too. The old circular
  import `aiChat ↔ wizard` is gone — wizard → aiChat is one-way now.
- `public/sw.js` precaches all four artifacts, so opening the wizard or waifu
  tab **offline** works on first try (`shell.spec.js` covers exactly that).
- `scripts/check-assets.mjs` rebuilds fresh and diffs **every** artifact
  (entry + chunks), flags leftover `.chunk.js` files that the build no longer
  produces, and verifies all artifacts are in `SHELL_FILES`.

Why only these two? The modules still hand off through `window.*` idempotent
assignments at evaluation time; a lazy chunk that *reads* `window.Ui` or
`window.AppState` at eval time (not call time) would break if it loads before
the shared chunk. Only call-time-touching modules are safe candidates, and
`wizard.js` + `waifuTab.js` (~47 KB bundled) are the only ones that qualify
without rework. `settings.js` / `editor.js` would need a larger refactor
(their eval-time global reads) for a smaller gain.