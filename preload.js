const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => {
  const h = (_e, data) => cb(data);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('liquid', {
  platform: process.platform,
  win: {
    min: () => ipcRenderer.send('win:min'),
    max: () => ipcRenderer.send('win:max'),
    close: () => ipcRenderer.send('win:close'),
    onState: on('win:state'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    clearData: () => ipcRenderer.invoke('data:clear'),
  },
  vpn: {
    connect: (key) => ipcRenderer.invoke('vpn:connect', key),
    disconnect: () => ipcRenderer.invoke('vpn:disconnect'),
    state: () => ipcRenderer.invoke('vpn:state'),
    startup: () => ipcRenderer.invoke('vpn:startup'),
    onState: on('vpn:state'),
  },
  claude: {
    send: (payload) => ipcRenderer.send('claude:send', payload),
    abort: (id) => ipcRenderer.send('claude:abort', id),
    check: (info) => ipcRenderer.invoke('claude:check', info),
    onChunk: on('claude:chunk'),
    onDone: on('claude:done'),
    onError: on('claude:error'),
    onAsk: on('claude:ask'),
  },
  tabs: { onOpen: on('tab:open'), onSearch: on('tab:search') },
  devtools: (wcId) => ipcRenderer.send('webview:devtools', wcId),
  onShortcut: on('shortcut'),
  onToast: on('toast'),
  onPopupBlocked: on('popup:blocked'),
  popupAllow: (site) => ipcRenderer.invoke('popup:allow', site),
  perms: { list: () => ipcRenderer.invoke('perms:list'), remove: (k) => ipcRenderer.invoke('perms:remove', k) },
  copy: (t) => ipcRenderer.send('clipboard:write', t),
  display: () => ipcRenderer.invoke('display:info'),
  relaunch: () => ipcRenderer.send('app:relaunch'),
  ask: (req) => ipcRenderer.invoke('claude:once', req),
  part: new URLSearchParams(location.search).get('part') || 'persist:liquid',
  incognito: new URLSearchParams(location.search).get('incognito') === '1',
  newIncognito: () => ipcRenderer.send('win:incognito'),
  fullscreen: (on) => ipcRenderer.send('win:fullscreen', on),
  vpnUnblock: (url) => ipcRenderer.invoke('vpn:unblock', url),
  vpnRouted: (url) => ipcRenderer.invoke('vpn:routed', url),
  adblock: { onCount: on('adblock:count'), count: (id) => ipcRenderer.invoke('adblock:count', id) },
  dl: {
    onUpdate: on('dl:update'),
    act: (id, act) => ipcRenderer.send('dl:act', { id, act }),
    showPath: (p) => ipcRenderer.send('dl:show-path', p),
    openPath: (p) => ipcRenderer.send('dl:open-path', p),
    folder: () => ipcRenderer.send('dl:folder'),
  },
  ext: {
    list: () => ipcRenderer.invoke('ext:list'),
    install: (input) => ipcRenderer.invoke('ext:install', input),
    toggle: (id, on) => ipcRenderer.invoke('ext:toggle', { id, on }),
    remove: (id) => ipcRenderer.invoke('ext:remove', id),
    open: (id, page) => ipcRenderer.send('ext:open', { id, page }),
  },
  mem: () => ipcRenderer.invoke('mem:info'),
  trimCache: () => ipcRenderer.invoke('cache:trim'),
  onSplit: on('tab:split'),
  onNote: on('note:add'),
  shot: {
    full: (wcId) => ipcRenderer.invoke('shot:full', wcId),
    visible: (wcId, rect) => ipcRenderer.invoke('shot:visible', { wcId, rect }),
  },
  saveFile: (name, data, kind, copy) => ipcRenderer.invoke('file:save', { name, data, kind, copy }),
  game: { state: () => ipcRenderer.invoke('game:state'), force: (on) => ipcRenderer.send('game:force', on), onState: on('game:state') },
  diag: {
    log: (level, source, message, extra) => ipcRenderer.send('diag:log', { level, source, message: String(message), extra: extra ? String(extra) : '' }),
    list: (min) => ipcRenderer.invoke('diag:list', min),
    report: () => ipcRenderer.invoke('diag:report'),
    save: () => ipcRenderer.invoke('diag:save'),
    clear: () => ipcRenderer.send('diag:clear'),
    seen: () => ipcRenderer.send('diag:seen'),
    folder: () => ipcRenderer.send('diag:folder'),
    onNew: on('diag:new'),
  },
  update: { on: on('update'), run: () => ipcRenderer.send('update:run'), later: () => ipcRenderer.send('update:later') },
});
