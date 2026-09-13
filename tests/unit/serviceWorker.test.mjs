import { test, expect, beforeAll } from 'bun:test';
import { readFileSync } from 'node:fs';

// The app-shell cache name is version-derived (CACHE_PREFIX in public/sw.js), so
// it is read from package.json rather than hardcoded: a hardcoded name turns
// every release into a red test, and "fix it by bumping the string" is how a
// test stops testing anything.
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const CURRENT_SHELL = `stce-v${version}:/`;
const OTHER_DEPLOY = `stce-v${version}:/dev/`;
const OLD_SHELL = 'stce-v2.6.0:/'; // any older build of this same path

// The activate filter decides which Cache Storage entries get purged on an
// update. Getting it wrong is invisible until it matters: the stable worker and
// the /dev/ worker share one origin, so a filter that purges too much takes the
// other deployment offline, and one that purges too little leaks every past
// version forever.
//
// This test loads the REAL public/sw.js with a fake `self`/`caches` and drives
// its activate handler, so it fails when the filter changes — unlike a copy of
// the filter inlined in the test, which only proves the copy agrees with itself.

/** @type {(keys: string[]) => Promise<unknown>} */
let activate;
const deleted = [];
let cacheKeys = [];

const fakeCaches = {
  keys: async () => cacheKeys,
  delete: async (key) => { deleted.push(key); return true; },
  open: async () => ({ add: async () => {}, match: async () => undefined, put: async () => {} }),
};

beforeAll(async () => {
  const listeners = {};
  globalThis.caches = fakeCaches;
  globalThis.self = {
    location: { href: 'http://localhost/' },
    addEventListener: (name, fn) => { listeners[name] = fn; },
    skipWaiting: () => {},
    clients: { claim: () => {} },
    registration: { scope: 'http://localhost/' },
  };
  const pending = [];
  await import('../../public/sw.js');
  activate = (keys) => {
    cacheKeys = keys;
    deleted.length = 0;
    listeners.activate({ waitUntil: (p) => pending.push(p) });
    return Promise.all(pending);
  };
});

test('activate purges this deployment’s old shells, not the other one', async () => {
  await activate([
    CURRENT_SHELL,        // current shell — keep
    OLD_SHELL,            // older shell of this path — purge
    OTHER_DEPLOY,         // the /dev/ worker owns it — keep
    'stce-v2.2',          // legacy, no path — purge
    'unrelated-cache',    // not ours — keep
  ]);
  expect(deleted.sort()).toEqual(['stce-v2.2', OLD_SHELL].sort());
});

test('activate deletes the retired cross-origin caches', async () => {
  // Two names that must not survive: 'stce-cdn-*' (Bootstrap/jsdiff/anime/marked
  // while they came from jsdelivr) and 'stce-fonts-*' (Google Fonts while it was
  // cross-origin and runtime-cached). Both were exempt once; now that every asset
  // is vendored same-origin and precached with the shell, they are unreachable
  // leftovers, and the legacy branch is what reclaims them.
  await activate([CURRENT_SHELL, `stce-fonts-v${version}`, `stce-cdn-v${version}`, OLD_SHELL]);
  expect(deleted.sort()).toEqual([`stce-cdn-v${version}`, `stce-fonts-v${version}`, OLD_SHELL].sort());
});

// The shell is now the only place assets can be cached from, so it must list
// every face of the vendored fonts: a missing woff2 is a cross-origin fetch or
// an unstyled offline page, and neither shows up as a test failure elsewhere.
test('the shell precaches the vendored fonts and their stylesheet', async () => {
  const sw = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
  const shell = [...(/SHELL_FILES\s*=\s*\[([\s\S]*?)\]/.exec(sw)?.[1] || "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const css = readFileSync(new URL('../../public/vendor/fonts.css', import.meta.url), 'utf8');
  const faces = new Set([...css.matchAll(/url\(([^)]+\.woff2)\)/g)].map((m) => `vendor/${m[1]}`));
  expect(faces.size).toBeGreaterThan(0);
  expect(shell).toContain('vendor/fonts.css');
  expect([...faces].filter((f) => !shell.includes(f))).toEqual([]);
});
