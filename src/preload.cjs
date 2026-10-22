const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = async (name, ...args) => {
  const result = await ipcRenderer.invoke(name, ...args); if (!result.ok) throw new Error(result.error); return result.value;
};
contextBridge.exposeInMainWorld('linx', {
  androidInstall: () => invoke('android-install'), snapshot: () => invoke('snapshot'), rename: name => invoke('rename', name), connect: (address, port) => invoke('connect', address, port), rescan: () => invoke('rescan'),
  message: (id, text) => invoke('message', id, text), pickSend: (id, folder) => invoke('pick-send', id, folder),
  clipboardImage: () => invoke('clipboard-image'), sendImages: (id, drafts) => invoke('send-images', id, drafts), discardImage: id => invoke('discard-image', id), transferImage: id => invoke('transfer-image', id),
  dropSend: (id, paths) => invoke('drop-send', id, paths), filePath: file => webUtils.getPathForFile(file),
  accept: (id, accepted) => invoke('accept', id, accepted), cancel: id => invoke('cancel', id), retry: id => invoke('retry', id),
  pickDownload: () => invoke('pick-download'), openDownload: () => invoke('open-download'), reveal: id => invoke('reveal', id),
  onState: callback => { const listener = (_, state) => callback(state); ipcRenderer.on('state', listener); return () => ipcRenderer.removeListener('state', listener); }
});
