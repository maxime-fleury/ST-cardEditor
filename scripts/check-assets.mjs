/**
 * check-assets.mjs — asset/shell/version drift guard.
 *
 * A single source of truth for the app version is package.json. This script
 * verifies everything that is supposed to track it stays in sync, and that
 * the offline app shell always precaches every asset index.html actually
 * loads. Exit code is non-zero (for CI) on any mismatch.
 *
 * Checks:
 *   1. Every <script src="js/..."> and <link href="css/..."> in index.html
 *      exists on disk.
 *   2. Every js/css asset referenced by index.html is listed in the service
 *      worker's SHELL_FILES (so the offline shell is never stale).
 *   3. All js script cache-busters (?v=N) are identical AND equal to the
 *      value derived from package.json's version.
 *   4. The navbar version badge (vX.Y), the README version badge, and the
 *      service worker CACHE_PREFIX all match package.json's version.
 *
 * Usage:  bun scripts/check-assets.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleSourceText } from "./build.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const pkg = JSON.parse(read("package.json"));
const version = pkg.version || "";
const vm = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
if (!vm) {
  console.error(`check-assets: cannot parse version ${JSON.stringify(version)} from package.json.`);
  process.exit(1);
}
const [, major, minor, patch = "0"] = vm;
const fullVersion = `${major}.${minor}.${patch}`;
const shortVersion = `${major}.${minor}`;
// Monotonic cache-buster derived from the version: 2.5.0 -> 250.
const expectedBuster = `${Number(major) * 100 + Number(minor) * 10 + Number(patch)}`;

let failures = 0;
const fail = (msg) => { failures++; console.error(`✗ ${msg}`); };
const ok = (msg) => console.log(`✓ ${msg}`);

// 0. The committed bundle is only byte-fresh when built with the exact bun
//    version that produced it (see .bun-version). A floating setup-bun or a
//    drifted local bun shows up here as a confusing "stale bundle" — fail with
//    an actionable message instead.
const bunPinPath = join(root, ".bun-version");
if (existsSync(bunPinPath)) {
  const pinned = readFileSync(bunPinPath, "utf8").trim().replace(/^v/, "");
  const actual = (typeof Bun !== "undefined" ? Bun.version : "").replace(/^v/, "");
  if (pinned && actual && actual !== pinned) {
    fail(`bun ${actual} does not match .bun-version (${pinned}); the committed bundle was built with ${pinned}. Run \`bun upgrade --to ${pinned}\` (or install that version) and rebuild, or bump .bun-version when upgrading bun intentionally.`);
  } else {
    ok(`bun ${actual} matches .bun-version (${pinned}).`);
  }
}

const indexHtml = read("public/index.html");
const swJs = read("public/sw.js");

// 1 + 3. Scripts and styles referenced by index.html.
const assetRe = /(?:src|href)="((?:js|css)\/[^"?#]+)(?:\?v=(\d+))?"/g;
const assets = [];
let m;
while ((m = assetRe.exec(indexHtml))) assets.push({ path: m[1], buster: m[2] });

const seen = new Set();
const busters = new Set();
for (const { path, buster } of assets) {
  if (seen.has(path)) continue;
  seen.add(path);
  // Dev source layout differs from the deployed tree: js/ modules live at the
  // repo root, css/ stylesheets under public/. Both are served from the site
  // root, so the shell check (string match) stays path-agnostic while the
  // on-disk existence check resolves each asset to its actual source file.
  const file = path.startsWith("js/") ? join(root, path) : join(root, "public", path);
  if (!existsSync(file)) fail(`asset not found on disk: ${path}`);
  if (path.startsWith("js/") && buster) busters.add(buster);
}

if (busters.size === 0) {
  fail("no js script cache-busters (?v=) found in index.html — add one to each <script>.");
} else if (busters.size > 1) {
  fail(`inconsistent js cache-busters: ${[...busters].sort().join(", ")} (expected all equal to ${expectedBuster}).`);
} else {
  const buster = [...busters][0];
  if (buster !== expectedBuster) {
    fail(`js cache-buster ${buster} != expected ${expectedBuster} for version ${fullVersion}. Bump the ?v= on every js <script> when releasing.`);
  } else {
    ok(`js cache-busters uniform (${buster}, derived from v${fullVersion}).`);
  }
}

// 2. Every referenced asset is precached by the service worker shell.
const shellMisses = assets.filter((a) => !seen2(a.path)).map((a) => a.path);
function seen2(path) { return swJs.includes(`'${path}'`) || swJs.includes(`"${path}"`); }
if (shellMisses.length) {
  fail(`assets missing from public/sw.js SHELL_FILES: ${shellMisses.join(", ")}`);
} else {
  ok(`all ${seen.size} js/css assets are present in the service-worker shell.`);
}

// 4a. Navbar version badge (full version, e.g. "v2.5.5").
const badgeMatch = />v(\d+\.\d+(?:\.\d+)?)</.exec(indexHtml);
if (!badgeMatch) {
  fail("navbar version badge (e.g. v2.5.5) not found in index.html.");
} else if (badgeMatch[1] !== fullVersion) {
  fail(`navbar badge v${badgeMatch[1]} != v${fullVersion} (package version ${fullVersion}).`);
} else {
  ok(`navbar badge v${fullVersion} matches package version.`);
}

// 4b. README version badge.
const readme = read("README.md");
const readmeMatch = /version-([0-9.]+)-purple/.exec(readme);
if (!readmeMatch) {
  fail("README version badge (version-X.Y.Z-purple) not found.");
} else if (readmeMatch[1] !== shortVersion && readmeMatch[1] !== fullVersion) {
  fail(`README version badge ${readmeMatch[1]} != ${fullVersion} (accepts ${shortVersion} or ${fullVersion}).`);
} else {
  ok(`README version badge ${readmeMatch[1]} matches package version.`);
}

// 4c. Service-worker cache prefix.
const cacheMatch = /CACHE_PREFIX\s*=\s*'([^']+)'/.exec(swJs);
if (!cacheMatch) {
  fail("CACHE_PREFIX constant not found in public/sw.js.");
} else if (!cacheMatch[1].includes(`-v${fullVersion}`)) {
  fail(`sw.js CACHE_PREFIX ${JSON.stringify(cacheMatch[1])} does not contain -v${fullVersion}.`);
} else {
  ok(`sw.js CACHE_PREFIX ${cacheMatch[1]} tracks version ${fullVersion}.`);
}

// 5. The committed js/app.js bundle is fresh — i.e. built from the current
//    sources. index.html and the SW shell both ship the single artifact, so a
//    stale bundle would silently ship old logic. Bun.build is byte-deterministic
//    for unchanged inputs, so a content diff is a reliable staleness signal.
//    (Runs on the exact build config shared with `bun run build`.)
const commitPath = "js/app.js";
try {
  const fresh = await bundleSourceText();
  const committed = existsSync(join(root, commitPath))
    ? readFileSync(join(root, commitPath), "utf8")
    : null;
  if (!committed) {
    fail(`bundle ${commitPath} is missing — run \`bun run build\` and commit the artifact.`);
  } else if (fresh !== committed) {
    fail(`bundle ${commitPath} is stale — run \`bun run build\` and commit the regenerated artifact.`);
  } else {
    ok(`bundle ${commitPath} is fresh (built from current sources).`);
  }
} catch (err) {
  fail(`bundle build check errored: ${err.message}`);
}

if (failures) {
  console.error(`\ncheck-assets: ${failures} problem(s) found.`);
  process.exit(1);
}
console.log(`\ncheck-assets: everything in sync with version ${fullVersion}.`);