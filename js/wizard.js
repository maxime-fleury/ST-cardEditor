/* ============================================================
   wizard.js — Card Creation Wizard: Guided Character Builder
   ============================================================ */

const Wizard = {
  _step: 1,
  _totalSteps: 5,
  _answers: {},
  _modal: null,

  init() {
    this._modal = new bootstrap.Modal('#wizardModal');
    this._bindEvents();
  },

  show() {
    this._step = 1;
    this._answers = {};
    this._fetchedImageUrl = null;
    this._fetchedImageBlob = null;
    this._autoFetched = false;
    this._resetFormUI();
    this._resetImageUI();
    this._renderStepIndicator();
    this._showStep(1);
    this._modal.show();
    setTimeout(() => {
      const step1 = document.querySelector('.wizard-step[data-step="1"]');
      if (step1) Anims.staggerFadeIn(step1.querySelectorAll('.mb-3, .mb-4'), { stagger: 30, duration: 200 });
    }, 100);
  },

  _resetFormUI() {
    const body = document.querySelector('#wizardModal .modal-body');
    if (!body) return;
    body.querySelectorAll('input[type="text"], textarea').forEach(el => { el.value = ''; });
    body.querySelectorAll('select').forEach(el => { el.selectedIndex = 0; });
    body.querySelectorAll('.wizard-chip.active').forEach(c => c.classList.remove('active'));
    const gc = document.querySelector('#wizGenderCustom'); if (gc) { gc.value = ''; gc.classList.add('d-none'); }
    const lc = document.querySelector('#wizLanguageCustom'); if (lc) { lc.value = ''; lc.classList.add('d-none'); }
  },

  _resetImageUI() {
    const btnFetch = document.querySelector('#wizBtnFetchImage');
    if (btnFetch) btnFetch.innerHTML = '<i class="bi bi-shuffle me-1"></i>' + I18n.t('wizard.fetchImages');
    document.querySelectorAll('.wizard-image-card').forEach(c => {
      c.classList.remove('selected');
      const thumb = c.querySelector('.wiz-thumb');
      if (thumb) { thumb.src = ''; thumb.hidden = true; }
      const ph = c.querySelector('.wizard-image-placeholder');
      if (ph) ph.classList.remove('d-none');
    });
    const btnUse = document.querySelector('#wizBtnUseImage');
    const btnRemove = document.querySelector('#wizBtnRemoveImage');
    if (btnUse) btnUse.classList.add('d-none');
    if (btnRemove) btnRemove.classList.add('d-none');
  },

  _bindEvents() {
    const self = this;

    // Next / Back
    document.querySelector('#wizBtnNext').addEventListener('click', () => self._next());
    document.querySelector('#wizBtnBack').addEventListener('click', () => self._back());

    // Gender custom toggle
    document.querySelector('#wizGender').addEventListener('change', (e) => {
      document.querySelector('#wizGenderCustom').classList.toggle('d-none', e.target.value !== 'other');
    });

    // Language custom toggle
    document.querySelector('#wizLanguage').addEventListener('change', (e) => {
      document.querySelector('#wizLanguageCustom').classList.toggle('d-none', e.target.value !== 'other');
    });

    // Chip selection (multi-select groups)
    document.querySelectorAll('.wizard-chip-group').forEach(group => {
      group.querySelectorAll('.wizard-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          chip.classList.toggle('active');
          Anims.scaleClick(chip);
        });
      });
    });

    // Generate buttons
    document.querySelector('#wizBtnAI').addEventListener('click', () => self._generateWithAI());
    document.querySelector('#wizBtnBlank').addEventListener('click', () => self._generateBlank());

    // Image fetch buttons
    document.querySelector('#wizBtnFetchImage').addEventListener('click', () => self._fetchImage());
    document.querySelector('#wizBtnUseImage').addEventListener('click', () => self._useFetchedImage());
    document.querySelector('#wizBtnRemoveImage').addEventListener('click', () => self._removeFetchedImage());

    // Nav button and center button
    document.querySelector('#btnWizardNav').addEventListener('click', () => self.show());
    const centerBtn = document.querySelector('#btnWizard');
    if (centerBtn) centerBtn.addEventListener('click', () => self.show());

    // Image selection (waifu.im fetched thumbnails)
    self._bindImageEvents();
  },

  _collectStep(step) {
    const a = this._answers;
    switch (step) {
      case 1:
        a.name = document.querySelector('#wizName').value.trim();
        a.gender = document.querySelector('#wizGender').value;
        a.genderCustom = document.querySelector('#wizGenderCustom').value.trim();
        a.tags = document.querySelector('#wizTags').value.split(',').map(s => s.trim()).filter(Boolean);
        a.creator = document.querySelector('#wizCreator').value.trim();
        break;
      case 2:
        a.type = document.querySelector('#wizType').value;
        a.language = document.querySelector('#wizLanguage').value;
        a.languageCustom = document.querySelector('#wizLanguageCustom').value.trim();
        a.genres = this._getChips('wizGenre');
        a.moods = this._getChips('wizMood');
        break;
      case 3:
        a.personalityDesc = document.querySelector('#wizPersonalityDesc').value.trim();
        a.appearance = document.querySelector('#wizAppearance').value.trim();
        a.abilities = document.querySelector('#wizAbilities').value.trim();
        break;
      case 4:
        a.scenario = document.querySelector('#wizScenario').value.trim();
        a.relationship = document.querySelector('#wizRelationship').value.trim();
        a.openingVibe = this._getChips('wizOpening');
        a.notes = document.querySelector('#wizNotes').value.trim();
        break;
    }
  },

  _populateStep(step) {
    const a = this._answers;
    switch (step) {
      case 1:
        if (a.name) document.querySelector('#wizName').value = a.name;
        if (a.gender) document.querySelector('#wizGender').value = a.gender;
        if (a.genderCustom) { document.querySelector('#wizGenderCustom').value = a.genderCustom; document.querySelector('#wizGenderCustom').classList.remove('d-none'); }
        if (a.tags?.length) document.querySelector('#wizTags').value = a.tags.join(', ');
        if (a.creator) document.querySelector('#wizCreator').value = a.creator;
        break;
      case 2:
        if (a.type) document.querySelector('#wizType').value = a.type;
        if (a.language) document.querySelector('#wizLanguage').value = a.language;
        if (a.languageCustom) { document.querySelector('#wizLanguageCustom').value = a.languageCustom; document.querySelector('#wizLanguageCustom').classList.remove('d-none'); }
        this._setChips('wizGenre', a.genres || []);
        this._setChips('wizMood', a.moods || []);
        break;
      case 3:
        if (a.personalityDesc) document.querySelector('#wizPersonalityDesc').value = a.personalityDesc;
        if (a.appearance) document.querySelector('#wizAppearance').value = a.appearance;
        if (a.abilities) document.querySelector('#wizAbilities').value = a.abilities;
        break;
      case 4:
        if (a.scenario) document.querySelector('#wizScenario').value = a.scenario;
        if (a.relationship) document.querySelector('#wizRelationship').value = a.relationship;
        this._setChips('wizOpening', a.openingVibe || []);
        if (a.notes) document.querySelector('#wizNotes').value = a.notes;
        break;
    }
  },

  _getChips(groupId) {
    const active = [];
    document.querySelectorAll('#' + groupId + ' .wizard-chip.active').forEach(c => active.push(c.dataset.value));
    return active;
  },

  _setChips(groupId, values) {
    const valSet = new Set(values);
    document.querySelectorAll('#' + groupId + ' .wizard-chip').forEach(c => {
      c.classList.toggle('active', valSet.has(c.dataset.value));
    });
  },

  _next() {
    this._collectStep(this._step);
    if (this._step === 1 && !this._answers.name) {
      Ui.showToast(I18n.t('wizard.nameRequired'), 'warning');
      Anims.shakeElement(document.querySelector('#wizName'));
      document.querySelector('#wizName').focus();
      return;
    }
    if (this._step < this._totalSteps) {
      const prevStep = this._step;
      this._step++;
      this._populateStep(this._step);
      this._showStepAnimated(this._step, prevStep, 'next');
    }
  },

  _back() {
    this._collectStep(this._step);
    if (this._step > 1) {
      const prevStep = this._step;
      this._step--;
      this._populateStep(this._step);
      this._showStepAnimated(this._step, prevStep, 'back');
    }
  },

  _showStepAnimated(step, prevStep, direction) {
    const prevEl = document.querySelector('.wizard-step[data-step="' + prevStep + '"]');
    const nextEl = document.querySelector('.wizard-step[data-step="' + step + '"]');

    document.querySelector('#wizBtnBack').disabled = step === 1;

    if (step === this._totalSteps) {
      document.querySelector('#wizBtnNext').classList.add('d-none');
      document.querySelector('#wizStepLabel').textContent = I18n.t('wizard.ready');
      this._renderSummary();
    } else {
      document.querySelector('#wizBtnNext').classList.remove('d-none');
      document.querySelector('#wizBtnNext').innerHTML = I18n.t('wizard.next') + ' <i class="bi bi-arrow-right ms-1"></i>';
      document.querySelector('#wizStepLabel').textContent = I18n.t('wizard.stepLabel', { step: step, total: this._totalSteps });
    }

    if (step === this._totalSteps && !this._autoFetched) {
      this._autoFetched = true;
      this._fetchImage();
    }

    this._renderStepIndicator();
    this._updateProgressBar();

    Anims.slideStep(prevEl, nextEl, direction, () => {
      if (step === this._totalSteps) {
        const items = document.querySelectorAll('.wizard-summary-item');
        Anims.staggerFadeIn(items, { stagger: 20, duration: 200 });
      } else {
        Anims.staggerFadeIn(nextEl.querySelectorAll('.mb-3, .mb-4'), { stagger: 25, duration: 180 });
      }
    });
  },

  _showStep(step) {
    document.querySelectorAll('.wizard-step').forEach(el => el.classList.add('d-none'));
    const target = document.querySelector('.wizard-step[data-step="' + step + '"]');
    if (target) target.classList.remove('d-none');

    document.querySelector('#wizBtnBack').disabled = step === 1;

    if (step === this._totalSteps) {
      document.querySelector('#wizBtnNext').classList.add('d-none');
      document.querySelector('#wizStepLabel').textContent = I18n.t('wizard.ready');
      this._renderSummary();
    } else {
      document.querySelector('#wizBtnNext').classList.remove('d-none');
      document.querySelector('#wizBtnNext').innerHTML = I18n.t('wizard.next') + ' <i class="bi bi-arrow-right ms-1"></i>';
      document.querySelector('#wizStepLabel').textContent = I18n.t('wizard.stepLabel', { step: step, total: this._totalSteps });
    }

    if (step === this._totalSteps && !this._autoFetched) {
      this._autoFetched = true;
      this._fetchImage();
    }

    this._renderStepIndicator();
    this._updateProgressBar();
  },

  _renderStepIndicator() {
    const labels = [I18n.t('wizard.step.basics'), I18n.t('wizard.step.concept'), I18n.t('wizard.step.personality'), I18n.t('wizard.step.scenario'), I18n.t('wizard.step.generate')];
    const container = document.querySelector('#wizardStepsIndicator');
    container.innerHTML = labels.map((label, i) => {
      const stepNum = i + 1;
      const isActive = stepNum === this._step;
      const isDone = stepNum < this._step;
      return '<div class="wizard-step-dot' + (isActive ? ' active' : '') + (isDone ? ' done' : '') + '">'
        + (isDone ? '<i class="bi bi-check-lg"></i>' : stepNum)
        + '<span class="wizard-step-dot-label">' + label + '</span>'
        + '</div>';
    }).join('');
  },

  _updateProgressBar() {
    const pct = Math.round((this._step / this._totalSteps) * 100);
    document.querySelector('#wizardProgressBar').style.width = pct + '%';
    Anims.progressBounce(document.querySelector('#wizardProgressBar'));
  },

  _renderSummary() {
    const a = this._answers;
    const genderLabel = a.gender === 'other' ? a.genderCustom : a.gender;
    const langLabel = a.language === 'other' ? a.languageCustom : a.language;
    const typeLabels = {
      original: 'Original Character', fanfic: 'Fan Fiction', game: 'Game Character',
      anime: 'Anime / Manga', book: 'Book / Movie / Show', historical: 'Historical Figure',
      mythological: 'Mythological / Folklore', vtuber: 'VTuber / Streamer', other: 'Other'
    };

    let html = '<div class="wizard-summary-grid">';
    html += '<div class="wizard-summary-item"><span class="wizard-summary-label">' + I18n.t('wizard.summary.name') + '</span><span class="wizard-summary-value">' + Ui.escapeHtml(a.name || '-') + '</span></div>';
    html += '<div class="wizard-summary-item"><span class="wizard-summary-label">' + I18n.t('wizard.summary.gender') + '</span><span class="wizard-summary-value">' + Ui.escapeHtml(genderLabel || '-') + '</span></div>';
    html += '<div class="wizard-summary-item"><span class="wizard-summary-label">' + I18n.t('wizard.summary.type') + '</span><span class="wizard-summary-value">' + Ui.escapeHtml(typeLabels[a.type] || '-') + '</span></div>';
    html += '<div class="wizard-summary-item"><span class="wizard-summary-label">' + I18n.t('wizard.summary.language') + '</span><span class="wizard-summary-value">' + Ui.escapeHtml(langLabel || '-') + '</span></div>';
    html += '<div class="wizard-summary-item"><span class="wizard-summary-label">' + I18n.t('wizard.summary.tags') + '</span><span class="wizard-summary-value">' + Ui.escapeHtml((a.tags || []).join(', ') || '-') + '</span></div>';
    html += '<div class="wizard-summary-item"><span class="wizard-summary-label">' + I18n.t('wizard.summary.genres') + '</span><span class="wizard-summary-value">' + Ui.escapeHtml((a.genres || []).join(', ') || '-') + '</span></div>';
    html += '<div class="wizard-summary-item"><span class="wizard-summary-label">' + I18n.t('wizard.summary.mood') + '</span><span class="wizard-summary-value">' + Ui.escapeHtml((a.moods || []).join(', ') || '-') + '</span></div>';
    html += '<div class="wizard-summary-item"><span class="wizard-summary-label">' + I18n.t('wizard.summary.opening') + '</span><span class="wizard-summary-value">' + Ui.escapeHtml((a.openingVibe || []).join(', ') || '-') + '</span></div>';
    if (a.personalityDesc) html += '<div class="wizard-summary-item full"><span class="wizard-summary-label">' + I18n.t('wizard.summary.personality') + '</span><span class="wizard-summary-value">' + Ui.escapeHtml(a.personalityDesc) + '</span></div>';
    if (a.appearance) html += '<div class="wizard-summary-item full"><span class="wizard-summary-label">' + I18n.t('wizard.summary.appearance') + '</span><span class="wizard-summary-value">' + Ui.escapeHtml(a.appearance) + '</span></div>';
    if (a.scenario) html += '<div class="wizard-summary-item full"><span class="wizard-summary-label">' + I18n.t('wizard.summary.scenario') + '</span><span class="wizard-summary-value">' + Ui.escapeHtml(a.scenario) + '</span></div>';
    if (a.relationship) html += '<div class="wizard-summary-item full"><span class="wizard-summary-label">' + I18n.t('wizard.summary.relationship') + '</span><span class="wizard-summary-value">' + Ui.escapeHtml(a.relationship) + '</span></div>';
    if (a.notes) html += '<div class="wizard-summary-item full"><span class="wizard-summary-label">' + I18n.t('wizard.summary.notes') + '</span><span class="wizard-summary-value">' + Ui.escapeHtml(a.notes) + '</span></div>';
    html += '</div>';

    document.querySelector('#wizardSummary').innerHTML = html;
  },

  // ─── IMAGE FETCH (waifu.im) ─────────────────────────
  _fetchedImages: [],
  _selectedImageIdx: -1,

  _bindImageEvents() {
    const self = this;
    document.querySelectorAll('.wizard-image-card').forEach(card => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.dataset.idx, 10);
        if (!self._fetchedImages[idx]) return;
        document.querySelectorAll('.wizard-image-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        self._selectedImageIdx = idx;
        document.querySelector('#wizBtnUseImage').classList.remove('d-none');
        document.querySelector('#wizBtnRemoveImage').classList.remove('d-none');
        document.querySelector('#wizBtnFetchImage').innerHTML = '<i class="bi bi-shuffle me-1"></i>' + I18n.t('wizard.refetchOthers');
      });
    });
  },

  async _fetchImage() {
    const btn = document.querySelector('#wizBtnFetchImage');
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-hourglass-split me-1"></i>' + I18n.t('wizard.fetching');

    try {
      // Determine which slots need new images (unselected ones).
      // waifu.im /images returns only a single image per request, so we fetch
      // each needed slot with its own request (in parallel).
      const slotsToFetch = [];
      for (let i = 0; i < 3; i++) {
        if (i === this._selectedImageIdx) continue; // keep selected
        slotsToFetch.push(i);
      }
      if (!slotsToFetch.length) { btn.disabled = false; btn.innerHTML = origHtml; return; }

      // Clear unselected cards before fetching
      for (const i of slotsToFetch) {
        const card = document.querySelectorAll('.wizard-image-card')[i];
        card.classList.remove('selected');
        const thumb = card.querySelector('.wiz-thumb');
        thumb.src = '';
        thumb.hidden = true;
        card.querySelector('.wizard-image-placeholder').classList.remove('d-none');
        const prev = this._fetchedImages[i];
        if (prev && prev._objUrl) URL.revokeObjectURL(prev._objUrl);
        this._fetchedImages[i] = null;
      }

      await Promise.all(slotsToFetch.map(async (i) => {
        try {
          const resp = await fetch('https://api.waifu.im/images?included_tags=waifu&is_nsfw=false');
          if (!resp.ok) throw new Error('API returned ' + resp.status);
          const data = await resp.json();
          const item = data.items && data.items[0];
          if (!item) throw new Error('No image returned');
          const imgResp = await fetch(item.url);
          const blob = await imgResp.blob();
          const objUrl = URL.createObjectURL(blob);
          this._fetchedImages[i] = { blob, url: item.url, _objUrl: objUrl, tags: (item.tags || []).map(t => t.name).join(', ') };
          const card = document.querySelectorAll('.wizard-image-card')[i];
          const thumb = card.querySelector('.wiz-thumb');
          thumb.src = objUrl;
          thumb.hidden = false;
          card.querySelector('.wizard-image-placeholder').classList.add('d-none');
        } catch (e) {
          console.error('waifu.im slot ' + i + ' fetch failed', e);
        }
      }));

      const ok = slotsToFetch.some(i => this._fetchedImages[i]);
      if (!ok) throw new Error('All requests failed');

      // Update buttons based on current selection
      if (this._selectedImageIdx >= 0 && this._fetchedImages[this._selectedImageIdx]) {
        document.querySelector('#wizBtnUseImage').classList.remove('d-none');
        document.querySelector('#wizBtnRemoveImage').classList.remove('d-none');
        document.querySelector('#wizBtnFetchImage').innerHTML = '<i class="bi bi-shuffle me-1"></i>' + I18n.t('wizard.refetchOthers');
      } else {
        document.querySelector('#wizBtnUseImage').classList.add('d-none');
        document.querySelector('#wizBtnRemoveImage').classList.add('d-none');
        document.querySelector('#wizBtnFetchImage').innerHTML = '<i class="bi bi-shuffle me-1"></i>' + I18n.t('wizard.fetchImages');
      }
    } catch (e) {
      console.error('waifu.im fetch failed', e);
      Ui.showToast(I18n.t('toast.wizardFetchFailed', { error: e.message }), 'danger');
    } finally {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  },

  async _useFetchedImage() {
    if (this._selectedImageIdx < 0 || !this._fetchedImages[this._selectedImageIdx]) return;
    const card = window.AppState.activeCard;
    if (!card) {
      Ui.showToast(I18n.t('toast.createCardFirst'), 'warning');
      return;
    }
    await Editor.setAvatar(this._fetchedImages[this._selectedImageIdx].blob);
  },

  _removeFetchedImage() {
    this._fetchedImages.forEach(img => { if (img && img._objUrl) URL.revokeObjectURL(img._objUrl); });
    this._fetchedImages = [];
    this._selectedImageIdx = -1;
    document.querySelectorAll('.wizard-image-card').forEach(c => {
      c.classList.remove('selected');
      const thumb = c.querySelector('.wiz-thumb');
      if (thumb) { thumb.src = ''; thumb.hidden = true; }
      const ph = c.querySelector('.wizard-image-placeholder');
      if (ph) ph.classList.remove('d-none');
    });
    document.querySelector('#wizBtnUseImage').classList.add('d-none');
    document.querySelector('#wizBtnRemoveImage').classList.add('d-none');
    document.querySelector('#wizBtnFetchImage').innerHTML = '<i class="bi bi-shuffle me-1"></i>' + I18n.t('wizard.fetchImages');
  },

  // ─── GENERATE ───────────────────────────────────────
  async _generateBlank() {
    this._collectStep(this._step);
    this._modal.hide();

    const card = CardEngine.createEmptyCard(this._answers.name || 'New Character');
    card.tags = this._answers.tags || [];
    card.creator = this._answers.creator || '';

    await CardStorage.upsertCard(card);
    window.AppState.cards = CardStorage.getCards();
    CardManager.renderCardList();
    await CardManager.selectCard(card);
    if (this._selectedImageIdx >= 0 && this._fetchedImages[this._selectedImageIdx]) {
      try { await Editor.setAvatar(this._fetchedImages[this._selectedImageIdx].blob); } catch (_) {}
    }
    document.querySelector('#editName').focus();
    Ui.showToast(I18n.t('toast.wizardCreated'), 'success');
  },

  async _generateWithAI() {
    this._collectStep(this._step);
    if (!AIService.hasApiKey()) {
      Ui.showToast(I18n.t('toast.wizardApi'), 'warning');
      return;
    }
    const modelId = document.querySelector('#aiModelSelect').value || document.querySelector('#navModelSelect').value;
    if (!modelId) {
      Ui.showToast(I18n.t('toast.wizardModel'), 'warning');
      return;
    }
    document.querySelector('#aiModelSelect').value = modelId;

    this._modal.hide();
    const a = this._answers;

    // Build the prompt
    const genderText = a.gender === 'other' ? a.genderCustom : (a.gender || 'unspecified');
    const langMap = { en: 'English', fr: 'French', de: 'German', ja: 'Japanese' };
    const langText = langMap[a.language] || a.languageCustom || 'English';
    const typeLabels = {
      original: 'Original Character', fanfic: 'Fan Fiction', game: 'Game Character',
      anime: 'Anime / Manga', book: 'Book / Movie / Show', historical: 'Historical Figure',
      mythological: 'Mythological / Folklore', vtuber: 'VTuber / Streamer', other: 'Other'
    };

    let prompt = 'Create a complete SillyTavern character card as valid JSON (chara_card_v2 spec). ';
    prompt += 'Write everything in ' + langText + '. ';
    prompt += 'Return ONLY the JSON code block, no explanation.\n\n';
    prompt += '## Character Details\n\n';
    prompt += '- **Name**: ' + (a.name || 'New Character') + '\n';
    prompt += '- **Gender**: ' + genderText + '\n';
    prompt += '- **Type**: ' + (typeLabels[a.type] || 'Original Character') + '\n';
    prompt += '- **Tags**: ' + (a.tags || []).join(', ') + '\n';
    if (a.genres?.length) prompt += '- **Genre/World**: ' + a.genres.join(', ') + '\n';
    if (a.moods?.length) prompt += '- **Mood/Tone**: ' + a.moods.join(', ') + '\n';
    if (a.personalityDesc) prompt += '- **Personality**: ' + a.personalityDesc + '\n';
    if (a.appearance) prompt += '- **Appearance**: ' + a.appearance + '\n';
    if (a.abilities) prompt += '- **Special Traits**: ' + a.abilities + '\n';
    if (a.scenario) prompt += '- **Scenario**: ' + a.scenario + '\n';
    if (a.relationship) prompt += '- **Relationship to {{user}}**: ' + a.relationship + '\n';
    if (a.openingVibe?.length) prompt += '- **First Message Style**: ' + a.openingVibe.join(', ') + '\n';
    if (a.notes) prompt += '- **Additional Notes**: ' + a.notes + '\n';

    prompt += '\n## Requirements\n\n';
    prompt += '- `name`: Character name\n';
    prompt += '- `description`: Detailed appearance and backstory (2-4 paragraphs)\n';
    prompt += '- `personality`: Personality traits and mannerisms\n';
    prompt += '- `scenario`: The current setting and context\n';
    prompt += '- `first_mes`: An engaging opening message in character, using *asterisks for actions* and dialogue in quotes. Match the requested opening vibe.\n';
    prompt += '- `mes_example`: 2-3 example dialogues in <START> blocks showing different aspects of the character\n';
    prompt += '- `system_prompt`: A system prompt that captures the character essence\n';
    prompt += '- `tags`: The tags provided\n';
    prompt += '- `creator_notes`: Brief usage notes for the card\n';
    prompt += '- Use {{char}} for the character name and {{user}} for the user in example messages\n';
    prompt += '- Keep the JSON structure clean and valid\n';

    // Switch to full card target
    document.querySelector('#aiTargetSelect').value = 'full';
    document.querySelector('#aiInput').value = prompt;

    // Create the card first so we have something to work with
    const card = CardEngine.createEmptyCard(a.name || 'New Character');
    card.tags = a.tags || [];
    card.creator = a.creator || '';
    await CardStorage.upsertCard(card);
    window.AppState.cards = CardStorage.getCards();
    CardManager.renderCardList();
    await CardManager.selectCard(card);
    if (this._selectedImageIdx >= 0 && this._fetchedImages[this._selectedImageIdx]) {
      try { await Editor.setAvatar(this._fetchedImages[this._selectedImageIdx].blob); } catch (_) {}
    }

    // Send to AI
    AiChat.send();
  },
};

window.Wizard = Wizard;
