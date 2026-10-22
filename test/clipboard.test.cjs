'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ClipboardImages } = require('../src/core/clipboard-images.cjs');
const { LanService } = require('../src/core/service.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
async function wait(fn) { for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 30)); } throw new Error('等待图片传输超时'); }
test('剪贴板图片：确认前不发送、取消清理、令牌约束、失败保留草稿、发送字节一致', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flyingmouse-clipboard-'));
  const a = await new LanService({ dataDir: path.join(root, 'a'), discovery: false }).start();
  const b = await new LanService({ dataDir: path.join(root, 'b'), downloadDir: path.join(root, 'received'), discovery: false }).start();
  t.after(async () => { await Promise.all([a.stop(), b.stop()]); await fs.rm(root, { recursive: true, force: true }); });
  const store = new ClipboardImages(path.join(root, 'images'));
  const removed = await store.stage(png, 'preview');
  assert.equal(a.transfers.size, 0);
  await store.discard(removed.id);
  assert.deepEqual(await fs.readdir(store.root), []);
  await assert.rejects(store.stage(Buffer.from('not an image'), ''), /有效图片/);
  const draft = await store.stage(png, 'preview');
  await assert.rejects(store.send(a, 'offline', [draft.id]), /终端/);
  await assert.rejects(store.send(a, 'offline', ['../../secret']), /失效/);
  await assert.rejects(store.send(a, 'offline', [draft.id, draft.id]), /列表/);
  await a.connect('127.0.0.1', b.port);
  const id = await store.send(a, b.config.id, [draft.id]);
  await assert.rejects(store.send(a, b.config.id, [draft.id]), /失效/);
  await store.discard(draft.id); // Submitted image must stay available for transfer/retry.
  await wait(() => [...b.transfers.values()].some(t => t.status === 'pending'));
  const received = [...b.transfers.values()][0];
  await b.accept(received.id, true);
  await wait(() => a.transfers.get(id).status === 'completed');
  assert.deepEqual(await fs.readFile(path.join(received.receiveDir, draft.name)), png);
});
