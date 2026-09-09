import {
  CardStorage,
  Editor,
  I18n,
  Ui
} from "./app.chunk.js";

// js/waifuTab.js
var WaifuTab = {
  _fetched: [],
  _selected: -1,
  _fetching: false,
  _source: "snapshot",
  _gender: "all",
  _mode: "source",
  _preloaded: false,
  _lastRun: null,
  init() {
    const on = (sel, event, fn) => {
      const el = document.querySelector(sel);
      if (el)
        el.addEventListener(event, fn);
    };
    on("#waifuBtnFetch", "click", () => this._fetch());
    on("#waifuBtnRegenerate", "click", () => this._regenerate());
    on("#waifuBtnMixed", "click", () => this._fetchMixedFromUI());
    on("#waifuBtnUse", "click", () => this._useSelected());
    on("#waifuBtnRemove", "click", () => this._removeCurrent());
    on("#waifuBtnUpload", "click", () => {
      const inp = document.querySelector("#waifuUploadInput");
      if (inp)
        inp.click();
    });
    on("#waifuUploadInput", "change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f)
        Editor.setAvatar(f);
      e.target.value = "";
    });
    on("#waifuSourceSelect", "change", () => this._onSourceChange());
    const chipsWrap = document.querySelector("#waifuGenderChips");
    if (chipsWrap) {
      chipsWrap.addEventListener("click", (e) => {
        const chip = e.target.closest(".waifu-chip");
        if (!chip || !chip.dataset.gender)
          return;
        this._gender = chip.dataset.gender;
        chipsWrap.querySelectorAll(".waifu-chip").forEach((c) => {
          c.classList.toggle("active", c === chip);
        });
      });
    }
    const search = document.querySelector("#waifuTagSearch");
    if (search) {
      search.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this._fetch();
        }
      });
    }
    const tabTrigger = document.querySelector('#editorTabs .nav-link[data-bs-target="#tabWaifu"]');
    if (tabTrigger) {
      tabTrigger.addEventListener("shown.bs.tab", () => {
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
  _onSourceChange(mode) {
    const select = document.querySelector("#waifuSourceSelect");
    this._source = select ? select.value : "snapshot";
    this._mode = mode || "source";
    const isChar = this._source === "character";
    const genderWrap = document.querySelector("#waifuGenderWrap");
    if (genderWrap)
      genderWrap.style.display = isChar ? "" : "none";
    const sub = document.querySelector("#waifuSubText");
    const search = document.querySelector("#waifuTagSearch");
    const label = document.querySelector("#waifuSearchLabel");
    if (isChar) {
      if (sub)
        sub.textContent = I18n.t("editor.waifuCharSub");
      if (search)
        search.placeholder = I18n.t("editor.waifuSearchPlaceholderChar");
      if (label)
        label.textContent = I18n.t("editor.waifuSearchChar");
    } else {
      if (sub)
        sub.textContent = I18n.t("editor.waifuSub");
      if (search)
        search.placeholder = I18n.t("editor.waifuSearchPlaceholder");
      if (label)
        label.textContent = I18n.t("editor.waifuSearch");
    }
    this._syncGenderChips();
    this._discardResults();
  },
  _syncGenderChips() {
    const wrap = document.querySelector("#waifuGenderChips");
    if (!wrap)
      return;
    wrap.querySelectorAll(".waifu-chip").forEach((c) => {
      c.classList.toggle("active", c.dataset.gender === this._gender);
    });
  },
  _discardResults() {
    this._fetched.forEach((f) => {
      if (f && f.objUrl)
        URL.revokeObjectURL(f.objUrl);
    });
    this._fetched = [];
    this._selected = -1;
    this._render();
  },
  _searchValue() {
    const inp = document.querySelector("#waifuTagSearch");
    return inp ? inp.value.trim() : "";
  },
  _tagsFromSearch(searchVal) {
    const tags = (searchVal || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!tags.length)
      tags.push("waifu");
    return tags;
  },
  _slotTags(userTags, i) {
    const idx1 = i * 2 % userTags.length;
    const tags = [userTags[idx1]];
    if (userTags.length > 1) {
      const idx2 = (i * 2 + 1) % userTags.length;
      if (idx2 !== idx1)
        tags.push(userTags[idx2]);
    }
    return tags;
  },
  async _fetchSnapshots(searchVal) {
    const results = [];
    const userTags = this._tagsFromSearch(searchVal);
    for (let i = 0;i < 3; i++) {
      try {
        const slotTags = this._slotTags(userTags, i);
        const page = Math.max(1, Math.floor(Math.random() * 20));
        const resp = await fetch("https://api.waifu.im/images?" + "included_tags=" + encodeURIComponent(slotTags.join(",")) + "&is_nsfw=false&page=" + page);
        if (!resp.ok)
          throw new Error("API returned " + resp.status);
        const data = await resp.json();
        const items = data.items || [];
        if (!items.length)
          throw new Error("No image for " + slotTags.join(", "));
        const item = items[Math.floor(Math.random() * items.length)];
        const imgResp = await fetch(item.url);
        const blob = await imgResp.blob();
        const objUrl = URL.createObjectURL(blob);
        results.push({
          blob,
          url: item.url,
          objUrl,
          tags: (item.tags || []).map((t) => t.name).slice(0, 4).join(", ")
        });
      } catch (e) {
        console.error("waifu tab snapshot slot " + i + " fetch failed", e);
      }
    }
    return results;
  },
  async _graphQL(query, variables) {
    const resp = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables })
    });
    if (!resp.ok)
      throw new Error("AniList returned " + resp.status);
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
  async _queryCharacters(searchVal, genderWanted, want) {
    const search = searchVal || null;
    const perPage = 50;
    const candidates = [];
    const sort = search ? "SEARCH_MATCH" : "FAVOURITES_DESC";
    const pages = search ? 2 : 4;
    for (let page = 1;page <= pages; page++) {
      try {
        const data = await this._graphQL(this._characterQuery(), {
          search,
          page,
          perPage,
          sort: [sort]
        });
        const chars = data.data && data.data.Page && data.data.Page.characters || [];
        let pool = chars;
        if (genderWanted !== "all") {
          pool = pool.filter((c) => c && (c.gender || "").toLowerCase() === genderWanted);
        }
        for (const c of pool) {
          if (c && c.image && c.image.large)
            candidates.push(c);
        }
      } catch (e) {
        console.error("AniList character fetch failed", e);
        break;
      }
      if (candidates.length >= 60)
        break;
    }
    if (search) {
      candidates.splice(want);
    } else {
      for (let i = candidates.length - 1;i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }
    }
    const results = [];
    for (const c of candidates) {
      if (results.length >= want)
        break;
      try {
        const imgResp = await fetch(c.image.large);
        if (!imgResp.ok)
          continue;
        const blob = await imgResp.blob();
        const objUrl = URL.createObjectURL(blob);
        const name = c.name && c.name.full || "";
        const g = (c.gender || "").toLowerCase();
        let genderLabel = "?";
        if (g === "female")
          genderLabel = "Female";
        else if (g === "male")
          genderLabel = "Male";
        else if (genderWanted === "female")
          genderLabel = "Female";
        else if (genderWanted === "male")
          genderLabel = "Male";
        results.push({ blob, url: c.image.large, objUrl, tags: (name + " · " + genderLabel).trim() });
      } catch (_) {}
    }
    return results;
  },
  async _fetchMixed(searchVal) {
    const [female, male] = await Promise.all([
      this._queryCharacters(searchVal, "female", 3),
      this._queryCharacters(searchVal, "male", 3)
    ]);
    const out = [];
    for (let i = 0;i < 3; i++) {
      if (female[i])
        out.push(female[i]);
      if (male[i])
        out.push(male[i]);
    }
    return out;
  },
  _currentIntent() {
    return {
      mode: this._mode,
      source: this._source,
      gender: this._gender,
      search: this._searchValue()
    };
  },
  async _runFetch(intent, triggerBtn) {
    if (this._fetching)
      return;
    this._fetching = true;
    const fetchBtn = document.querySelector("#waifuBtnFetch");
    const fetchLabel = fetchBtn ? fetchBtn.querySelector("span") : null;
    if (fetchLabel)
      fetchLabel.textContent = I18n.t("wizard.fetching");
    if (triggerBtn)
      triggerBtn.disabled = true;
    try {
      let results;
      if (intent.mode === "mixed") {
        results = await this._fetchMixed(intent.search);
      } else if (intent.source === "character") {
        results = await this._queryCharacters(intent.search, intent.gender, 3);
      } else {
        results = await this._fetchSnapshots(intent.search);
      }
      this._fetched.forEach((f) => {
        if (f && f.objUrl)
          URL.revokeObjectURL(f.objUrl);
      });
      this._fetched = results;
      this._selected = results.length ? 0 : -1;
      this._render();
      if (!results.length) {
        Ui.showToast(I18n.t("toast.wizardFetchFailed", { error: "No results found" }), "danger");
      }
      this._lastRun = intent;
    } finally {
      this._fetching = false;
      if (fetchLabel)
        fetchLabel.textContent = I18n.t("editor.waifuFetch");
      if (triggerBtn)
        triggerBtn.disabled = false;
    }
  },
  _fetch() {
    this._mode = "source";
    this._runFetch(this._currentIntent(), document.querySelector("#waifuBtnFetch"));
  },
  _regenerate() {
    if (!this._lastRun) {
      this._fetch();
      return;
    }
    this._runFetch({ ...this._lastRun }, document.querySelector("#waifuBtnRegenerate"));
  },
  _fetchMixedFromUI() {
    const src = document.querySelector("#waifuSourceSelect");
    if (src)
      src.value = "character";
    this._source = "character";
    this._gender = "all";
    this._mode = "mixed";
    this._onSourceChange("mixed");
    this._syncGenderChips();
    this._runFetch({ mode: "mixed", search: this._searchValue() }, document.querySelector("#waifuBtnMixed"));
  },
  _render() {
    const wrap = document.querySelector("#waifuResults");
    const btnUse = document.querySelector("#waifuBtnUse");
    if (!wrap)
      return;
    if (!this._fetched.length) {
      wrap.innerHTML = "";
      if (btnUse)
        btnUse.hidden = true;
      return;
    }
    wrap.innerHTML = '<div class="waifu-results-grid">' + this._fetched.map((f, i) => {
      const tagHtml = f.tags ? '<div class="waifu-card-tags">' + Ui.escapeHtml(f.tags) + "</div>" : "";
      return '<div class="waifu-card' + (i === this._selected ? " selected" : "") + '" data-idx="' + i + '" role="button" tabindex="0">' + '<img src="' + f.objUrl + '" alt="">' + tagHtml + "</div>";
    }).join("") + "</div>";
    wrap.querySelectorAll(".waifu-card").forEach((card) => {
      card.addEventListener("click", () => {
        this._selected = +card.dataset.idx;
        this._render();
      });
    });
    if (btnUse)
      btnUse.hidden = this._selected < 0;
  },
  async _useSelected() {
    if (this._selected < 0 || !this._fetched[this._selected])
      return;
    const { activeCard } = window.AppState;
    if (!activeCard) {
      Ui.showToast(I18n.t("toast.createCardFirst"), "warning");
      return;
    }
    await Editor.setAvatar(this._fetched[this._selected].blob);
    this._refreshPreview();
  },
  async _removeCurrent() {
    const { activeCard } = window.AppState;
    if (!activeCard) {
      Ui.showToast(I18n.t("toast.selectCard"), "warning");
      return;
    }
    if (!activeCard._hasImage && !activeCard._imageBase64) {
      Ui.showToast(I18n.t("toast.noImage"), "warning");
      return;
    }
    delete activeCard._imageBase64;
    delete activeCard._thumbnail;
    activeCard._hasImage = false;
    if (activeCard._id) {
      try {
        await CardStorage.deleteImage(activeCard._id);
      } catch (_) {}
    }
    const img = document.querySelector("#charAvatarImg");
    if (img) {
      img.src = "";
      img.hidden = true;
    }
    const ph = document.querySelector("#avatarPlaceholder");
    if (ph)
      ph.style.display = "";
    try {
      await Editor.syncEditorToCard();
    } catch (_) {}
    this._refreshPreview();
    Ui.showToast(I18n.t("toast.imageRemoved"), "success");
  },
  _refreshPreview() {
    const { activeCard } = window.AppState;
    const img = document.querySelector("#waifuCurrentImg");
    const noImg = document.querySelector("#waifuNoImage");
    if (!img || !noImg)
      return;
    if (activeCard && (activeCard._imageBase64 || activeCard._hasImage)) {
      img.src = activeCard._imageBase64 || activeCard._thumbnail || "";
      img.hidden = false;
      noImg.style.display = "none";
    } else {
      img.src = "";
      img.hidden = true;
      noImg.style.display = "";
    }
  }
};
if (typeof window !== "undefined")
  window.WaifuTab = WaifuTab;
export {
  WaifuTab
};
