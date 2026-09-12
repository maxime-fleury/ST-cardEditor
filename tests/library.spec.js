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
  expect(await page.evaluate(() => window.CardState.activeCard.name)).toContain('Copy');

  // Reselect the original (exact name — the clone contains "DupSource" too) and
  // delete it through the in-app confirm dialog.
  await page.locator('.card-list-item').filter({ has: page.getByText('DupSource', { exact: true }) }).click();
  await page.waitForTimeout(150);
  await page.locator('#btnDeleteCard').click();
  await page.locator('#dialogOk').click();
  await page.waitForTimeout(400);
  await expect(page.locator('.card-list-item')).toHaveCount(1);
  expect(await page.evaluate(() => window.CardState.cards[0].name)).toContain('Copy');

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
  const orderBefore = await page.evaluate(() => window.CardState.cards.map((c) => c.name));
  await page.locator('.card-drag-handle[data-card-id]').first().dispatchEvent('dragstart');
  await page.locator('.card-list-item', { hasText: 'Bravado' }).dispatchEvent('dragover');
  await page.locator('.card-list-item', { hasText: 'Bravado' }).dispatchEvent('drop');
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.CardState.cards.map((c) => c.name))).toEqual(orderBefore);

  // Tag chips filter the library.
  await page.locator('#tagChipStrip .tag-chip-strip-chip[data-tag="modern"]').first().click();
  await page.waitForTimeout(250);
  await expect(page.locator('.card-list-item')).toHaveCount(2);

  // Sort mode AND the active tag filter both survive a reload: the library view
  // (query, tag filters, collapsed groups) is persisted alongside the sort, so a
  // user who filtered the library does not come back to a full one.
  await page.locator('#cardSortSelect').selectOption('name-desc');
  await page.locator('#cardSortSelect').dispatchEvent('change');
  await page.reload();
  await expect(page.locator('#cardSortSelect')).toHaveValue('name-desc');
  await expect(page.locator('.card-list-item')).toHaveCount(2);
  expect(await page.locator('.card-list-item .card-list-name').first().innerText()).toBe('delta');

  // Clearing the restored filter brings the whole (still name-desc) library back.
  await page.locator('#tagChipStrip .tag-chip-strip-clear').click();
  await page.waitForTimeout(250);
  await expect(page.locator('.card-list-item')).toHaveCount(7);
  expect(await page.locator('.card-list-item .card-list-name').first().innerText()).toBe('Zed');

  expect(errors, 'grouped library must not throw').toEqual([]);
});

test('full-text search matches body fields and names the field that matched', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  // Four cards: the search box only appears once the library is big enough to
  // need it (`cards.length > 3` in renderCardList).
  await importCards(page, [
    v2Card('Aurora', { description: 'A cartographer who maps impossible coastlines.' }),
    v2Card('Bishop', { description: 'A quiet librarian from Toulouse, fond of a good café.' }),
    v2Card('Cinder', { description: 'A blacksmith with soot in her hair.' }),
    v2Card('Dune', { description: 'A navigator of the dry seas.' }),
  ]);
  // The index is built in an idle callback after the first render.
  await page.waitForFunction(() => window.CardSearch && window.CardSearch.size >= 4, null, { timeout: 10_000 });

  // A word that exists only in the body (never the name/tags) now finds the card.
  await page.locator('#cardSearchInput').fill('librarian');
  await expect(page.locator('.card-list-item')).toHaveCount(1);
  await expect(page.locator('.card-list-name')).toHaveText('Bishop');
  await expect(page.locator('.card-match-field')).toHaveText('Description');
  await expect(page.locator('.card-list-match mark')).toHaveText(/librarian/i);

  // Accent-insensitive: the query is typed without the diacritic, the snippet
  // highlights the accented original.
  await page.locator('#cardSearchInput').fill('cafe');
  await expect(page.locator('.card-list-item')).toHaveCount(1);
  await expect(page.locator('.card-list-match mark')).toHaveText('café');

  // Clearing the query restores the full library.
  await page.locator('#cardSearchInput').fill('');
  await expect(page.locator('.card-list-item')).toHaveCount(4);
  expect(errors, 'full-text search must not throw').toEqual([]);
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

test('switching cards focuses the AI input until the user moves on', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [v2Card('FocusA'), v2Card('FocusB')]);

  // The quick-editing workflow: selecting a card parks the caret in the AI
  // input so a prompt can be typed immediately.
  await page.locator('.card-list-item', { hasText: 'FocusA' }).click();
  await expect(page.locator('#aiInput')).toBeFocused();

  // ...but that autofocus is a 100 ms timeout, so it must never override a field
  // the user has already clicked into — it used to steal the caret mid-typing.
  await page.locator('.card-list-item', { hasText: 'FocusB' }).click();
  await page.locator('#editDescription').click();
  await page.locator('#editDescription').pressSequentially('typed right after the switch');
  await page.waitForTimeout(300); // outlive the autofocus timer
  await expect(page.locator('#editDescription')).toBeFocused();
  // The keystrokes must have landed in THIS field (inserted at the caret), which
  // is what proves focus was never taken away mid-typing.
  await expect(page.locator('#editDescription')).toHaveValue(/typed right after the switch/);
  expect(errors, 'a card switch must not steal focus').toEqual([]);
});

test('tag chips and card reordering work from the keyboard', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [
    v2Card('Alpha', { tags: ['modern'] }),
    v2Card('Bravo'),
    v2Card('Charlie'),
    v2Card('Delta'),
  ]);
  const order = () => page.evaluate(() => window.CardState.cards.map((c) => c.name));

  // The tag cloud chips filter the list, so they must be real buttons with a
  // machine-readable pressed state — a click-only <span> is invisible to
  // keyboard and screen-reader users.
  await page.locator('#btnToggleTagCloud').click();
  const chip = page.locator('#tagCloud .tag-chip[data-tag="modern"]');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveJSProperty('tagName', 'BUTTON');
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.card-list-item')).toHaveCount(1);
  await expect(page.locator('#tagCloud .tag-chip[data-tag="modern"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#tagChipStrip .tag-chip-strip-clear').click();
  await expect(page.locator('.card-list-item')).toHaveCount(4);

  // Arrow keys on the drag handle are the keyboard equivalent of drag & drop.
  const initial = await order();
  expect(initial).toHaveLength(4);
  const firstId = await page.evaluate(() => window.CardState.cards[0]._id);
  const handle = page.locator(`.card-drag-handle[data-card-id="${firstId}"]`);
  await handle.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(order).toEqual([initial[1], initial[0], initial[2], initial[3]]);
  // Focus must survive the re-render (the whole list is rebuilt), or the second
  // press would go nowhere — the handle now sits on the second row.
  await expect(page.locator(`.card-drag-handle[data-card-id="${firstId}"]`)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect.poll(order).toEqual([initial[1], initial[2], initial[0], initial[3]]);

  // With a search active the visible order is a subset, so a reorder is refused
  // rather than silently reshuffling the hidden manual order.
  const sorted = await order();
  await page.locator('#cardSearchInput').fill('Alpha');
  await expect(page.locator('.card-list-item')).toHaveCount(1);
  await page.locator('.card-drag-handle').first().focus();
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(200);
  expect(await order()).toEqual(sorted);

  expect(errors, 'keyboard library operations must not throw').toEqual([]);
});

test('version history records, compares and restores edits', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [v2Card('Historian', { description: 'First draft.' }), v2Card('Second')]);
  await page.locator('.card-list-item', { hasText: 'Historian' }).click();
  await page.locator('#editDescription').fill('Second draft.');
  await page.waitForTimeout(1200); // debounced autosave

  // The preview lists the content that was replaced — the point of the feature
  // is finding an earlier draft, so the list must be there before any other UI.
  await page.locator('.card-list-item', { hasText: 'Historian' }).locator('.card-preview-btn').click();
  await expect(page.locator('#cardPreviewModal')).toHaveClass(/show/);
  await expect(page.locator('#cardPreviewHistory .history-item')).toHaveCount(1);

  // Compare opens the read-only diff: the apply buttons (and any leftover
  // Review & Apply handler) must not be reachable from a comparison.
  await page.locator('#cardPreviewHistory .history-compare').first().click();
  await expect(page.locator('#aiPreviewModal')).toHaveClass(/show/);
  await expect(page.locator('#btnAcceptAI')).toBeHidden();
  await expect(page.locator('#btnApplyAll')).toBeHidden();
  await expect(page.locator('#aiDiffNew')).toContainText('Second draft.');
  await page.locator('#aiPreviewModal .modal-header .btn-close').click();
  await expect(page.locator('#aiPreviewModal')).not.toHaveClass(/show/);

  // Comparing closes the preview (two Bootstrap modals must never be in flight
  // at once — hide() is ignored mid-transition), so reopen it to restore.
  await page.locator('.card-list-item', { hasText: 'Historian' }).locator('.card-preview-btn').click();
  await expect(page.locator('#cardPreviewModal')).toHaveClass(/show/);

  // Restore puts the earlier text back, and is itself a version.
  await page.locator('#cardPreviewHistory .history-restore').first().click();
  await expect(page.locator('#editDescription')).toHaveValue('First draft.');
  await expect(page.locator('#cardPreviewHistory .history-item')).toHaveCount(2);
  await page.locator('#cardPreviewModal .modal-header .btn-close').click();
  await expect(page.locator('#cardPreviewModal')).not.toHaveClass(/show/);

  expect(errors, 'version history must not throw').toEqual([]);
});

test('preview reports card problems and the lorebook entries that can fire', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [v2Card('Broken', {
    description: 'Meets {{usser}} in the rain.',
    tags: [],
    character_book: {
      entries: [
        { keys: [], content: 'no key and not constant' },
        { keys: ['Broken'], content: 'fires on the card text alone' },
      ],
    },
  })]);
  await page.locator('.card-list-item').first().locator('.card-preview-btn').click();
  await expect(page.locator('#cardPreviewModal')).toHaveClass(/show/);

  const health = page.locator('#cardPreviewHealth');
  await expect(health).toContainText('usser');            // macro typo sent verbatim
  await expect(health).toContainText('no key');           // an entry that can never fire
  await expect(health).toContainText('1 lorebook entry'); // the keyed one matches the card
  // Severity has to survive without colour: the class carries it too.
  await expect(health.locator('.health-issue.is-warn').first()).toBeVisible();
  await expect(health.locator('.health-issue.is-info').first()).toBeVisible();
  expect(errors, 'card diagnostics must not throw').toEqual([]);
});

test('batch delete can be undone, restoring content and chat', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [v2Card('KeepA'), v2Card('KeepB')]);
  // Give both cards a distinctive description and one card a chat message.
  await page.locator('.card-list-item', { hasText: 'KeepA' }).click();
  await page.locator('#editDescription').fill('Restored description A.');
  await page.waitForTimeout(1200);
  await page.evaluate(async () => {
    const meta = CardStorage.getCards().find((c) => c.name === 'KeepB');
    CardStorage.saveChatHistory([{ role: 'user', content: 'still here?' }], meta._id);
  });
  await page.waitForTimeout(200);

  await page.locator('.card-list-item', { hasText: 'KeepA' }).locator('.card-batch-check').check();
  await page.locator('.card-list-item', { hasText: 'KeepB' }).locator('.card-batch-check').check();
  await expect(page.locator('#batchCount')).toHaveText(/2/);
  await page.locator('#btnBatchDelete').click();
  await page.locator('#dialogOk').click();
  await expect(page.locator('.card-list-item')).toHaveCount(0);

  // Undo must bring the cards back whole: an undo that resurrects an empty
  // shell (no text, no chat) is worse than no undo at all.
  await page.locator('.undo-delete-btn').click();
  await expect(page.locator('.card-list-item')).toHaveCount(2);
  const restored = await page.evaluate(async () => {
    const out = {};
    for (const meta of CardStorage.getCards()) {
      const full = await CardStorage.getCard(meta._id);
      out[meta.name] = {
        description: full ? full.description : null,
        chat: CardStorage.getChatHistory(meta._id).length,
      };
    }
    return out;
  });
  expect(restored.KeepA.description).toBe('Restored description A.');
  expect(restored.KeepB.chat).toBe(1);
  expect(errors, 'batch-delete undo must not throw').toEqual([]);
});