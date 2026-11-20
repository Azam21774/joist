'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const inv = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const on = ch => cb => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('api', {
  init: () => inv('init'),
  onState: on('state'),
  onLog: on('log'),
  saveSettings: s => inv('settings:save', s),
  accounts: {
    add: t => inv('accounts:add', t),
    import: () => inv('accounts:import'),
    open: id => inv('accounts:open', id),
    close: id => inv('accounts:close', id),
    remove: id => inv('accounts:remove', id),
    removeAll: () => inv('accounts:removeAll')
  },
  recipients: {
    add: t => inv('recipients:add', t),
    import: () => inv('recipients:import'),
    remove: ids => inv('recipients:remove', ids),
    clear: scope => inv('recipients:clear', scope)
  },
  run: {
    start: () => inv('run:start'),
    pause: () => inv('run:pause'),
    resume: () => inv('run:resume'),
    stop: () => inv('run:stop'),
    restart: () => inv('run:restart')
  }
});
