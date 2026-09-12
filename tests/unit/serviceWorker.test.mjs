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

test('activate never purges the font cache (it carries no deployment path)', async () => {
  await activate([
    CURRENT_SHELL,
    `stce-fonts-v${version}`,    // shared by every path, so it must survive
    'stce-fonts-v2.6.0',         // an older font cache — still shared, still keep
  ]);
  expect(deleted).toEqual([]);
});

test('activate cleans up the pre-vendoring CDN cache', async () => {
  // The font cache used to be named stce-cdn-* while Bootstrap, jsdiff, anime
  // and marked still came from jsdelivr. That name is no longer exempt, so the
  // leftover entry is removed by the legacy branch instead of leaking forever.
  await activate([`stce-fonts-v${version}`, `stce-cdn-v${version}`, OLD_SHELL]);
  expect(deleted.sort()).toEqual([`stce-cdn-v${version}`, OLD_SHELL].sort());
});
