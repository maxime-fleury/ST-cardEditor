/**
 * build.mjs — bundle the whole app for production.
 *
 * One source of truth for the bundle configuration, shared by:
 *   - `bun run build`  (CLI: writes the artifacts under js/)
 *   - scripts/check-assets.mjs  (imports bundleArtifacts() to verify the
 *     committed artifacts are fresh — i.e. built from the current sources)
 *
 * Layout (ESM, code-split):
 *   - js/app.js             — tiny entry that boots the app
 *   - js/app.chunk.js       — shared code (all modules except the lazy two)
 *   - js/wizard.chunk.js    — card-creation wizard, loaded on first open
 *   - js/waifuTab.chunk.js  — Waifu Image tab, loaded on first open
 * Names are deterministic (no content hashes), so the committed artifacts can
 * be diffed against a fresh build to catch stale-bundle regressions in CI, and
 * the service worker precaches the exact list (public/sw.js SHELL_FILES).
 *
 * Usage:  bun scripts/build.mjs
 */

import { build } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(root, "scripts", "app.js");

/**
 * The release cache-buster, derived from package.json exactly as check-assets
 * derives the one it expects in index.html (2.8.1 -> 281). Shared rather than
 * duplicated so the stub's `?v=` and the artifacts' cannot disagree.
 */
export function bundleBuster() {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version || "");
  if (!match) throw new Error(`build: cannot derive a cache-buster from version ${JSON.stringify(version)}.`);
  const [, major, minor, patch = "0"] = match;
  return String(Number(major) * 100 + Number(minor) * 10 + Number(patch));
}

/**
 * Append the buster to the imports BETWEEN the artifacts.
 *
 * index.html loads `js/app.js?v=281`, but that file is a 24-byte re-export: the
 * app is `js/app.chunk.js`, which it imports with a relative specifier carrying
 * no query of its own. So the buster busted a stub — after a deploy a browser
 * could keep serving the previous app.chunk.js, wizard.chunk.js, … from its HTTP
 * cache for as long as the host's max-age allows, i.e. a fresh entry stub in
 * front of stale code (and a lazy chunk that no longer matches the module graph
 * it was built against). Rewriting the specifiers here is what makes one `?v=`
 * cover every artifact. The service worker matches precache entries on the
 * *pathname*, so the query is invisible to it.
 */
const bustImports = (text, buster) => text.replace(
  /(["'])\.\/([A-Za-z0-9_-]+\.chunk\.js)\1/g,
  (match, quote, name) => `${quote}./${name}?v=${buster}${quote}`,
);

// Deterministic, code-split, browser-targeted ESM.
//
// minify:true is what ships: the shared chunk is the single largest asset the
// browser parses on boot, and un-minified it was ~1.17 MB (25k lines) of
// mostly indentation and long identifiers. The freshness check is unaffected —
// check-assets diffs a *freshly built* artifact, and bun's minifier is
// deterministic for the same input + version, so "committed === fresh build"
// keeps working (the .bun-version pin makes that guarantee explicit). Source is
// always one `bun run build` away, which is what the debug workflow uses.
const BUNDLE_CONFIG = {
  entrypoints: [ENTRY],
  target: "browser",
  format: "esm",
  minify: true,
  sourcemap: "none",
  splitting: true,
  // Entry and chunks keep stable names (no content hashes): sw.js precaches
  // them by name and check-assets diffs each artifact against a fresh build.
  // `[name]` resolves to the source module name, so the shared chunk (named
  // after the entry script) is js/app.chunk.js.
  naming: { entry: "js/app.js", chunk: "js/[name].chunk.js" },
};

async function buildTo(outdir) {
  const result = await build({ ...BUNDLE_CONFIG, outdir });
  if (!result.success) {
    for (const log of result.logs) console.error(log.message);
    throw new Error("Bundle build failed");
  }
  // Post-process in place, then re-read from disk so the "committed === fresh
  // build" comparison in check-assets compares the bytes that actually ship.
  // Only the build's own outputs are considered — the repo's js/ directory also
  // holds the hand-written sources.
  const buster = bundleBuster();
  /** @type {{ relPath: string, text: string }[]} */
  const artifacts = [];
  for (const out of result.outputs) {
    const busted = bustImports(await out.text(), buster);
    await Bun.write(out.path, busted);
    artifacts.push({
      relPath: relative(outdir, out.path).replace(/\\/g, "/"),
      text: readFileSync(out.path, "utf8"),
    });
  }
  artifacts.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return artifacts;
}

/**
 * Freshly-built artifacts as [{ relPath, text }], read back from disk. Built into
 * a scratch dir so checking never touches the repo.
 */
export async function bundleArtifacts() {
  const scratch = join(tmpdir(), `stce-build-${process.pid}-${Date.now()}`);
  return buildTo(scratch);
}

async function main() {
  // Fail fast when the local bun can't reproduce the committed artifacts (see
  // .bun-version): check-assets diffs a fresh build against the committed
  // js/*.js files, and bun's bundler output is only byte-stable for one
  // version.
  const pinPath = join(root, ".bun-version");
  if (existsSync(pinPath)) {
    const pinned = readFileSync(pinPath, "utf8").trim().replace(/^v/, "");
    const actual = Bun.version.replace(/^v/, "");
    if (actual !== pinned) {
      console.error(`build: bun ${actual} does not match .bun-version (${pinned}). Install the pinned version (\`bun upgrade --to ${pinned}\`) to keep the bundle reproducible, or bump .bun-version when upgrading bun intentionally.`);
      process.exit(1);
    }
  }
  const artifacts = await buildTo(root);
  let total = 0;
  for (const { relPath, text } of artifacts) {
    // Bytes, not `text.length`: these files carry accented and CJK strings, so a
    // character count under-reports the transfer size by ~4% and quietly
    // disagreed with the size the server actually sends.
    const bytes = Buffer.byteLength(text);
    total += bytes;
    console.log(`  ↳ ${relPath} (${(bytes / 1024).toFixed(1)} KB)`);
  }
  console.log(`✓ Bundled ${ENTRY.replace(root, ".")} -> ${artifacts.length} artifacts (${(total / 1024).toFixed(1)} KB total, imports busted with ?v=${bundleBuster()})`);
}

if (import.meta.main) {
  await main();
}