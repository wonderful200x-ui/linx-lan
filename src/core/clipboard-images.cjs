'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Paths never come from the renderer. Draft IDs grant access only to staged images.
class ClipboardImages {
  constructor(root) { this.root = root; this.drafts = new Map(); }
  async stage(png, preview) {
    if (!Buffer.isBuffer(png) || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('剪贴板中没有有效图片');
    if (png.length > 25 * 1024 * 1024) throw new Error('图片超过 25 MB，请保存后使用文件发送');
    if ([...this.drafts.values()].filter(d => !d.sent).length >= 10) throw new Error('最多暂存 10 张图片，请先发送或移除');
    const id = randomUUID(), name = '图片-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + id.slice(0, 6) + '.png';
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = path.join(this.root, name);
    await fs.writeFile(file, png, { mode: 0o600 });
    this.drafts.set(id, { file, sent: false });
    return { id, name, size: png.length, preview };
  }
  async send(service, peerId, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 10 || new Set(ids).size !== ids.length) throw new Error('图片列表无效');
    const drafts = ids.map(id => this.drafts.get(id));
    if (drafts.some(d => !d || d.sent)) throw new Error('图片草稿已失效，请重新粘贴');
    // Mark synchronously to prevent a second click from submitting the same draft.
    for (const d of drafts) d.sent = true;
    try {
      return await service.sendFiles(peerId, drafts.map(d => d.file));
    } catch (e) { for (const d of drafts) d.sent = false; throw e; }
  }
  async discard(id) {
    const draft = this.drafts.get(id);
    if (!draft || draft.sent) return;
    await fs.rm(draft.file, { force: true }); this.drafts.delete(id);
  }
}
module.exports = { ClipboardImages };
