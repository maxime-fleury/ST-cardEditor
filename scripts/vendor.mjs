/**
 * vendor.mjs — download the pinned third-party assets into public/vendor/.
 *
 * Why vendor at all: every one of these files is remote code (or a stylesheet
 * that loads remote fonts) executed by the app. Loading them from a CDN means
 * the editor's integrity depends on a third party staying up, serving the same
 * bytes, and never being compromised — and the offline PWA only worked because
 * the service worker happened to have cached the CDN responses at runtime
 * (which is why a purge left the app styling-less, v2 #26).
 *
 * Vendored, they are: same-origin (so the CSP no longer allowlists
 * cdn.jsdelivr.net / cdnjs.cloudflare.com / esm.sh for scripts), committed (so
 * `check-assets` can verify what ships), and available offline from the shell
 * cache without any runtime CDN round-trip.
 *
 * Versions are pinned exactly, and a re-download whose bytes differ from the
 * hash already recorded in the manifest is REFUSED (the file is left untouched
 * and the run exits non-zero), so an upstream republish — or a hijacked CDN
 * response — cannot silently ship new code. `--force` is the deliberate
 * override for the one legitimate case: bumping a version below.
 *
 * Usage:
 *   bun scripts/vendor.mjs           # download/refresh public/vendor/*
 *   bun scripts/vendor.mjs --check   # verify local bytes against MANIFEST.txt
 *   bun scripts/vendor.mjs --force   # accept a changed hash (version bump)
 *
 * Re-run it only when intentionally bumping a dependency version below.
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(root, "public", "vendor");
const manifestPath = join(vendorDir, "MANIFEST.txt");

// Pinned sources. `out` is relative to public/vendor/ (kept in sync with the
// paths referenced by public/index.html, js/ui.js and js/tokenizer.js).
const ASSETS = [
  { out: "bootstrap.min.css", url: "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" },
  { out: "bootstrap.rtl.min.css", url: "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.rtl.min.css" },
  { out: "bootstrap.bundle.min.js", url: "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js" },
  // bootstrap-icons.css references ./fonts/bootstrap-icons.woff2 in the same
  // npm package, so the CSS and its fonts must stay siblings under vendor/.
  { out: "bootstrap-icons.css", url: "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.css" },
  { out: "fonts/bootstrap-icons.woff2", url: "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/fonts/bootstrap-icons.woff2" },
  { out: "fonts/bootstrap-icons.woff", url: "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/fonts/bootstrap-icons.woff" },
  { out: "diff.min.js", url: "https://cdn.jsdelivr.net/npm/diff@9.0.0/dist/diff.min.js" },
  { out: "anime.min.js", url: "https://cdnjs.cloudflare.com/ajax/libs/animejs/3.2.2/anime.min.js" },
  // marked/DOMPurify were loaded from *unpinned* jsdelivr URLs (…/npm/marked/…),
  // i.e. whatever the CDN resolved that day — pinning is part of the fix.
  { out: "marked.min.js", url: "https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js" },
  { out: "purify.min.js", url: "https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.min.js" },
  // gpt-tokenizer is ~2.8 MB, so it stays a lazy fetch (see js/tokenizer.js):
  // it is deliberately NOT precached with the app shell, and the service worker
  // caches it at runtime on first use instead.
  { out: "gpt-tokenizer.js", url: "https://esm.sh/gpt-tokenizer@3.0.1/es2022/gpt-tokenizer.mjs", lazy: true },
];

const sha384 = (bytes) => "sha384-" + createHash("sha384").update(bytes).digest("base64");

function readManifest() {
  /** @type {Map<string, { url: string, integrity: string, size: number }>} */
  const map = new Map();
  if (!existsSync(manifestPath)) return map;
  for (const line of readFileSync(manifestPath, "utf8").split("\n")) {
    // Format: "  <out> sha384-… <size> <url>". Entry lines are the only ones
    // indented by two spaces; comments start with `#`.
    if (!line.startsWith("  ")) continue;
    const parts = line.trim().split(/\s+/);
    const out = parts[0];
    // The integrity prefix is the real discriminator — keying on `=` dropped
    // every entry whose base64 hash happens to have no padding, which made
    // --check report a valid manifest as missing.
    if (!out || parts.length < 4 || !String(parts[1] || "").startsWith("sha384-")) continue;
    map.set(out, { integrity: parts[1] || "", size: Number(parts[2] || 0), url: parts[3] || "" });
  }
  return map;
}

async function check() {
  const manifest = readManifest();
  if (manifest.size === 0) {
    console.error("vendor --check: public/vendor/MANIFEST.txt is missing — run `bun scripts/vendor.mjs` first.");
    process.exit(1);
  }
  let bad = 0;
  for (const [out, expected] of manifest) {
    const file = join(vendorDir, out);
    if (!existsSync(file)) {
      console.error(`✗ vendor/${out} is missing`);
      bad++;
      continue;
    }
    const actual = sha384(readFileSync(file));
    if (actual !== expected.integrity) {
      console.error(`✗ vendor/${out} does not match the manifest (${actual} != ${expected.integrity})`);
      bad++;
    }
  }
  if (bad) {
    console.error(`vendor --check: ${bad} problem(s).`);
    process.exit(1);
  }
  console.log(`✓ ${manifest.size} vendored asset(s) match public/vendor/MANIFEST.txt.`);
}

async function download() {
  const force = process.argv.includes("--force");
  const previous = readManifest();
  const lines = [
    "# Vendored third-party assets — see scripts/vendor.mjs.",
    "#",
    "# These files are committed on purpose: they are remote code the app used to",
    "# execute straight from a CDN. Re-running scripts/vendor.mjs verifies each",
    "# download against the hash below, so an upstream change fails loudly here",
    "# instead of shipping silently. Do not edit these files by hand.",
    "#",
    "# <file> <sha384> <bytes> <source>",
    "",
  ];
  for (const asset of ASSETS) {
    const res = await fetch(asset.url);
    if (!res.ok) {
      console.error(`✗ ${asset.url} → HTTP ${res.status}`);
      process.exitCode = 1;
      continue;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const integrity = sha384(bytes);
    const known = previous.get(asset.out);
    const drift = known && known.integrity !== integrity;
    if (drift && !force) {
      // Refuse rather than overwrite: the whole point of the manifest is that
      // shipped bytes are the reviewed ones. Keep the manifest line we already
      // have so a later --force run is a single, explicit decision.
      console.error(`✗ ${asset.url} returned different bytes than the manifest records`
        + `\n    recorded ${known.integrity}`
        + `\n    fetched  ${integrity}`
        + `\n  vendor/${asset.out} left untouched. Re-run with --force only if you are bumping the version.`);
      lines.push(`  ${asset.out} ${known.integrity} ${known.size} ${known.url}`);
      process.exitCode = 1;
      continue;
    }
    const target = join(vendorDir, asset.out);
    mkdirSync(dirname(target), { recursive: true });
    await Bun.write(target, bytes);
    lines.push(`  ${asset.out} ${integrity} ${bytes.byteLength} ${asset.url}`);
    const size = `${(bytes.byteLength / 1024).toFixed(1)} KB`;
    console.log(`${drift ? "↻" : "↳"} vendor/${asset.out} (${size})${drift ? "  ← differs from the previous download" : ""}`);
  }
  await Bun.write(manifestPath, lines.join("\n") + "\n");
  console.log(`✓ wrote ${ASSETS.length} asset(s) + public/vendor/MANIFEST.txt`);
}

if (process.argv.includes("--check")) await check();
else await download();
