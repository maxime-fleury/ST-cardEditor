/* ============================================================
   waifuTab.js — "Waifu Image" editor tab
   Fetch a card image from:
     • Anime snapshots (waifu.im) — fast random images by tag
     • Anime characters (AniList) — search named characters of any
       gender (male/eboy included) and use their official portrait.
   Includes a one-click "Girls + Boys" mixed pack (3 f + 3 m), a
   Regenerate button, and auto-preload of that pack on first open.
   Also supports uploading your own, or removing the card image.
   ============================================================ */

const WaifuTab = {
  _fetched: [],        // [{ blob, url, objUrl, tags }]
  _selected: -1,
  _fetching: false,
  _source: 'snapshot', // 'snapshot' | 'character'
  _gender: 'all',      // 'all' | 'female' | 'male' (character source)
  _mode: 'source',     // 'source' | 'mixed' (mixed = the 3f+3m pack)
  _preloaded: false,   // auto-loaded the default pack once per app session
  _lastRun: null,      // last executed intent, so Regenerate can re-roll it

  init() {
    const on = (sel, event, fn) => {
      const el = document.querySelector(sel);
      if (el) el.addEventListener(event, fn);
    };

    on('#waifuBtnFetch', 'click', () => this._fetch());
    on('#waifuBtnRegenerate', 'click', () => this._regenerate());
    on('#waifuBtnMixed', 'click', () => this._fetchMixedFromUI());
    on('#waifuBtnUse', 'click', () => this._useSelected());
    on('#waifuBtnRemove', 'click', () => this._removeCurrent());
    on('#waifuBtnUpload', 'click', () => {
      const inp = document.querySelector('#waifuUploadInput');
      if (inp) inp.click();
    });
    on('#waifuUploadInput', 'change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) Editor.setAvatar(f);
      e.target.value = '';
    });
    on('#waifuSourceSelect', 'change', () => this._onSourceChange());

    // Gender is selected via chips (Any / Female only / Male only).
    const chipsWrap = document.querySelector('#waifuGenderChips');
    if (chipsWrap) {
      chipsWrap.addEventListener('click', (e) => {
        const chip = e.target.closest('.waifu-chip');
        if (!chip || !chip.dataset.gender) return;
        this._gender = chip.dataset.gender;
        chipsWrap.querySelectorAll('.waifu-chip').forEach(c => {
          c.classList.toggle('active', c === chip);
        });
      });
    }

    const search = document.querySelector('#waifuTagSearch');
    if (search) {
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._fetch(); }
      });
    }

    // Refresh the current-image preview each time the tab is shown, and
    // preload a starter pack (3 female + 3 male) the first time it opens.
    const tabTrigger = document.querySelector('#editorTabs .nav-link[data-bs-target="#tabWaifu"]');
    if (tabTrigger) {
      tabTrigger.addEventListener('shown.bs.tab', () => {
        this._refreshPreview();
        this._render();
        if (!this._preloaded && !this._fetched.length && !this._fetching) {
          this._preloaded = true;
          this._fetchMixedFromUI();
        }
      });
    }

    this._onSourceChange();
    this._refreshPreview();
    this._render();
  },

  _onSourceChange() {
    const select = document.querySelector('#waifuSourceSelect');
    this._source = select ? select.value : 'snapshot';
    this._mode = 'source';   // any manual source switch leaves the mixed pack
    const isChar = this._source === 'character';
    const genderWrap = document.querySelector('#waifuGenderWrap');
    if (genderWrap) genderWrap.style.display = isChar ? '' : 'none';

    const sub = document.querySelector('#waifuSubText');
    const search = document.querySelector('#waifuTagSearch');
    const label = document.querySelector('#waifuSearchLabel');
    if (isChar) {
      if (sub) sub.textContent = I18n.t('editor.waifuCharSub');
      if (search) search.placeholder = I18n.t('editor.waifuSearchPlaceholderChar');
      if (label) label.textContent = I18n.t('editor.waifuSearchChar');
    } else {
      if (sub) sub.textContent = I18n.t('editor.waifuSub');
      if (search) search.placeholder = I18n.t('editor.waifuSearchPlaceholder');
      if (label) label.textContent = I18n.t('editor.waifuSearch');
    }
    this._syncGenderChips();
    // Reset stale results when switching source.
    this._discardResults();
  },

  // Reflect the current gender filter on the chips.
  _syncGenderChips() {
    const wrap = document.querySelector('#waifuGenderChips');
    if (!wrap) return;
    wrap.querySelectorAll('.waifu-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.gender === this._gender);
    });
  },

  _discardResults() {
    this._fetched.forEach(f => { if (f && f.objUrl) URL.revokeObjectURL(f.objUrl); });
    this._fetched = [];
    this._selected = -1;
    this._render();
  },

  _searchValue() {
    const inp = document.querySelector('#waifuTagSearch');
    return inp ? inp.value.trim() : '';
  },

  // ─── SNAPSHOT SOURCE (waifu.im) ─────────────────────────────
  _tagsFromSearch(searchVal) {
    const tags = (searchVal || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    if (!tags.length) tags.push('waifu');
    return tags;
  },

  _slotTags(userTags, i) {
    const idx1 = (i * 2) % userTags.length;
    const tags = [userTags[idx1]];
    if (userTags.length > 1) {
      const idx2 = (i * 2 + 1) % userTags.length;
      if (idx2 !== idx1) tags.push(userTags[idx2]);
    }
    return tags;
  },

  async _fetchSnapshots(searchVal) {
    const results = [];
    const userTags = this._tagsFromSearch(searchVal);
    for (let i = 0; i < 3; i++) {
      try {
        const slotTags = this._slotTags(userTags, i);
        const page = Math.max(1, Math.floor(Math.random() * 20));
        const resp = await fetch('https://api.waifu.im/images?'
          + 'included_tags=' + encodeURIComponent(slotTags.join(','))
          + '&is_nsfw=false&page=' + page);
        if (!resp.ok) throw new Error('API returned ' + resp.status);
        const data = await resp.json();
        const items = data.items || [];
        if (!items.length) throw new Error('No image for ' + slotTags.join(', '));
        const item = items[Math.floor(Math.random() * items.length)];
        const imgResp = await fetch(item.url);
        const blob = await imgResp.blob();
        const objUrl = URL.createObjectURL(blob);
        results.push({
          blob,
          url: item.url,
          objUrl,
          tags: (item.tags || []).map(t => t.name).slice(0, 4).join(', '),
        });
      } catch (e) {
        console.error('waifu tab snapshot slot ' + i + ' fetch failed', e);
      }
    }
    return results;
  },

  // ─── CHARACTER SOURCE (AniList) ─────────────────────────────
  async _graphQL(query, variables) {
    const resp = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!resp.ok) throw new Error('AniList returned ' + resp.status);
    return resp.json();
  },

  _characterQuery() {
    return `
      query ($search: String, $page: Int, $perPage: Int, $sort: [CharacterSort]) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { hasNextPage }
          characters(search: $search, sort: $sort) {
            id
            name { full }
            gender
            image { large }
          }
        }
      }`;
  },

  // Fetch up to `want` AniList characters, gender-filtered client-side.
  // For a general browse the candidate pool is shuffled, so refetching
  // (Regenerate) yields a different batch rather than the same top picks.
  async _queryCharacters(searchVal, genderWanted, want) {
    const search = searchVal || null;
    const perPage = 50;
    const candidates = [];
    // AniList has no POPULARITY sort for characters: use SEARCH_MATCH for a
    // name query and FAVOURITES_DESC for a general browse.
    const sort = search ? 'SEARCH_MATCH' : 'FAVOURITES_DESC';
    const pages = search ? 2 : 4;
    for (let page = 1; page <= pages; page++) {
      try {
        const data = await this._graphQL(this._characterQuery(), {
          search, page, perPage, sort: [sort],
        });
        const chars = (data.data && data.data.Page && data.data.Page.characters) || [];
        let pool = chars;
        if (genderWanted !== 'all') {
          pool = pool.filter(c => c && (c.gender || '').toLowerCase() === genderWanted);
        }
        for (const c of pool) {
          if (c && c.image && c.image.large) candidates.push(c);
        }
      } catch (e) {
        console.error('AniList character fetch failed', e);
        break;
      }
      if (candidates.length >= 60) break;
    }

    // Name queries keep relevance order; browse mode shuffles for variety.
    if (search) {
      candidates.splice(want);
    } else {
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }
    }

    const results = [];
    for (const c of candidates) {
      if (results.length >= want) break;
      try {
        const imgResp = await fetch(c.image.large);
        if (!imgResp.ok) continue;
        const blob = await imgResp.blob();
        const objUrl = URL.createObjectURL(blob);
        const name = (c.name && c.name.full) || '';
        // AniList reports null for many characters' gender; label only when we
        // actually know it, otherwise reflect the requested filter (or '?' from
        // a general browse) instead of assuming Male.
        const g = (c.gender || '').toLowerCase();
        let genderLabel = '?';
        if (g === 'female') genderLabel = 'Female';
        else if (g === 'male') genderLabel = 'Male';
        else if (genderWanted === 'female') genderLabel = 'Female';
        else if (genderWanted === 'male') genderLabel = 'Male';
        results.push({ blob, url: c.image.large, objUrl, tags: (name + ' · ' + genderLabel).trim() });
      } catch (e) {
        // skip individual image-fetch failures
      }
    }
    return results;
  },

  // Balanced "Girls + Boys" pack: 3 female + 3 male, interleaved.
  async _fetchMixed(searchVal) {
    const [female, male] = await Promise.all([
      this._queryCharacters(searchVal, 'female', 3),
      this._queryCharacters(searchVal, 'male', 3),
    ]);
    const out = [];
    for (let i = 0; i < 3; i++) {
      if (female[i]) out.push(female[i]);
      if (male[i]) out.push(male[i]);
    }
    return out;
  },

  // ─── FETCH/DISPATCH ─────────────────────────────────────────
  _currentIntent() {
    return {
      mode: this._mode,
      source: this._source,
      gender: this._gender,
      search: this._searchValue(),
    };
  },

  async _runFetch(intent, triggerBtn) {
    if (this._fetching) return;
    this._fetching = true;

    const fetchBtn = document.querySelector('#waifuBtnFetch');
    const fetchLabel = fetchBtn ? fetchBtn.querySelector('span') : null;
    if (fetchLabel) fetchLabel.textContent = I18n.t('wizard.fetching');
    if (triggerBtn) triggerBtn.disabled = true;

    try {
      let results;
      if (intent.mode === 'mixed') {
        results = await this._fetchMixed(intent.search);
      } else if (intent.source === 'character') {
        results = await this._queryCharacters(intent.search, intent.gender, 3);
      } else {
        results = await this._fetchSnapshots(intent.search);
      }

      this._fetched.forEach(f => { if (f && f.objUrl) URL.revokeObjectURL(f.objUrl); });
      this._fetched = results;
      this._selected = results.length ? 0 : -1;
      this._render();
      if (!results.length) {
        Ui.showToast(I18n.t('toast.wizardFetchFailed', { error: 'No results found' }), 'danger');
      }
      this._lastRun = intent;
    } finally {
      this._fetching = false;
      if (fetchLabel) fetchLabel.textContent = I18n.t('editor.waifuFetch');
      if (triggerBtn) triggerBtn.disabled = false;
    }
  },

  // “Fetch” always runs the active source/gender selection. If the user last
  // used the Girls+Boys mixed pack, its intent lingers in _mode — forcing this
  // back to 'source' means the Fetch button behaves predictably instead of
  // re-running the mixed pack while the chips show a normal search.
  _fetch() {
    this._mode = 'source';
    this._runFetch(this._currentIntent(), document.querySelector('#waifuBtnFetch'));
  },

  // Re-run the last fetch with the exact same intent (a "re-roll").
  _regenerate() {
    if (!this._lastRun) { this._fetch(); return; }
    this._runFetch({ ...this._lastRun }, document.querySelector('#waifuBtnRegenerate'));
  },

  // One click → the 3f+3m pack; switches the UI into character mode.
  _fetchMixedFromUI() {
    const src = document.querySelector('#waifuSourceSelect');
    if (src) src.value = 'character';
    this._source = 'character';
    this._gender = 'all';
    this._mode = 'mixed';
    this._onSourceChange();   // reflects character mode + clears old results
    this._syncGenderChips();
    this._runFetch({ mode: 'mixed', search: this._searchValue() }, document.querySelector('#waifuBtnMixed'));
  },

  // ─── RENDER / APPLY / REMOVE ────────────────────────────────
  _render() {
    const wrap = document.querySelector('#waifuResults');
    const btnUse = document.querySelector('#waifuBtnUse');
    const isMixed = this._mode === 'mixed';
    if (!wrap) return;

    if (!this._fetched.length) {
      wrap.innerHTML = '';
      if (btnUse) btnUse.hidden = true;
      return;
    }

    wrap.innerHTML = '<div class="waifu-results-grid">' + this._fetched.map((f, i) => {
      const tagHtml = f.tags ? '<div class="waifu-card-tags">' + Ui.escapeHtml(f.tags) + '</div>' : '';
      return '<div class="waifu-card' + (i === this._selected ? ' selected' : '') + '" data-idx="' + i + '" role="button" tabindex="0">'
        + '<img src="' + f.objUrl + '" alt="">' + tagHtml + '</div>';
    }).join('') + '</div>';

    wrap.querySelectorAll('.waifu-card').forEach(card => {
      card.addEventListener('click', () => {
        this._selected = +card.dataset.idx;
        this._render();
      });
    });

    if (btnUse) btnUse.hidden = this._selected < 0;
  },

  async _useSelected() {
    if (this._selected < 0 || !this._fetched[this._selected]) return;
    const { activeCard } = window.AppState;
    if (!activeCard) { Ui.showToast(I18n.t('toast.createCardFirst'), 'warning'); return; }
    await Editor.setAvatar(this._fetched[this._selected].blob);
    this._refreshPreview();
  },

  async _removeCurrent() {
    const { activeCard } = window.AppState;
    if (!activeCard) { Ui.showToast(I18n.t('toast.selectCard'), 'warning'); return; }
    if (!activeCard._hasImage && !activeCard._imageBase64) {
      Ui.showToast(I18n.t('toast.noImage'), 'warning');
      return;
    }
    delete activeCard._imageBase64;
    delete activeCard._thumbnail;
    activeCard._hasImage = false;

    if (activeCard._id) {
      try { await CardStorage.deleteImage(activeCard._id); } catch (_) {}
    }
    const img = document.querySelector('#charAvatarImg');
    if (img) { img.src = ''; img.hidden = true; }
    const ph = document.querySelector('#avatarPlaceholder');
    if (ph) ph.style.display = '';
    try { await Editor.syncEditorToCard(); } catch (_) {}
    this._refreshPreview();
    Ui.showToast(I18n.t('toast.imageRemoved'), 'success');
  },

  _refreshPreview() {
    const { activeCard } = window.AppState;
    const img = document.querySelector('#waifuCurrentImg');
    const noImg = document.querySelector('#waifuNoImage');
    if (!img || !noImg) return;
    if (activeCard && (activeCard._imageBase64 || activeCard._hasImage)) {
      img.src = activeCard._imageBase64 || activeCard._thumbnail || '';
      img.hidden = false;
      noImg.style.display = 'none';
    } else {
      img.src = '';
      img.hidden = true;
      noImg.style.display = '';
    }
  },
};

export { WaifuTab };
if (typeof window !== 'undefined') window.WaifuTab = WaifuTab;