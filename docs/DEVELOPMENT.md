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

> **Note on the typecheck scope.** The hot modules carry `// @ts-check`
> (`aiChat.js`, `cardManager.js`, `editor.js`, `cardEngine.js`) and
> `strictNullChecks` is **on** for them — the null-noise of the legacy era was
> cleaned up (Passe 5: DOM lookups guarded, `activeCard` treated as nullable
> where the flow allows it, `_imageBase64` typed `string | undefined` instead
> of the old literal `null`). The rest of `js/` is legacy JS without type
> annotations and is not checked; type coverage grows module by module as code
> is migrated.

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

### Bundle size & future splitting (evaluated, deferred)

The whole app ships as one ~1.26 MB artifact (`js/app.js`). Splitting it into
lazy chunks was evaluated and **deliberately deferred** — it is a dedicated
pass, not a quick win, because of three interacting contracts:

1. **Service-worker shell** — `public/sw.js` precaches exactly one bundle and
   the CDN libs. Introducing lazy chunks means teaching the SW to fetch them
   on demand (or accept a second network round-trip), changing the offline
   guarantee that `shell.spec.js` asserts.
2. **check-assets freshness** — the gate rebuilds from `scripts/app.entry.js`
   and diffs `js/app.js`. Code-splitting (multiple outputs) requires the gate
   to verify *every* artifact, not just the entry.
3. **Window-global wiring** — modules still hand off through `window.*`
   idempotent assignments. A lazy chunk that touches `window.Ui` or
   `window.AppState` at *evaluation* time (not call time) would break if the
   main bundle evaluates after it. Only call-time-touching modules are
   candidates.

Current module weight (source, pre-bundle), so the candidates are visible:

| Module | Bytes | Lazy-load candidate? |
| --- | --- | --- |
| `ui.js` | 66 KB | No — everything depends on it. |
| `aiChat.js` | 92 KB | No — core chat flow. |
| `cardManager.js` | 45 KB | No — core card flow. |
| `settings.js` | 43 KB | Partially — provider/model lists could lazy-fill. |
| `editor.js` | 42 KB | Partially — the greetings/lorebook editors load with the tab. |
| `wizard.js` | 36 KB | **Yes** — only used by the "New card" wizard modal. |
| `storage.js` | 31 KB | No — everything persists through it. |
| `aiService.js` | 25 KB | No — chat needs it immediately. |
| `cardEngine.js` | 18 KB | No — import/parse is first interaction. |
| `waifuTab.js` | 17 KB | **Yes** — tab content, could import on first open. |

The realistic win is `wizard.js` + `waifuTab.js` (~53 KB pre-min, less after
minification) via dynamic `import()` when the tab/modal first opens. The
loader work is small; the SW + check-assets contract changes are not. When
splitting lands, do it as one PR that updates `sw.js`, `check-assets.mjs` and
`shell.spec.js` together.