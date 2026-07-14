/* ============================================================
   cardEngine.js — SillyTavern Character Card Parser & Editor
   ============================================================ */

const CardEngine = {
  // Single shared TextDecoder for performance
  _utf8Decoder: new TextDecoder('utf-8'),

  async parseFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'json') {
      const text = await file.text();
      return this.parseJSON(text, file.name);
    }
    if (ext === 'png' || ext === 'webp') {
      const buffer = await file.arrayBuffer();
      const card = this.parsePNG(buffer, file.name);
      if (!card._imageBase64) {
        const blob = new Blob([buffer], { type: 'image/' + ext });
        card._imageBase64 = await this._blobToBase64(blob);
      }
      return card;
    }
    throw new Error('Unsupported file type: .' + ext);
  },

  generateStableId(card) {
    const key = (card.name || '') + '|' + (card.creator || '') + '|' + ((card.description || '').slice(0, 200));
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

    if (raw.spec === 'chara_card_v2' || raw.spec === 'chara_card_v3') {
      card.spec = 'chara_card_v2';
      card.spec_version = raw.spec_version || '2.0';
      const d = raw.data || {};
      card.name = d.name || '';
      card.description = d.description || '';
      card.personality = d.personality || '';
      card.scenario = d.scenario || '';
      card.first_mes = d.first_mes || '';
      card.mes_example = d.mes_example || '';
      card.creator_notes = d.creator_notes || '';
      card.system_prompt = d.system_prompt || '';
      card.post_history_instructions = d.post_history_instructions || '';
      card.alternate_greetings = Array.isArray(d.alternate_greetings) ? [...d.alternate_greetings] : [];
      card.tags = Array.isArray(d.tags) ? [...d.tags] : [];
      card.creator = d.creator || '';
      card.character_version = d.character_version || '';
      card.character_book = d.character_book ? JSON.parse(JSON.stringify(d.character_book)) : { entries: [] };
      card.extensions = d.extensions ? JSON.parse(JSON.stringify(d.extensions)) : {};
    } else if (raw.name !== undefined && !raw.spec) {
      card.spec = 'chara_card_v2';
      card.spec_version = '2.0';
      card.name = raw.name || '';
      card.description = raw.description || '';
      card.personality = raw.personality || '';
      card.scenario = raw.scenario || '';
      card.first_mes = raw.first_mes || '';
      card.mes_example = raw.mes_example || '';
      card.creator_notes = raw.creator_notes || '';
      card.system_prompt = raw.system_prompt || '';
      card.post_history_instructions = raw.post_history_instructions || '';
      card.alternate_greetings = Array.isArray(raw.alternate_greetings) ? [...raw.alternate_greetings] : [];
      card.tags = Array.isArray(raw.tags) ? [...raw.tags] : [];
      card.creator = raw.creator || '';
      card.character_version = raw.character_version || '';
      card.character_book = raw.character_book ? JSON.parse(JSON.stringify(raw.character_book)) : { entries: [] };
      card.extensions = raw.extensions ? JSON.parse(JSON.stringify(raw.extensions)) : {};
    } else {
      throw new Error('Unknown card format — not a SillyTavern character card');
    }

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
    return (bytes[offset] << 24) | (bytes[offset + 1] << 16) |
           (bytes[offset + 2] << 8) | bytes[offset + 3];
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
};

window.CardEngine = CardEngine;
