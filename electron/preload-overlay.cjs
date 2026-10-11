// Preload of the pilot HUD overlay. It only receives its state: no file system, no other channel.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('overlay', {
  on: callback => { ipcRenderer.on('overlay:state', (_event, state) => callback(state)); },
});
