'use strict';
const http = require('node:http');
const dgram = require('node:dgram');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const GROUP = '239.255.77.88', DISCOVERY_PORT = 45893, PROTOCOL = 'linx-lan/1';
const terminal = new Set(['completed', 'rejected', 'cancelled', 'failed']);
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('已取消'));
  const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(done, ms);
  const abort = () => { clearTimeout(timer); reject(new Error('已取消')); };
  signal?.addEventListener('abort', abort, { once: true });
});
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || value.includes('\\') || value.startsWith('/') || value.includes('\0')) throw new Error('无效的相对路径');
  const parts = value.split('/');
  for (const p of parts) if (!p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(p)) throw new Error('文件名称不兼容 macOS/Windows：' + value);
  return parts.join('/');
}
async function readJSON(req, limit = 4 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('请求过大'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function respond(res, data, code = 200) { if (!res.destroyed && !res.writableEnded) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); } }
function request(peer, route, data, method = 'POST', signal) {
  return new Promise((resolve, reject) => {
    const body = data === undefined ? undefined : JSON.stringify(data);
    const req = http.request({ hostname: peer.address, port: peer.port, path: route, method, signal, headers: { 'x-linx-token': peer.token || '', ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) } }, res => {
      let result = ''; res.on('data', b => { result += b; if (result.length > 5 * 1024 * 1024) res.destroy(new Error('响应过大')); });
      res.on('error', reject); res.on('end', () => { try { const value = JSON.parse(result); if (res.statusCode >= 400) reject(new Error(value.error || '远端请求失败')); else resolve(value); } catch (e) { reject(e); } });
    });
    req.setTimeout(15000, () => req.destroy(new Error('连接超时'))); req.on('error', reject); req.end(body);
  });
}
async function collectFiles(paths) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('请先选择文件或文件夹');
  const entries = [], seen = new Set(); let total = 0;
  async function visit(absolute, relative) {
    safeRelative(relative);
    const key = relative.toLowerCase(); if (seen.has(key)) throw new Error('存在同名或仅大小写不同的路径：' + relative); seen.add(key);
    const stat = await fsp.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error('暂不传输符号链接：' + relative);
    if (stat.isDirectory()) { entries.push({ path: relative, type: 'directory', size: 0 }); for (const child of (await fsp.readdir(absolute)).sort()) await visit(path.join(absolute, child), relative + '/' + child); }
    else if (stat.isFile()) { total += stat.size; if (!Number.isSafeInteger(total)) throw new Error('总大小超出支持范围'); entries.push({ path: relative, type: 'file', size: stat.size, source: absolute }); }
    else throw new Error('不支持的文件类型：' + relative);
    if (entries.length > 10000) throw new Error('每批最多支持 10,000 个文件和目录，请分批发送');
  }
  for (const p of paths) await visit(path.resolve(p), path.basename(p));
  return { entries, total };
}
class LanService extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.dataDir = options.dataDir || path.join(os.homedir(), '.linx-lan');
    this.peers = new Map(); this.transfers = new Map(); this.messages = []; this.token = randomBytes(32).toString('hex'); this.sockets = new Set(); this.connecting = new Set(); this.stopping = false;
  }
  async start() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    if (this.options.androidApkPath) {
      try { const stat = await fsp.stat(this.options.androidApkPath); const hash = createHash('sha256'); for await (const chunk of fs.createReadStream(this.options.androidApkPath)) hash.update(chunk); this.androidInstaller = { size: stat.size, sha256: hash.digest('hex') }; } catch {}
    }
    let saved = {}; try { saved = JSON.parse(await fsp.readFile(path.join(this.dataDir, 'state.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') this.warning = '本地记录损坏，已使用新的会话'; }
    this.config = { id: saved.config?.id || randomUUID(), name: saved.config?.name || os.hostname(), downloadDir: saved.config?.downloadDir || this.options.downloadDir || path.join(os.homedir(), 'Downloads', '飞鼠') };
    this.messages = Array.isArray(saved.messages) ? saved.messages.slice(-2000) : [];
    for (const t of (saved.transfers || []).slice(-100)) this.transfers.set(t.id, { ...t, status: terminal.has(t.status) ? t.status : 'failed', error: terminal.has(t.status) ? t.error : '应用退出，传输已中断', controller: new AbortController() });
    this.server = http.createServer((req, res) => this.route(req, res).catch(e => respond(res, { error: e.message }, 400)));
    this.server.requestTimeout = 0; this.server.headersTimeout = 15000;
    this.server.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.options.port || 0, '0.0.0.0', resolve); });
    this.port = this.server.address().port;
    if (this.options.discovery !== false) await this.startDiscovery();
    this.heartbeatTimer = setInterval(() => this.refreshKnownPeers(), 4000);
    this.cleanupTimer = setInterval(() => {
      let changed = false;
      for (const [id, p] of this.peers) if (p.online && Date.now() - p.lastSeen > 12000) { p.online = false; changed = true; }
      for (const t of this.transfers.values()) if (t.direction === 'incoming' && !terminal.has(t.status) && Date.now() - t.updatedAt > 10 * 60 * 1000) this.cancel(t.id);
      if (changed) this.changed();
    }, 3000);
    this.changed(); return this;
  }
  hello() { return { protocol: PROTOCOL, id: this.config.id, name: this.config.name, platform: process.platform, port: this.port }; }
  addresses() { return [...new Set(Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address))]; }
  snapshot() {
    return { config: this.config, port: this.port, addresses: this.addresses(), warning: this.warning || '', peers: [...this.peers.values()].map(({ token, ...p }) => p), messages: this.messages,
      transfers: [...this.transfers.values()].map(t => this.publicTransfer(t)).reverse() };
  }
  publicTransfer(t) { const { entries, controller, secret, peer, retryPaths, active, accepting, ...visible } = t; return { ...visible, fileCount: t.fileCount ?? entries?.filter(e => e.type === 'file').length ?? 0 }; }
  changed() {
    if (this.stopping || this.changeTimer) return;
    this.changeTimer = setTimeout(() => { this.changeTimer = null; this.emit('state', this.snapshot()); }, 90);
    clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.persist().catch(e => { this.warning = '记录保存失败：' + e.message; }), 400);
  }
  persist() {
    const data = JSON.stringify({ config: this.config, messages: this.messages.slice(-2000), transfers: [...this.transfers.values()].slice(-100).map(t => this.publicTransfer(t)) });
    this.saveChain = (this.saveChain || Promise.resolve()).catch(() => {}).then(async () => { const temp = path.join(this.dataDir, 'state.tmp'); await fsp.writeFile(temp, data, { mode: 0o600 }); await fsp.rename(temp, path.join(this.dataDir, 'state.json')); }); return this.saveChain;
  }
  async setConfig(update) {
    if (update.name !== undefined) { const name = String(update.name).trim(); if (!name || name.length > 40) throw new Error('终端名称应为 1–40 个字符'); this.config.name = name; }
    if (update.downloadDir !== undefined) { await fsp.mkdir(update.downloadDir, { recursive: true }); this.config.downloadDir = path.resolve(update.downloadDir); }
    this.announce(); this.changed(); await this.persist(); return this.snapshot();
  }
  async startDiscovery() {
    this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp.on('error', e => { this.warning = '自动发现不可用：' + e.message + '。可使用手动连接。'; this.changed(); });
    this.udp.on('message', (buffer, remote) => {
      if (buffer.length > 2048) return;
      try { const h = JSON.parse(buffer); if (h.protocol !== PROTOCOL || h.id === this.config.id) return; this.discover(remote.address, h.port).catch(() => {}); } catch {}
    });
    await new Promise(resolve => { this.udp.once('error', resolve); this.udp.bind(DISCOVERY_PORT, () => {
      this.udp.setBroadcast(true); this.udp.setMulticastTTL(1);
      for (const address of this.addresses()) { try { this.udp.addMembership(GROUP, address); } catch {} }
      try { this.udp.addMembership(GROUP); } catch {} resolve();
    }); });
    this.announce(); this.announceTimer = setInterval(() => this.announce(), 2500);
  }
  announce() {
    if (!this.udp || !this.port) return;
    const data = Buffer.from(JSON.stringify(this.hello()));
    for (const address of [GROUP, '255.255.255.255']) { try { this.udp.send(data, DISCOVERY_PORT, address, () => {}); } catch {} }
  }
  async discover(address, port) {
    if (!net.isIPv4(address) || !Number.isInteger(Number(port)) || port < 1 || port > 65535) throw new Error('请输入有效的 IPv4 地址和端口');
    const key = address + ':' + port; if (this.connecting.has(key)) return;
    this.connecting.add(key);
    try {
      const h = await request({ address, port }, '/hello', undefined, 'GET');
      if (h.protocol !== PROTOCOL || typeof h.id !== 'string' || typeof h.name !== 'string' || typeof h.token !== 'string') throw new Error('不是飞鼠客户端');
      if (h.id === this.config.id) throw new Error('这是当前终端');
      const peer = { id: h.id, name: h.name.slice(0, 40), platform: h.platform, address, port: Number(port), token: h.token, online: true, lastSeen: Date.now() };
      this.peers.set(peer.id, peer); this.changed(); return peer.id;
    } finally { this.connecting.delete(key); }
  }
  refreshKnownPeers() {
    return Promise.allSettled([...this.peers.values()].filter(p => Date.now() - p.lastSeen > 3000).map(p => this.discover(p.address, p.port)));
  }
  async connect(address, port) {
    const id = await this.discover(address, Number(port)); if (!id) throw new Error('连接正在进行，请稍后重试');
    const p = this.peers.get(id); await request(p, '/introduce', this.hello()); return id;
  }
  getPeer(id) { const p = this.peers.get(id); if (!p?.online) throw new Error('终端当前不在线'); return p; }
  async sendMessage(peerId, text) {
    text = String(text).trim(); if (!text || text.length > 20000) throw new Error('消息应为 1–20,000 个字符');
    const p = this.getPeer(peerId), msg = { id: randomUUID(), peerId, peerName: p.name, direction: 'outgoing', text, createdAt: Date.now() };
    await request(p, '/message', { ...msg, sender: this.hello() }); this.messages.push(msg); this.messages = this.messages.slice(-2000); this.changed(); return msg;
  }
  validateManifest(entries) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 10000) throw new Error('文件清单超出限制');
    let total = 0; const names = new Map();
    const clean = entries.map(e => {
      const relative = safeRelative(e.path), key = relative.toLowerCase();
      if (names.has(key) || !['file', 'directory'].includes(e.type) || !Number.isSafeInteger(e.size) || e.size < 0 || (e.type === 'directory' && e.size !== 0)) throw new Error('文件清单无效');
      names.set(key, e.type); total += e.size; return { path: relative, type: e.type, size: e.size };
    });
    if (!Number.isSafeInteger(total)) throw new Error('总大小无效');
    for (const e of clean) { const parts = e.path.toLowerCase().split('/'); parts.pop(); while (parts.length) { if (names.get(parts.join('/')) !== 'directory') throw new Error('目录清单不完整'); parts.pop(); } }
    return { entries: clean, total };
  }
  async route(req, res) {
    req.setTimeout(60000, () => req.destroy(new Error('传输长时间无响应')));
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && this.androidInstaller && ['/android', '/android.apk'].includes(url.pathname)) {
      if (url.pathname === '/android') { const html = (await fsp.readFile(path.join(__dirname, 'android-install.html'), 'utf8')).replace('__SHA256__', this.androidInstaller.sha256); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(html); }
      else { res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': this.androidInstaller.size, 'Content-Disposition': 'attachment; filename="FlyingMouse-android.apk"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); await pipeline(fs.createReadStream(this.options.androidApkPath), res); }
      return;
    }
    if (url.pathname === '/hello' && req.method === 'GET') return respond(res, { ...this.hello(), token: this.token });
    if (req.headers['x-linx-token'] !== this.token) return respond(res, { error: '连接凭证已失效，请重新发现终端' }, 401);
    if (req.method === 'POST' && ['/introduce', '/message', '/offer'].includes(url.pathname)) {
      const body = await readJSON(req);
      const sender = url.pathname === '/introduce' ? body : body.sender;
      if (!sender || sender.protocol !== PROTOCOL || typeof sender.id !== 'string' || typeof sender.name !== 'string' || !Number.isInteger(sender.port) || sender.port < 1 || sender.port > 65535) throw new Error('无效的发送终端');
      const address = req.socket.remoteAddress.replace(/^::ffff:/, '');
      if (sender.id === this.config.id) throw new Error('不能连接自身');
      if (url.pathname === '/introduce') { await this.discover(address, sender.port); return respond(res, { ok: true }); }
      // Reply discovery runs independently, so message delivery does not depend on the reverse connection.
      this.discover(address, sender.port).catch(() => {});
      if (url.pathname === '/message') {
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20000 || typeof body.id !== 'string' || body.id.length > 100) throw new Error('无效的消息');
        if (!this.messages.some(m => m.id === body.id)) this.messages.push({ id: body.id, peerId: sender.id, peerName: sender.name.slice(0, 40), direction: 'incoming', text: body.text, createdAt: Date.now() });
        this.messages = this.messages.slice(-2000); this.changed(); this.emit('notification', { title: sender.name.slice(0, 40), body: body.text.slice(0, 120) }); return respond(res, { ok: true });
      }
      if ([...this.transfers.values()].filter(t => !terminal.has(t.status)).length >= 30) throw new Error('待处理传输过多，请稍后重试');
      const { entries, total } = this.validateManifest(body.entries);
      const id = randomUUID(), secret = randomBytes(24).toString('hex'), now = Date.now();
      const roots = [...new Set(entries.map(e => e.path.split('/')[0]))];
      const transfer = { id, secret, direction: 'incoming', peerId: sender.id, peerName: sender.name.slice(0, 40), name: roots.length === 1 ? roots[0] : `${roots[0]} 等 ${roots.length} 项`, entries, total, bytes: 0, status: 'pending', createdAt: now, updatedAt: now, controller: new AbortController(), currentFile: '', speed: 0 };
      this.transfers.set(id, transfer); this.changed(); this.emit('notification', { title: '收到文件传输请求', body: `${transfer.peerName}：${transfer.name}` });
      return respond(res, { id, secret });
    }
    const match = url.pathname.match(/^\/transfer\/([\w-]+)(?:\/(\d+|finish|cancel))?$/);
    if (!match) return respond(res, { error: '未知请求' }, 404);
    const t = this.transfers.get(match[1]);
    if (!t || t.direction !== 'incoming' || req.headers['x-transfer-secret'] !== t.secret && url.searchParams.get('secret') !== t.secret) return respond(res, { error: '传输凭证无效' }, 403);
    t.updatedAt = Date.now();
    if (req.method === 'GET' && !match[2]) return respond(res, { status: t.status, error: t.error });
    if (req.method === 'POST' && match[2] === 'cancel') { this.cancel(t.id); return respond(res, { ok: true }); }
    if (req.method === 'POST' && match[2] === 'finish') {
      if (t.status !== 'receiving' || t.entries.some(e => e.type === 'file' && !e.done)) throw new Error('文件尚未完整接收');
      t.status = 'completed'; t.speed = 0; t.bytes = t.total; t.completedAt = Date.now(); this.changed(); return respond(res, { ok: true });
    }
    if (req.method !== 'PUT' || !/^\d+$/.test(match[2]) || t.status !== 'receiving' || t.active) throw new Error('传输状态不允许写入');
    const entry = t.entries[Number(match[2])]; if (!entry || entry.type !== 'file' || entry.done) throw new Error('文件索引无效');
    const destination = path.join(t.receiveDir, ...entry.path.split('/')), partial = path.join(t.receiveDir, '.linx-' + randomUUID() + '.part');
    t.currentFile = entry.path; t.active = true; let bytes = 0, previous = Date.now(), previousBytes = t.bytes; const base = t.bytes, hash = createHash('sha256');
    const meter = new Transform({ transform: (chunk, _, cb) => {
      bytes += chunk.length; if (bytes > entry.size) return cb(new Error('文件大小超出清单'));
      hash.update(chunk); t.bytes = base + bytes; t.updatedAt = Date.now();
      if (Date.now() - previous > 350) { t.speed = (t.bytes - previousBytes) * 1000 / (Date.now() - previous); previous = Date.now(); previousBytes = t.bytes; this.changed(); } cb(null, chunk);
    } });
    try {
      await pipeline(req, meter, fs.createWriteStream(partial, { flags: 'wx' }), { signal: t.controller.signal });
      if (bytes !== entry.size || req.trailers['x-content-sha256'] !== hash.digest('hex')) throw new Error('文件大小或 SHA-256 校验失败');
      if (t.controller.signal.aborted) throw new Error('已取消');
      await fsp.rename(partial, destination); entry.done = true; t.bytes = base + bytes; this.changed(); respond(res, { ok: true });
    } catch (e) {
      await fsp.rm(partial, { force: true }).catch(() => {}); t.bytes = base; if (t.status !== 'cancelled') { t.status = 'failed'; t.error = e.message; } this.changed(); respond(res, { error: e.message }, 400);
    } finally { t.active = false; }
  }
  async accept(id, accepted) {
    const t = this.transfers.get(id); if (!t || t.direction !== 'incoming' || t.status !== 'pending' || t.accepting) throw new Error('请求已处理');
    if (!accepted) { t.status = 'rejected'; this.changed(); return; }
    t.accepting = true;
    try { await fsp.mkdir(this.config.downloadDir, { recursive: true });
      const disk = await fsp.statfs(this.config.downloadDir);
      if (disk.bavail * disk.bsize < t.total) throw new Error('接收目录可用空间不足');
    } catch (e) { t.accepting = false; throw e; }
    // A fresh private directory prevents overwrites and path traversal through existing symlinks.
    try {
      t.receiveDir = await fsp.mkdtemp(path.join(this.config.downloadDir, '飞鼠-'));
      for (const entry of t.entries) if (entry.type === 'directory') await fsp.mkdir(path.join(t.receiveDir, ...entry.path.split('/')), { recursive: true });
      if (t.controller.signal.aborted) throw new Error('已取消');
      t.status = 'receiving'; t.updatedAt = Date.now(); this.changed();
    } catch (e) { t.status = 'failed'; t.error = e.message; this.changed(); throw e; }
  }
  async sendFiles(peerId, paths) {
    const peer = { ...this.getPeer(peerId) }, { entries, total } = await collectFiles(paths);
    const now = Date.now(), roots = [...new Set(entries.map(e => e.path.split('/')[0]))];
    const t = { id: randomUUID(), direction: 'outgoing', peerId, peerName: peer.name, name: roots.length === 1 ? roots[0] : `${roots[0]} 等 ${roots.length} 项`, entries, total, bytes: 0, speed: 0, status: 'pending', createdAt: now, updatedAt: now, controller: new AbortController(), retryPaths: paths, peer };
    this.transfers.set(t.id, t); this.changed(); this.runSend(t).catch(() => {}); return t.id;
  }
  async runSend(t) {
    const signal = t.controller.signal; let remote;
    try {
      remote = await request(t.peer, '/offer', { sender: this.hello(), entries: t.entries.map(({ source, ...e }) => e) }, 'POST', signal);
      t.remoteId = remote.id; t.secret = remote.secret;
      const route = '/transfer/' + remote.id, query = '?secret=' + remote.secret, deadline = Date.now() + 10 * 60 * 1000;
      while (true) {
        const result = await request(t.peer, route + query, undefined, 'GET', signal);
        if (result.status === 'receiving') break;
        if (['rejected', 'cancelled', 'failed'].includes(result.status)) { t.status = result.status; t.error = result.error; this.changed(); return; }
        if (Date.now() > deadline) throw new Error('等待接收超时'); await sleep(600, signal);
      }
      t.status = 'sending'; this.changed();
      for (let i = 0; i < t.entries.length; i++) {
        const entry = t.entries[i]; if (entry.type === 'directory') continue;
        const stat = await fsp.stat(entry.source); if (stat.size !== entry.size) throw new Error('发送前文件大小发生变化：' + entry.path);
        t.currentFile = entry.path;
        await this.uploadFile(t, entry, route + '/' + i + query);
      }
      await request(t.peer, route + '/finish' + query, {}, 'POST', signal);
      t.status = 'completed'; t.bytes = t.total; t.speed = 0; t.completedAt = Date.now(); this.changed();
    } catch (e) {
      if (t.status !== 'cancelled') { t.status = 'failed'; t.error = e.message; t.speed = 0; this.changed(); }
      if (remote) request(t.peer, '/transfer/' + remote.id + '/cancel?secret=' + remote.secret, {}).catch(() => {});
    }
  }
  async uploadFile(t, entry, route) {
    const hash = createHash('sha256'), base = t.bytes; let previous = Date.now(), previousBytes = base, count = 0;
    const req = http.request({ hostname: t.peer.address, port: t.peer.port, path: route, method: 'PUT', signal: t.controller.signal, headers: { 'x-linx-token': t.peer.token, Trailer: 'x-content-sha256', 'Content-Type': 'application/octet-stream' } });
    req.setTimeout(60000, () => req.destroy(new Error('传输超时')));
    const response = new Promise((resolve, reject) => { req.on('error', reject); req.on('response', res => { let body = ''; res.on('data', b => { body += b; if (body.length > 65536) res.destroy(new Error('响应过大')); }); res.on('error', reject); res.on('end', () => { if (res.statusCode !== 200) { try { reject(new Error(JSON.parse(body).error)); } catch { reject(new Error('远端拒绝文件')); } } else resolve(); }); }); });
    // Attach rejection handling immediately while the upload stream is running.
    response.catch(() => {});
    const meter = new Transform({ transform: (chunk, _, cb) => {
      count += chunk.length; if (count > entry.size) return cb(new Error('文件在传输期间发生变化'));
      hash.update(chunk); t.bytes = base + count;
      if (Date.now() - previous > 350) { t.speed = (t.bytes - previousBytes) * 1000 / (Date.now() - previous); previous = Date.now(); previousBytes = t.bytes; this.changed(); } cb(null, chunk);
    }, flush(cb) { req.addTrailers({ 'x-content-sha256': hash.digest('hex') }); cb(); } });
    await pipeline(fs.createReadStream(entry.source), meter, req, { signal: t.controller.signal }); await response;
    t.bytes = base + entry.size; this.changed();
  }
  cancel(id) {
    const t = this.transfers.get(id); if (!t || terminal.has(t.status)) return;
    t.status = 'cancelled'; t.speed = 0; t.controller.abort(); t.updatedAt = Date.now(); this.changed();
  }
  async retry(id) { const t = this.transfers.get(id); if (!t?.retryPaths || t.direction !== 'outgoing' || !terminal.has(t.status)) throw new Error('请重新选择文件发送'); return this.sendFiles(t.peerId, t.retryPaths); }
  async stop() {
    this.stopping = true; clearInterval(this.announceTimer); clearInterval(this.heartbeatTimer); clearInterval(this.cleanupTimer); clearTimeout(this.changeTimer); clearTimeout(this.saveTimer);
    for (const t of this.transfers.values()) if (!terminal.has(t.status)) { t.status = 'cancelled'; t.controller.abort(); }
    if (this.udp) { try { this.udp.close(); } catch {} }
    for (const socket of this.sockets) socket.destroy();
    await new Promise(resolve => this.server ? this.server.close(resolve) : resolve()); await this.persist();
  }
}
module.exports = { LanService, collectFiles, safeRelative, request, PROTOCOL };
