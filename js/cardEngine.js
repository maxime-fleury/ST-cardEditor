/* ============================================================
   cardEngine.js — SillyTavern Character Card Parser & Editor
   ============================================================ */

const CardEngine = {
  _utf8Decoder: new TextDecoder('utf-8'),
  THUMBNAIL_MAX_SIZE: 128,
  THUMBNAIL_JPEG_QUALITY: 0.8,
  STABLE_ID_DESC_PREFIX_LENGTH: 200,

  async parseFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'json') {
      const text = await file.text();
      return this.parseJSON(text, file.name);
    }
    if (ext === 'png') {
      const buffer = await file.arrayBuffer();
      const card = this.parsePNG(buffer, file.name);
      if (!card._imageBase64) {
        const blob = new Blob([buffer], { type: 'image/png' });
        card._imageBase64 = await this._blobToBase64(blob);
      }
      card._thumbnail = await this._createThumbnail(card._imageBase64);
      return card;
    }
    if (ext === 'webp') {
      // WebP has no standard tEXt/chara chunk; import as image-only card.
      const buffer = await file.arrayBuffer();
      const card = this._createEmptyCard(file.name);
      const blob = new Blob([buffer], { type: 'image/webp' });
      card._imageBase64 = await this._blobToBase64(blob);
      card._hasImage = true;
      card._thumbnail = await this._createThumbnail(card._imageBase64);
      return card;
    }
    throw new Error('Unsupported file type: .' + ext);
  },

  generateStableId(card) {
    const key = (card.name || '') + '|' + (card.creator || '') + '|' + ((card.description || '').slice(0, this.STABLE_ID_DESC_PREFIX_LENGTH));
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash) + key.charCodeAt(i);
      hash = hash & hash;
    }
    return 'card_' + Math.abs(hash).toString(36);
  },

  parseJSON(jsonStr, filename) {
    filename = filename || 'untitled.json';
    let raw;
    try { raw = JSON.parse(jsonStr); }
    catch (e) { throw new Error('Invalid JSON: ' + (e.message || 'parse error')); }
    return this.normalize(raw, filename);
  },

  parsePNG(buffer, filename) {
    filename = filename || 'untitled.png';
    const bytes = new Uint8Array(buffer);
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== sig[i]) throw new Error('Not a valid PNG file');
    }

    let offset = 8;
    let charaRaw = null;
    let ccv3Raw = null;

    while (offset + 12 <= bytes.length) {
      const len = this._readUint32(bytes, offset);
      offset += 4;
      const type = this._utf8Decoder.decode(bytes.slice(offset, offset + 4));
      offset += 4;

      if (type === 'tEXt') {
        const chunkData = bytes.slice(offset, offset + len);
        const nullIdx = chunkData.indexOf(0);
        if (nullIdx >= 0) {
          const keyword = this._utf8Decoder.decode(chunkData.slice(0, nullIdx)).toLowerCase();
          // Slice out raw text value — DON'T use spread, decode bytes directly
          if (keyword === 'chara') {
            charaRaw = chunkData.slice(nullIdx + 1);
          } else if (keyword === 'ccv3') {
            ccv3Raw = chunkData.slice(nullIdx + 1);
          }
        }
      } else if (type === 'IEND') {
        break;
      }

      offset += len + 4;
    }

    // Try chara first, then ccv3
    const rawBytes = charaRaw || ccv3Raw;
    if (rawBytes) {
      const rawStr = this._utf8Decoder.decode(rawBytes);
      const jsonStr = this._decodeCharaValue(rawStr);
      return this.parseJSON(jsonStr, filename);
    }

    return this._createEmptyCard(filename);
  },

  normalize(raw, filename) {
    const card = {
      _id: '', _filename: filename, _hasImage: false, _imageBase64: null,
    };

    let source;
    if (raw.spec === 'chara_card_v2' || raw.spec === 'chara_card_v3') {
      card.spec = raw.spec;
      card.spec_version = raw.spec_version || (raw.spec === 'chara_card_v3' ? '3.0' : '2.0');
      source = raw.data || {};
    } else if (raw.name !== undefined && !raw.spec) {
      card.spec = 'chara_card_v2';
      card.spec_version = '2.0';
      source = raw;
    } else {
      throw new Error('Unknown card format — not a SillyTavern character card');
    }

    const fields = ['name', 'description', 'personality', 'scenario', 'first_mes',
      'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions',
      'creator', 'character_version'];
    for (const f of fields) card[f] = source[f] || '';
    card.alternate_greetings = Array.isArray(source.alternate_greetings) ? [...source.alternate_greetings] : [];
    card.tags = Array.isArray(source.tags) ? [...source.tags] : [];
    card.character_book = source.character_book ? JSON.parse(JSON.stringify(source.character_book)) : { entries: [] };
    card.extensions = source.extensions ? JSON.parse(JSON.stringify(source.extensions)) : {};

    if (!card.character_book || !card.character_book.entries) {
      card.character_book = { entries: [] };
    }
    card._id = this.generateStableId(card);
    return card;
  },

  createEmptyCard(name) {
    name = name || 'New Character';
    return {
      _id: 'card_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9),
      _filename: name + '.json', _hasImage: false, _imageBase64: null,
      spec: 'chara_card_v2', spec_version: '2.0',
      name: name, description: '', personality: '', scenario: '',
      first_mes: '', mes_example: '', creator_notes: '',
      system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: [],
      creator: '', character_version: '1.0',
      character_book: { entries: [] }, extensions: {},
    };
  },

  toJSON(card) {
    return JSON.stringify({
      spec: card.spec || 'chara_card_v2',
      spec_version: card.spec_version || '2.0',
      data: {
        name: card.name || '', description: card.description || '',
        personality: card.personality || '', scenario: card.scenario || '',
        first_mes: card.first_mes || '', mes_example: card.mes_example || '',
        creator_notes: card.creator_notes || '',
        system_prompt: card.system_prompt || '',
        post_history_instructions: card.post_history_instructions || '',
        alternate_greetings: card.alternate_greetings || [],
        tags: card.tags || [], creator: card.creator || '',
        character_version: card.character_version || '',
        character_book: card.character_book || { entries: [] },
        extensions: card.extensions || {},
      },
    }, null, 2);
  },

  getTextContent(card, field) {
    if (field && card[field] !== undefined) return card[field] || '';
    const fields = [
      ['Name', card.name], ['Description', card.description],
      ['Personality', card.personality], ['Scenario', card.scenario],
      ['First Message', card.first_mes], ['Example Messages', card.mes_example],
      ['System Prompt', card.system_prompt],
      ['Post-History Instructions', card.post_history_instructions],
    ];
    return fields.filter(([_, v]) => v && v.trim())
      .map(([label, value]) => `[${label}]\n${value}`).join('\n\n');
  },

  // ─── Decode chara/ccv3 chunk value ──────────────────

  _decodeCharaValue(rawValue) {
    // Try raw JSON first
    try { JSON.parse(rawValue); return rawValue; } catch (_) {}

    // Try base64 decode — atob() returns a binary string (Latin-1),
    // so we must convert back to bytes then decode as UTF-8 for non-ASCII cards.
    try {
      const binStr = atob(rawValue);
      const bytes = Uint8Array.from(binStr, c => c.charCodeAt(0));
      const decoded = this._utf8Decoder.decode(bytes);
      JSON.parse(decoded); // verify
      return decoded;
    } catch (_) {}

    // Give up — let parseJSON throw
    return rawValue;
  },

  // ─── Internal helpers ────────────────────────────────

  _readUint32(bytes, offset) {
    if (offset + 4 > bytes.length) return 0;
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) |
           (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  },

  _createEmptyCard(filename) {
    return this.normalize({ name: filename.replace(/\.[^.]+$/, '') }, filename);
  },

  _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  },

  _createThumbnail(base64) {
    return new Promise(resolve => {
      if (!base64) return resolve(null);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const MAX = this.THUMBNAIL_MAX_SIZE;
        let w = img.width, h = img.height;
        if (w > h) {
          if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
        } else {
          if (h > MAX) { w = Math.round(w * MAX / h); h = MAX; }
        }
        canvas.width = w; canvas.height = h;
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', this.THUMBNAIL_JPEG_QUALITY));
      };
      img.onerror = () => resolve(null);
      img.src = base64;
    });
  },
};

window.CardEngine = CardEngine;
