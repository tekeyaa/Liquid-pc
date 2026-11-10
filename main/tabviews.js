// Вкладки на WebContentsView (движок «view», настройка «Эксперименты»): страница живёт в основном процессе,
// а окно управляет ею по IPC. Без тега <webview> загрузка страницы в замерах CI быстрее на 35–190 мс.
// Окно видит вкладку как элемент <liquid-view> (renderer/tabview.js) с тем же набором методов и событий, что у webview.
//
// Главная особенность: WebContentsView рисуется ПОВЕРХ html окна. Поэтому окно само говорит, где вкладка
// (bounds) и видна ли она: при меню и всплывающих окнах интерфейса вкладка прячется, а на её месте — снимок.
const { ipcMain, BrowserWindow, WebContentsView, webContents } = require('electron');

// события вкладки, которые нужны окну, и что из них передать (как поля события у webview)
const EVENTS = {
  'dom-ready': () => ({}),
  'did-start-loading': () => ({}),
  'did-stop-loading': () => ({}),
  'did-finish-load': () => ({}),
  'page-title-updated': (_e, title) => ({ title }),
  'page-favicon-updated': (_e, favicons) => ({ favicons }),
  'media-started-playing': () => ({}),
  'media-paused': () => ({}),
  'did-navigate': (_e, url, httpResponseCode) => ({ url, httpResponseCode, isMainFrame: true }),
  'did-navigate-in-page': (_e, url, isMainFrame) => ({ url, isMainFrame }),
  'did-start-navigation': (d) => ({ url: d.url, isMainFrame: d.isMainFrame, isSameDocument: d.isSameDocument, isInPlace: d.isSameDocument }),
  'did-fail-load': (_e, errorCode, errorDescription, validatedURL, isMainFrame) => ({ errorCode, errorDescription, validatedURL, isMainFrame }),
  'render-process-gone': (_e, details) => ({ details, reason: details && details.reason }),
  'enter-html-full-screen': () => ({}),
  'leave-html-full-screen': () => ({}),
  'found-in-page': (_e, result) => ({ result }),
  focus: () => ({}),
  blur: () => ({}),
};
// что окно может вызвать у вкладки (как методы webview)
const CALLS = new Set(['loadURL', 'reload', 'reloadIgnoringCache', 'stop', 'executeJavaScript', 'setZoomLevel', 'findInPage', 'stopFindInPage',
  'setAudioMuted', 'paste', 'sendInputEvent', 'print', 'openDevTools', 'closeDevTools', 'insertCSS', 'setUserAgent', 'copy', 'selectAll', 'undo', 'redo', 'cut']);

function setup({ prefs, onCreated, log }) {
  const views = new Map(); // id вкладки → { view, host, win, shown }
  const hostOf = new WeakMap(); // webContents вкладки → webContents окна

  // «назад»: пустая заготовка (about:blank в начале истории) не в счёт — как в tab:nav
  const navOf = (wc) => {
    try {
      const h = wc.navigationHistory, i = h.getActiveIndex();
      return { back: h.canGoBack() && !(i === 1 && /^about:blank/.test(h.getEntryAtIndex(0)?.url || '')), fwd: h.canGoForward(), zoom: wc.getZoomLevel() };
    } catch { return { back: false, fwd: false, zoom: 0 }; }
  };
  const emit = (rec, type, data) => {
    if (!rec.host || rec.host.isDestroyed()) return;
    let extra = {};
    try { if (!rec.wc.isDestroyed()) extra = { url: rec.wc.getURL(), title: rec.wc.getTitle(), ...navOf(rec.wc) }; } catch {}
    try { rec.host.send('tv:event', { id: rec.id, type, state: extra, data: data || {} }); } catch {}
  };

  ipcMain.handle('tv:create', (e, { url, partition } = {}) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || !win.__liquid) return 0;
    const view = new WebContentsView({ webPreferences: prefs(partition) });
    const wc = view.webContents;
    const rec = { id: wc.id, view, wc, host: e.sender, win, shown: false };
    views.set(wc.id, rec);
    hostOf.set(wc, e.sender);
    view.setVisible(false);
    try { view.setBackgroundColor('#00000000'); } catch {}
    win.contentView.addChildView(view);
    for (const [ev, pick] of Object.entries(EVENTS)) wc.on(ev, (...a) => emit(rec, ev, pick(...a)));
    wc.once('destroyed', () => { emit(rec, 'destroyed'); views.delete(rec.id); });
    // видео или сайт на весь экран — окно тоже на весь экран (у <webview> это делает сам Electron)
    wc.on('enter-html-full-screen', () => { if (!win.isDestroyed() && !win.isFullScreen()) { rec.fsByUs = true; win.setFullScreen(true); } });
    wc.on('leave-html-full-screen', () => { if (rec.fsByUs && !win.isDestroyed()) { rec.fsByUs = false; win.setFullScreen(false); } });
    watchHost(e.sender);
    try { onCreated(wc, e.sender); } catch (err) { log('error', 'вкладка', 'Настройка вкладки: ' + err.message); }
    if (url) wc.loadURL(url).catch(() => {});
    return wc.id;
  });

  // окно закрыли или перезагрузили — его вкладки закрываем вместе с ним (один обработчик на окно)
  const hosts = new WeakSet();
  const watchHost = (host) => {
    if (hosts.has(host)) return;
    hosts.add(host);
    const dropAll = () => { for (const r of [...views.values()]) if (r.host === host) destroy(r.id); };
    host.once('destroyed', dropAll);
    host.on('did-navigate', dropAll);
  };
  const destroy = (id) => {
    const rec = views.get(id); if (!rec) return;
    views.delete(id);
    try { if (!rec.win.isDestroyed()) rec.win.contentView.removeChildView(rec.view); } catch {}
    try { if (!rec.wc.isDestroyed()) rec.wc.close(); } catch {}
  };
  ipcMain.on('tv:destroy', (e, id) => { const r = views.get(id); if (r && r.host === e.sender) destroy(id); });

  // где вкладка и видна ли: окно присылает прямоугольник области страницы (в точках окна)
  ipcMain.on('tv:bounds', (e, id, b, show) => {
    const rec = views.get(id); if (!rec || rec.host !== e.sender || rec.wc.isDestroyed()) return;
    if (b) rec.view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) });
    if (b && Number.isFinite(b.r) && b.r !== rec.r) { rec.r = b.r; try { if (rec.view.setBorderRadius) rec.view.setBorderRadius(Math.max(0, b.r - 1)); } catch {} }
    if (!!show !== rec.shown) {
      rec.shown = !!show;
      rec.view.setVisible(rec.shown);
      // видимая вкладка — над остальными (порядок дочерних видов = порядок отрисовки)
      if (rec.shown) { try { rec.win.contentView.addChildView(rec.view); } catch {} }
    }
  });

  ipcMain.handle('tv:call', async (e, id, method, args) => {
    if (method === 'hostFocus') { e.sender.focus(); return; } // фокус клавиатуры — обратно интерфейсу окна
    const rec = views.get(id); if (!rec || rec.host !== e.sender || rec.wc.isDestroyed()) throw new Error('Вкладка закрыта');
    const wc = rec.wc;
    switch (method) {
      // ошибка загрузки приходит событием did-fail-load (как у <webview>), а не отказом вызова
      case 'loadURL': return wc.loadURL(String(args[0] || '')).catch(() => {});
      case 'goBack': return wc.navigationHistory.goBack();
      case 'goForward': return wc.navigationHistory.goForward();
      case 'goToIndex': return wc.navigationHistory.goToIndex(args[0]);
      case 'clearHistory': wc.navigationHistory.clear(); emit(rec, 'nav-state'); return;
      case 'focus': return wc.focus();
      case 'getZoomLevel': return wc.getZoomLevel();
      case 'isDevToolsOpened': return wc.isDevToolsOpened();
      // снимок для показа под меню интерфейса: JPEG — быстрее PNG
      case 'freeze': { const img = await wc.capturePage(); return img.isEmpty() ? '' : 'data:image/jpeg;base64,' + img.toJPEG(80).toString('base64'); }
    }
    if (!CALLS.has(method)) throw new Error('Нельзя: ' + method);
    return wc[method](...(args || []));
  });
  // сообщения страницы (webview-preload.js) — у webview они шли через sendToHost
  ipcMain.on('tv:tohost', (e, channel, ...args) => {
    const host = hostOf.get(e.sender); if (!host || host.isDestroyed()) return;
    try { host.send('tv:event', { id: e.sender.id, type: 'ipc-message', state: {}, data: { channel, args } }); } catch {}
  });
  // команды страницы от окна (как webview.send)
  ipcMain.on('tv:send', (e, id, channel, ...args) => { const r = views.get(id); if (r && r.host === e.sender && !r.wc.isDestroyed()) r.wc.send(channel, ...args); });

  return {
    hostOf: (wc) => (wc ? hostOf.get(wc) : undefined),
    isTab: (wc) => !!wc && hostOf.has(wc),
    // для тестов: что сейчас видно
    state: () => [...views.values()].map((r) => ({ id: r.id, shown: r.shown, bounds: r.view.getBounds(), url: r.wc.isDestroyed() ? '' : r.wc.getURL() })),
  };
}

module.exports = { setup };
