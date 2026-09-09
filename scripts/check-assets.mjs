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

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleArtifacts } from "./build.mjs";

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

// 5. The committed bundle artifacts are fresh — i.e. built from the current
//    sources. The build is code-split (see scripts/build.mjs): a tiny ESM
//    entry, one shared chunk and one lazy chunk per deferred module. index.html
//    and the SW shell ship these artifacts, so a stale one would silently ship
//    old logic. Bun.build is byte-deterministic for unchanged inputs, so a
//    content diff is a reliable staleness signal. (Runs on the exact build
//    config shared with `bun run build`.)
let freshArtifacts = null;
try {
  freshArtifacts = await bundleArtifacts();
  let stale = 0;
  for (const art of freshArtifacts) {
    const committed = existsSync(join(root, art.relPath))
      ? readFileSync(join(root, art.relPath), "utf8")
      : null;
    if (committed === null) {
      fail(`bundle artifact ${art.relPath} is missing — run \`bun run build\` and commit it.`);
      stale++;
    } else if (committed !== art.text) {
      fail(`bundle artifact ${art.relPath} is stale — run \`bun run build\` and commit the regenerated file.`);
      stale++;
    }
  }
  // A leftover chunk (module removed from the split) would ship dead code that
  // the service worker still precaches — flag it instead of silently keeping it.
  const freshPaths = new Set(freshArtifacts.map((a) => a.relPath));
  for (const file of readdirSync(join(root, "js"))) {
    if (!/\.chunk\.js$/.test(file)) continue;
    if (!freshPaths.has(`js/${file}`)) {
      fail(`stale bundle chunk js/${file} is committed but the current build does not produce it — delete it.`);
      stale++;
    }
  }
  if (stale === 0) {
    ok(`${freshArtifacts.length} bundle artifact(s) fresh (built from current sources).`);
  }
} catch (err) {
  fail(`bundle build check errored: ${err.message}`);
}

// 5b. Every bundle artifact is precached by the service worker, so the lazy
//     chunks keep working offline. (Entry + shared chunk are the offline app
//     shell; the lazy chunks are small and precached eagerly because a first
//     open while offline must still work.)
if (freshArtifacts) {
  const artifactShellMisses = freshArtifacts
    .filter((a) => !swJs.includes(`'${a.relPath}'`) && !swJs.includes(`"${a.relPath}"`))
    .map((a) => a.relPath);
  if (artifactShellMisses.length) {
    fail(`bundle artifacts missing from public/sw.js SHELL_FILES: ${artifactShellMisses.join(", ")}`);
  } else {
    ok(`all ${freshArtifacts.length} bundle artifacts are present in the service-worker shell.`);
  }
}

// 6. GitHub Actions workflow files must survive GitHub's strict YAML parser.
//    A plain (unquoted) scalar cannot contain ": " — a step name like
//    `- name: Typecheck (@ts-check files: ...)` is a syntax error for GitHub
//    (every run fails at 0s with "invalid workflow file" — the ci.yml
//    breakage of 2.7.1), even though some lenient parsers accept it. Bun.YAML
//    rejects the same input, so a strict parse plus a targeted scan of
//    unquoted step-name scalars covers the failure mode end to end.
const workflowsDir = join(root, ".github", "workflows");
const workflowFiles = (() => {
  try {
    return readdirSync(workflowsDir).filter(f => /\.ya?ml$/i.test(f)).sort();
  } catch (_) {
    return [];
  }
})();
if (workflowFiles.length === 0) {
  fail(".github/workflows has no *.yml/*.yaml files to validate.");
} else {
  let workflowIssues = 0;
  for (const file of workflowFiles) {
    const text = read(`.github/workflows/${file}`);
    try {
      const parsed = Bun.YAML.parse(text);
      if (!parsed || typeof parsed !== "object" || !parsed.jobs) {
        fail(`.github/workflows/${file} parses but has no top-level "jobs" key.`);
        workflowIssues++;
        continue;
      }
    } catch (e) {
      fail(`.github/workflows/${file} is not valid YAML (GitHub would reject it): ${e.message.split("\n")[0]}`);
      workflowIssues++;
      continue;
    }
    text.split(/\r?\n/).forEach((line, i) => {
      const nameMatch = /^\s*-\s*name:\s*(.*)$/.exec(line);
      if (!nameMatch) return;
      const value = nameMatch[1];
      // Quoted scalars ('...' or "...") can safely contain ": ".
      if (/^['"]/.test(value)) return;
      if (/:[\t ]/.test(value)) {
        fail(`.github/workflows/${file}:${i + 1}: step name is unquoted and contains ": " — GitHub's parser rejects it; wrap the name in quotes.`);
        workflowIssues++;
      }
    });
  }
  if (workflowIssues === 0) {
    ok(`${workflowFiles.length} workflow file(s) parse cleanly (strict YAML, no unquoted ": " in step names).`);
  }
}

// 7. Module decoupling: a module that already imports X must not also reach
//    for the `window.X` global at call time — that dead coupling is how a
//    stale global copy outlives the import (editor.js called window.Ui while
//    importing Ui; aiChat.js read window.Tokenizer while importing Tokenizer).
//    The module's own export line (`window.X = X`) is expected and excluded.
// Source modules only: app.js (entry artifact) and *.chunk.js (built artifacts)
// are bundler output, not hand-written modules.
const jsModules = readdirSync(join(root, "js")).filter(f => f.endsWith(".js") && f !== "app.js" && !f.endsWith(".chunk.js"));
let couplingIssues = 0;
for (const file of jsModules) {
  const src = read(`js/${file}`);
  const imported = new Set();
  for (const im of src.matchAll(/import\s*\{([^}]+)\}\s*from\s+'\.[^']+\.js';/g)) {
    for (const part of im[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) imported.add(name);
    }
  }
  if (imported.size === 0) continue;
  for (const wm of src.matchAll(/window\.([A-Z][A-Za-z0-9]*)/g)) {
    const name = wm[1];
    if (!imported.has(name)) continue;
    // Skip the module's own export line `window.X = X;`.
    const tail = src.slice(wm.index, wm.index + name.length + 12);
    if (tail.startsWith(`window.${name} = ${name}`) || tail.startsWith(`window.${name}=${name}`)) continue;
    fail(`js/${file}: uses window.${name} while importing ${name} — use the import; the global copy can go stale (decoupling check).`);
    couplingIssues++;
  }
}
if (couplingIssues === 0) {
  ok(`${jsModules.length} js modules have no dead window.* coupling (imports are the only entry point).`);
}

if (failures) {
  console.error(`\ncheck-assets: ${failures} problem(s) found.`);
  process.exit(1);
}
console.log(`\ncheck-assets: everything in sync with version ${fullVersion}.`);