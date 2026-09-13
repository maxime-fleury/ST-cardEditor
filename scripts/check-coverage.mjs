/**
 * check-coverage.mjs — run the unit suite under coverage and enforce a floor.
 *
 * The unit tests are the only gate that exercises the pure logic modules
 * (cardEngine, cardSearch, cardHealth, storage, …), and "we have N tests" says
 * nothing about what they touch: the suite could double in size without a single
 * new line of `cardSearch.js` being executed. Bun's `--coverage` reports that,
 * but has no threshold flag, so the floor lives here.
 *
 * Two kinds of floor, because one number hides the interesting failure:
 *   - a global floor, so the suite can't quietly stop covering things as a whole;
 *   - a per-module floor for the pure-logic modules, which is where an untested
 *     branch is an actual bug rather than a missing DOM fixture.
 *
 * A module in CORE that does not appear in the report at all is a failure, not a
 * skip: it means no test imports it, and lcov only lists files that were loaded —
 * so without that check a brand-new module would be invisible to this gate.
 *
 * Usage:  bun scripts/check-coverage.mjs
 *         bun scripts/check-coverage.mjs --report   # print the table, no gate
 */

import { readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reportOnly = process.argv.includes("--report");

// A ratchet, not a quality target. This number only measures how far the *unit*
// suite reaches into the app, and it is low on purpose-adjacent grounds: ui.js,
// editor.js, settings.js, cardManager.js and aiChat.js are driven by the
// Playwright suite, which lcov cannot see, so their columns stay near zero no
// matter how good the e2e coverage is. What it can still catch is the unit suite
// losing reach — hence "measured, then set below", and it should only ever be
// raised. Lowering it needs a reason in the commit message.
const GLOBAL_FLOOR = 22;

/**
 * Pure-logic modules: no DOM, no network, no timers — everything they do is
 * decided by their own branches, so a line no test reaches is a line nobody has
 * ever run. Keep this list in step with what tests/unit actually imports.
 * @type {Record<string, number>}
 */
const CORE = {
  "js/cardEngine.js": 50,
  "js/cardSearch.js": 85,
  "js/cardHealth.js": 85,
  "js/textFold.js": 90,
  "js/cardState.js": 75,
  "js/chatState.js": 80,
  "js/storage.js": 15,
};

const coverageDir = join(tmpdir(), `stce-coverage-${process.pid}`);
rmSync(coverageDir, { recursive: true, force: true });

const run = spawnSync("bun", ["test", "--parallel", "tests/unit", "--coverage",
  "--coverage-reporter=lcov", `--coverage-dir=${coverageDir}`], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (run.status !== 0) {
  console.error("\ncheck-coverage: the unit suite failed — fix that before reading the numbers.");
  process.exit(run.status || 1);
}

const lcovPath = join(coverageDir, "lcov.info");
if (!existsSync(lcovPath)) {
  console.error(`check-coverage: bun produced no lcov report at ${lcovPath} — the coverage flags changed.`);
  process.exit(1);
}

/** lcov is one "SF:<path>" record per file followed by LF/LH totals. */
/** @type {Map<string, { found: number, hit: number }>} relative path -> counts */
const files = new Map();
let current = null;
for (const line of readFileSync(lcovPath, "utf8").split("\n")) {
  if (line.startsWith("SF:")) {
    // Coverage paths are absolute; report them relative to the repo so the
    // table matches what a reviewer sees in the file tree (and so the pure
    // modules can be keyed on a stable string).
    current = relative(root, line.slice(3).trim()).split("\\").join("/");
    if (!files.has(current)) files.set(current, { found: 0, hit: 0 });
  } else if (line.startsWith("LF:") && current) {
    const entry = files.get(current);
    if (entry) entry.found += Number(line.slice(3));
  } else if (line.startsWith("LH:") && current) {
    const entry = files.get(current);
    if (entry) entry.hit += Number(line.slice(3));
  }
}
rmSync(coverageDir, { recursive: true, force: true });

if (files.size === 0) {
  console.error("check-coverage: the lcov report listed no files — refusing to pass on an empty report.");
  process.exit(1);
}

// Only the app's own logic counts towards the gate. Excluded, with reasons:
//   - tests/**      they are the instrument, and are trivially 100% covered;
//   - js/i18n/*.js  one dictionary per locale, 670 literal strings each — 27 of
//                   them would add ~18 000 always-covered lines and swamp the
//                   ratio, hiding a real regression in the modules that decide
//                   things. The loader (js/i18n.js) is real logic and stays in.
//   - built files   js/app.js is a re-export stub and *.chunk.js is bundler
//                   output; neither is hand-written.
const isCovered = (file) => file.startsWith("js/")
  && !file.startsWith("js/i18n/")
  && !file.endsWith(".chunk.js")
  && file !== "js/app.js";

const pct = (entry) => (entry.found === 0 ? 100 : (entry.hit / entry.found) * 100);
const counted = [...files.entries()].filter(([file]) => isCovered(file));
const total = counted.reduce((acc, [, e]) => ({ found: acc.found + e.found, hit: acc.hit + e.hit }), { found: 0, hit: 0 });

const rows = counted.sort((a, b) => pct(a[1]) - pct(b[1]));
const width = Math.max(...rows.map(([file]) => file.length), 20);
console.log(`\n${"file".padEnd(width)}  lines   covered`);
for (const [file, entry] of rows) {
  const mark = CORE[file] !== undefined ? "*" : " ";
  console.log(`${mark}${file.padEnd(width - 1)}  ${String(entry.found).padStart(5)}  ${pct(entry).toFixed(1).padStart(6)}%`);
}
console.log(`\n* = pure-logic module with its own floor`);
console.log(`${"TOTAL".padEnd(width)}  ${String(total.found).padStart(5)}  ${pct(total).toFixed(1).padStart(6)}%`);

if (reportOnly) process.exit(0);

let failures = 0;
const fail = (msg) => { failures++; console.error(`✗ ${msg}`); };

console.log(`\n(Rows near zero are the DOM-facing modules — ui.js, editor.js,\nsettings.js, cardManager.js, aiChat.js — which the Playwright suite drives; lcov\nonly sees the unit suite, so read those columns as "not this instrument".)`);

if (pct(total) < GLOBAL_FLOOR) {
  fail(`unit-suite line coverage ${pct(total).toFixed(1)}% is below the ${GLOBAL_FLOOR}% ratchet.`);
} else {
  console.log(`✓ unit-suite line coverage ${pct(total).toFixed(1)}% (ratchet ${GLOBAL_FLOOR}%).`);
}

for (const [file, floor] of Object.entries(CORE)) {
  const entry = files.get(file);
  if (!entry) {
    fail(`${file} is in the CORE list but no unit test imports it — the floor for it is not being checked.`);
    continue;
  }
  if (pct(entry) < floor) {
    fail(`${file} line coverage ${pct(entry).toFixed(1)}% is below its ${floor}% floor (${entry.hit}/${entry.found}).`);
  }
}
if (failures === 0) console.log(`✓ ${Object.keys(CORE).length} pure-logic module(s) meet their own floor.`);

if (failures) {
  console.error(`\ncheck-coverage: ${failures} problem(s).`);
  process.exit(1);
}
