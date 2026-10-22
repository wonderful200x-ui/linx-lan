'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, clipboard, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { LanService } = require('./core/service.cjs');
const { ClipboardImages } = require('./core/clipboard-images.cjs');
let win, service, images, shuttingDown = false;
const uiPath = path.join(__dirname, 'ui', 'index.html');
if (process.env.LINX_PROFILE) app.setPath('userData', path.resolve(process.env.LINX_PROFILE));
else {
  // A product rename must not create a new device ID or lose existing history.
  const legacy = path.join(app.getPath('appData'), '邻讯');
  if (require('node:fs').existsSync(path.join(legacy, 'state.json'))) app.setPath('userData', legacy);
}
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    service = await new LanService({ dataDir: app.getPath('userData'), androidApkPath: path.join(__dirname, '../assets/Linx-android.apk'), downloadDir: path.join(app.getPath('downloads'), '飞鼠') }).start();
    images = new ClipboardImages(path.join(app.getPath('userData'), 'clipboard-images'));
    registerIPC(); createWindow();
    service.on('state', state => { if (win && !win.isDestroyed()) win.webContents.send('state', state); });
    service.on('notification', ({ title, body }) => { if (!win?.isFocused() && Notification.isSupported()) new Notification({ title, body }).show(); });
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  }).catch(e => { dialog.showErrorBox('飞鼠启动失败', e.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => { if (service && !shuttingDown) { event.preventDefault(); shuttingDown = true; service.stop().finally(() => app.quit()); } });
}
function createWindow() {
  win = new BrowserWindow({ width: 1060, height: 760, minWidth: 780, minHeight: 600, backgroundColor: '#ffffff', title: '飞鼠', autoHideMenuBar: true, icon: path.join(__dirname, '../assets/icon.png'),
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
  handle('clipboard-image', async () => {
    // Read only after an explicit paste action, never on a polling timer.
    let image;
    for (const item of await clipboard.read()) {
      const type = item.types.find(type => /^image\/(png|jpeg|webp|gif|bmp|tiff)$/.test(type));
      if (!type) continue;
      const blob = await item.getType(type);
      if (blob.size > 25 * 1024 * 1024) throw new Error('图片超过 25 MB，请保存后使用文件发送');
      image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
      if (!image.isEmpty()) break;
    }
    if (!image || image.isEmpty()) return null;
    const size = image.getSize();
    if (size.width * size.height > 40_000_000) throw new Error('图片尺寸过大，请保存后使用文件发送');
    return images.stage(image.toPNG(), image.resize({ width: Math.min(320, size.width) }).toDataURL());
  });
  handle('send-images', (id, drafts) => { service.getPeer(id); return images.send(service, id, drafts); });
  handle('discard-image', id => images.discard(id));
  handle('transfer-image', async id => {
    const t = service.transfers.get(id);
    if (!t || t.status !== 'completed' || !/\.(png|jpe?g|webp|gif)$/i.test(t.name) || path.basename(t.name) !== t.name) return null;
    const files = t.entries?.filter(e => e.type === 'file');
    if ((files?.length ?? t.fileCount) !== 1) return null;
    const file = t.direction === 'incoming' && t.receiveDir ? path.join(t.receiveDir, t.name) : files?.[0]?.source;
    if (!file) return null;
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) return null;
    const image = nativeImage.createFromBuffer(await fs.readFile(file));
    if (image.isEmpty()) return null;
    return image.resize({ width: Math.min(360, image.getSize().width) }).toDataURL();
  });
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
