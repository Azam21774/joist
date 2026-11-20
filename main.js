'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./src/store');
const { Engine } = require('./src/engine');

let win = null;
let engine = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#0a0c12',
    title: 'Joist Mailer',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => (win = null));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function pickTextFile(title) {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters: [{ name: 'Text', extensions: ['txt', 'csv'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return fs.readFileSync(r.filePaths[0], 'utf8');
}

app.whenReady().then(() => {
  const dir = app.getPath('userData');
  engine = new Engine(new Store(path.join(dir, 'data.json')), dir);
  engine.on('state', () => send('state', engine.snapshot()));
  engine.on('log', l => send('log', l));

  ipcMain.handle('init', () => ({ state: engine.snapshot(), logs: engine.logs }));

  ipcMain.handle('settings:save', (_e, s) => engine.saveSettings(s));

  ipcMain.handle('accounts:add', (_e, text) => engine.addAccounts(text));
  ipcMain.handle('accounts:import', async () => {
    const t = await pickTextFile('credentials.txt (email:password)');
    return t == null ? null : engine.addAccounts(t);
  });
  ipcMain.handle('accounts:open', (_e, id) => { engine.startAccount(id); return true; }); // non-blocking
  ipcMain.handle('accounts:close', (_e, id) => engine.closeAccount(id));
  ipcMain.handle('accounts:remove', (_e, id) => engine.removeAccount(id));
  ipcMain.handle('accounts:removeAll', () => engine.removeAllAccounts());

  ipcMain.handle('recipients:add', (_e, text) => engine.addRecipients(text));
  ipcMain.handle('recipients:import', async () => {
    const t = await pickTextFile('recipients.txt');
    return t == null ? null : engine.addRecipients(t);
  });
  ipcMain.handle('recipients:remove', (_e, ids) => engine.removeRecipients(ids));
  ipcMain.handle('recipients:clear', (_e, scope) => engine.clearRecipients(scope));

  ipcMain.handle('run:start', () => engine.start());
  ipcMain.handle('run:pause', () => engine.pause());
  ipcMain.handle('run:resume', () => engine.resume());
  ipcMain.handle('run:stop', () => engine.stop());
  ipcMain.handle('run:restart', () => engine.restart());

  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});

let quitting = false;
app.on('before-quit', async e => {
  if (quitting || !engine) return;
  e.preventDefault();
  quitting = true;
  await engine.shutdown();
  app.quit();
});

app.on('window-all-closed', () => app.quit());
