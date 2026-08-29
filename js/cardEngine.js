/* ============================================================
   cardEngine.js — SillyTavern Character Card Parser & Editor
   ============================================================ */

const CardEngine = {
  _utf8Decoder: new TextDecoder('utf-8'),
  THUMBNAIL_MAX_SIZE: 128,
  THUMBNAIL_JPEG_QUALITY: 0.8,

  async parseFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'json') {
      const text = await file.text();
      return this.parseJSON(text, file.name);
    }
    if (ext === 'png') {
      const buffer = await file.arrayBuffer();
      const card = await this.parsePNG(buffer, file.name);
      if (!card._imageBase64) {
        const blob = new Blob([buffer], { type: 'image/png' });
        card._imageBase64 = await this._blobToBase64(blob);
      }
      card._hasImage = true; // matches the webp branch; keeps the flag consistent (#44)
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
    throw new Error((I18n.t ? I18n.t('error.unsupportedFile', { ext: ext }) : 'Unsupported file type: .' + ext));
  },

  _uniqueId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return 'card_' + crypto.randomUUID();
    }
    return 'card_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
  },

  parseJSON(jsonStr, filename) {
    filename = filename || 'untitled.json';
    let raw;
    try { raw = JSON.parse(jsonStr); }
    catch (e) { throw new Error((I18n.t ? I18n.t('error.invalidJson', { message: e.message || 'parse error' }) : 'Invalid JSON: ' + (e.message || 'parse error'))); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error((I18n.t ? I18n.t('error.unknownFormat') : 'Unknown card format — not a SillyTavern character card'));
    }
    return this.normalize(raw, filename);
  },

  async parsePNG(buffer, filename) {
    filename = filename || 'untitled.png';
    const bytes = new Uint8Array(buffer);
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== sig[i]) throw new Error((I18n.t ? I18n.t('error.notPng') : 'Not a valid PNG file'));
    }

    let offset = 8;
    let charaRaw = null;
    let ccv3Raw = null;
    // A chara/ccv3 chunk we found but couldn't decode would otherwise silently
    // become an image-only empty card, losing the character data. Track that so
    // we can surface an error instead.
    let cardChunkUnreadable = false;

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
      } else if (type === 'iTXt' || type === 'zTXt') {
        const chunkData = bytes.slice(offset, offset + len);
        const nullIdx = chunkData.indexOf(0);
        if (nullIdx >= 0) {
          const keyword = this._utf8Decoder.decode(chunkData.slice(0, nullIdx)).toLowerCase();
          let valueBytes = null;
          if (type === 'iTXt') {
            let p = nullIdx + 1;
            const compressionFlag = chunkData[p]; p += 1;
            p += 1; // compression method (unused)
            const langEnd = chunkData.indexOf(0, p);
            if (langEnd < 0) { offset += len + 4; continue; }
            p = langEnd + 1;
            const transEnd = chunkData.indexOf(0, p);
            if (transEnd < 0) { offset += len + 4; continue; }
            p = transEnd + 1;
            valueBytes = chunkData.slice(p);
            if (compressionFlag === 1) valueBytes = await this._inflate(valueBytes);
          } else { // zTXt
            const p = nullIdx + 2; // skip compression method byte
            valueBytes = await this._inflate(chunkData.slice(p));
          }
          if (valueBytes) {
            if (keyword === 'chara') charaRaw = valueBytes;
            else if (keyword === 'ccv3') ccv3Raw = valueBytes;
          } else if (keyword === 'chara' || keyword === 'ccv3') {
            // Compressed chara/ccv3 data present but not decompressible here.
            cardChunkUnreadable = true;
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

    // The file advertises card data but we couldn't read it. Surface an error
    // rather than silently importing an image-only empty card over the data.
    if (cardChunkUnreadable) {
      throw new Error((I18n.t ? I18n.t('error.pngInflateFailed') : 'This PNG contains character data that could not be decompressed.'));
    }

    return this._createEmptyCard(filename);
  },

  async _inflate(bytes) {
    let writer = null;
    try {
      if (typeof DecompressionStream === 'undefined') return null;
      const ds = new DecompressionStream('zlib');
      writer = ds.writable.getWriter();
      await writer.write(bytes);
      await writer.close();
      const ab = await new Response(ds.readable).arrayBuffer();
      return new Uint8Array(ab);
    } catch (e) {
      console.error('zlib inflate failed', e);
      return null;
    } finally {
      if (writer && typeof writer.releaseLock === 'function') {
        try { writer.releaseLock(); } catch (_) {}
      }
    }
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
      throw new Error((I18n.t ? I18n.t('error.unknownFormat') : 'Unknown card format — not a SillyTavern character card'));
    }

    const fields = ['name', 'description', 'personality', 'scenario', 'first_mes',
      'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions',
      'creator', 'character_version'];
    for (const f of fields) card[f] = source[f] || '';
    card.alternate_greetings = Array.isArray(source.alternate_greetings) ? [...source.alternate_greetings] : [];
    card.tags = Array.isArray(source.tags) ? [...source.tags] : [];
    card.character_book = source.character_book ? JSON.parse(JSON.stringify(source.character_book)) : { entries: [] };
    card.extensions = source.extensions ? JSON.parse(JSON.stringify(source.extensions)) : {};

    // Validate character_book so a malformed card can never break the lorebook
    // renderer (which runs during card selection). keysecondary must be an
    // array per the V2 spec (legacy cards may store a comma-joined string);
    // keys must be strings or arrays of strings; non-object entries are
    // dropped and replaced with an empty entry.
    if (!card.character_book || !Array.isArray(card.character_book.entries)) {
      card.character_book = { entries: [] };
    } else {
      card.character_book.entries = card.character_book.entries.map(e => {
        if (!e || typeof e !== 'object') {
          return { key: '', keysecondary: [], content: '', order: 100, constant: false, selective: false, position: 'after_char', comment: '' };
        }
        // Interop: spec-conformant entries (character-card-spec-v2 and
        // SillyTavern world-info exports) name these fields keys /
        // secondary_keys / insertion_order / enabled, while the editor speaks
        // key / keysecondary / order / disable. Map the spec names in when the
        // editor's names are absent, so real cards don't silently lose their
        // keywords (v3 sweep finding).
        if (e.keys != null && e.key == null) e.key = e.keys;
        if (e.secondary_keys != null && e.keysecondary == null) e.keysecondary = e.secondary_keys;
        if (e.insertion_order != null && e.order == null) e.order = e.insertion_order;
        if (e.enabled != null && e.disable == null) e.disable = !e.enabled;
        if (!Array.isArray(e.keysecondary)) {
          e.keysecondary = e.keysecondary == null
            ? []
            : String(e.keysecondary).split(',').map(s => s.trim()).filter(Boolean);
        }
        if (e.key != null && !Array.isArray(e.key) && typeof e.key !== 'string') {
          e.key = String(e.key);
        }
        return e;
      });
    }
    card._id = this._uniqueId();
    card._createdAt = Date.now();
    card._fileSize = JSON.stringify(card).length;
    return card;
  },

  createEmptyCard(name) {
    name = name || (I18n.t ? I18n.t('gen.newCharacter') : 'New Character');
    const card = {
      _id: this._uniqueId(),
      _filename: name + '.json', _hasImage: false, _imageBase64: null,
      _createdAt: Date.now(), _fileSize: 0,
      spec: 'chara_card_v2', spec_version: '2.0',
      name: name, description: '', personality: '', scenario: '',
      first_mes: '', mes_example: '', creator_notes: '',
      system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: [],
      creator: '', character_version: '1.0',
      character_book: { entries: [] }, extensions: {},
    };
    card._fileSize = JSON.stringify(card).length;
    return card;
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
        try {
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
          // Release the decoded image WITHOUT nuking the src: assigning ''
          // makes the browser re-resolve the document URL and fire a spurious
          // request/onerror (#45).
          img.removeAttribute('src');
          img.onload = null;
          img.onerror = null;
          resolve(canvas.toDataURL('image/jpeg', this.THUMBNAIL_JPEG_QUALITY));
        } catch (_) {
          img.removeAttribute('src');
          img.onload = null;
          img.onerror = null;
          resolve(null);
        }
      };
      img.onerror = () => { img.removeAttribute('src'); img.onload = null; img.onerror = null; resolve(null); };
      img.src = base64;
    });
  },
};

window.CardEngine = CardEngine;
