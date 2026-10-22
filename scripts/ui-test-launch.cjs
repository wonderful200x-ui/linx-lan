'use strict';
// Test-only clipboard fixture. Snapshot every available format and restore on normal exit.
const { app, clipboard, ClipboardItem, nativeImage } = require('electron');
const fs = require('node:fs');
app.whenReady().then(async () => {
  if (process.env.LINX_TEST_IMAGE) {
    const saved = [];
    for (const item of await clipboard.read()) {
      const data = {};
      for (const type of item.types) { try { data[type] = await item.getType(type); } catch {} }
      if (Object.keys(data).length) saved.push(new ClipboardItem(data));
    }
    let restoring = false;
    app.on('before-quit', event => {
      if (restoring) return;
      event.preventDefault(); restoring = true;
      clipboard.write(saved).finally(() => app.quit());
    });
    const png = nativeImage.createFromPath(process.env.LINX_TEST_IMAGE).toPNG();
    fs.writeFileSync(process.env.LINX_TEST_PNG, png);
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
  }
  require('../src/main.cjs');
}).catch(e => { console.error(e); app.exit(1); });
