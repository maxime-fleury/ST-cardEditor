/**
 * build.mjs — bundle the whole app into a single entry module (js/app.js).
 *
 * One source of truth for the bundle configuration, shared by:
 *   - `bun run build`  (CLI: writes js/app.js)
 *   - scripts/check-assets.mjs  (imports bundleSourceText() to verify the
 *     committed js/app.js is fresh — i.e. built from the current sources)
 *
 * Output is a deterministic IIFE (Bun.build is byte-stable for the same
 * inputs), so the committed artifact can be diffed against a fresh build to
 * catch stale bundle regressions in CI.
 *
 * Usage:  bun scripts/build.mjs
 */

import { build } from "bun";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(root, "scripts", "app.entry.js");
export const BUNDLE_PATH = join(root, "js", "app.js");

// Deterministic, single-file, browser-targeted IIFE. minify:false keeps the
// artifact (somewhat) debuggable and guarantees byte-stable builds for the
// freshness check; the ?v= cache-buster in index.html handles caching instead.
const BUNDLE_CONFIG = {
  entrypoints: [ENTRY],
  target: "browser",
  format: "iife",
  minify: false,
  sourcemap: "none",
  splitting: false,
};

export async function buildResult() {
  // No outfile: outputs stay in memory (used by check-assets for the diff).
  const result = await build(BUNDLE_CONFIG);
  if (!result.success) {
    for (const log of result.logs) console.error(log.message);
    throw new Error("Bundle build failed");
  }
  return result;
}

/** Returns the freshly-built bundle text. */
export async function bundleSourceText() {
  const result = await buildResult();
  return new TextDecoder().decode(await result.outputs[0].arrayBuffer());
}

async function main() {
  const source = await bundleSourceText();
  const kb = (source.length / 1024).toFixed(1);
  writeFileSync(BUNDLE_PATH, source, "utf8");
  console.log(`✓ Bundled ${ENTRY.replace(root, ".")} -> js/app.js (${kb} KB)`);
}

if (import.meta.main) {
  await main();
}