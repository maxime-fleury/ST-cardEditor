/* ============================================================
   exportUtils.js — PNG/JSON Export, CRC32, PNG Chunk Embedding
   ============================================================ */

const ExportUtils = {
  EDITOR_CREDIT: 'Made using https://maxime-fleury.github.io/ST-cardEditor/',

  injectCopyright(card) {
    const note = card.creator_notes || '';
    if (!note.includes(this.EDITOR_CREDIT)) {
      card.creator_notes = note ? note.trimEnd() + '\n\n' + this.EDITOR_CREDIT : this.EDITOR_CREDIT;
    }
    return card;
  },

  async exportAsJSON() {
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    await Editor.syncEditorToCard();
    if (!activeCard.name) Ui.showToast(I18n.t('toast.noNameWarning'), 'warning');
    const clone = JSON.parse(JSON.stringify(activeCard));
    if (CardStorage.getInjectCopyright()) this.injectCopyright(clone);
    Ui.downloadFile((activeCard.name || 'character') + '.json', CardEngine.toJSON(clone), 'application/json');
    Ui.showToast(I18n.t('toast.exportedJson'), 'success');
  },

  async exportAsPNG() {
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    await Editor.syncEditorToCard();
    const clone = JSON.parse(JSON.stringify(activeCard));
    if (CardStorage.getInjectCopyright()) this.injectCopyright(clone);
    const json = CardEngine.toJSON(clone);
    try {
      let pngBytes = null;
      if (activeCard._imageBase64) {
        pngBytes = await this.imageBase64ToPNGBytes(activeCard._imageBase64);
        if (!pngBytes) {
          pngBytes = this._dataUrlToBytes(activeCard._imageBase64);
        }
      }
      if (!pngBytes) {
        pngBytes = await this.createMinimalPNGBytes();
      }
      const blob = new Blob([this.embedCharaChunk(pngBytes, json)], { type: 'image/png' });
      Ui.downloadBlob(blob, (activeCard.name || 'character') + '.png');
      Ui.showToast(I18n.t('toast.exportedPng'), 'success');
    } catch (err) {
      console.error('PNG export failed:', err);
      Ui.showToast(I18n.t('toast.exportFailed'), 'warning');
      this.exportAsJSON();
    }
  },

  async imageBase64ToPNGBytes(imageBase64) {
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = imageBase64;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return new Promise((resolve) => {
        canvas.toBlob((blob) => {
          if (!blob) return resolve(null);
          const reader = new FileReader();
          reader.onload = () => resolve(new Uint8Array(reader.result));
          reader.readAsArrayBuffer(blob);
        }, 'image/png');
      });
    } catch (err) {
      console.error('Failed to convert image to PNG:', err);
      return null;
    }
  },

  async embedJSONInPNG(imageBase64, jsonStr) {
    try {
      const pngBytes = await this.imageBase64ToPNGBytes(imageBase64);
      if (!pngBytes) return null;
      return new Blob([this.embedCharaChunk(pngBytes, jsonStr)], { type: 'image/png' });
    } catch (err) {
      console.error('Failed to embed PNG chunk:', err);
      return null;
    }
  },

  _dataUrlToBytes(dataUrl) {
    try {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) return null;
      const comma = dataUrl.indexOf(',');
      if (comma < 0) return null;
      const bin = atob(dataUrl.slice(comma + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      // Verify the 8-byte PNG signature; return null for anything else so
      // callers fall back to a real PNG instead of exporting a mislabeled file.
      const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
      for (let i = 0; i < PNG_SIG.length; i++) {
        if (bytes[i] !== PNG_SIG[i]) return null;
      }
      return bytes;
    } catch (e) {
      console.error('Failed to decode data URL:', e);
      return null;
    }
  },

  async createMinimalPNGBytes() {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 64, 64);
    g.addColorStop(0, '#772ce8'); g.addColorStop(1, '#ec4899');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(I18n.t ? I18n.t('export.minimalPngLabel') : 'ST Card', 32, 36);
    return new Promise((resolve) => {
      // toBlob can return null on some platforms; hard-fail rather than hang.
      let settled = false;
      const settle = (bytes) => { if (!settled) { settled = true; resolve(bytes); } };
      canvas.toBlob((blob) => {
        if (!blob) {
          // Fallback: render via dataURL
          try {
            const dataUrl = canvas.toDataURL('image/png');
            const bin = atob(dataUrl.split(',')[1]);
            const out = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            settle(out);
          } catch (e) {
            settle(new Uint8Array(0));
          }
          return;
        }
        const reader = new FileReader();
        reader.onload = () => settle(new Uint8Array(reader.result));
        reader.onerror = () => settle(new Uint8Array(0));
        reader.readAsArrayBuffer(blob);
      }, 'image/png');
    });
  },

  embedCharaChunk(pngBytes, jsonStr) {
    const bytes = new Uint8Array(pngBytes);
    // Walk the chunk list once: find the IEND position and strip any existing
    // `chara` tEXt chunk so re-exports don't keep appending duplicates that
    // bloat the file and confuse parsers reading the FIRST chara chunk (#33).
    let offset = 8, iendPos = -1;
    const kept = [];
    while (offset + 12 <= bytes.length) {
      const length = CardEngine._readUint32(bytes, offset);
      if (offset + 12 + length > bytes.length) break;
      const type = String.fromCharCode(bytes[offset+4], bytes[offset+5], bytes[offset+6], bytes[offset+7]);
      if (type === 'IEND') { iendPos = offset; break; }
      const isCharaText = type === 'tEXt' && (() => {
        const nullIdx = bytes.indexOf(0, offset + 8);
        if (nullIdx < 0 || nullIdx > offset + 8 + 79) return false;
        const kw = String.fromCharCode.apply(null, bytes.subarray(offset + 8, nullIdx));
        return kw === 'chara';
      })();
      if (!isCharaText) {
        kept.push(bytes.subarray(offset, offset + 12 + length));
      }
      offset += 12 + length;
    }
    if (iendPos < 0) {
      console.warn('exportUtils: PNG missing IEND chunk — card data was not embedded');
      return bytes;
    }

    const keyword = 'chara';
    const jsonBytes = new TextEncoder().encode(jsonStr);
    // Encode JSON bytes to base64 directly, avoiding transient copies.
    let b64 = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < jsonBytes.length; i += CHUNK) {
      b64 += String.fromCharCode.apply(null, jsonBytes.subarray(i, i + CHUNK));
    }
    b64 = btoa(b64);
    const textData = new TextEncoder().encode(keyword + '\0' + b64);
    const typeBytes = new TextEncoder().encode('tEXt');
    const crcData = new Uint8Array(4 + textData.length);
    crcData.set(typeBytes, 0); crcData.set(textData, 4);
    const crc = this.crc32(crcData);

    const chunk = new Uint8Array(12 + textData.length);
    new DataView(chunk.buffer).setUint32(0, textData.length, false);
    chunk.set(typeBytes, 4); chunk.set(textData, 8);
    new DataView(chunk.buffer).setUint32(8 + textData.length, crc, false);

    // Reassemble: PNG signature + kept chunks + new chara chunk + IEND and
    // everything after it. The chunk walk above starts at offset 8 (after the
    // signature), so the signature must be re-added explicitly or the exported
    // file is not a valid PNG (v3 #2).
    const keptSize = kept.reduce((n, c) => n + c.length, 0);
    const result = new Uint8Array(8 + keptSize + chunk.length + (bytes.length - iendPos));
    result.set(bytes.subarray(0, 8), 0); // PNG signature
    let pos = 8;
    for (const c of kept) { result.set(c, pos); pos += c.length; }
    result.set(chunk, pos); pos += chunk.length;
    result.set(bytes.subarray(iendPos), pos);
    return result;
  },

  crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  },
};

window.ExportUtils = ExportUtils;
