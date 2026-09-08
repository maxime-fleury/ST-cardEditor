import { test, expect } from '@playwright/test';
import { v2Card, importCards, collectErrors } from './helpers.js';

test('cards persist across reload (IndexedDB)', async ({ page }) => {
  await page.goto('/');
  await importCards(page, ['Persist']);
  // Await the debounced IndexedDB write completes.
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.locator('.card-list-item')).toHaveCount(1);
  await expect(page.locator('.card-list-name')).toHaveText(/Persist/);
});

test('duplicate card then delete with confirm', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [v2Card('DupSource')]);
  await page.locator('.card-list-item').first().click();
  await page.locator('#btnDuplicateCard').click();
  await page.waitForTimeout(300);
  await expect(page.locator('.card-list-item')).toHaveCount(2);
  // The clone becomes active with a "(Copy)" suffix.
  expect(await page.evaluate(() => window.AppState.activeCard.name)).toContain('Copy');

  // Reselect the original (exact name — the clone contains "DupSource" too) and
  // delete it through the in-app confirm dialog.
  await page.locator('.card-list-item').filter({ has: page.getByText('DupSource', { exact: true }) }).click();
  await page.waitForTimeout(150);
  await page.locator('#btnDeleteCard').click();
  await page.locator('#dialogOk').click();
  await page.waitForTimeout(400);
  await expect(page.locator('.card-list-item')).toHaveCount(1);
  expect(await page.evaluate(() => window.AppState.cards[0].name)).toContain('Copy');

  expect(errors, 'duplicate/delete flow must not throw').toEqual([]);
});

test('rapid card switching never cross-writes debounced edits', async ({ page }) => {
  // Regression for #75: a debounced editor sync firing mid card-switch must not
  // persist one card's values into another.
  const errors = collectErrors(page);
  await page.goto('/');
  // Import one card with description filled, plus five that stay empty.
  const withDesc = v2Card('Hold');
  await importCards(page, [withDesc, v2Card('Empty2'), v2Card('Empty3'), v2Card('Empty4'), v2Card('Empty5'), v2Card('Empty6')]);
  await page.locator('.card-list-item', { hasText: 'Hold' }).click();
  await page.locator('#editName').fill('Hold Renamed');
  for (let i = 2; i <= 6; i++) {
    await page.locator('.card-list-item', { hasText: 'Empty' + i }).click();
  }
  await page.waitForTimeout(1000); // let the 500ms debounce (and its guard) run

  // Every OTHER card must still hold its own data: no name drift and no card
  // absorbed the "Hold" text typed into the previous card (its own template
  // description legitimately contains "Hold is a test character…").
  const contaminated = await page.evaluate(async () => {
    const bad = [];
    for (const meta of CardStorage.getCards()) {
      if (meta.name === 'Hold Renamed') continue;
      const full = await CardStorage.getCard(meta._id);
      if (!full) continue;
      if (full.name !== meta.name) bad.push('name:' + meta.name);
      if ((full.description || '').includes('Hold')) bad.push('desc:' + meta.name);
    }
    return bad;
  });
  expect(contaminated, 'no cross-card write contamination').toEqual([]);
  // And the intended card kept its edit (proves the writes aren't just lost).
  const heldName = await page.evaluate(async () => {
    const meta = CardStorage.getCards().find((c) => c.name === 'Hold Renamed');
    if (!meta) return null;
    const full = await CardStorage.getCard(meta._id);
    return full ? full.name : null;
  });
  expect(heldName).toBe('Hold Renamed');
  expect(errors, 'rapid-switch flow must not throw').toEqual([]);
});

test('grouped library: letter groups, collapse, tag chips, persisted sort', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [
    v2Card('Alpha', { tags: ['rpg'] }), v2Card('Bravado', { tags: ['rpg'] }),
    v2Card('Citroen', { tags: ['modern'] }), v2Card('delta', { tags: ['modern'] }),
    v2Card('Zed', { tags: [] }), v2Card('1Nine', { tags: [] }), v2Card('.hidden', { tags: [] }),
  ]);

  await page.locator('#cardSortSelect').selectOption('name-asc');
  await page.locator('#cardSortSelect').dispatchEvent('change');
  await page.waitForTimeout(300);
  const letters = await page.evaluate(() =>
    [...document.querySelectorAll('.card-group-header')].map((h) => h.dataset.letter)
  );
  expect(letters[0]).toBe('#');
  expect(letters).toEqual(['#', '1', 'A', 'B', 'C', 'D', 'Z']);

  // Collapse/expand the A group.
  await page.locator('.card-group-header[data-letter="A"]').click();
  await page.waitForTimeout(150);
  await expect(page.locator('.card-group-header[data-letter="A"]')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.card-list-group[data-letter="A"] .card-list-item').first()).toBeHidden();
  await page.locator('.card-group-header[data-letter="A"]').click();
  await page.waitForTimeout(150);
  await expect(page.locator('.card-group-header[data-letter="A"]')).toHaveAttribute('aria-expanded', 'true');

  // Under name-asc sorting a drop must not reshuffle the (invisible) manual order.
  const orderBefore = await page.evaluate(() => window.AppState.cards.map((c) => c.name));
  await page.locator('.card-drag-handle[data-card-id]').first().dispatchEvent('dragstart');
  await page.locator('.card-list-item', { hasText: 'Bravado' }).dispatchEvent('dragover');
  await page.locator('.card-list-item', { hasText: 'Bravado' }).dispatchEvent('drop');
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.AppState.cards.map((c) => c.name))).toEqual(orderBefore);

  // Tag chips filter the library.
  await page.locator('#tagChipStrip .tag-chip-strip-chip[data-tag="modern"]').first().click();
  await page.waitForTimeout(250);
  await expect(page.locator('.card-list-item')).toHaveCount(2);

  // Sort mode persists after a reload.
  await page.locator('#cardSortSelect').selectOption('name-desc');
  await page.locator('#cardSortSelect').dispatchEvent('change');
  await page.reload();
  await expect(page.locator('#cardSortSelect')).toHaveValue('name-desc');
  expect(await page.locator('.card-list-item .card-list-name').first().innerText()).toBe('Zed');

  expect(errors, 'grouped library must not throw').toEqual([]);
});

test('switching cards clears stale AI chat and never duplicates history', async ({ page }) => {
  // Regression: renderChatHistory() bailed out with an empty history WITHOUT
  // clearing the DOM or latching _historyRendered, so a card with no chat
  // showed the previous card's messages; cards with history STACKED their
  // transcripts on top of the previous card's, and switching back re-appended
  // the whole history (duplicates).
  const errors = collectErrors(page);
  await page.goto('/');
  await page.evaluate(async () => {
    const seed = async (name, sid, msgs) => {
      const card = CardEngine.createEmptyCard();
      card.name = name;
      await CardStorage.upsertCard(card);
      if (!msgs) return;
      const now = Date.now();
      CardStorage.saveChatSession(card._id, {
        id: sid,
        created: now,
        lastUpdated: now,
        preview: msgs[0].content,
        messageCount: msgs.length,
      });
      CardStorage.saveSessionMessages(card._id, sid, msgs);
    };
    await seed('Aria', 'ses_a_0001', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    await seed('Borin', 'ses_b_0001', [
      { role: 'user', content: 'ola' },
      { role: 'assistant', content: 'hola' },
    ]);
    await seed('Cleo', null, null); // no chat at all
  });
  await page.reload();
  await expect(page.locator('.card-list-item')).toHaveCount(3);

  // Card with history renders its own two messages...
  await page.locator('.card-list-item', { hasText: 'Aria' }).click();
  await expect(page.locator('#aiChatMessages .ai-message')).toHaveCount(2);

  // ...and a second card with history renders ITS OWN two — not Aria's plus
  // its own stacked below.
  await page.locator('.card-list-item', { hasText: 'Borin' }).click();
  await expect(page.locator('#aiChatMessages .ai-message')).toHaveCount(2);

  // A card with no chat must show the welcome, never the previous chat.
  await page.locator('.card-list-item', { hasText: 'Cleo' }).click();
  await expect(page.locator('#aiChatMessages .ai-message')).toHaveCount(0);
  await expect(page.locator('#aiChatMessages .ai-welcome')).toBeVisible();

  // Switching back to a card with history renders it exactly once.
  await page.locator('.card-list-item', { hasText: 'Aria' }).click();
  await expect(page.locator('#aiChatMessages .ai-message')).toHaveCount(2);

  expect(errors, 'card-switch chat flow must not throw').toEqual([]);
});

test('selecting a card repairs {user}/{char} placeholders into {{user}}/{{char}}', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [v2Card('Placeholders', {
    description: 'Elle arrive chez {user}, et {CHAR} lui répond.',
    first_mes: 'Bonjour {UsER}.',
  })]);
  // Opening the card runs the load-time repair and persists the cleaned card.
  await page.locator('.card-list-item').first().click();
  await page.waitForTimeout(300);
  const stored = await page.evaluate(async () => {
    const meta = CardStorage.getCards().find((c) => c.name === 'Placeholders');
    const full = meta ? await CardStorage.getCard(meta._id) : null;
    return full ? { description: full.description, first_mes: full.first_mes } : null;
  });
  expect(stored.description).toBe('Elle arrive chez {{user}}, et {{char}} lui répond.');
  expect(stored.first_mes).toBe('Bonjour {{user}}.');
  expect(errors, 'placeholder repair must not throw').toEqual([]);
});