'use strict';
// Run with Electron, isolated from the user's real application data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
let root;
app.whenReady().then(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flyingmouse-migration-'));
  app.setPath('appData', root);
  delete process.env.LINX_PROFILE;
  const legacy = path.join(root, '邻讯'), downloadDir = path.join(root, '原接收目录');
  await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, 'state.json'), JSON.stringify({
    config: { id: 'preserved-device-id', name: '旧版终端', downloadDir },
    messages: [{ id: 'old-message', peerId: 'old-peer', peerName: '旧伙伴', direction: 'incoming', text: '保留的聊天', createdAt: Date.now() }]
  }));
  require('../src/main.cjs');
  let snapshot;
  for (let i = 0; i < 200; i++) {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading()) {
      snapshot = await win.webContents.executeJavaScript('window.linx?.snapshot()').catch(() => null);
      if (snapshot) break;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(snapshot, '飞鼠应成功启动');
  assert.equal(app.getPath('userData'), legacy);
  assert.equal(snapshot.config.id, 'preserved-device-id');
  assert.equal(snapshot.config.name, '旧版终端');
  assert.equal(snapshot.config.downloadDir, downloadDir);
  assert.equal(snapshot.messages[0].text, '保留的聊天');
  console.log('✓ 邻讯→飞鼠：沿用旧资料目录，设备 ID、终端名、接收位置和聊天均保留');
  app.on('will-quit', () => require('node:fs').rmSync(root, { recursive: true, force: true }));
  app.quit();
}).catch(async e => { console.error(e); if (root) await fs.rm(root, { recursive: true, force: true }); app.exit(1); });
