import { test, expect, beforeAll, beforeEach } from 'bun:test';

// ChatState is a pure module (no DOM/global access at import time), so it is
// safe to load without stubs. These tests pin the store semantics that the
// AI chat relies on — especially the single-call full reset that prevents
// stale apply queues/sessions/callbacks from surviving a card switch.
let ChatState;

beforeAll(async () => {
  ChatState = (await import('../../js/chatState.js')).ChatState;
});

beforeEach(() => {
  ChatState.resetChat();
  ChatState.selectedFields.clear();
});

const connectedEl = () => ({ isConnected: true });

test('registerApply registers once per element and updates on duplicates', () => {
  const el = connectedEl();
  const first = ChatState.registerApply(el, 'description', 'v1');
  const again = ChatState.registerApply(el, 'personality', 'v2');

  expect(ChatState.applyQueue).toHaveLength(1);
  expect(again).toBe(first); // same item object, not a duplicate
  expect(first.field).toBe('personality'); // updated in place
  expect(first.content).toBe('v2');
  expect(first.applied).toBe(false);
});

test('registerApply returns null for falsy elements', () => {
  expect(ChatState.registerApply(null, 'description', 'x')).toBeNull();
  expect(ChatState.applyQueue).toHaveLength(0);
});

test('firstUnappliedIndex / nextUnappliedIndex skip applied items', () => {
  ChatState.applyQueue = [
    { applied: true },
    { applied: false },
    { applied: true },
    { applied: false },
  ];
  expect(ChatState.firstUnappliedIndex()).toBe(1);
  ChatState.applyIndex = 1;
  expect(ChatState.nextUnappliedIndex()).toBe(3);
  ChatState.applyIndex = 3;
  expect(ChatState.nextUnappliedIndex()).toBe(-1); // exhausted
  expect(ChatState.allApplied()).toBe(false);
});

test('allApplied is true only when every item is applied', () => {
  ChatState.applyQueue = [{ applied: true }, { applied: true }];
  expect(ChatState.allApplied()).toBe(true);
  ChatState.applyQueue = [{ applied: true }, { applied: false }];
  expect(ChatState.allApplied()).toBe(false);
  ChatState.applyQueue = [];
  expect(ChatState.allApplied()).toBe(true); // empty queue: nothing pending
});

test('pruneDetached drops disconnected items and clamps the index', () => {
  const liveA = connectedEl();
  const dead = { isConnected: false };
  const liveB = connectedEl();
  ChatState.applyQueue = [
    { el: liveA, applied: false },
    { el: dead, applied: false },
    { el: liveB, applied: false },
  ];
  ChatState.applyIndex = 2;
  ChatState.pruneDetached();
  expect(ChatState.applyQueue).toHaveLength(2);
  expect(ChatState.applyQueue[0].el).toBe(liveA);
  expect(ChatState.applyQueue[1].el).toBe(liveB);
  expect(ChatState.applyIndex).toBe(1); // clamped to last item
});

test('resetApply empties queue, store, index and element map', () => {
  const el = connectedEl();
  ChatState.registerApply(el, 'description', 'v1');
  ChatState.applyStore.set('msg-1', { content: 'v1', field: 'description' });
  ChatState.applyIndex = 0;

  ChatState.resetApply();
  expect(ChatState.applyQueue).toHaveLength(0);
  expect(ChatState.applyStore.size).toBe(0);
  expect(ChatState.applyIndex).toBe(0);
  expect(ChatState.applyElMap.get(el)).toBeUndefined(); // fresh WeakMap
});

test('resetChat aborts in-flight controllers and clears session + render flag', () => {
  const aborted = [];
  const ctrl = { abort: () => aborted.push('aborted') };
  ChatState.addController(ctrl);
  ChatState.currentSessionId = 'ses_1';
  ChatState.historyRendered = true;
  ChatState.registerApply(connectedEl(), 'description', 'v1');
  const genBefore = ChatState.gen;

  ChatState.resetChat();

  expect(aborted).toEqual(['aborted']);
  expect(ChatState.abortControllers).toHaveLength(0);
  expect(ChatState.gen).toBe(genBefore + 1); // stale callbacks invalidated
  expect(ChatState.applyQueue).toHaveLength(0);
  expect(ChatState.currentSessionId).toBeNull();
  expect(ChatState.historyRendered).toBe(false);
  // Selection survives a card switch (unlike clearChat, which resets it):
  ChatState.selectedFields.add('name');
  ChatState.resetChat();
  expect([...ChatState.selectedFields]).toEqual(['name']);
});

test('generation tokens are monotonic and bumpContextBarGen is independent', () => {
  const g1 = ChatState.bumpGen();
  const g2 = ChatState.bumpGen();
  expect(g2).toBe(g1 + 1);
  const c1 = ChatState.bumpContextBarGen();
  const c2 = ChatState.bumpContextBarGen();
  expect(c2).toBe(c1 + 1);
});

test('controller add/release keeps the list in sync', () => {
  const a = { abort: () => {} };
  const b = { abort: () => {} };
  ChatState.addController(a);
  ChatState.addController(b);
  expect(ChatState.abortControllers).toHaveLength(2);
  ChatState.releaseController(a);
  expect(ChatState.abortControllers).toEqual([b]);
  ChatState.releaseController(a); // already gone: no-op
  expect(ChatState.abortControllers).toEqual([b]);
});