import { test, expect, beforeAll } from 'bun:test';

// animations.js drives anime.js and the DOM, so only its pure policy is testable
// here — and that policy is exactly what broke large libraries: `opacity:[0,1]`
// applies the FROM value to every target immediately, so an uncapped stagger
// left the tail of a long list invisible for seconds (500 cards = 12.5 s).
let Anims;

beforeAll(async () => {
  Anims = (await import('../../js/animations.js')).Anims;
});

test('a short list keeps the requested stagger', () => {
  expect(Anims._staggerStep(1, 25)).toBe(25);
  expect(Anims._staggerStep(2, 25)).toBe(25);
  expect(Anims._staggerStep(10, 25)).toBe(25);
  expect(Anims._staggerStep(0, 25)).toBe(25);
});

test('a long list fits inside the stagger window', () => {
  for (const count of [40, 100, 500, 2000]) {
    const step = Anims._staggerStep(count, 25);
    expect(step * (count - 1)).toBeLessThanOrEqual(Anims._STAGGER_WINDOW_MS + 1e-9);
  }
});

test('the 500-card library no longer waits 12.5 s for its last row', () => {
  expect(Anims._staggerStep(500, 25) * 499).toBeLessThanOrEqual(Anims._STAGGER_WINDOW_MS);
  // Sanity: the uncapped behaviour really was that bad.
  expect(25 * 499).toBeGreaterThan(12_000);
});
