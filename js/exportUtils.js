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
    if (!activeCard.name) Ui.showToast('Warning: Card has no name. File will be saved as "character.json".', 'warning');
    const clone = JSON.parse(JSON.stringify(activeCard));
    if (CardStorage.getInjectCopyright()) this.injectCopyright(clone);
    Ui.downloadFile((activeCard.name || 'character') + '.json', CardEngine.toJSON(clone), 'application/json');
    Ui.showToast('Exported as JSON!', 'success');
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
      Ui.showToast('Exported as PNG with card data!', 'success');
    } catch (err) {
      console.error('PNG export failed:', err);
      Ui.showToast('Image export failed. Falling back to JSON.', 'warning');
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
      const comma = dataUrl.indexOf(',');
      if (comma < 0) return null;
      const bin = atob(dataUrl.slice(comma + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
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
    ctx.fillText('ST Card', 32, 36);
    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        const reader = new FileReader();
        reader.onload = () => resolve(new Uint8Array(reader.result));
        reader.readAsArrayBuffer(blob);
      }, 'image/png');
    });
  },

  embedCharaChunk(pngBytes, jsonStr) {
    const bytes = new Uint8Array(pngBytes);
    let offset = 8, iendPos = -1;
    while (offset + 12 <= bytes.length) {
      const length = CardEngine._readUint32(bytes, offset);
      const type = String.fromCharCode(bytes[offset+4], bytes[offset+5], bytes[offset+6], bytes[offset+7]);
      if (type === 'IEND') { iendPos = offset; break; }
      offset += 12 + length;
    }
    if (iendPos < 0) {
      console.warn('exportUtils: PNG missing IEND chunk — card data was not embedded');
      return bytes;
    }

    const keyword = 'chara';
    const utf8Bytes = new TextEncoder().encode(jsonStr);
    let binary = '';
    for (let i = 0; i < utf8Bytes.length; i++) binary += String.fromCharCode(utf8Bytes[i]);
    const b64 = btoa(binary);
    const textData = new TextEncoder().encode(keyword + '\0' + b64);
    const typeBytes = new TextEncoder().encode('tEXt');
    const crcData = new Uint8Array(4 + textData.length);
    crcData.set(typeBytes, 0); crcData.set(textData, 4);
    const crc = this.crc32(crcData);

    const chunk = new Uint8Array(12 + textData.length);
    new DataView(chunk.buffer).setUint32(0, textData.length, false);
    chunk.set(typeBytes, 4); chunk.set(textData, 8);
    new DataView(chunk.buffer).setUint32(8 + textData.length, crc, false);

    const result = new Uint8Array(bytes.length + chunk.length);
    result.set(bytes.slice(0, iendPos), 0);
    result.set(chunk, iendPos);
    result.set(bytes.slice(iendPos), iendPos + chunk.length);
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
