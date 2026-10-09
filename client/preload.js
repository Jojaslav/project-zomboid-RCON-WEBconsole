const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('pzSetup', {
    list: () => ipcRenderer.invoke('servers:list'),
    connect: (address) => ipcRenderer.invoke('servers:connect', address),
    forget: (address) => ipcRenderer.invoke('servers:forget', address),
  });
} else {
  contextBridge.exposeInMainWorld('pzClient', {
    switchServer: () => ipcRenderer.invoke('client:switch-server'),
  });
}
