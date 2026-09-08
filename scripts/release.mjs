#!/usr/bin/env bun
/**
 * release.mjs — single-command version bump.
 *
 * Turns a release into: `bun scripts/release.mjs 2.6.0` + a CHANGELOG commit.
 * Edits every place that must track the version, consistently:
 *   1. package.json            — "version"
 *   2. public/index.html       — js cache-buster (?v=N) and navbar badge (vX.Y.Z)
 *   3. README.md               — shields version badge (and its changelog link)
 *   4. public/sw.js            — CACHE_PREFIX (app shell) and CDN_CACHE
 *   5. CHANGELOG.md            — [Unreleased] becomes [X.Y.Z] - date, fresh
 *                                [Unreleased] section added on top, link refs
 *                                rewritten so old links keep resolving
 *
 * Then runs `bun scripts/check-assets.mjs` to prove nothing drifted.
 *
 * Usage:
 *   bun scripts/release.mjs 2.6.0            # bump + verify
 *   bun scripts/release.mjs 2.6.0 2026-10-01 # with an explicit date
 *   bun scripts/release.mjs 2.6.0 --dry-run  # show what would change
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const write = (p, s) => writeFileSync(join(root, p), s);

const arg = process.argv[2];
if (!arg || arg.startsWith("-")) {
  console.error("usage: bun scripts/release.mjs <new-version> [YYYY-MM-DD] [--dry-run]");
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");

// ─── Version parsing & validation ─────────────────────────────────────────
const sem = /^(\d+)\.(\d+)\.(\d+)$/.exec(arg);
if (!sem) {
  console.error(`release: "${arg}" is not a valid semver (expected X.Y.Z).`);
  process.exit(1);
}
const [, newMajor, newMinor, newPatch] = sem.map(Number);
const newVersion = `${newMajor}.${newMinor}.${newPatch}`;
const buster = `${newMajor * 100 + newMinor * 10 + newPatch}`;

const pkg = JSON.parse(read("package.json"));
const oldVersion = pkg.version || "";
const oldSem = /^(\d+)\.(\d+)\.(\d+)$/.exec(oldVersion);
if (!oldSem) {
  console.error(`release: cannot parse current version "${oldVersion}" from package.json.`);
  process.exit(1);
}
const oldNum = oldSem.slice(1).map(Number).reduce((a, b) => a * 1000 + b, 0);
const newNum = [newMajor, newMinor, newPatch].reduce((a, b) => a * 1000 + b, 0);
if (newNum <= oldNum) {
  console.error(`release: ${newVersion} is not newer than the current ${oldVersion}.`);
  process.exit(1);
}

const today = (process.argv[3] && !process.argv[3].startsWith("-")) ? process.argv[3] : new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
  console.error(`release: "${today}" is not a valid date (expected YYYY-MM-DD).`);
  process.exit(1);
}

const REPO = "maxime-fleury/ST-cardEditor";

// ─── Edits ────────────────────────────────────────────────────────────────
const edits = [];
const plan = (file, label) => {
  if (dryRun) edits.push(`  ${file}: ${label}`);
  else console.log(`  ${file}: ${label}`);
};

// 1. package.json
pkg.version = newVersion;
if (!dryRun) write("package.json", JSON.stringify(pkg, null, 2) + "\n");
plan("package.json", `version ${oldVersion} → ${newVersion}`);

// 2. public/index.html — cache-buster + navbar badge
let indexHtml = read("public/index.html");
const busterRe = /(\?v=)(\d+)/g;
const busters = [...indexHtml.matchAll(busterRe)].map((m) => m[2]);
if (busters.length === 0) {
  console.error("release: no js cache-busters (?v=N) found in public/index.html.");
  process.exit(1);
}
if (new Set(busters).size > 1) {
  console.error(`release: inconsistent cache-busters in index.html: ${[...new Set(busters)].join(", ")} — fix by hand first.`);
  process.exit(1);
}
indexHtml = indexHtml.replace(busterRe, `$1${buster}`);
indexHtml = indexHtml.replace(/>v\d+\.\d+(?:\.\d+)?</, `>v${newVersion}<`);
if (!dryRun) write("public/index.html", indexHtml);
plan("public/index.html", `cache-buster ${busters[0]} → ${buster}, navbar badge → v${newVersion}`);

// 3. README.md — shields version badge
let readme = read("README.md");
const badgeRe = /(version-)[0-9.]+(-purple)/;
if (!badgeRe.test(readme)) {
  console.error("release: README version badge (version-X.Y.Z-purple) not found.");
  process.exit(1);
}
readme = readme.replace(badgeRe, `$1${newVersion}$2`);
if (!dryRun) write("README.md", readme);
plan("README.md", `version badge → ${newVersion}`);

// 4. public/sw.js — CACHE_PREFIX + CDN_CACHE
let swJs = read("public/sw.js");
const prefixRe = /(CACHE_PREFIX\s*=\s*')(stce-v[\d.]+)(')/;
const cdnRe = /(CDN_CACHE\s*=\s*')(stce-cdn-v[\d.]+)(')/;
if (!prefixRe.test(swJs) || !cdnRe.test(swJs)) {
  console.error("release: CACHE_PREFIX or CDN_CACHE not found in public/sw.js.");
  process.exit(1);
}
swJs = swJs.replace(prefixRe, `$1stce-v${newVersion}$3`);
swJs = swJs.replace(cdnRe, `$1stce-cdn-v${newVersion}$3`);
if (!dryRun) write("public/sw.js", swJs);
plan("public/sw.js", `CACHE_PREFIX → stce-v${newVersion}, CDN_CACHE → stce-cdn-v${newVersion}`);

// 5. CHANGELOG.md — insert a dated [X.Y.Z] entry under [Unreleased], then
//    rewrite the version-link block at the bottom (old links keep resolving).
let changelog = read("CHANGELOG.md");
// Keep a Changelog order: [Unreleased] stays on top, and the newly-dated
// release entry goes right below it (above the previous release).
const unreleasedIdx = changelog.indexOf("## [Unreleased]");
if (unreleasedIdx === -1) {
  console.error("release: expected a \"## [Unreleased]\" section in CHANGELOG.md — fix by hand first.");
  process.exit(1);
}
const afterUnreleased = unreleasedIdx + "## [Unreleased]".length;
const firstReleaseIdx = changelog.indexOf("## [", afterUnreleased);
if (firstReleaseIdx === -1) {
  console.error("release: no \"## [X.Y.Z]\" release section after [Unreleased] in CHANGELOG.md — fix by hand first.");
  process.exit(1);
}
const entry = `## [${newVersion}] - ${today}\n\n`;
changelog = changelog.slice(0, firstReleaseIdx)
  + entry
  + changelog.slice(firstReleaseIdx);
const refsRe = /(\[Unreleased\]: https:\/\/github\.com\/[^\n]+compare\/v[\d.]+(?:\.\.\.HEAD|\+?\.\.\.HEAD))\n((?:\[[\d.]+\]: https:\/\/github\.com\/[^\n]+\n?)+)/;
const refsM = refsRe.exec(changelog);
if (refsM) {
  const rest = refsM[2].replace(/^\[Unreleased\]: .*\n/, ""); // never keep a stale Unreleased URL
  changelog = changelog.replace(
    refsM[0],
    `[Unreleased]: https://github.com/${REPO}/compare/v${newVersion}...HEAD\n`
    + `[${newVersion}]: https://github.com/${REPO}/releases/tag/v${newVersion}\n`
    + rest
  );
}
if (!dryRun) write("CHANGELOG.md", changelog);
plan("CHANGELOG.md", `dated [${newVersion}] entry under [Unreleased], link refs rewritten`);

// ─── Verify ───────────────────────────────────────────────────────────────
if (dryRun) {
  console.log("\nrelease: --dry-run — no files were changed. Edits planned:");
  edits.forEach((e) => console.log(e));
  console.log(`\nrelease: ${oldVersion} → ${newVersion} (date ${today}).`);
  process.exit(0);
}

console.log(`\nrelease: bumping ${oldVersion} → ${newVersion}.`);
console.log("Verifying with check-assets…\n");
import("../scripts/check-assets.mjs").catch((err) => {
  console.error(`\nrelease: verification failed: ${err.message}`);
  console.error("Review the partial edits, fix the drift, and re-run.");
  process.exit(1);
});