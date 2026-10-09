// Preload of the two overlay windows (pilot HUD and aiming sight). They only receive their state
// and send back a click or a cancel: no file system, no other channel.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('overlay', {
  on: callback => { ipcRenderer.on('overlay:state', (_event, state) => callback(state)); },
  aimed: () => ipcRenderer.send('overlay:aimed'),
  cancel: () => ipcRenderer.send('overlay:cancel'),
});
