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

// Deterministic, code-split, browser-targeted ESM. minify:false keeps the
// artifacts (somewhat) debuggable and guarantees byte-stable builds for the
// freshness check; the ?v= cache-buster in index.html handles caching of the
// entry, and the service worker precaches the chunks.
const BUNDLE_CONFIG = {
  entrypoints: [ENTRY],
  target: "browser",
  format: "esm",
  minify: false,
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
  return result;
}

/**
 * Freshly-built artifacts as [{ relPath, text }] (entry first, then chunks by
 * path). Built into a scratch dir so checking never touches the repo.
 */
export async function bundleArtifacts() {
  const scratch = join(tmpdir(), `stce-build-${process.pid}-${Date.now()}`);
  const result = await buildTo(scratch);
  const artifacts = [];
  for (const out of result.outputs) {
    const text = new TextDecoder().decode(await out.arrayBuffer());
    artifacts.push({
      relPath: relative(scratch, out.path).replace(/\\/g, "/"),
      text,
    });
  }
  artifacts.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return artifacts;
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
  const result = await buildTo(root);
  let total = 0;
  for (const out of result.outputs) {
    const text = new TextDecoder().decode(await out.arrayBuffer());
    total += text.length;
    const rel = relative(root, out.path).replace(/\\/g, "/");
    console.log(`  ↳ ${rel} (${(text.length / 1024).toFixed(1)} KB)`);
  }
  console.log(`✓ Bundled ${ENTRY.replace(root, ".")} -> ${result.outputs.length} artifacts (${(total / 1024).toFixed(1)} KB total)`);
}

if (import.meta.main) {
  await main();
}