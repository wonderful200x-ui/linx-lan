'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { LanService } = require('./core/service.cjs');
let win, service, shuttingDown = false;
const uiPath = path.join(__dirname, 'ui', 'index.html');
if (process.env.LINX_PROFILE) app.setPath('userData', path.resolve(process.env.LINX_PROFILE));
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    service = await new LanService({ dataDir: app.getPath('userData'), androidApkPath: path.join(__dirname, '../assets/Linx-android.apk'), downloadDir: path.join(app.getPath('downloads'), '邻讯') }).start();
    registerIPC(); createWindow();
    service.on('state', state => { if (win && !win.isDestroyed()) win.webContents.send('state', state); });
    service.on('notification', ({ title, body }) => { if (!win?.isFocused() && Notification.isSupported()) new Notification({ title, body }).show(); });
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  }).catch(e => { dialog.showErrorBox('邻讯启动失败', e.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => { if (service && !shuttingDown) { event.preventDefault(); shuttingDown = true; service.stop().finally(() => app.quit()); } });
}
function createWindow() {
  win = new BrowserWindow({ width: 1280, height: 840, minWidth: 940, minHeight: 660, backgroundColor: '#f5f7fa', title: '邻讯 · 局域网协作', autoHideMenuBar: true, icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.loadFile(uiPath);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
}
function registerIPC() {
  const handle = (channel, action) => ipcMain.handle(channel, async (event, ...args) => {
    if (event.senderFrame !== win?.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(uiPath).href) throw new Error('无效的页面来源');
    try { return { ok: true, value: await action(...args) }; } catch (e) { return { ok: false, error: e.message }; }
  });
  handle('snapshot', () => service.snapshot());
  handle('android-install', async () => {
    if (!service.androidInstaller) throw new Error('此客户端未包含 Android 安装包');
    const QRCode = require('qrcode'); const links = [];
    for (const address of service.addresses()) { const url = 'http://' + address + ':' + service.port + '/android'; links.push({ address, url, qr: await QRCode.toDataURL(url, { width: 280, margin: 2, color: { dark: '#24324aff', light: '#ffffffff' } }) }); }
    return { links, sha256: service.androidInstaller.sha256 };
  });
  handle('rename', name => service.setConfig({ name }));
  handle('connect', (address, port) => service.connect(address, port));
  handle('rescan', () => { service.announce(); return service.snapshot(); });
  handle('message', (id, text) => service.sendMessage(id, text));
  handle('pick-send', async (id, folder) => {
    service.getPeer(id);
    const result = await dialog.showOpenDialog(win, { title: folder ? '选择要发送的文件夹' : '选择要发送的文件', properties: [folder ? 'openDirectory' : 'openFile', 'multiSelections'] });
    if (!result.canceled) return service.sendFiles(id, result.filePaths);
  });
  handle('drop-send', (id, paths) => {
    if (!Array.isArray(paths) || paths.length > 10000 || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('拖入的文件无效');
    return service.sendFiles(id, paths);
  });
  handle('accept', (id, accepted) => service.accept(id, accepted === true));
  handle('cancel', id => service.cancel(id));
  handle('retry', id => service.retry(id));
  handle('pick-download', async () => {
    const result = await dialog.showOpenDialog(win, { title: '选择接收文件保存位置', properties: ['openDirectory', 'createDirectory'] });
    if (!result.canceled) return service.setConfig({ downloadDir: result.filePaths[0] });
  });
  handle('open-download', async () => { await require('node:fs/promises').mkdir(service.config.downloadDir, { recursive: true }); return shell.openPath(service.config.downloadDir); });
  handle('reveal', id => { const t = service.transfers.get(id); if (!t?.receiveDir) throw new Error('没有接收目录'); return shell.openPath(t.receiveDir); });
}
