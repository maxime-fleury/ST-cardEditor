# Development Guide

Everything you need to know to work on this codebase without tripping the
quality gates. The gates are deliberately **fast and hermetic** so they run
comfortably in CI on every push/PR (`ci.yml`) and locally before committing.

## Quality gates

| Gate | Command | What it checks |
| --- | --- | --- |
| Typecheck | `bun run typecheck` | `tsc --noEmit` on the `// @ts-check` modules (`aiChat.js`, `cardManager.js`, `editor.js`, plus `js/globals.d.ts`). Types only — see below. |
| Lint | `bun run lint` | ESLint (flat config, `eslint.config.js`). Style + static bugs: unused vars, dead code, undeclared globals, complexity… |
| Unit tests | `bun run test:unit` | 123 Bun tests across `tests/unit/` (cardEngine, tokenizer, aiService, i18n, cardManager, editor, exportUtils, settings, aiChat, chatState). Runs with `--parallel` (see the module-isolation note). |
| Bundle freshness | `bun scripts/check-assets.mjs` | `js/app.js` (committed build artifact) matches a fresh `bun run build`; also checks SW shell, version cache-busters and the `CACHE_PREFIX`. |
| i18n parity | `bun run i18n:check` | All 27 `js/i18n/*.js` files stay in sync with `en.js` (same keys, no single-brace placeholders, ≥ 75 % coverage). |
| e2e | `bunx playwright test` | Playwright suite in `tests/*.spec.js`. Needs a free port: on this Windows machine the default 8182 is inside an OS-reserved range, so use e.g. `PORT=8300` and a matching `baseURL` in the config. |

> **Note on the typecheck scope.** Only three hot modules carry `// @ts-check`;
> the rest of `js/` is legacy JS without type annotations. `strictNullChecks`
> stays off project-wide because the legacy code assumes DOM elements and cards
> always exist — the resulting null-noise reports nothing. Type coverage grows
> module by module as code is migrated.

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