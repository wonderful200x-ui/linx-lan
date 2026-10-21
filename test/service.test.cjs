'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const fsp = fs.promises;
const path = require('node:path'); const os = require('node:os'); const http = require('node:http');
const { createHash } = require('node:crypto');
const { LanService, collectFiles, safeRelative, request } = require('../src/core/service.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 15000) { const start = Date.now(); while (!fn()) { if (Date.now() - start > timeout) throw new Error('等待状态超时'); await delay(25); } }
async function setup(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'linx-test-'));
  const a = await new LanService({ dataDir: path.join(root, 'a'), downloadDir: path.join(root, 'downloads-a'), discovery: false, ...options }).start();
  const b = await new LanService({ dataDir: path.join(root, 'b'), downloadDir: path.join(root, 'downloads-b'), discovery: false, ...options }).start();
  t.after(async () => { await Promise.all([a.stop(), b.stop()]); await fsp.rm(root, { recursive: true, force: true }); });
  await a.connect('127.0.0.1', b.port); return { root, a, b };
}
async function incoming(b) { await until(() => [...b.transfers.values()].some(t => t.status === 'pending')); return [...b.transfers.values()].find(t => t.status === 'pending'); }
async function digest(file) { const hash = createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
function put(peer, route, payload, hash = 'invalid') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: peer.address, port: peer.port, path: route, method: 'PUT', headers: { 'x-linx-token': peer.token, Trailer: 'x-content-sha256' } }, res => { let body = ''; res.on('data', b => { body += b; }); res.on('end', () => resolve({ code: res.statusCode, body })); });
    req.on('error', reject); req.write(payload); req.addTrailers({ 'x-content-sha256': hash }); req.end();
  });
}
test('互相发现、改名和双向消息，重复消息只入库一次', async t => {
  const { a, b } = await setup(t);
  assert.equal(a.peers.get(b.config.id).online, true); assert.equal(b.peers.get(a.config.id).online, true);
  await b.setConfig({ name: '研发 Windows 工作站' }); await a.discover('127.0.0.1', b.port); assert.equal(a.peers.get(b.config.id).name, '研发 Windows 工作站');
  const msg = await a.sendMessage(b.config.id, '你好，<script>alert(1)</script>\n多行消息 📦');
  await request(a.peers.get(b.config.id), '/message', { ...msg, sender: a.hello() });
  assert.equal(b.messages.length, 1); assert.equal(b.messages[0].text, msg.text);
  await b.sendMessage(a.config.id, '已收到'); assert.equal(a.messages.at(-1).text, '已收到');
  assert.equal(a.snapshot().peers[0].token, undefined);
});
test('文件夹保留嵌套目录、中文、空目录、零字节文件和内容校验', async t => {
  const { root, a, b } = await setup(t); const folder = path.join(root, '设计项目');
  await fsp.mkdir(path.join(folder, '图片', '空目录'), { recursive: true });
  await fsp.writeFile(path.join(folder, '说明.txt'), '你好，局域网传输\n'.repeat(1000));
  await fsp.writeFile(path.join(folder, '图片', 'zero.bin'), '');
  await fsp.writeFile(path.join(folder, '图片', '素材.bin'), Buffer.alloc(1024 * 1024, 127));
  const id = await a.sendFiles(b.config.id, [folder]); const received = await incoming(b);
  assert.equal(received.status, 'pending'); assert.equal(received.receiveDir, undefined);
  await b.accept(received.id, true); await until(() => a.transfers.get(id).status === 'completed');
  assert.equal(received.status, 'completed'); assert.equal(received.bytes, received.total);
  const output = path.join(received.receiveDir, '设计项目');
  assert.equal(await digest(path.join(output, '说明.txt')), await digest(path.join(folder, '说明.txt')));
  assert.equal(await digest(path.join(output, '图片', '素材.bin')), await digest(path.join(folder, '图片', '素材.bin')));
  assert.equal((await fsp.stat(path.join(output, '图片', 'zero.bin'))).size, 0);
  assert.equal((await fsp.stat(path.join(output, '图片', '空目录'))).isDirectory(), true);
});
test('流式大文件：字节精确、发送/接收进度递增、SHA-256 一致', { timeout: 180000 }, async t => {
  const { root, a, b } = await setup(t);
  const file = path.join(root, 'large.bin'), size = process.env.LINX_LARGE_TEST ? 4 * 1024 ** 3 + 17 : 64 * 1024 ** 2 + 17;
  const handle = await fsp.open(file, 'w'); await handle.truncate(size); await handle.write(Buffer.from('LARGE-FILE-TAIL'), 0, 15, size - 15); await handle.close();
  const observed = []; const id = await a.sendFiles(b.config.id, [file]); const received = await incoming(b);
  const timer = setInterval(() => { observed.push(received.bytes); }, 3); t.after(() => clearInterval(timer));
  await b.accept(received.id, true); await until(() => ['completed', 'failed'].includes(a.transfers.get(id).status), 150000);
  assert.equal(a.transfers.get(id).status, 'completed', a.transfers.get(id).error);
  assert.equal(received.bytes, size); assert.equal((await fsp.stat(path.join(received.receiveDir, 'large.bin'))).size, size);
  assert.equal(await digest(file), await digest(path.join(received.receiveDir, 'large.bin')));
  assert.ok(observed.some(n => n > 0 && n < size), '应观察到中间进度');
  assert.ok(observed.every((n, i) => !i || n >= observed[i - 1]), '进度不可倒退');
});
test('拒绝、取消、重新发送；不会在接收确认之前写文件', async t => {
  const { root, a, b } = await setup(t); const file = path.join(root, 'hello.txt'); await fsp.writeFile(file, 'hello');
  const id = await a.sendFiles(b.config.id, [file]), r = await incoming(b);
  await b.accept(r.id, false); await until(() => a.transfers.get(id).status === 'rejected'); assert.equal(r.receiveDir, undefined);
  const retry = await a.retry(id), next = await incoming(b); a.cancel(retry);
  await until(() => next.status === 'cancelled'); assert.equal(a.transfers.get(retry).status, 'cancelled');
  const third = await a.sendFiles(b.config.id, [file]), receive = await incoming(b); b.cancel(receive.id); await until(() => a.transfers.get(third).status === 'cancelled');
});
test('接收目录隔离，同名文件不覆盖既有内容', async t => {
  const { root, a, b } = await setup(t); const file = path.join(root, 'same.txt'); await fsp.writeFile(file, 'original');
  const destinations = [];
  for (let i = 0; i < 2; i++) { const id = await a.sendFiles(b.config.id, [file]), r = await incoming(b); await b.accept(r.id, true); await until(() => a.transfers.get(id).status === 'completed'); destinations.push(r.receiveDir); }
  assert.notEqual(...destinations); for (const dir of destinations) assert.equal(await fsp.readFile(path.join(dir, 'same.txt'), 'utf8'), 'original');
});
test('路径穿越、Windows 保留名称、重复路径和符号链接被拒绝', async t => {
  for (const p of ['../secret', '/tmp/a', 'a/../b', 'a\\b', 'C:/a', 'CON.txt', 'a/aux', 'a.', 'a//b']) assert.throws(() => safeRelative(p));
  const { root, a } = await setup(t);
  assert.throws(() => a.validateManifest([{ path: 'x', type: 'file', size: 1 }, { path: 'X', type: 'file', size: 1 }]));
  assert.throws(() => a.validateManifest([{ path: 'a/b', type: 'file', size: 1 }]));
  const file = path.join(root, 'source'); await fsp.writeFile(file, 'x'); await fsp.symlink(file, path.join(root, 'link'));
  await assert.rejects(() => collectFiles([path.join(root, 'link')]), /符号链接/);
  await assert.rejects(() => a.connect('example.com', 80), /IPv4/);
});
test('不正确的连接凭证和传输凭证被拒绝，坏的摘要不会留下完成文件', async t => {
  const { root, a, b } = await setup(t), peer = a.peers.get(b.config.id);
  await assert.rejects(() => request({ ...peer, token: 'bad' }, '/message', {}), /凭证/);
  const remote = await request(peer, '/offer', { sender: a.hello(), entries: [{ path: 'bad.bin', type: 'file', size: 3 }] });
  await b.accept(remote.id, true); const transfer = b.transfers.get(remote.id);
  await assert.rejects(() => request(peer, '/transfer/' + remote.id + '?secret=bad', undefined, 'GET'), /凭证/);
  await put(peer, `/transfer/${remote.id}/0?secret=${remote.secret}`, Buffer.from('abc')).catch(() => {});
  await until(() => transfer.status === 'failed');
  assert.match(transfer.error, /校验失败/); assert.deepEqual(await fsp.readdir(transfer.receiveDir), []);
});
test('本地名称、路径和聊天记录在重启后保留', async t => {
  const { root, a, b } = await setup(t);
  await a.setConfig({ name: '我的台式机', downloadDir: path.join(root, '新目录') }); await a.sendMessage(b.config.id, '重启后还在'); await a.persist();
  const second = await new LanService({ dataDir: a.dataDir, discovery: false }).start();
  assert.equal(second.config.name, '我的台式机'); assert.equal(second.config.downloadDir, path.join(root, '新目录')); assert.equal(second.messages[0].text, '重启后还在'); await second.stop();
});

test('手动连接在 UDP 不可用时通过 HTTP 心跳维持在线', async t => {
  const { a, b } = await setup(t);
  const peer = a.peers.get(b.config.id); peer.lastSeen = Date.now() - 20000; peer.online = false;
  await a.refreshKnownPeers(); assert.equal(a.peers.get(b.config.id).online, true);
  assert.ok(Date.now() - a.peers.get(b.config.id).lastSeen < 1000);
});
test('纯空文件夹可以完成传输', async t => {
  const { root, a, b } = await setup(t); const folder = path.join(root, 'empty'); await fsp.mkdir(folder);
  const id = await a.sendFiles(b.config.id, [folder]), r = await incoming(b); await b.accept(r.id, true);
  await until(() => a.transfers.get(id).status === 'completed'); assert.equal(r.total, 0);
  assert.equal((await fsp.stat(path.join(r.receiveDir, 'empty'))).isDirectory(), true);
});

test('手机安装页面和 APK 通过局域网提供，文件不可任意读取', async t => {
  const { root, a } = await setup(t);
  const apk = path.join(root, 'client.apk'); await fsp.writeFile(apk, Buffer.from('PK-test-android-apk'));
  const mobile = await new LanService({ dataDir: path.join(root, 'mobile-server'), discovery: false, androidApkPath: apk }).start();
  try {
    const page = await fetch('http://127.0.0.1:' + mobile.port + '/android'); assert.equal(page.status, 200); const html = await page.text(); assert.match(html, /Android/); assert.match(html, /android.apk/); assert.ok(!html.includes('__SHA256__'));
    const binary = await fetch('http://127.0.0.1:' + mobile.port + '/android.apk'); assert.equal(binary.headers.get('content-type'), 'application/vnd.android.package-archive'); assert.deepEqual(Buffer.from(await binary.arrayBuffer()), await fsp.readFile(apk));
    const forbidden = await fetch('http://127.0.0.1:' + mobile.port + '/state.json'); assert.equal(forbidden.status, 401);
    const absent = await fetch('http://127.0.0.1:' + a.port + '/android.apk'); assert.equal(absent.status, 401);
  } finally { await mobile.stop(); }
});
