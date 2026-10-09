const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const { normalizeUrl, checkServer, loadServers, saveServer, forgetServer } = require('./servers');

let window;
let serverOrigin = null;

const serversFile = () => path.join(app.getPath('userData'), 'servers.json');
const showConnectScreen = () => { serverOrigin = null; return window.loadFile(path.join(__dirname, 'connect.html')); };

function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0c100e',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setMenuBarVisibility(false);

  const isAllowed = (url) => url.startsWith('file:') || (serverOrigin && new URL(url).origin === serverOrigin);
  window.webContents.on('will-navigate', (event, url) => { if (!isAllowed(url)) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  showConnectScreen();
}

// Only the local connect screen may configure servers; remote pages can merely ask to go back.
const fromLocalPage = (event) => event.senderFrame?.url?.startsWith('file:');

ipcMain.handle('servers:list', (event) => (fromLocalPage(event) ? loadServers(serversFile()) : { last: '', servers: [] }));
ipcMain.handle('servers:forget', async (event, origin) => (fromLocalPage(event) ? forgetServer(serversFile(), String(origin)) : undefined));
ipcMain.handle('servers:connect', async (event, input) => {
  if (!fromLocalPage(event)) return { ok: false, error: 'Not allowed.' };
  try {
    const origin = normalizeUrl(input);
    await checkServer(origin);
    await saveServer(serversFile(), origin);
    serverOrigin = origin;
    await window.loadURL(origin);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('client:switch-server', () => showConnectScreen());

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
