const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('elpo', {
  status: () => ipcRenderer.invoke('elpo:status'),
  chooseRoot: () => ipcRenderer.invoke('elpo:chooseRoot'),
  chooseFlowFolder: project => ipcRenderer.invoke('elpo:chooseFlowFolder', project),
  clearFlowFolder: project => ipcRenderer.invoke('elpo:clearFlowFolder', project),
  engine: (action, args) => ipcRenderer.invoke('elpo:engine', { action, args }),
  mediaSources: project => ipcRenderer.invoke('elpo:mediaSources', project),
  loadFile: type => ipcRenderer.invoke('elpo:loadFile', type),
  export: (name, text) => ipcRenderer.invoke('elpo:export', { name, text }),
  preferences: value => ipcRenderer.invoke('elpo:preferences', value),
  openCapcut: () => ipcRenderer.invoke('elpo:openCapcut'),
  openBackups: () => ipcRenderer.invoke('elpo:openBackups'),
});
