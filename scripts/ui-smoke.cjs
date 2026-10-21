'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path'); const fs = require('node:fs/promises'); const os = require('node:os'); const net = require('node:net');
const assert = require('node:assert/strict');
const { LanService } = require('../src/core/service.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, ms = 20000) { const start = Date.now(); while (Date.now() - start < ms) { try { const value = await fn(); if (value) return value; } catch {} await delay(100); } throw new Error('UI 等待超时'); }
class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.pending = new Map(); this.id = 0; this.ws.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.id) { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }); }
  async ready() { if (this.ws.readyState !== WebSocket.OPEN) await new Promise((r, j) => { this.ws.addEventListener('open', r, { once: true }); this.ws.addEventListener('error', j, { once: true }); }); }
  call(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const value = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (value.exceptionDetails) throw new Error(value.exceptionDetails.text + ': ' + JSON.stringify(value.exceptionDetails.exception)); return value.result.value; }
}
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linx-ui-')), profile = path.join(root, 'profile'); await fs.mkdir(profile);
  await fs.writeFile(path.join(profile, 'state.json'), JSON.stringify({ config: { name: '我的 MacBook', downloadDir: path.join(root, 'received') } }));
  const peer = await new LanService({ dataDir: path.join(root, 'peer'), downloadDir: path.join(root, 'peer-received') }).start(); await peer.setConfig({ name: '设计工作站' });
  const portFinder = net.createServer(); await new Promise(r => portFinder.listen(0, '127.0.0.1', r)); const debugPort = portFinder.address().port; await new Promise(r => portFinder.close(r));
  const env = { ...process.env, LINX_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.env.LINX_BINARY || require('electron'), [...(process.env.LINX_BINARY ? [] : ['.']), '--remote-debugging-port=' + debugPort], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] }); let log = '';
  child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  let cdp;
  try {
    const page = await wait(async () => { const list = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json(); return list.find(p => p.type === 'page' && p.url.includes('index.html')); });
    cdp = new CDP(page.webSocketDebuggerUrl); await cdp.ready(); await cdp.call('Runtime.enable');
    const consoleErrors = [];
    cdp.ws.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.text); });
    await wait(() => cdp.eval('Boolean(window.linx && document.getElementById("selfName").textContent === "我的 MacBook")'));
    await fs.mkdir(path.join(__dirname, '../docs/screenshots'), { recursive: true });
    const screenshot = async name => { await delay(600); const result = await cdp.call('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(__dirname, '../docs/screenshots', name + '.png'), Buffer.from(result.data, 'base64')); };
    await wait(async () => (await cdp.eval('window.linx.snapshot()')).peers.some(p => p.id === peer.config.id && p.online));
    console.log('✓ UDP 自动发现真实桌面客户端与第二终端');
    await screenshot('welcome');
    await cdp.eval('document.getElementById("androidButton").click()');
    await wait(() => cdp.eval('document.getElementById("androidDialog").open && !document.getElementById("androidQR").hidden'));
    const installURL = await cdp.eval('document.getElementById("androidURL").textContent');
    const installPage = await (await fetch(installURL)).text(); assert.match(installPage, /android.apk/);
    const apkResponse = await fetch(new URL('/android.apk', installURL)); assert.equal(apkResponse.status, 200); assert.ok((await apkResponse.arrayBuffer()).byteLength > 10000);
    await screenshot('android-install'); await cdp.eval('document.getElementById("androidDialog").close()');
    console.log('✓ Android 安装二维码、局域网下载页面和 APK 下载');
    await cdp.eval(`document.getElementById('connectButton').click(); document.getElementById('peerAddress').value='127.0.0.1'; document.getElementById('peerPort').value='${peer.port}'; document.getElementById('connectForm').requestSubmit();`);
    await wait(() => cdp.eval('!document.getElementById("connectDialog").open && !document.getElementById("chat").hidden'));
    await cdp.eval(`document.getElementById('messageInput').value='你好！项目文件可以直接发到这里。'; document.getElementById('messageInput').dispatchEvent(new Event('input')); document.getElementById('sendMessage').click();`);
    await wait(() => peer.messages.some(m => m.text.includes('项目文件')));
    const own = await cdp.eval('window.linx.snapshot()'); await peer.connect('127.0.0.1', own.port);
    await peer.sendMessage(own.config.id, '收到，整个设计文件夹一起发给你，空目录也会保留。');
    const folder = path.join(root, '品牌设计方案'); await fs.mkdir(path.join(folder, '交付素材'), { recursive: true }); await fs.writeFile(path.join(folder, '设计说明.txt'), '邻讯真实客户端端到端测试'); await fs.writeFile(path.join(folder, '交付素材', '封面.bin'), Buffer.alloc(8 * 1024 * 1024, 37));
    const sentId = await peer.sendFiles(own.config.id, [folder]);
    await wait(() => cdp.eval('Boolean(document.querySelector("#activeTransfers [data-action=accept]"))'));
    await cdp.eval('document.querySelector("#activeTransfers [data-action=accept]").click()');
    await wait(() => peer.transfers.get(sentId).status === 'completed');
    const received = (await cdp.eval('window.linx.snapshot()')).transfers.find(t => t.status === 'completed');
    assert.equal(await fs.readFile(path.join(received.receiveDir, '品牌设计方案', '设计说明.txt'), 'utf8'), '邻讯真实客户端端到端测试');
    const out = path.join(root, '会议记录.txt'); await fs.writeFile(out, 'UI outgoing file');
    await cdp.eval(`window.linx.dropSend(${JSON.stringify(peer.config.id)}, ${JSON.stringify([out])})`);
    await wait(() => [...peer.transfers.values()].find(t => t.direction === 'incoming' && t.status === 'pending'));
    const inbound = [...peer.transfers.values()].find(t => t.direction === 'incoming' && t.status === 'pending'); await peer.accept(inbound.id, true);
    await wait(() => inbound.status === 'completed');
    assert.equal(await fs.readFile(path.join(inbound.receiveDir, '会议记录.txt'), 'utf8'), 'UI outgoing file');
    await cdp.eval(`document.getElementById('settingsButton').click(); document.getElementById('deviceName').value='产品团队 · MacBook'; document.getElementById('settingsForm').requestSubmit();`);
    await wait(() => cdp.eval('document.getElementById("selfName").textContent === "产品团队 · MacBook"'));
    await peer.sendMessage(own.config.id, '文件夹传输完成，校验通过 ✓'); await delay(500);
    await screenshot('chat');
    await cdp.eval('document.querySelector("[data-view=transfers]").click()'); await screenshot('transfers');
    assert.deepEqual(consoleErrors, []);
    console.log('✓ Electron 真实界面：启动、手动连接、双向聊天、接收文件夹、发送文件、进度卡片、改名、传输记录均通过');
    console.log('✓ 截图保存在 docs/screenshots/');
  } catch (e) { console.error(log.slice(-6000)); console.error('Peer transfers:', JSON.stringify(peer.snapshot().transfers)); if (cdp) { console.error('App state:', JSON.stringify(await cdp.eval('window.linx.snapshot()').catch(() => ({})))); const shot = await cdp.call('Page.captureScreenshot', { format: 'png' }).catch(() => null); if (shot) await fs.writeFile(path.join(__dirname, '../docs/screenshots/error.png'), Buffer.from(shot.data, 'base64')); } throw e; }
  finally { cdp?.ws.close(); child.kill('SIGTERM'); await delay(1000); await peer.stop(); await fs.rm(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
