const { app, BrowserWindow, ipcMain, session, safeStorage, Menu, clipboard, shell, net, dialog, screen, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const { parseKey, Xray } = require('./vpn');
const { spawn } = require('child_process');
const { AdBlock } = require('./main/adblock');
const { SmartVpn } = require('./main/smartvpn');
const { Extensions, POPULAR } = require('./main/extensions');
const { translateBatch } = require('./main/translate');
const { GameMode } = require('./main/gamemode');
const { Diag, sysInfo } = require('./main/diag');
const os = require('os');
const { nativeImage } = require('electron');
let game = null;

const PARTITION = 'persist:liquid';
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
app.userAgentFallback = UA;

// Google не пускает во «встроенные» браузеры (Electron), а Firefox пускает.
// Поэтому только на страницах входа Google представляемся свежим Firefox.
const FF_VER = 128 + Math.floor((Date.now() - Date.UTC(2024, 6, 9)) / (28 * 864e5)) - 1; // Firefox выходит раз в 4 недели
const FF_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${FF_VER}.0) Gecko/20100101 Firefox/${FF_VER}.0`;
const AUTH_HOSTS = /^https:\/\/(accounts\.google\.com|accounts\.youtube\.com|myaccount\.google\.com)\//;
const WEBVIEW_PRELOAD = path.join(__dirname, 'webview-preload.js');

function hardenSession(sess) {
  sess.setUserAgent(UA);
  sess.webRequest.onBeforeSendHeaders((d, cb) => {
    const h = d.requestHeaders;
    let topUrl = '';
    try { topUrl = d.frame?.top?.url || ''; } catch {}
    const auth = AUTH_HOSTS.test(d.url) || AUTH_HOSTS.test(topUrl);
    for (const k of Object.keys(h)) {
      const lk = k.toLowerCase();
      if (lk === 'user-agent') h[k] = auth ? FF_UA : h[k].replace(/\s*Electron\/\S+/, '').replace(/\s*liquid-browser\/\S+/i, '');
      else if (auth && lk.startsWith('sec-ch-ua')) delete h[k]; // Firefox такие заголовки не шлёт
    }
    cb({ requestHeaders: h });
  });
}

// ---------- плавность: GPU и частота монитора (до app.ready) ----------
let bootSettings = {};
try { bootSettings = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')); } catch {}
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization');
// ---------- журнал ошибок ----------
const diag = new Diag(app.getPath('userData'));
let gpuLine = '';
for (const lvl of ['warn', 'error']) {
  const orig = console[lvl].bind(console);
  console[lvl] = (...a) => { orig(...a); diag.log(lvl, 'main', a.map((x) => (x && x.stack) || (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
}
process.on('uncaughtException', (e) => {
  diag.log('crash', 'main', e);
  // упали до появления окна — иначе пользователь просто ничего не увидит
  if (!win) {
    try { dialog.showErrorBox('Liquid не смог запуститься', `Ошибка записана в журнал:\n${diag.file()}\n\nОтправь этот файл Claude — он починит.\n\n${(e && e.message) || e}`); } catch {}
    try { shell.showItemInFolder(diag.file()); } catch {}
  }
});
process.on('unhandledRejection', (e) => {
  // «Script failed to execute» — это скрипт блокировщика рекламы, упавший на странице сайта; браузеру он не вредит
  const m = String((e && e.message) || e);
  diag.log(/Script failed to execute/.test(m) ? 'debug' : 'error', 'main', e);
});
app.on('render-process-gone', (_e, wc, d) => {
  let url = ''; try { url = wc.getURL(); } catch {}
  diag.log(d.reason === 'clean-exit' ? 'info' : 'crash', wc.getType() === 'webview' ? 'вкладка' : 'интерфейс', `Процесс упал: ${d.reason} (код ${d.exitCode})`, url);
});
app.on('child-process-gone', (_e, d) => {
  if (d.reason !== 'clean-exit' && d.reason !== 'killed') diag.log('crash', d.type, `Процесс ${d.type}${d.name ? ' ' + d.name : ''} упал: ${d.reason} (код ${d.exitCode})`);
});
diag.log('info', 'main', `Запуск Liquid ${app.getVersion()} (Electron ${process.versions.electron})`);

// Экономия памяти: без «запасного» процесса и без кэша страниц «назад/вперёд» в ОЗУ
if (bootSettings.memSaver !== false) {
  app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,BackForwardCache');
}
if (bootSettings.fps === '60') {
  // Ограничение кадров до 60 — меньше нагрузка на видеокарту и батарею
  app.commandLine.appendSwitch('limit-fps', '60');
}


let win = null;          // главное окно
let ses = null;          // основная сессия (persist:liquid)
const incognito = new Map(); // BrowserWindow -> session
let adblock = null;
const smart = new SmartVpn();
let exts = null;
let proxyRules = '';     // текущий прокси, если VPN включён
let proxyPac = '';       // то же в синтаксисе PAC
const downloads = new Map(); // id -> { item, host }
let dlSeq = 0;
let xray = null;
let vpnStartup = null;
let permDecided = null;
let iconSes = null; // решения о доступе для сайтов (обычный режим), загружаются при старте
let vpnState = { on: false, name: '', country: '', ip: '', busy: false };
let proxyAuth = null;
const claudeJobs = new Map();

// ---------- настройки ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } }
function saveSettings(s) { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); }
function enc(str) {
  if (!str) return '';
  return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(str).toString('base64') : 'plain:' + str;
}
function dec(b) {
  if (!b) return '';
  if (b.startsWith('plain:')) return b.slice(6);
  try { return safeStorage.decryptString(Buffer.from(b, 'base64')); } catch { return ''; }
}
function publicSettings() {
  const s = loadSettings();
  return {
    hasVpnKey: !!s.vpnKey, vpnName: s.vpnName || '',
    hasClaudeKey: !!s.claudeKey, model: s.model || 'claude-sonnet-5-5',
    search: s.search || 'google', vpnAuto: !!s.vpnAuto, guard: s.guard !== false, fps: s.fps === '60' ? '60' : 'auto', claudeMode: s.claudeMode || (s.claudeKey ? 'api' : 'web'),
    vpnMode: s.vpnMode || 'smart', autoVpn: s.autoVpn !== false, vpnSites: (s.vpnSites || []).join('\n'), learned: s.learned || [],
    memSaver: s.memSaver !== false, sleepAfter: s.sleepAfter ?? 20, restore: s.restore !== false, adblock: s.adblock !== false,
    adAllow: s.adAllow || [], dlAsk: !!s.dlAsk, gameMode: s.gameMode !== false, gameKeepAudio: s.gameKeepAudio !== false,
    superRes: ['off', 'mid', 'max'].includes(s.superRes) ? s.superRes : 'off', srHdr: !!s.srHdr, vidBar: s.vidBar !== false,
    version: app.getVersion(), electron: process.versions.electron,
  };
}

// ---------- окно ----------
function allSessions() { return [ses, ...incognito.values()].filter(Boolean); }
function broadcast(ch, data) { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.__liquid) w.webContents.send(ch, data); }
function hostOf(wc) { return wc?.hostWebContents || wc; }

function createWindow({ priv = false } = {}) {
  const w = new BrowserWindow({
    width: 1400, height: 900, minWidth: 760, minHeight: 500,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    backgroundColor: priv ? '#0b0812' : '#0a0a12',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  w.__liquid = true;
  let part = 'persist:liquid';
  if (priv) {
    // Инкогнито: сессия только в памяти — после закрытия окна куки, кэш и история исчезают
    part = 'incognito-' + Date.now();
    const s = session.fromPartition(part, { cache: false });
    incognito.set(w, s);
    setupSession(s, true);
    w.on('closed', () => { const s2 = incognito.get(w); incognito.delete(w); try { s2.clearStorageData(); s2.clearCache(); } catch {} });
  }
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { part, ...(priv ? { incognito: '1' } : {}) } });
  w.on('maximize', () => w.webContents.send('win:state', { max: true }));
  w.on('unmaximize', () => w.webContents.send('win:state', { max: false }));
  w.on('enter-full-screen', () => w.webContents.send('win:state', { full: true }));
  w.on('leave-full-screen', () => w.webContents.send('win:state', { full: false }));
  w.webContents.on('before-input-event', (e, input) => handleShortcut(e, input, w.webContents));
  if (!priv) { win = w; w.on('closed', () => { if (win === w) win = null; }); }
  return w;
}

const SHORTCUTS = new Set(['t', 'w', 'l', 'r', 'tab', 'j', 'k', 'h', '=', '+', '-', '0', 'f', 'i', 'n', 'd', 'b', '\\', 'y', 's']);
function handleShortcut(e, input, target) {
  if (input.type !== 'keyDown' || !target || target.isDestroyed()) return;
  const k = (input.key || '').toLowerCase();
  const mod = input.control || input.meta;
  let hit = null;
  if (mod && SHORTCUTS.has(k)) hit = k;
  else if (k === 'f5') hit = 'r';
  else if (k === 'f12') hit = 'i';
  else if (input.alt && k === 'arrowleft') hit = 'back';
  else if (input.alt && k === 'arrowright') hit = 'forward';
  else if (input.alt && (k === 'p' || k === 'з')) hit = 'pip';
  else if (k === 'f11') hit = 'f11';
  else if (k === 'f9') hit = 'reader';
  else if (k === 'escape') hit = 'escape';
  if (!hit) return;
  if (hit === 'escape') { target.send('shortcut', { key: 'escape' }); return; }
  if (hit === 'f11') { const bw = BrowserWindow.fromWebContents(target); if (bw) bw.setFullScreen(!bw.isFullScreen()); e.preventDefault(); return; }
  if (hit === 'i' && !input.shift && k !== 'f12') return; // Ctrl+Shift+I = devtools страницы
  if (hit === 's' && !input.shift) return; // Ctrl+S оставляем сайтам
  if (hit === 's') { e.preventDefault(); target.send('shortcut', { key: 'shot' }); return; }
  if (hit === 'n' && input.shift) { e.preventDefault(); createWindow({ priv: true }); return; }
  if (hit === 'f') { target.send('shortcut', { key: 'f' }); e.preventDefault(); return; }
  e.preventDefault();
  target.send('shortcut', { key: hit, shift: input.shift });
}

// ---------- webview: новые окна, контекстное меню, хоткеи ----------
// Каждый webview получает только наш безопасный preload, без доступа к Node
app.on('web-contents-created', (_e, contents) => {
  const kind = () => (contents.getType() === 'webview' ? 'вкладка' : 'интерфейс');
  contents.setMaxListeners(40); // вкладку слушают блокировщик, журнал и интерфейс — 10 по умолчанию мало
  // один аргумент: в Electron 45 старая форма (ev, lvl, msg, …) выдаёт предупреждение об устаревании
  contents.on('console-message', function (ev) {
    const [, lvl, msg, line, src] = arguments;
    const level = ev && typeof ev.level === 'string' ? ev.level : ({ 0: 'debug', 1: 'info', 2: 'warning', 3: 'error' })[lvl];
    const message = ev && typeof ev.message === 'string' ? ev.message : msg;
    const source = String((ev && ev.sourceId) || src || '');
    const ln = (ev && ev.lineNumber) || line;
    if (level !== 'error' && level !== 'warning') return;
    const ours = contents.getType() !== 'webview' || /webview-preload/i.test(source) || String(message).startsWith('[liquid]');
    // ошибки самих сайтов — шум, их пишем только как отладочные
    diag.log(ours ? (level === 'error' ? 'error' : 'warn') : 'debug', kind(), `${message}`, `${source.split(/[\\/]/).pop()}:${ln}`);
  });
  contents.on('preload-error', (_ev, p, err) => diag.log('error', 'preload', err, p && p.split(/[\\/]/).pop()));
  contents.on('unresponsive', () => { let u = ''; try { u = contents.getURL(); } catch {} diag.log('warn', kind(), 'Страница зависла и не отвечает', u); });
  contents.on('responsive', () => diag.log('info', kind(), 'Страница снова отвечает'));
  contents.on('did-fail-load', (_ev, code, desc, url, isMain) => { if (isMain && code !== -3) diag.log('warn', 'загрузка', `${desc} (${code})`, url); });
  contents.on('will-attach-webview', (_ev, wp) => {
    wp.preload = WEBVIEW_PRELOAD;
    wp.nodeIntegration = false;
    wp.nodeIntegrationInSubFrames = false;
    wp.contextIsolation = true;
    wp.sandbox = true;
  });
});

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  const host = () => hostOf(contents);
  contents.on('did-navigate', () => { if (adblock) adblock.resetCount(contents.id); });
  if (proxyRules) { try { contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp'); } catch {} }

  // Всплывающие окна разрешаем только сразу после нажатия или клавиши (как блокировщик попапов в Chrome)
  let lastInput = 0, lastPopupToast = 0;
  contents.on('input-event', (_ev, ie) => { if (/^(mouseDown|mouseUp|keyDown|rawKeyDown|char|gestureTap|touchStart|touchEnd)$/.test(ie.type)) lastInput = Date.now(); });
  contents.setWindowOpenHandler(({ url, disposition, features }) => {
    let site = ''; try { site = new URL(contents.getURL()).hostname.replace(/^www\./, ''); } catch {}
    const allowed = (loadSettings().popupAllow || []).includes(site);
    if (!allowed && Date.now() - lastInput > 5000) {
      if (Date.now() - lastPopupToast > 4000) { lastPopupToast = Date.now(); try { host().send('popup:blocked', { site, url }); } catch {} }
      diag.log('info', 'попап', 'Заблокировано окно без нажатия', url);
      return { action: 'deny' };
    }
    // Окна входа (Google / Apple) открываем как настоящие попапы, иначе вход в claude.ai не завершится
    if (/^https:\/\/(accounts\.google\.com|appleid\.apple\.com)\//.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520, height: 720, autoHideMenuBar: true, parent: BrowserWindow.fromWebContents(host()) || win, backgroundColor: '#ffffff',
          webPreferences: { preload: WEBVIEW_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
        },
      };
    }
    // window.open с размерами или «новое окно» — это вход через сервис или оплата: сайт ждёт ответа от этого окна,
    // поэтому открываем настоящее всплывающее окно, связанное с сайтом. Обычные ссылки target=_blank — вкладкой
    if (/^https?:/.test(url) && (disposition === 'new-window' || (features && /width|height|popup/i.test(features)))) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 560, height: 760, autoHideMenuBar: true, parent: BrowserWindow.fromWebContents(host()) || win, backgroundColor: '#ffffff',
          webPreferences: { preload: WEBVIEW_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
        },
      };
    }
    if (/^https?:|^file:|^chrome-extension:/.test(url)) host().send('tab:open', { url, background: false });
    else if (url) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  contents.on('before-input-event', (e, input) => handleShortcut(e, input, host()));

  contents.on('context-menu', (_e, p) => {
    const t = [];
    if (p.linkURL) {
      t.push({ label: 'Открыть рядом (два сайта)', click: () => host().send('tab:split', { url: p.linkURL }) });
      t.push({ label: 'Открыть в инкогнито', click: () => { const w = createWindow({ priv: true }); w.webContents.once('did-finish-load', () => w.webContents.send('tab:open', { url: p.linkURL, replace: true })); } });
      t.push({ label: 'Открыть в новой вкладке', click: () => host().send('tab:open', { url: p.linkURL, background: true }) });
      t.push({ label: 'Копировать ссылку', click: () => clipboard.writeText(p.linkURL) });
      t.push({ type: 'separator' });
    }
    if (p.selectionText) {
      const sel = p.selectionText.trim();
      t.push({ label: 'Копировать', role: 'copy' });
      t.push({ label: `Спросить Claude: «${sel.slice(0, 24)}${sel.length > 24 ? '…' : ''}»`, click: () => host().send('claude:ask', { text: sel }) });
      t.push({ label: 'Искать в интернете', click: () => host().send('tab:search', { q: sel }) });
      t.push({ label: 'Сохранить в заметки', click: () => host().send('note:add', { text: sel.slice(0, 20000), url: contents.getURL(), title: contents.getTitle() }) });
      t.push({ type: 'separator' });
    }
    if (p.isEditable) {
      t.push({ label: 'Вырезать', role: 'cut' }, { label: 'Копировать', role: 'copy' }, { label: 'Вставить', role: 'paste' }, { type: 'separator' });
    }
    if (p.mediaType === 'video') {
      t.push({ label: 'Картинка в картинке', click: () => host().send('shortcut', { key: 'pip' }) });
      t.push({ label: 'Настройки видео (скорость, громкость)', click: () => host().send('shortcut', { key: 'video' }) });
      t.push({ type: 'separator' });
    }
    if (p.mediaType === 'image' && p.srcURL) {
      t.push({ label: 'Открыть картинку в новой вкладке', click: () => host().send('tab:open', { url: p.srcURL, background: true }) });
      t.push({ label: 'Сохранить картинку как…', click: () => contents.downloadURL(p.srcURL) });
      t.push({ type: 'separator' });
    }
    t.push(
      { label: 'Назад', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
      { label: 'Вперёд', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
      { label: 'Обновить', click: () => contents.reload() },
      { type: 'separator' },
      { label: 'Скриншот страницы', click: () => host().send('shortcut', { key: 'shot' }) },
      { label: 'Режим чтения', click: () => host().send('shortcut', { key: 'reader' }) },
      { label: 'Пересказать страницу (Claude)', click: () => host().send('claude:ask', { preset: 'summary' }) },
      { label: 'Просмотр кода элемента', click: () => contents.inspectElement(p.x, p.y) },
    );
    Menu.buildFromTemplate(t).popup({ window: BrowserWindow.fromWebContents(host()) || win });
  });
});

// Авторизация для http-прокси из ключа
app.on('login', (e, _wc, _details, authInfo, cb) => {
  if (authInfo.isProxy && proxyAuth) { e.preventDefault(); cb(proxyAuth.user, proxyAuth.pass); }
});

// ---------- VPN ----------
async function sesText(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await ses.fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    return await r.text();
  } finally { clearTimeout(t); }
}

async function checkIp() {
  try {
    const txt = await sesText('https://1.1.1.1/cdn-cgi/trace'); // 1.1.1.1 всегда идёт через VPN (и в умном режиме)
    const m = Object.fromEntries(txt.trim().split('\n').map((l) => l.split('=')));
    return { ip: m.ip || '', country: m.loc || '' };
  } catch { return null; }
}

function sendVpn() { broadcast('vpn:state', vpnState); }

function syncSmartLists() {
  const s = loadSettings();
  smart.learned = new Set(s.learned || []);
  smart.custom = new Set((s.vpnSites || []).map((x) => SmartVpn.baseDomain(x)).filter(Boolean));
  smart.custom.add('1.1.1.1');
}

// sessions — каким сессиям, close — рвать ли открытые соединения (нужно при смене режима, не нужно, когда
// просто добавился сайт в «умный» список или открылось новое окно — иначе прерываются видео и загрузки)
async function applyProxy({ sessions = allSessions(), close = true } = {}) {
  const mode = loadSettings().vpnMode || 'smart';
  if (iconSes && !sessions.includes(iconSes)) sessions = [...sessions, iconSes]; // значки стартовой — тоже через VPN
  for (const sess of sessions) {
    if (!proxyRules) await sess.setProxy({ mode: 'direct' });
    else if (mode === 'smart') await sess.setProxy({ mode: 'pac_script', pacScript: smart.url() });
    else await sess.setProxy({ proxyRules, proxyBypassRules: '<local>' });
    if (close) await sess.closeAllConnections();
  }
  // при VPN звонки в браузере (WebRTC) не должны выдавать настоящий IP
  for (const wc of webContents.getAllWebContents()) { try { if (wc.getType() === 'webview') wc.setWebRTCIPHandlingPolicy(proxyRules ? 'disable_non_proxied_udp' : 'default'); } catch {} }
}

async function vpnConnect(rawKey) {
  const s = loadSettings();
  const key = rawKey ? rawKey.trim() : dec(s.vpnKey);
  if (!key) throw new Error('Сначала вставь ключ');
  vpnState = { ...vpnState, busy: true }; sendVpn();
  try {
    const cfg = await parseKey(key, (u) => net.fetch(u).then((r) => r.text()));
    proxyAuth = null;
    if (cfg.kind === 'xray') {
      const port = await xray.start(cfg.outbound);
      proxyRules = `socks5://127.0.0.1:${port}`;
      smart.proxy = `SOCKS5 127.0.0.1:${port}; SOCKS 127.0.0.1:${port}`;
    } else {
      xray.stop();
      proxyRules = cfg.rules;
      proxyAuth = cfg.auth;
      const u = new URL(cfg.rules);
      const kw = u.protocol === 'https:' ? 'HTTPS' : u.protocol.startsWith('socks') ? 'SOCKS5' : 'PROXY';
      smart.proxy = `${kw} ${u.host}`;
    }
    syncSmartLists();
    await applyProxy();
    const info = await checkIp();
    if (!info) {
      await vpnDisconnect(true);
      throw new Error('Сервер не отвечает. Проверь ключ или попробуй другой.' + (xray.log ? '\n' + xray.log.trim().split('\n').pop() : ''));
    }
    if (rawKey) { s.vpnKey = enc(key); s.vpnName = cfg.name; saveSettings(s); }
    vpnState = { on: true, name: cfg.name, ip: info.ip, country: info.country, busy: false, mode: loadSettings().vpnMode || 'smart' };
    sendVpn();
    return vpnState;
  } catch (e) {
    vpnState = { ...vpnState, busy: false }; sendVpn();
    diag.log('error', 'vpn', e.message, xray?.log ? 'xray: ' + xray.log.trim().split('\n').slice(-3).join(' / ') : '');
    throw e;
  }
}

async function vpnDisconnect(silent) {
  xray.stop();
  proxyAuth = null;
  proxyRules = '';
  await applyProxy();
  vpnState = { on: false, name: '', ip: '', country: '', busy: false };
  if (!silent) sendVpn();
  return vpnState;
}

// --- чему «умный» VPN может учиться ---
// российские сайты, банки и госуслуги никогда не уводим за границу — они могут перестать пускать
const NEVER_VPN = ['gosuslugi.ru', 'nalog.gov.ru', 'mos.ru', 'sberbank.ru', 'sber.ru', 'tbank.ru', 'tinkoff.ru', 'vtb.ru', 'alfabank.ru', 'gazprombank.ru',
  'raiffeisen.ru', 'pochtabank.ru', 'sovcombank.ru', 'otpbank.ru', 'rshb.ru', 'mts.ru', 'megafon.ru', 'beeline.ru', 'tele2.ru', 'rostelecom.ru', 'yandex.ru',
  'ya.ru', 'vk.com', 'vk.ru', 'mail.ru', 'ok.ru', 'ozon.ru', 'wildberries.ru', 'avito.ru', 'kinopoisk.ru', 'rzd.ru', 'pochta.ru', 'nspk.ru', 'gov.ru', 'max.ru'];
function learnable(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost' || /^[\d.]+$/.test(h) || h.includes(':')) return false;
  if (/\.(ru|su|xn--p1ai|рф|local|lan)$/.test(h)) return false;
  return !NEVER_VPN.some((d) => h === d || h.endsWith('.' + d));
}
let probeSes = null;
function probeSession() {
  if (!probeSes) { probeSes = session.fromPartition('liquid-probe', { cache: false }); probeSes.setProxy({ mode: 'direct' }).catch(() => {}); }
  return probeSes;
}
async function directReachable(url, ms = 6000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try { await probeSession().fetch(url, { method: 'HEAD', signal: ctrl.signal, redirect: 'manual', cache: 'no-store' }); return true; }
  catch { return false; } finally { clearTimeout(t); }
}
// существует ли домен: спрашиваем DNS через HTTPS (у провайдера ответ может быть подделан). Не узнали — считаем, что существует
async function resolves(host) {
  for (const u of [`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`]) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const r = await probeSession().fetch(u, { headers: { accept: 'application/dns-json' }, signal: ctrl.signal, cache: 'no-store' });
      const j = await r.json();
      if (j.Status === 3) return false;           // NXDOMAIN — такого имени нет
      if (j.Status === 0) return true;
    } catch {} finally { clearTimeout(t); }
  }
  return true;
}
async function directWorks() {
  const r = await Promise.all(['https://ya.ru/', 'https://www.google.com/generate_204', 'https://vk.com/'].map((u) => directReachable(u, 5000)));
  return r.some(Boolean);
}

// Сайт не открылся «как при блокировке» → запоминаем его и пускаем через VPN
async function vpnUnblock(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return { ok: false } }
  const s = loadSettings();
  if (s.autoVpn === false) return { ok: false, reason: 'off' };
  if (!s.vpnKey) return { ok: false, reason: 'nokey' };
  const base = SmartVpn.baseDomain(host);
  const mode = s.vpnMode || 'smart';
  if (vpnState.on && (mode === 'all' || smart.matches(host))) return { ok: false, reason: 'already' };
  if (!learnable(host)) return { ok: false, reason: 'local' };
  if (!(await resolves(host))) { diag.log('info', 'vpn', 'Не учу: такого сайта нет (опечатка?)'); return { ok: false, reason: 'nxdomain' }; }
  if (!net.isOnline() || !(await directWorks()) || (await directReachable('https://' + host + '/'))) {
    diag.log('info', 'vpn', 'Не учу: сайт открывается напрямую или нет интернета', host);
    return { ok: false, reason: 'notblocked' };
  }
  if (!(s.learned || []).includes(base)) { s.learned = [...(s.learned || []), base].slice(-300); saveSettings(s); }
  syncSmartLists();
  try {
    if (!vpnState.on) await vpnConnect();
    else await applyProxy({ close: false });
    return { ok: true, host: base };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ---------- Claude ----------
async function claudeStream(sender, { id, model, system, messages }) {
  const key = dec(loadSettings().claudeKey);
  if (!key) { sender.send('claude:error', { id, error: 'Добавь API-ключ Claude в настройках (шестерёнка справа сверху).' }); return; }
  const ctrl = new AbortController();
  claudeJobs.set(id, ctrl);
  try {
    const res = await ses.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 8192, stream: true, system, messages }),
    });
    if (!res.ok) {
      let msg = `Ошибка ${res.status}`;
      try { const j = await res.json(); msg += ': ' + (j.error?.message || JSON.stringify(j)); } catch {}
      if (res.status === 403 && !vpnState.on) msg += '\nПохоже, API недоступен из твоего региона — включи VPN.';
      if (res.status === 401) msg = 'Неверный API-ключ. Проверь его в настройках.';
      sender.send('claude:error', { id, error: msg });
      return;
    }
    const reader = res.body.getReader();
    const td = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += td.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') sender.send('claude:chunk', { id, text: ev.delta.text });
        else if (ev.type === 'error') sender.send('claude:error', { id, error: ev.error?.message || 'Ошибка API' });
      }
    }
    sender.send('claude:done', { id });
  } catch (e) {
    if (e.name === 'AbortError') sender.send('claude:done', { id, aborted: true });
    else sender.send('claude:error', { id, error: 'Нет связи с API: ' + e.message + (vpnState.on ? '' : '\nПопробуй включить VPN.') });
  } finally {
    claudeJobs.delete(id);
  }
}



// ---------- обновления движка ----------
function newer(a, b) {
  const pa = String(a).split('-')[0].split('.').map(Number);
  const pb = String(b).split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}
function findInstaller() {
  // 1) установлено через Liquid-Setup.exe: %LOCALAPPDATA%\Liquid\app\Liquid.exe → ..\Liquid-Setup.exe
  if (app.isPackaged) {
    const setup = path.join(path.dirname(process.execPath), '..', 'Liquid-Setup.exe');
    if (fs.existsSync(setup)) return { kind: 'setup', file: setup };
  }
  // 2) ручная установка через install.bat
  const starts = app.isPackaged ? [path.dirname(process.execPath)] : [__dirname];
  for (const start of starts) {
    let d = start;
    for (let i = 0; i < 4; i++) {
      const f = path.join(d, 'install.bat');
      if (fs.existsSync(f)) return { kind: 'bat', file: f };
      d = path.dirname(d);
    }
  }
  return null;
}
// Новые версии Liquid берём из релизов GitHub (движок Electron закреплён в package.json, сам по себе не обновляется).
// Пока репозиторий приватный, GitHub отвечает 404 — тогда просто молчим.
const RELEASES = 'https://api.github.com/repos/tekeyaa/Liquid-pc/releases/latest';
let pendingSetup = null;
async function checkUpdates() {
  const s = loadSettings();
  if (s.updSnooze && Date.now() < s.updSnooze) return;
  try {
    const r = await net.fetch(RELEASES, { cache: 'no-store', headers: { accept: 'application/vnd.github+json' } });
    if (!r.ok) return;
    const j = await r.json();
    const version = String(j.tag_name || '').replace(/^v/, '');
    const cur = app.getVersion();
    const asset = (j.assets || []).find((a) => /Liquid-Setup\.exe$/i.test(a.name));
    if (version && asset && newer(version, cur) && win && !win.isDestroyed()) {
      pendingSetup = asset.browser_download_url;
      win.webContents.send('update', { latest: version, current: cur, liquid: true, notes: String(j.body || '').slice(0, 600), canRun: true });
    }
  } catch { /* нет сети — проверим позже */ }
}

// ---------- Claude-защита: проверка страниц с паролями / картами ----------
const GUARD_PROMPT = `Ты — модуль защиты браузера. Тебе дают данные о странице, где есть поле пароля или банковской карты. Оцени риск фишинга и мошенничества.
Опасные признаки: домен похож на известный бренд, но им не является (опечатки, лишние слова, дефисы, странные зоны вроде .top .xyz .click), форма отправляет данные на сторонний домен, просят пароль от другого сервиса, коды из SMS, данные карты ради «выигрыша», «возврата», «разблокировки»; срочность и угрозы; крипто-раздачи; бесплатные скины и предметы в обмен на вход через Steam.
Если это официальный сайт известного сервиса или обычный сайт без признаков обмана — safe.
Ответь ТОЛЬКО JSON без пояснений: {"verdict":"safe|caution|danger","reason":"одно короткое предложение по-русски"}`;

async function guardCheck(info) {
  const key = dec(loadSettings().claudeKey);
  if (!key) return { verdict: 'unknown', reason: 'Добавь API-ключ Claude в настройках, чтобы работала проверка сайтов.' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await ses.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-5-5', max_tokens: 200, system: GUARD_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(info).slice(0, 12000) }],
      }),
    });
    if (!res.ok) return { verdict: 'unknown', reason: `Проверка не удалась (ошибка ${res.status}).` };
    const j = await res.json();
    const text = (j.content || []).map((c) => c.text || '').join('');
    const m = text.match(/\{[\s\S]*\}/);
    const r = m ? JSON.parse(m[0]) : null;
    if (!r || !['safe', 'caution', 'danger'].includes(r.verdict)) return { verdict: 'unknown', reason: 'Не удалось разобрать ответ проверки.' };
    return { verdict: r.verdict, reason: String(r.reason || '') };
  } catch (e) {
    return { verdict: 'unknown', reason: 'Нет связи с Claude' + (vpnState.on ? '.' : ' — попробуй включить VPN.') };
  } finally { clearTimeout(t); }
}


// Разовый запрос к Claude API (агент идей и т.п.)
async function claudeOnce({ system, user, model = 'claude-sonnet-5-5', maxTokens = 2000 }) {
  const key = dec(loadSettings().claudeKey);
  if (!key) return { ok: false, error: 'nokey' };
  try {
    const res = await ses.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    const j = await res.json();
    if (!res.ok) return { ok: false, error: j.error?.message || `Ошибка ${res.status}` };
    return { ok: true, text: (j.content || []).map((c) => c.text || '').join('') };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---------- IPC ----------
function registerIpc() {
  const bw = (e) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.on('win:min', (e) => bw(e)?.minimize());
  ipcMain.on('win:max', (e) => { const w = bw(e); if (w) w.isMaximized() ? w.unmaximize() : w.maximize(); });
  ipcMain.on('win:close', (e) => bw(e)?.close());
  ipcMain.on('win:fullscreen', (e, on) => bw(e)?.setFullScreen(!!on));

  ipcMain.handle('settings:get', () => publicSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    const s = loadSettings();
    if ('claudeKey' in patch) s.claudeKey = patch.claudeKey ? enc(patch.claudeKey.trim()) : '';
    if ('model' in patch) s.model = patch.model;
    if ('search' in patch) s.search = patch.search;
    if ('vpnAuto' in patch) s.vpnAuto = !!patch.vpnAuto;
    if ('guard' in patch) s.guard = !!patch.guard;
    if ('fps' in patch) s.fps = patch.fps === '60' ? '60' : 'auto';
    if ('claudeMode' in patch) s.claudeMode = patch.claudeMode === 'api' ? 'api' : 'web';
    if ('vpnMode' in patch) s.vpnMode = patch.vpnMode === 'all' ? 'all' : 'smart';
    if ('autoVpn' in patch) s.autoVpn = !!patch.autoVpn;
    if ('vpnSites' in patch) s.vpnSites = String(patch.vpnSites).split(/[\s,]+/).map((x) => x.trim()).filter(Boolean).slice(0, 500);
    if (patch.forgetLearned) s.learned = [];
    if (patch.learnedRemove) s.learned = (s.learned || []).filter((x) => x !== patch.learnedRemove);
    if ('memSaver' in patch) s.memSaver = !!patch.memSaver;
    if ('sleepAfter' in patch) s.sleepAfter = Number(patch.sleepAfter) || 0;
    if ('restore' in patch) s.restore = !!patch.restore;
    if ('dlAsk' in patch) s.dlAsk = !!patch.dlAsk;
    if ('gameMode' in patch) { s.gameMode = !!patch.gameMode; if (game) { game.enabled = s.gameMode; if (!s.gameMode && game.forced === null) game.set(false); } }
    if ('gameKeepAudio' in patch) s.gameKeepAudio = !!patch.gameKeepAudio;
    if ('superRes' in patch) s.superRes = ['off', 'mid', 'max'].includes(patch.superRes) ? patch.superRes : 'off';
    if ('srHdr' in patch) s.srHdr = !!patch.srHdr;
    if ('vidBar' in patch) s.vidBar = !!patch.vidBar;
    if ('adblock' in patch) { s.adblock = !!patch.adblock; if (adblock) adblock.enabled = s.adblock; }
    if ('adAllowToggle' in patch) {
      const h = String(patch.adAllowToggle);
      const set = new Set(s.adAllow || []);
      set.has(h) ? set.delete(h) : set.add(h);
      s.adAllow = [...set];
      if (adblock) adblock.allow = set;
    }
    if (patch.forgetVpn) { s.vpnKey = ''; s.vpnName = ''; }
    saveSettings(s);
    if ('vpnMode' in patch || 'vpnSites' in patch || patch.forgetLearned || patch.learnedRemove) { syncSmartLists(); if (vpnState.on) applyProxy({ close: 'vpnMode' in patch }).then(sendVpn); }
    return publicSettings();
  });
  // «Разрешения сайтов»: камера, микрофон, уведомления, буфер, всплывающие окна
  ipcMain.handle('perms:list', () => {
    const s = loadSettings();
    return [...Object.entries(s.perms || {}).map(([k, v]) => ({ key: k, site: k.split('|')[0].replace(/^https?:\/\//, ''), what: k.split('|')[1], allow: v })),
      ...(s.popupAllow || []).map((h) => ({ key: 'popup|' + h, site: h, what: 'popup', allow: true }))];
  });
  ipcMain.handle('perms:remove', (_e, key) => {
    const s = loadSettings();
    if (key === '*') { s.perms = {}; s.popupAllow = []; permDecided?.clear(); }
    else if (String(key).startsWith('popup|')) s.popupAllow = (s.popupAllow || []).filter((h) => h !== key.slice(6));
    else { const p = { ...(s.perms || {}) }; delete p[key]; s.perms = p; permDecided?.delete(key); }
    saveSettings(s);
    return true;
  });
  ipcMain.handle('popup:allow', (_e, site) => {
    if (!site) return false;
    const s = loadSettings(); s.popupAllow = [...new Set([...(s.popupAllow || []), String(site)])].slice(-200); saveSettings(s); return true;
  });
  // значки для стартовой: качаем сами без куки, кэш 14 дней — сайты не видят каждое открытие стартовой
  ipcMain.handle('newtab:icons', async (e, hosts) => {
    let u = ''; try { u = e.sender.getURL(); } catch {}
    if (!/^file:.*\/newtab\.html(#|$)/.test(u) || !Array.isArray(hosts)) return {};
    const dir = path.join(app.getPath('userData'), 'icons'); fs.mkdirSync(dir, { recursive: true });
    if (!iconSes) { iconSes = session.fromPartition('liquid-icons', { cache: false }); if (proxyRules) await applyProxy({ sessions: [iconSes], close: false }); }
    const out = {};
    await Promise.all(hosts.slice(0, 80).map(String).map((h) => h.toLowerCase()).filter((h) => /^[a-z0-9.-]{3,100}$/.test(h) && h.includes('.')).map(async (h) => {
      const f = path.join(dir, h + '.png'), miss = path.join(dir, h + '.none');
      try { if (Date.now() - fs.statSync(f).mtimeMs < 14 * 864e5) { out[h] = 'data:image/png;base64,' + fs.readFileSync(f).toString('base64'); return; } } catch {}
      try { if (Date.now() - fs.statSync(miss).mtimeMs < 864e5) { out[h] = ''; return; } } catch {}
      for (const p of ['/apple-touch-icon.png', '/favicon.ico']) {
        try {
          const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
          const r = await iconSes.fetch('https://' + h + p, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' }).finally(() => clearTimeout(t));
          if (!r.ok) continue;
          const img = nativeImage.createFromBuffer(Buffer.from(await r.arrayBuffer()));
          if (img.isEmpty() || img.getSize().width < 16) continue;
          const png = (img.getSize().width > 128 ? img.resize({ width: 128 }) : img).toPNG();
          fs.writeFileSync(f, png); out[h] = 'data:image/png;base64,' + png.toString('base64'); return;
        } catch {}
      }
      try { fs.writeFileSync(miss, ''); } catch {}
      out[h] = '';
    }));
    return out;
  });
  ipcMain.handle('newtab:tiles', (e, tiles) => {
    let u = ''; try { u = e.sender.getURL(); } catch {}
    if (!/^file:.*\/newtab\.html(#|$)/.test(u)) return null;
    const s = loadSettings();
    if (Array.isArray(tiles) && e.sender.session === ses) { // из инкогнито избранное не меняем
      s.tiles = tiles.slice(0, 48).map((t) => ({ name: String(t.name || '').slice(0, 40), url: String(t.url || '').slice(0, 500), ...(t.ic ? { ic: String(t.ic).slice(0, 4) } : {}), ...(t.color ? { color: String(t.color).slice(0, 20) } : {}) })).filter((t) => /^https?:/.test(t.url));
      saveSettings(s);
    }
    return Array.isArray(s.tiles) ? s.tiles : null;
  });
  ipcMain.handle('data:clear', async () => {
    await ses.clearStorageData();
    await ses.clearCache();
    return true;
  });
  ipcMain.handle('cache:trim', async () => { for (const s2 of allSessions()) await s2.clearCache(); return true; });

  ipcMain.handle('vpn:connect', async (_e, key) => {
    try { return { ok: true, state: await vpnConnect(key) }; } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('vpn:disconnect', async () => ({ ok: true, state: await vpnDisconnect() }));
  ipcMain.handle('vpn:state', () => vpnState);
  // окно ждёт автозапуска VPN перед тем, как открыть вкладки (не дольше 9 секунд)
  ipcMain.handle('vpn:startup', () => Promise.race([vpnStartup || Promise.resolve(), new Promise((r) => setTimeout(r, 20000))]).then(() => vpnState));
  ipcMain.handle('vpn:unblock', (_e, url) => vpnUnblock(url));
  ipcMain.handle('vpn:routed', (_e, url) => { try { return vpnState.on && ((loadSettings().vpnMode || 'smart') === 'all' || smart.matches(new URL(url).hostname)); } catch { return false; } });

  // окна
  ipcMain.on('win:incognito', () => createWindow({ priv: true }));

  // перевод страниц (вызывается из preload сайтов)
  ipcMain.handle('translate:batch', (e, texts) => {
    if (!Array.isArray(texts) || e.sender.getType() !== 'webview') return null;
    const sess = e.sender.session || ses;
    return translateBatch((u, o) => sess.fetch(u, o), texts.slice(0, 200).map((t) => String(t).slice(0, 2000)), 'ru', (lvl, m) => diag.log(lvl, 'перевод', m));
  });

  // блокировщик рекламы
  ipcMain.handle('adblock:count', (_e, wcId) => adblock?.counts.get(wcId) || 0);

  // загрузки
  ipcMain.on('dl:act', (_e, { id, act }) => {
    const d = downloads.get(id);
    if (!d) return;
    const it = d.item;
    try {
      if (act === 'pause') it.pause();
      else if (act === 'resume') it.canResume() && it.resume();
      else if (act === 'cancel') it.cancel();
      else if (act === 'open') shell.openPath(it.getSavePath());
      else if (act === 'show') shell.showItemInFolder(it.getSavePath());
    } catch {}
  });
  ipcMain.on('dl:show-path', (_e, p) => { if (p) shell.showItemInFolder(p); });
  ipcMain.on('dl:open-path', (_e, p) => { if (p) shell.openPath(p); });
  ipcMain.on('dl:folder', () => shell.openPath(app.getPath('downloads')));

  // расширения
  ipcMain.handle('ext:list', () => ({ installed: exts.view(), popular: POPULAR }));
  ipcMain.handle('ext:install', async (_e, input) => {
    try {
      const e = await exts.install(input, (u) => ses.fetch(u), [ses], process.versions.chrome);
      return { ok: true, ext: e };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('ext:toggle', async (_e, { id, on }) => { await exts.setEnabled(id, on, [ses]); return exts.view(); });
  ipcMain.handle('ext:remove', (_e, id) => { exts.remove(id, [ses]); return exts.view(); });
  ipcMain.on('ext:open', (e, { id, page }) => {
    const x = exts.list.find((v) => v.id === id);
    if (!x || !x.realId || !page) return;
    const parent = BrowserWindow.fromWebContents(e.sender) || win;
    const w = new BrowserWindow({
      width: 420, height: 600, parent, autoHideMenuBar: true, backgroundColor: '#1b1a24', title: x.name,
      webPreferences: { session: ses, contextIsolation: true, sandbox: true },
    });
    w.loadURL(`chrome-extension://${x.realId}/${page.replace(/^\//, '')}`);
  });

  // скриншоты: вся страница через DevTools-протокол, кусками до 4000px, склейка — в интерфейсе
  ipcMain.handle('shot:full', async (_e, wcId) => {
    const wc = webContents.fromId(wcId);
    if (!wc) return { ok: false, error: 'Вкладка не найдена' };
    const dbg = wc.debugger;
    let attached = false;
    try {
      if (!dbg.isAttached()) { dbg.attach('1.3'); attached = true; }
      const m = await dbg.sendCommand('Page.getLayoutMetrics');
      const size = m.cssContentSize || m.contentSize;
      const width = Math.min(Math.ceil(size.width), 4000);
      const height = Math.min(Math.ceil(size.height), 30000);
      const tiles = [];
      for (let y = 0; y < height; y += 4000) {
        const h = Math.min(4000, height - y);
        const r = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y, width, height: h, scale: 1 } });
        tiles.push({ y, h, data: r.data });
      }
      return { ok: true, width, height, tiles, cut: Math.ceil(size.height) > height };
    } catch (err) { return { ok: false, error: err.message }; }
    finally { if (attached) { try { dbg.detach(); } catch {} } }
  });
  ipcMain.handle('shot:visible', async (_e, { wcId, rect }) => {
    const wc = webContents.fromId(wcId);
    if (!wc) return null;
    const img = await wc.capturePage(rect || undefined);
    return img.toDataURL();
  });
  ipcMain.handle('file:save', async (_e, { name, data, kind, copy }) => {
    const dir = path.join(app.getPath(kind === 'note' ? 'downloads' : 'pictures'), kind === 'note' ? '' : 'Liquid');
    fs.mkdirSync(dir, { recursive: true });
    const file = uniquePath(dir, name);
    const buf = typeof data === 'string' && data.startsWith('data:') ? Buffer.from(data.split(',')[1], 'base64') : Buffer.from(data);
    fs.writeFileSync(file, buf);
    if (copy) { try { clipboard.writeImage(nativeImage.createFromBuffer(buf)); } catch {} }
    return file;
  });

  // журнал ошибок
  const sys = () => sysInfo(app, {
    'Видеокарта': gpuLine || '?',
    'Аппаратное ускорение': Object.entries(app.getGPUFeatureStatus()).filter(([, v]) => !String(v).startsWith('enabled')).map(([k, v]) => `${k}=${v}`).join(', ') || 'всё включено',
    'Мониторы': screen.getAllDisplays().map((d) => `${d.size.width}×${d.size.height}@${Math.round(d.displayFrequency || 60)}Гц ×${d.scaleFactor}`).join(', '),
    'VPN': vpnState.on ? `включён (${loadSettings().vpnMode || 'smart'})` : 'выключен',
    'Вкладок (webview)': webContents.getAllWebContents().filter((w) => w.getType() === 'webview').length,
    'Расширения': (exts?.list || []).filter((x) => x.enabled !== false).map((x) => x.name).join(', ') || 'нет',
  });
  ipcMain.on('diag:log', (_e, { level, source, message, extra }) => diag.log(level || 'error', source || 'интерфейс', message, extra));
  ipcMain.handle('diag:list', (_e, min) => ({ items: diag.list(min || 'warn', 400), unseen: diag.unseen }));
  ipcMain.handle('diag:report', () => diag.report(sys()));
  ipcMain.handle('diag:save', async () => {
    const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
    const f = uniquePath(app.getPath('downloads'), `Liquid-отчёт ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}-${p2(d.getMinutes())}.txt`);
    let full = diag.report(sys(), 400) + '\n\n## Полный журнал за сегодня\n';
    try { full += fs.readFileSync(diag.file(), 'utf8').slice(-400_000); } catch {}
    fs.writeFileSync(f, full);
    return f;
  });
  ipcMain.on('diag:clear', () => diag.clear());
  ipcMain.on('diag:seen', () => diag.seen());
  ipcMain.on('diag:folder', () => shell.openPath(diag.dir));
  let diagT = 0;
  diag.listeners.add((e, unseen) => {
    if (e && e.level !== 'error' && e.level !== 'crash') return;
    clearTimeout(diagT);
    diagT = setTimeout(() => broadcast('diag:new', { unseen, last: e ? { level: e.level, source: e.source, msg: e.msg.slice(0, 160) } : null }), 300);
  });

  // игровой режим
  ipcMain.handle('game:state', () => ({ on: !!game?.on, game: game?.game || '', forced: game?.forced ?? null, supported: process.platform === 'win32' }));
  ipcMain.on('game:force', (_e, on) => game?.force(on));

  // память
  ipcMain.handle('mem:info', () => {
    const byPid = new Map(app.getAppMetrics().map((m) => [m.pid, m.memory?.workingSetSize || 0]));
    let total = 0;
    for (const v of byPid.values()) total += v;
    const tabs = webContents.getAllWebContents().filter((w) => w.getType() === 'webview').map((w) => {
      let pid = 0; try { pid = w.getOSProcessId(); } catch {}
      return { wcId: w.id, mb: Math.round((byPid.get(pid) || 0) / 1024) };
    });
    return { totalMb: Math.round(total / 1024), tabs };
  });

  ipcMain.on('claude:send', (e, payload) => claudeStream(e.sender, payload));
  ipcMain.on('claude:abort', (_e, id) => claudeJobs.get(id)?.abort());
  ipcMain.handle('claude:check', (_e, info) => guardCheck(info));
  ipcMain.handle('display:info', (e) => {
    const w0 = BrowserWindow.fromWebContents(e.sender) || win;
    const d = w0 ? screen.getDisplayMatching(w0.getBounds()) : screen.getPrimaryDisplay();
    const all = screen.getAllDisplays().map((x) => Math.round(x.displayFrequency || 60));
    return { hz: Math.round(d.displayFrequency || 60), all, primary: Math.round(screen.getPrimaryDisplay().displayFrequency || 60) };
  });
  ipcMain.on('app:relaunch', () => { app.relaunch(); app.exit(0); });
  ipcMain.handle('claude:once', (_e, req) => claudeOnce(req));
  ipcMain.on('clipboard:write', (_e, t) => clipboard.writeText(String(t || '')));
  ipcMain.on('update:later', () => { const s = loadSettings(); s.updSnooze = Date.now() + 3 * 864e5; saveSettings(s); });
  ipcMain.on('update:run', async () => {
    if (pendingSetup) {
      // скачиваем новый установщик и запускаем его в режиме обновления
      try {
        const r = await net.fetch(pendingSetup);
        if (!r.ok) throw new Error('GitHub ответил ' + r.status);
        const f = path.join(app.getPath('temp'), 'Liquid-Setup.exe');
        fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
        spawn(f, ['--update'], { cwd: path.dirname(f), detached: true, stdio: 'ignore' }).unref();
        setTimeout(() => app.quit(), 300);
      } catch (e) { broadcast('toast', { text: 'Не удалось скачать обновление: ' + e.message, error: true }); }
      return;
    }
    const inst = findInstaller();
    if (!inst) return;
    if (inst.kind === 'setup') spawn(inst.file, ['--update'], { cwd: path.dirname(inst.file), detached: true, stdio: 'ignore' }).unref();
    else spawn('cmd.exe', ['/c', 'start', '', inst.file], { cwd: path.dirname(inst.file), detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 300);
  });

  ipcMain.on('webview:devtools', (_e, wcId) => {
    const { webContents } = require('electron');
    const wc = webContents.fromId(wcId);
    if (wc) wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: 'detach' });
  });
}


// ---------- сессии: защита, реклама, разрешения, загрузки ----------
const DANGER_EXT = /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|js|jse|wsf|hta|jar|lnk|reg|dll|apk)$/i;
function uniquePath(dir, name) {
  name = name.replace(/[\\/:*?"<>|]+/g, '_') || 'download';
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p) || [...downloads.values()].some((d) => d.path === p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}
function onDownload(item, wc) {
  const id = ++dlSeq;
  const host = hostOf(wc) || win?.webContents;
  const ask = loadSettings().dlAsk;
  let savePath = '';
  if (!ask) { savePath = uniquePath(app.getPath('downloads'), item.getFilename()); item.setSavePath(savePath); }
  else item.setSaveDialogOptions({ title: 'Сохранить файл', defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
  const d = { item, host, path: savePath, last: 0, lastBytes: 0, speed: 0 };
  downloads.set(id, d);
  const send = (extra = {}) => {
    if (!host || host.isDestroyed()) return;
    const p = item.getSavePath() || d.path;
    host.send('dl:update', {
      id, name: path.basename(p || item.getFilename()), path: p, url: item.getURL(),
      received: item.getReceivedBytes(), total: item.getTotalBytes(), state: item.getState(),
      paused: item.isPaused(), speed: d.speed, danger: DANGER_EXT.test(item.getFilename()), ...extra,
    });
  };
  send({ started: true });
  item.on('updated', () => {
    const now = Date.now();
    if (now - d.last > 400) {
      const bytes = item.getReceivedBytes();
      if (d.last) d.speed = Math.max(0, (bytes - d.lastBytes) / ((now - d.last) / 1000));
      d.last = now; d.lastBytes = bytes;
      send();
    }
  });
  item.once('done', (_e, state) => { d.speed = 0; send({ state }); setTimeout(() => downloads.delete(id), 60e3); });
}

function setupSession(sess, priv) {
  if (!permDecided) permDecided = new Map(Object.entries(loadSettings().perms || {}));
  hardenSession(sess);
  if (adblock) adblock.addSession(sess);
  if (!priv) {} // расширения грузятся отдельно, только в обычном режиме
  // Безопасные разрешения — сразу, опасные (камера, микрофон, геолокация, уведомления, чтение буфера) — только с вопросом
  const SAFE = ['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'mediaKeySystem'];
  const ASK = { media: 'камеру/микрофон', geolocation: 'твоё местоположение', notifications: 'показ уведомлений', 'clipboard-read': 'чтение буфера обмена' };
  const decided = priv ? new Map() : permDecided; // origin|perm -> true/false (в обычном режиме — общие и сохранённые)
  sess.setPermissionRequestHandler(async (wc, perm, cb, details) => {
    if (SAFE.includes(perm)) return cb(true);
    if (!ASK[perm]) return cb(false);
    let origin = '';
    try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch {}
    const key = origin + '|' + perm;
    if (decided.has(key)) return cb(decided.get(key));
    const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(hostOf(wc)) || win, {
      type: 'question', buttons: ['Разрешить', 'Запретить'], defaultId: 1, cancelId: 1,
      title: 'Запрос доступа', message: `${origin || 'Сайт'} просит ${ASK[perm]}`,
      detail: 'Разрешай только сайтам, которым доверяешь.',
    });
    decided.set(key, response === 0);
    if (!priv) { const s = loadSettings(); s.perms = { ...(s.perms || {}), [key]: response === 0 }; saveSettings(s); }
    cb(response === 0);
  });
  sess.setPermissionCheckHandler((wc, perm, origin) => {
    if (SAFE.includes(perm)) return true;
    let o = origin || '';
    try { o = new URL(origin || wc?.getURL() || '').origin; } catch {}
    return decided.get(o + '|' + perm) === true;
  });
  sess.on('will-download', (_e, item, wc) => onDownload(item, wc));

  if (proxyRules) applyProxy({ sessions: [sess], close: false });
}

// ---------- старт ----------
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  ses = session.fromPartition(PARTITION);
  hardenSession(session.defaultSession);
  await smart.start().catch(() => {});
  syncSmartLists();
  adblock = new AdBlock(app.getPath('userData'));
  const st0 = loadSettings();
  adblock.enabled = st0.adblock !== false;
  adblock.allow = new Set(st0.adAllow || []);
  adblock.onCount = (id, n) => { const wc = webContents.fromId(id); const h = hostOf(wc); if (h && !h.isDestroyed()) h.send('adblock:count', { wcId: id, n }); };
  setupSession(ses, false);
  adblock.init((url, opts) => ses.fetch(url, opts)).catch(() => {});
  const binDir = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, 'bin');
  xray = new Xray(binDir, app.getPath('userData'));
  // xray неожиданно завершился: снимаем прокси, иначе ни один сайт не откроется
  xray.onExit = (code) => {
    if (!vpnState.on) return;
    diag.log('error', 'vpn', `xray остановился (код ${code})`, xray.log ? xray.log.trim().split('\n').slice(-3).join(' / ') : '');
    vpnDisconnect().then(() => broadcast('toast', { text: 'VPN отключился: xray остановился. Сайты пока открываются напрямую — включи VPN заново.', error: true }));
  };

  exts = new Extensions(app.getPath('userData'));
  await Promise.race([exts.loadAll([ses]), new Promise((r) => setTimeout(r, 2000))]).catch(() => {});

  app.getGPUInfo('basic').then((g) => {
    const dev = (g.gpuDevice || []).find((x) => x.active) || (g.gpuDevice || [])[0];
    gpuLine = dev ? `${dev.vendorId?.toString(16)}:${dev.deviceId?.toString(16)} драйвер ${dev.driverVersion || '?'}` : '?';
  }).catch(() => {});
  registerIpc();
  createWindow();
  // игровой режим
  game = new GameMode({
    isOwnPid: (pid) => app.getAppMetrics().some((m) => m.pid === pid),
    onChange: ({ on, game: name }) => {
      for (const m of app.getAppMetrics()) {
        try { os.setPriority(m.pid, on ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL); } catch {}
      }
      broadcast('game:state', { on, game: name, keepAudio: loadSettings().gameKeepAudio !== false });
    },
  });
  game.enabled = loadSettings().gameMode !== false;
  setTimeout(() => game.start(), 6000);
  setTimeout(checkUpdates, 8000);
  setInterval(checkUpdates, 6 * 3600e3);

  const s = loadSettings();
  if (s.vpnAuto && s.vpnKey) {
    vpnStartup = vpnConnect().catch((e) => { win?.webContents.once('did-finish-load', () => broadcast('toast', { text: 'VPN: ' + e.message, error: true })); });
  }
});

app.on('before-quit', () => { if (xray) xray.stop(); game?.stop(); });
app.on('window-all-closed', () => { if (xray) xray.stop(); app.quit(); });

// Одна копия приложения
if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); } else createWindow(); });
