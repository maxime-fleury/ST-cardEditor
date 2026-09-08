import { test, expect, beforeAll, beforeEach } from 'bun:test';

let IntentLearner;

// Minimal in-memory localStorage so persistence paths are exercised.
const storage = new Map();
beforeAll(async () => {
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: (k) => { storage.delete(k); },
  };
  IntentLearner = (await import('../../js/intentLearner.js')).IntentLearner;
});

beforeEach(() => {
  IntentLearner._reset();
  storage.clear();
});

test('learn + recall: a twice-learned keyword maps to its field', () => {
  IntentLearner.learn('benenne die Karte um in Elodie', ['name']);
  IntentLearner.learn('bitte benenne die Karte um', ['name']);
  expect(IntentLearner.recall('benenne die Karte um')).toEqual(['name']);
});

test('recall ignores single-occurrence evidence (confidence threshold)', () => {
  IntentLearner.learn('une seule occurrence du mot drakkar', ['scenario']);
  expect(IntentLearner.recall('drakkar')).toEqual([]);
});

test('accent-insensitive matching: "femme de ménage" vs "ménage"', () => {
  IntentLearner.learn('elle est étudiante femme de menage fauchée', ['description']);
  IntentLearner.learn('elle fait des ménages pour survivre', ['description']);
  expect(IntentLearner.recall('femme de ménage étudiante')).toEqual(['description']);
});

test('stopwords and short words never become keywords', () => {
  IntentLearner.learn('elle veut avec pour les carte mais', ['scenario']);
  // All tokens are stopwords -> nothing learned -> recall stays empty.
  expect(IntentLearner.recall('elle veut avec pour les carte mais')).toEqual([]);
});

test('learned fields persist across module reloads (localStorage)', async () => {
  IntentLearner.learn('es una estudiante pobre que quiere dinero', ['description']);
  IntentLearner.learn('es una estudiante sin dinero', ['description']);
  // Re-import a fresh module instance: the store must come back from storage.
  const fresh = (await import('../../js/intentLearner.js?reload=1')).IntentLearner;
  expect(fresh.recall('estudiante pobre')).toEqual(['description']);
});

test('recall orders fields by total evidence', () => {
  IntentLearner.learn('renomme en Elodie et ecris un scenario sombre', ['name']);
  IntentLearner.learn('renomme la carte en Elodie', ['name']);
  IntentLearner.learn('ecris un scenario sombre pour elle', ['scenario']);
  const got = IntentLearner.recall('renomme et ecris un scenario');
  expect(got[0]).toBe('name'); // strongest evidence wins
  expect(got).toContain('scenario');
});

test('prune keeps the store bounded', () => {
  for (let i = 0; i < 400; i++) {
    IntentLearner.learn('motunique' + i + ' pour un scenario' + (i % 5), ['scenario']);
  }
  // Can only verify indirectly: recall of an early-pruned keyword is empty or
  // works, and the in-memory store stays under the cap.
  const raw = storage.get('stce.intentLearner.v1');
  expect(Object.keys(JSON.parse(raw)).length).toBeLessThanOrEqual(310); // cap + slack
});