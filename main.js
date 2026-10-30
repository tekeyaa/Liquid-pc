const { app, BrowserWindow, ipcMain, session, safeStorage, Menu, clipboard, shell, net, dialog, screen, webContents, Notification, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { parseKey, Xray, DPI_CONFIG } = require('./vpn');
const { spawn } = require('child_process');
const { AdBlock } = require('./main/adblock');
const { SmartVpn, DPI_SITES } = require('./main/smartvpn');
const { Extensions, POPULAR } = require('./main/extensions');
const { translateBatch } = require('./main/translate');
const { GameMode } = require('./main/gamemode');
const { WatchRoom } = require('./main/watch');
const { Diag, sysInfo } = require('./main/diag');
const os = require('os');
let game = null;

// Автотесты (tests/): отдельная папка данных, чтобы тест не трогал настоящие настройки, вкладки и входы,
// и программная отрисовка WebGL — у серверов GitHub нет видеокарты. Обычный запуск это не затрагивает.
const TEST = !!process.env.LIQUID_TEST;
if (process.env.LIQUID_USER_DATA) app.setPath('userData', process.env.LIQUID_USER_DATA);
if (TEST) app.commandLine.appendSwitch('enable-unsafe-swiftshader');

const PARTITION = 'persist:liquid';
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
app.userAgentFallback = UA;
// Код приложения для Windows: без него (и без такого же кода в ярлыке «Пуска») Windows прячет уведомления
const AUMID = 'app.liquid.browser';
if (process.platform === 'win32') app.setAppUserModelId(AUMID);
function fixShortcuts() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const target = process.execPath;
  const links = [
    [path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Liquid.lnk'), true],  // «Пуск» — нужен всегда
    [path.join(app.getPath('desktop'), 'Liquid.lnk'), false],                                                   // рабочий стол — только если уже есть
  ];
  for (const [lnk, must] of links) {
    try {
      let cur = null; try { cur = shell.readShortcutLink(lnk); } catch {}
      if (!cur && !must) continue;
      if (cur && cur.appUserModelId === AUMID && path.resolve(cur.target || '') === path.resolve(target)) continue;
      const ico = path.join(path.dirname(path.dirname(target)), 'icon.ico');
      shell.writeShortcutLink(lnk, cur ? 'replace' : 'create', {
        target, cwd: path.dirname(target), appUserModelId: AUMID, description: 'Liquid browser',
        ...(fs.existsSync(ico) ? { icon: ico, iconIndex: 0 } : {}),
      });
    } catch (e) { try { diag.log('warn', 'ярлык', e.message); } catch {} }
  }
}

// Google не пускает во «встроенные» браузеры (Electron), а Firefox пускает.
// Поэтому только на страницах входа Google представляемся свежим Firefox.
const FF_VER = 128 + Math.floor((Date.now() - Date.UTC(2024, 6, 9)) / (28 * 864e5)) - 1; // Firefox выходит раз в 4 недели
const FF_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${FF_VER}.0) Gecko/20100101 Firefox/${FF_VER}.0`;
const AUTH_HOSTS = /^https:\/\/(accounts\.google\.com|accounts\.youtube\.com|myaccount\.google\.com)\//;
const WEBVIEW_PRELOAD = path.join(__dirname, 'webview-preload.js');
const USER_INPUT = new Set(['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'char', 'gestureTap', 'touchStart', 'touchEnd']);
const POPUP_INPUT = new Set(['mouseDown', 'keyDown', 'rawKeyDown', 'char', 'gestureTap']);

// Адрес страницы в каждой вкладке. Обработчики сетевых запросов спрашивали его у фрейма на КАЖДЫЙ запрос
// (сотни на одну страницу), а это вызов в движок; теперь — поиск в таблице.
const topUrls = new Map(); // webContentsId -> адрес главной страницы
const GOOGLEISH = /google|gstatic|youtube|ggpht/i;
function topUrlOf(d, exact) {
  const u = exact ? undefined : topUrls.get(d.webContentsId);
  if (u !== undefined) return u;
  try { return d.frame?.top?.url || ''; } catch { return ''; }
}

// Подмена на Firefox нужна только при входе в Google: страницы входа и их файлы живут на этих доменах.
// Раньше обработчик стоял на ВСЕХ запросах всех сайтов, и каждый запрос ждал основной процесс браузера.
// Остальным сайтам правильный User-Agent и так ставит setUserAgent.
const AUTH_FILTER = { urls: ['*://*.google.com/*', '*://*.gstatic.com/*', '*://*.googleapis.com/*', '*://accounts.youtube.com/*', '*://*.googleusercontent.com/*'] };
function hardenSession(sess) {
  sess.setUserAgent(UA);
  sess.webRequest.onBeforeSendHeaders(AUTH_FILTER, (d, cb) => {
    const h = d.requestHeaders;
    // для запросов к Google — всегда точный адрес из фрейма, как раньше: от этого зависит вход в аккаунт
    const topUrl = topUrlOf(d, GOOGLEISH.test(d.url));
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
// список включаемых функций Chromium задаётся одним вызовом: второй вызов затёр бы первый
app.commandLine.appendSwitch('enable-features', ['CanvasOopRasterization', ...(bootSettings.memSaver === true ? [] : ['BackForwardCache'])].join(','));
// ---------- журнал ошибок ----------
const diag = new Diag(app.getPath('userData'));
let gpuLine = '';
// сообщения блокировщика о скачивании списков — в журнал как обычные записи
{ const orig = console.info.bind(console); console.info = (...a) => { orig(...a); if (typeof a[0] === 'string' && a[0].startsWith('[adblock]')) diag.log('info', 'блокировщик', a.join(' ').slice(10)); }; }
for (const lvl of ['warn', 'error']) {
  const orig = console[lvl].bind(console);
  console[lvl] = (...a) => {
    orig(...a);
    const text = a.map((x) => (x && x.stack) || (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    // Electron сам пишет «Error occurred in handler for GUEST_VIEW_MANAGER_CALL … (-3)», когда загрузку вкладки прервали
    // переходом на другую страницу, — это обычное дело, а не ошибка
    diag.log(/GUEST_VIEW_MANAGER_CALL[\s\S]*\(-3\)/.test(text) ? 'debug' : lvl, 'main', text);
  };
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
  // «Script failed to execute» — скрипт блокировщика рекламы, упавший на странице сайта; «Render frame was disposed» —
  // вкладку или фрейм закрыли, пока в нём выполнялся скрипт (блокировщика или проверки). Браузеру это не вредит
  const m = String((e && e.message) || e);
  diag.log(/Script failed to execute|Render frame was disposed/.test(m) ? 'debug' : 'error', 'main', e);
});
app.on('render-process-gone', (_e, wc, d) => {
  let url = ''; try { url = wc.getURL(); if (ses && wc.session && wc.session !== ses) url = '(инкогнито — адрес не записан)'; } catch {}
  diag.log(d.reason === 'clean-exit' ? 'info' : 'crash', wc.getType() === 'webview' ? 'вкладка' : 'интерфейс', `Процесс упал: ${d.reason} (код ${d.exitCode})`, url);
});
app.on('child-process-gone', (_e, d) => {
  if (d.reason !== 'clean-exit' && d.reason !== 'killed') diag.log('crash', d.type, `Процесс ${d.type}${d.name ? ' ' + d.name : ''} упал: ${d.reason} (код ${d.exitCode})`);
});
// вторая копия (ярлык нажали, когда Liquid уже открыт) сразу отдаёт окно первой и не пишет в журнал «Запуск»
const firstInstance = app.requestSingleInstanceLock();
if (firstInstance) diag.log('info', 'main', `Запуск Liquid ${app.getVersion()} (Electron ${process.versions.electron})`);

// «Назад» и «Вперёд» мгновенно, как в Chrome: прошлая страница остаётся в памяти и не грузится заново.
// Раньше «экономия памяти» (включённая сразу) это отключала. Теперь отключает, только если её включить вручную.
// (включение — в общем списке функций выше)
if (bootSettings.memSaver === true) app.commandLine.appendSwitch('disable-features', 'BackForwardCache');
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
const downloads = new Map(); // id -> { item, host }
let dlSeq = 0;
let xray = null;
let dpiXray = null;       // обход замедления без VPN (Twitch, YouTube, Discord)
let vpnStartup = null;
let bootReady = Promise.resolve();
let permDecided = null;  // решения о доступе для сайтов (обычный режим), загружаются при старте
let iconSes = null;      // сессия без куки для значков и подсказок поиска
let vpnState = { on: false, name: '', country: '', ip: '', busy: false };
let proxyAuth = null;
const claudeJobs = new Map();

// ---------- настройки ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
// Настройки держим в памяти: раньше файл читался с диска при каждом переходе по ссылке, подсказке поиска,
// открытии окна — и всё это время основной процесс браузера стоял. Пишет файл только сам браузер.
// Наружу отдаём копию: код меняет полученный объект и сохраняет его — как и раньше с прочитанным из файла.
let settingsMem = null;
function loadSettings() {
  if (!settingsMem) { try { settingsMem = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { settingsMem = {}; } }
  return structuredClone(settingsMem);
}
function saveSettings(s) { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); settingsMem = structuredClone(s); }
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
    memSaver: s.memSaver === true, sleepAfter: s.sleepAfter ?? 20, restore: s.restore !== false, adblock: s.adblock !== false,
    adAllow: s.adAllow || [], dlAsk: !!s.dlAsk, gameMode: s.gameMode !== false, gameKeepAudio: s.gameKeepAudio !== false,
    superRes: ['off', 'mid', 'max'].includes(s.superRes) ? s.superRes : 'off', srHdr: !!s.srHdr, vidBar: s.vidBar !== false,
    antiDpi: s.antiDpi !== false, antiDpiOn: !!smart.dpi, dns: dnsMode(s),
    version: app.getVersion(), electron: process.versions.electron,
  };
}

// ---------- безопасный DNS (DNS по HTTPS) ----------
// Адреса сайтов спрашиваем у DNS по зашифрованному каналу: провайдер не видит и не подменяет ответы.
// Режим «automatic»: не ответил безопасный DNS — браузер тихо берёт обычный, поэтому сайты не пропадут.
const DNS = {
  auto: ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query', 'https://dns.adguard-dns.com/dns-query'],
  cloudflare: ['https://cloudflare-dns.com/dns-query'],
  google: ['https://dns.google/dns-query'],
  adguard: ['https://dns.adguard-dns.com/dns-query'],
  yandex: ['https://common.dot.dns.yandex.net/dns-query'],
};
const dnsMode = (s) => (DNS[s.dns] || s.dns === 'off' ? s.dns : 'auto');
function applyDns() {
  const m = dnsMode(loadSettings());
  try {
    if (m === 'off') app.configureHostResolver({ secureDnsMode: 'off' });
    else app.configureHostResolver({ secureDnsMode: 'automatic', secureDnsServers: DNS[m] });
  } catch (e) { diag.log('warn', 'dns', 'Безопасный DNS не включился: ' + e.message); }
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
  // боковые кнопки мыши в Windows приходят ещё и командой окна — так они работают и над видео в фреймах
  w.on('app-command', (_e, cmd) => { if (cmd === 'browser-backward' || cmd === 'browser-forward') w.webContents.send('shortcut', { key: cmd === 'browser-backward' ? 'navBack' : 'navForward' }); });
  w.on('unmaximize', () => w.webContents.send('win:state', { max: false }));
  w.on('enter-full-screen', () => w.webContents.send('win:state', { full: true }));
  w.on('leave-full-screen', () => w.webContents.send('win:state', { full: false }));
  w.webContents.on('before-input-event', (e, input) => handleShortcut(e, input, w.webContents));
  if (!priv) { win = w; w.on('closed', () => { if (win === w) win = null; if (mini && !mini.isDestroyed()) mini.close(); }); } // без главного окна видео поверх тоже закрываем
  return w;
}

const CODE_KEYS = { Equal: '=', Minus: '-', Backslash: '\\', Tab: 'tab', NumpadAdd: '+', NumpadSubtract: '-', Numpad0: '0' };
function keyOf(input) {
  const c = input.code || '';
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (CODE_KEYS[c]) return CODE_KEYS[c];
  return (input.key || '').toLowerCase(); // F5, F11, Escape, стрелки — от раскладки не зависят
}
const SHORTCUTS = new Set(['t', 'w', 'l', 'r', 'tab', 'j', 'k', 'h', '=', '+', '-', '0', 'f', 'i', 'n', 'd', 'b', '\\', 'y', 's']);
function handleShortcut(e, input, target) {
  if (input.type !== 'keyDown' || !target || target.isDestroyed()) return;
  // Клавишу узнаём по её месту на клавиатуре, а не по букве: с русской раскладкой Ctrl+T приходит как Ctrl+Е,
  // и раньше почти все сочетания (Ctrl+T, W, L, F, J…) при русской раскладке не работали
  const k = keyOf(input);
  const mod = input.control || input.meta;
  let hit = null;
  if (mod && SHORTCUTS.has(k)) hit = k;
  else if (k === 'f5') hit = 'r';
  else if (k === 'f12') hit = 'i';
  else if (input.alt && k === 'arrowleft') hit = 'back';
  else if (input.alt && k === 'arrowright') hit = 'forward';
  else if (input.alt && k === 'p') hit = 'pip';
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
  const cid = contents.id;
  // адрес меняем уже в начале перехода: запросы новой страницы идут после этого
  const setTop = (d) => { if (d && d.isMainFrame && !d.isSameDocument && d.url) topUrls.set(cid, d.url); };
  contents.on('did-start-navigation', setTop);
  contents.on('did-redirect-navigation', setTop);
  contents.on('did-navigate', (_ev, url) => { if (url) topUrls.set(cid, url); });
  contents.once('destroyed', () => topUrls.delete(cid));
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
    if (!ours) return; // предупреждения самих сайтов (их сотни) журналу не нужны — раньше на каждое тратился основной процесс
    // ошибки самих сайтов — шум, их пишем только как отладочные
    diag.log(ours ? (level === 'error' ? 'error' : 'warn') : 'debug', kind(), `${message}`, `${source.split(/[\\/]/).pop()}:${ln}`);
  });
  contents.on('preload-error', (_ev, p, err) => diag.log('error', 'preload', err, p && p.split(/[\\/]/).pop()));
  const logUrl = (u) => (ses && contents.session && contents.session !== ses ? '(инкогнито — адрес не записан)' : u);
  contents.on('unresponsive', () => { let u = ''; try { u = contents.getURL(); } catch {} diag.log('warn', kind(), 'Страница зависла и не отвечает', logUrl(u)); });
  contents.on('responsive', () => diag.log('info', kind(), 'Страница снова отвечает'));
  contents.on('did-fail-load', (_ev, code, desc, url, isMain) => { if (isMain && code !== -3) diag.log('warn', 'загрузка', `${desc} (${code})`, logUrl(url)); });
  contents.on('will-attach-webview', (_ev, wp) => {
    wp.preload = WEBVIEW_PRELOAD;
    wp.nodeIntegration = false;
    // preload запускается и во фреймах (встроенные плееры), Node.js там по-прежнему выключен
    wp.nodeIntegrationInSubFrames = true;
    wp.contextIsolation = true;
    wp.sandbox = true;
  });
});

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  const host = () => hostOf(contents);
  contents.on('did-navigate', () => { if (adblock) adblock.resetCount(contents.id); });
  contents.once('destroyed', () => { if (adblock) adblock.counts.delete(contents.id); }); // счётчик закрытой вкладки больше не нужен
  applyRtcPolicy(contents);
  contents.on('did-start-navigation', (d) => { if (d.isMainFrame) applyRtcPolicy(contents, d.url); });

  // Всплывающие окна разрешаем только сразу после нажатия или клавиши (как блокировщик попапов в Chrome)
  let lastInput = 0, lastPopupToast = 0;
  contents.on('input-event', (_ev, ie) => { if (USER_INPUT.has(ie.type)) lastInput = Date.now(); }); // приходит и на каждое движение мыши — проверка должна быть дешёвой
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
    if (/^https?:|^file:|^chrome-extension:/.test(url)) host().send('tab:open', { url, background: disposition === 'background-tab' }); // колесико и Ctrl+клик — фоном, как в Chrome
    else if (url) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  contents.on('did-create-window', (w) => { try { setupPopup(w, host()); } catch {} });
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
      t.push({ label: 'Окно поверх игры', click: () => host().send('shortcut', { key: 'mini' }) });
      t.push({ label: 'Сохранить клип (последние 30 с)', click: () => host().send('shortcut', { key: 'clip' }) });
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

// WebRTC: при VPN звонки не должны выдавать настоящий IP — но только на сайтах, которые идут через VPN,
// иначе на российских сайтах (VK, Телемост) звонки шли бы хуже без причины
function applyRtcPolicy(wc, url) {
  try {
    let host = ''; try { host = new URL(url || wc.getURL()).hostname; } catch {}
    const mode = loadSettings().vpnMode || 'smart';
    const routed = !!proxyRules && (mode === 'all' || (host && smart.matches(host)));
    wc.setWebRTCIPHandlingPolicy(routed ? 'disable_non_proxied_udp' : 'default');
  } catch {}
}

// Проверка страницы в окне входа: тот же разбор, что у вкладок (renderer/app.js guardScan), вердикт считает окно браузера
const GUARD_SCAN = `(() => {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const pass = q('input[type=password]').length;
  const card = q('input[autocomplete^="cc-"], input[name*="card" i], input[id*="card" i], input[placeholder*="карт" i], input[name*="cvv" i], input[name*="cvc" i]').length;
  const actions = Array.from(new Set(q('form').map(f => { try { return new URL(f.action, location.href).host; } catch { return ''; } }).filter(Boolean)));
  // текст страницы (дорогой: пересчёт раскладки) нужен только для проверки страниц с паролем или картой
  return { pass, card, actions, title: document.title, text: (pass || card) && document.body ? document.body.innerText.slice(0, 2500) : '' };
})()`;
let guardSeq = 0;
const guardWait = new Map();
async function popupGuard(w, openerHost) {
  if (w.isDestroyed() || loadSettings().guard === false || !openerHost || openerHost.isDestroyed()) return;
  const wc = w.webContents, url = wc.getURL();
  if (!/^https?:/.test(url) || (w.__guard && w.__guard.url === url)) return;
  let info; try { info = await wc.executeJavaScript(GUARD_SCAN, true); } catch { return; }
  if (!info || (!info.pass && !info.card) || w.isDestroyed()) return;
  const id = ++guardSeq;
  const r = await new Promise((res) => { guardWait.set(id, res); openerHost.send('guard:popup', { id, url, info }); setTimeout(() => { guardWait.delete(id); res(null); }, 30000); });
  if (!r || w.isDestroyed() || wc.getURL() !== url) return;
  w.__guard = { url, verdict: r.verdict };
  try { w.__show && w.__show(); } catch {}
  if (r.verdict === 'danger') {
    const { response } = await dialog.showMessageBox(w, { type: 'warning', title: 'Liquid: опасная страница',
      message: 'Похоже на мошеннический сайт', detail: `${new URL(url).hostname}\n\n${r.reason || ''}\n\nНе вводи здесь пароль и данные карты.`,
      buttons: ['Закрыть окно', 'Всё равно продолжить'], defaultId: 0, cancelId: 0, noLink: true });
    if (response === 0 && !w.isDestroyed()) w.close();
  }
}

// настоящие всплывающие окна (вход, оплата): в заголовке — адрес сайта, лишние окна внутри блокируются
function setupPopup(w, openerHost) {
  const wc = w.webContents;
  const show = () => {
    let u = ''; try { u = new URL(wc.getURL()); } catch {}
    const host = u ? u.hostname : '';
    const g = w.__guard && w.__guard.url === wc.getURL() ? w.__guard.verdict : '';
    const lock = g === 'danger' ? '⛔ ОПАСНО' : g === 'caution' ? '⚠ ОСТОРОЖНО' : u && u.protocol === 'https:' ? '🔒' : '⚠ НЕ ЗАЩИЩЕНО';
    w.setTitle(`${lock} ${host}${wc.getTitle() && wc.getTitle() !== host ? ' — ' + wc.getTitle() : ''}`);
  };
  wc.on('page-title-updated', (e) => { e.preventDefault(); show(); });
  w.__guard = null; w.__show = show;
  wc.on('did-navigate', show); wc.on('did-navigate-in-page', show);
  applyRtcPolicy(wc);
  wc.on('did-start-navigation', (d) => { if (d.isMainFrame) applyRtcPolicy(wc, d.url); });
  let lastInput = 0;
  wc.on('input-event', (_e, ie) => { if (POPUP_INPUT.has(ie.type)) lastInput = Date.now(); });
  wc.setWindowOpenHandler(({ url }) => {
    if (Date.now() - lastInput > 5000) { diag.log('info', 'попап', 'Заблокировано окно из окна входа', ''); return { action: 'deny' }; }
    if (!/^https?:/.test(url)) return { action: 'deny' };
    // 3-D Secure и подтверждения внутри окна оплаты ждут ответа от своего окна — открываем дочерним окном, связанным с ним
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 520, height: 720, autoHideMenuBar: true, parent: w, backgroundColor: '#ffffff',
        webPreferences: { preload: WEBVIEW_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
      },
    };
  });
  wc.on('did-create-window', (child) => { try { setupPopup(child, openerHost); } catch {} });
  // защита от фишинга: окна входа и оплаты проверяем так же, как вкладки
  wc.on('did-stop-loading', () => popupGuard(w, openerHost));
  show();
}

// sessions — каким сессиям, close — рвать ли открытые соединения (нужно при смене режима, не нужно, когда
// просто добавился сайт в «умный» список или открылось новое окно — иначе прерываются видео и загрузки)
async function applyProxy({ sessions = allSessions(), close = true } = {}) {
  const mode = loadSettings().vpnMode || 'smart';
  smart.vpnOn = !!proxyRules;
  if (iconSes && !sessions.includes(iconSes)) sessions = [...sessions, iconSes]; // значки стартовой — тоже через VPN
  for (const sess of sessions) {
    if (!proxyRules && !smart.dpi) await sess.setProxy({ mode: 'direct' });
    else if (!proxyRules || mode === 'smart') await sess.setProxy({ mode: 'pac_script', pacScript: smart.url() }); // без VPN PAC ведёт только обход замедления
    else await sess.setProxy({ proxyRules, proxyBypassRules: '<local>' });
    if (close) await sess.closeAllConnections();
  }
  // при VPN звонки в браузере (WebRTC) не должны выдавать настоящий IP
  for (const wc of webContents.getAllWebContents()) { try { if (wc.getType() !== 'backgroundPage') applyRtcPolicy(wc); } catch {} }
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
    if (rawKey) { const s2 = loadSettings(); s2.vpnKey = enc(key); s2.vpnName = cfg.name; saveSettings(s2); }
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

// --- обход замедления без VPN ---
let dpiRestarts = 0;
async function startDpi() {
  if (loadSettings().antiDpi === false || !dpiXray) return false;
  try {
    const port = await dpiXray.start(null, DPI_CONFIG);
    smart.dpi = `SOCKS5 127.0.0.1:${port}; SOCKS 127.0.0.1:${port}`;
    await applyProxy({ close: true });
    diag.log('info', 'обход', 'Обход замедления включён (Twitch, YouTube, Discord без VPN)');
    return true;
  } catch (e) {
    smart.dpi = '';
    diag.log('warn', 'обход', 'Обход замедления не запустился: ' + e.message);
    return false;
  }
}
async function stopDpi() {
  dpiXray?.stop();
  smart.dpi = '';
  await applyProxy({ close: true });
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

// ---------- «Почему не открылось?» ----------
// Загрузка страницы с подсчётом байт: когда пришёл первый байт, сколько всего и не встала ли она посреди ответа.
// Провайдерское «замедление» узнаётся по обрыву после ~16 КБ: дальше данные просто перестают идти.
async function loadProbe(sess, url, { total = 15000, idle = 6000, cap = 1.5e6 } = {}) {
  const ctrl = new AbortController(); const t0 = Date.now(); const tAll = setTimeout(() => ctrl.abort(), total);
  const out = { ok: false, status: 0, bytes: 0, ttfb: 0, ms: 0, stalled: false, error: '' };
  try {
    const r = await sess.fetch(url, { signal: ctrl.signal, cache: 'no-store', redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
    out.status = r.status; out.ttfb = Date.now() - t0;
    const reader = r.body.getReader();
    for (;;) {
      let to; const step = await Promise.race([reader.read(), new Promise((res) => { to = setTimeout(() => res({ idle: true }), idle); })]);
      clearTimeout(to);
      if (step.idle) { out.stalled = true; ctrl.abort(); break; }
      if (step.done) break;
      out.bytes += step.value.length;
      if (out.bytes >= cap) { ctrl.abort(); break; }
    }
    out.ok = !out.stalled && r.status < 500;
  } catch (e) { out.error = String(e.message || e).replace(/^net::/, ''); if (/abort/i.test(out.error) && !out.status) out.error = 'нет ответа ' + Math.round(total / 1000) + ' с'; }
  finally { clearTimeout(tAll); out.ms = Date.now() - t0; }
  return out;
}
const BOGUS_IP = /^(0\.|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;
async function dohA(host) {
  for (const u of [`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`]) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
    try { const j = await (await probeSession().fetch(u, { headers: { accept: 'application/dns-json' }, signal: ctrl.signal, cache: 'no-store' })).json(); return (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data); }
    catch {} finally { clearTimeout(t); }
  }
  return null;
}
const kb = (n) => (n < 1024 ? n + ' Б' : Math.round(n / 1024) + ' КБ');
async function netDiagnose(url) {
  let u; try { u = new URL(url); } catch { return { verdict: 'Это не адрес сайта.', checks: [] }; }
  if (!/^https?:$/.test(u.protocol)) return { verdict: 'Проверяются только сайты (http и https).', checks: [] };
  const host = u.hostname, checks = [];
  const add = (status, title, text) => checks.push({ status, title, text });
  const mode = loadSettings().vpnMode || 'smart';
  const routed = vpnState.on && (mode === 'all' || smart.matches(host));
  const viaDpi = !routed && !!smart.dpi && DPI_SITES.some((d) => host === d || host.endsWith('.' + d));
  // всё независимое — одновременно
  const [online, sys, doh, direct, inLiquid] = await Promise.all([
    directWorks(),
    (async () => { try { const r = await ses.resolveHost(host, { secureDnsPolicy: 'disable' }); return (r.endpoints || []).map((e) => e.address); } catch (e) { return { error: e.message }; } })(),
    dohA(host),
    loadProbe(probeSession(), u.href),
    loadProbe(ses, u.href),
  ]);
  add(online || direct.ok ? 'ok' : 'bad', 'Интернет', online || direct.ok ? 'Есть' : 'Не открываются даже ya.ru и google.com — проблема с интернетом, а не с сайтом.');
  // DNS провайдера против безопасного DNS
  const sysIps = Array.isArray(sys) ? sys.filter((a) => !a.includes(':')) : [];
  const literal = /^[\d.]+$|^\[|^localhost$/.test(host); // адрес цифрами или свой компьютер — DNS тут ни при чём
  if (literal) add('info', 'DNS', 'Адрес сайта задан напрямую, DNS не нужен.');
  else if (!Array.isArray(sys)) add(doh && doh.length ? 'bad' : 'warn', 'DNS провайдера', `Не нашёл адрес сайта (${String(sys.error || '').replace(/^net::/, '')})${doh && doh.length ? ', а безопасный DNS нашёл — включи безопасный DNS в настройках.' : '.'}`);
  else if (sysIps.some((a) => BOGUS_IP.test(a))) add('bad', 'DNS провайдера', `Подменяет адрес сайта на ${sysIps.join(', ')} — включи безопасный DNS в настройках.`);
  else add('ok', 'DNS', `Адрес находится${doh ? '' : ' (безопасный DNS сейчас не ответил)'}.`);
  add('info', 'Маршрут', routed ? 'Сайт идёт через VPN Liquid.' : viaDpi ? 'Сайт идёт через обход замедления.' : 'Сайт идёт напрямую, без VPN.');
  const desc = (p) => p.ok ? `открылся: ${kb(p.bytes)} за ${(p.ms / 1000).toFixed(1)} с` : p.stalled ? `завис после ${kb(p.bytes)} — данные перестали идти` : p.error ? `ошибка: ${p.error}` : `ответ ${p.status}`;
  const throttled = (p) => p.stalled && p.bytes > 4096 && p.bytes < 64 * 1024;
  add(direct.ok ? 'ok' : 'bad', 'Напрямую, без расширений и данных сайта', desc(direct));
  add(inLiquid.ok ? 'ok' : 'bad', 'Через Liquid (прокси, вход в аккаунт)', desc(inLiquid));
  // фоновые скрипты сайта (service worker) — частая причина «белой страницы до перезагрузки»
  let sw = 0; try { sw = Object.values(ses.serviceWorkers.getAllRunning()).filter((w) => String(w.scope).startsWith(u.origin)).length; } catch {}
  if (sw) add('info', 'Фоновый скрипт сайта', 'Работает. Если страница грузится пустой, помогает «Очистить данные сайта».');
  const extOn = (exts?.list || []).filter((e) => e.enabled !== false).map((e) => e.name);
  add('info', 'Расширения', extOn.length ? 'Включены: ' + extOn.join(', ') : 'Нет');
  // вывод
  let verdict, action = '';
  if (!online && !direct.ok && !inLiquid.ok) verdict = 'Нет интернета или он работает с перебоями.';
  else if (throttled(direct) && !routed) { verdict = 'Провайдер замедляет этот сайт: соединение обрывается после ~16 КБ. Сайт не заблокирован, но без VPN полностью не загрузится.'; action = 'vpn'; }
  else if (!direct.ok && !inLiquid.ok && direct.error && /RESET|CLOSED|TIMED_OUT|нет ответа/i.test(direct.error) && !routed) { verdict = `Соединение с сайтом обрывается (${direct.error}) — так выглядит блокировка или замедление у провайдера. Поможет VPN или обход замедления.`; action = 'vpn'; }
  else if (direct.ok && !inLiquid.ok) { verdict = 'Напрямую сайт открывается, а через Liquid — нет: мешает что-то в браузере (прокси, сохранённые данные сайта). Попробуй «Очистить данные сайта».'; action = 'clear'; }
  else if (direct.ok && inLiquid.ok) { verdict = 'Сайт отвечает нормально. Если вкладка всё равно пустая, дело в самой странице: её данных или расширениях. Попробуй «Очистить данные сайта», потом — выключить расширения.'; action = 'clear'; }
  else verdict = 'Сайт сейчас не отвечает никому — скорее всего, проблема на его стороне.';
  diag.log('info', 'диагностика', `${host}: ${verdict}`, checks.map((c) => `${c.title}: ${c.text}`).join(' · '));
  return { host, origin: u.origin, verdict, action, checks };
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
  const s2 = loadSettings();
  if (!(s2.learned || []).includes(base)) { s2.learned = [...(s2.learned || []), base].slice(-300); saveSettings(s2); }
  syncSmartLists();
  try {
    if (!vpnState.on) await vpnConnect();
    else await applyProxy({ close: false });
    return { ok: true, host: base };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ---------- Claude ----------
// адрес API; в автотестах — подставной сервер (только в тестовом режиме)
const CLAUDE_API = (TEST && process.env.LIQUID_CLAUDE_API) || 'https://api.anthropic.com';
// Один шаг «Claude действует на странице»: запрос с инструментами, без потока (features6.js ведёт цикл и выполняет действия)
async function claudeCall({ model, system, messages, tools }) {
  const key = dec(loadSettings().claudeKey);
  if (!key) return { error: 'Нужен API-ключ Claude: Настройки → Claude → «Как подключаться» → API-ключ.' };
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 120e3);
  try {
    const res = await ses.fetch(CLAUDE_API + '/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: String(model || 'claude-sonnet-5-5'), max_tokens: 4096, system: String(system || ''), messages: Array.isArray(messages) ? messages : [], tools: Array.isArray(tools) ? tools : [] }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { error: res.status === 401 ? 'Неверный API-ключ.' : `Ошибка ${res.status}: ${j.error?.message || ''}${res.status === 403 && !vpnState.on ? ' — похоже, API недоступен из твоего региона, включи VPN.' : ''}` };
    return j;
  } catch (e) { return { error: e.name === 'AbortError' ? 'Claude не ответил за 2 минуты' : e.message }; }
  finally { clearTimeout(t); }
}
async function claudeStream(sender, { id, model, system, messages }) {
  const key = dec(loadSettings().claudeKey);
  if (!key) { sender.send('claude:error', { id, error: 'Добавь API-ключ Claude в настройках (шестерёнка справа сверху).' }); return; }
  const ctrl = new AbortController();
  claudeJobs.set(id, ctrl);
  try {
    const res = await ses.fetch(CLAUDE_API + '/v1/messages', {
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
// ---------- обновления Liquid из релизов GitHub ----------
// В фоне: раз в 3 часа смотрим последний релиз, качаем Liquid-Setup.exe, сверяем SHA-256 и запускаем его
// в тихом режиме. Он собирает новую версию, пока ты пользуешься браузером, и подменяет файлы, когда браузер закрыт.
const RELEASES = 'https://api.github.com/repos/tekeyaa/Liquid-pc/releases/latest';
const crypto = require('crypto');
let pendingSetup = null;        // для ручного режима (автообновление выключено)
const upd = { state: 'idle', version: '', error: '', checkedAt: 0, poll: null, engine: '', progress: 0, notes: [] };
// «Что нового» для карточки обновления: заголовки пунктов **…** из описания релиза (оно же CHANGELOG)
function releaseNotes(body) {
  const out = [];
  for (const l of String(body || '').split(/\r?\n/)) {
    const m = l.match(/^\s*[-*]\s+(?:\*\*(.+?)\*\*|(.+))/); if (!m) continue;
    let t = (m[1] || m[2] || '').replace(/\*\*|`/g, '').replace(/[.:]\s*$/, '').trim();
    if (t.length > 90) t = t.slice(0, 88).replace(/\s+\S*$/, '') + '…';
    if (t) out.push(t); if (out.length >= 4) break;
  }
  return out;
}
const liquidBase = () => path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Liquid');
const updStatusFile = () => path.join(liquidBase(), 'update-status.json');
// установщик уже работает или собрал обновление и ждёт закрытия браузера. «ready» не устаревает: он ждёт до недели
function installerBusy() {
  const st = readUpdStatus();
  if (!st) return null;
  if (st.state === 'ready') return st;
  if (st.state === 'working' && Date.now() / 1000 - st.at < 3 * 3600) return st;
  return null;
}
function readUpdStatus() { try { return JSON.parse(fs.readFileSync(updStatusFile(), 'utf8')); } catch { return null; } }
function sendUpd() { broadcast('update:state', { ...upd, poll: undefined, current: app.getVersion(), auto: loadSettings().autoUpdate !== false }); }

async function fetchJson(url) {
  const r = await net.fetch(url, { cache: 'no-store', headers: { accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(r.status === 404 ? 'релизы недоступны (репозиторий приватный?)' : 'GitHub ответил ' + r.status);
  return r.json();
}

// неудачное фоновое обновление не повторяем каждые 3 часа: ждём сутки, двое, трое; после трёх неудач — только вручную
function failedRecently(version) {
  const f = loadSettings().updFail;
  if (!f || f.version !== version) return false;
  return f.n >= 3 || Date.now() - f.at < f.n * 864e5;
}
function markFailed(version) {
  const s = loadSettings(); const f = s.updFail && s.updFail.version === version ? s.updFail : { version, n: 0 };
  s.updFail = { version, n: f.n + 1, at: Date.now() }; saveSettings(s);
}

async function checkUpdates(manual = false) {
  const s = loadSettings();
  upd.checkedAt = Date.now();
  // обновление уже скачивается, собирается или ждёт перезапуска — второй установщик не запускаем даже по кнопке
  if (['download', 'building', 'ready'].includes(upd.state)) return;
  if (installerBusy()) { watchInstaller(installerBusy().version); return; }
  try {
    const j = await fetchJson(RELEASES);
    const version = String(j.tag_name || '').replace(/^v/, '');
    const cur = app.getVersion();
    const asset = (j.assets || []).find((a) => /^Liquid-Setup\.exe$/i.test(a.name));
    const sum = (j.assets || []).find((a) => /^Liquid-Setup\.exe\.sha256$/i.test(a.name));
    if (!version || !asset || !newer(version, cur)) {
      if (manual) { upd.state = 'latest'; upd.version = cur; sendUpd(); }
      await checkEngine(manual);
      return;
    }
    if (s.autoUpdate === false || !app.isPackaged || process.platform !== 'win32') {
      if (s.updSnooze && Date.now() < s.updSnooze && !manual) return;
      pendingSetup = { version, asset, sum };
      win?.webContents.send('update', { latest: version, current: cur });
      return;
    }
    if (!manual && failedRecently(version)) return;
    upd.notes = releaseNotes(j.body);
    { const s2 = loadSettings(); s2.updNotes = { version, notes: upd.notes }; saveSettings(s2); }
    await backgroundUpdate(version, asset, sum);
  } catch (e) {
    diag.log('warn', 'обновление', e.message);
    if (manual) { upd.state = 'error'; upd.error = e.message; sendUpd(); }
  }
}

// Движок: Electron закреплён на ветке 45 (^45 в package.json). Исправления безопасности внутри ветки ставим сами —
// пересобираем браузер местным установщиком, он подтягивает последний 45.x
async function checkEngine(manual) {
  if (!app.isPackaged || process.platform !== 'win32' || loadSettings().autoUpdate === false) return;
  try {
    const curMajor = Number(process.versions.electron.split('.')[0]);
    const r = await net.fetch('https://registry.npmjs.org/electron', { headers: { accept: 'application/vnd.npm.install-v1+json' }, cache: 'no-store' });
    if (!r.ok) return;
    const meta = await r.json();
    const stable = Object.keys(meta.versions || {}).filter((v) => !v.includes('-'));
    const latestMajor = Number(String((meta['dist-tags'] || {}).latest || '').split('.')[0]) || curMajor;
    // Electron поддерживает 3 последние ветки. Наша вышла из поддержки — переходим на самую старую из поддерживаемых:
    // она дольше всех получала исправления и ближе всего к нашей
    const major = latestMajor - curMajor >= 3 ? latestMajor - 2 : curMajor;
    const best = stable.filter((v) => Number(v.split('.')[0]) === major).sort((a, b) => (newer(a, b) ? 1 : newer(b, a) ? -1 : 0)).pop();
    if (!best || !newer(best, process.versions.electron)) return;
    const local = path.join(liquidBase(), 'Liquid-Setup.exe');
    if (!fs.existsSync(local) || (!manual && failedRecently('engine-' + best))) return;
    if (installerBusy()) return;
    const s = loadSettings(); s.engineTarget = best; saveSettings(s);
    // точная версия: если npm её не найдёт, установщик честно завершится ошибкой, а не соберёт старый движок
    spawn(local, ['--silent', '--engine', '--electron=' + best], { cwd: liquidBase(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
    diag.log('info', 'обновление', `Обновляю движок Electron ${process.versions.electron} → ${best}${major !== curMajor ? ' (переход на поддерживаемую ветку)' : ''} в фоне`);
    upd.engine = best;
    watchInstaller(app.getVersion());
  } catch (e) { diag.log('warn', 'обновление', 'движок: ' + e.message); }
}

// скачать установщик и сверить SHA-256 из релиза (и для фонового, и для ручного обновления)
async function downloadVerified(version, asset, sumAsset) {
  const dir = path.join(app.getPath('userData'), 'updates'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `Liquid-Setup-${version}.exe`);
  let buf = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (!buf || buf.length !== asset.size) {
    const r = await net.fetch(asset.browser_download_url);
    if (!r.ok) throw new Error('не скачался установщик: ' + r.status);
    // читаем по частям, чтобы карточка показывала, сколько скачалось
    const total = asset.size || Number(r.headers.get('content-length')) || 0;
    const parts = []; let got = 0, last = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      parts.push(Buffer.from(value)); got += value.length;
      if (total && Date.now() - last > 400) { last = Date.now(); upd.progress = Math.min(99, Math.round(got * 100 / total)); sendUpd(); }
    }
    buf = Buffer.concat(parts); upd.progress = 100;
    if (asset.size && buf.length !== asset.size) throw new Error('установщик скачался не целиком');
  }
  if (!sumAsset) throw new Error('в релизе нет контрольной суммы — обновление не ставлю');
  const want = (await (await net.fetch(sumAsset.browser_download_url)).text()).trim().split(/\s+/)[0].toLowerCase();
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (want !== got) throw new Error('контрольная сумма установщика не совпала — обновление отменено');
  fs.writeFileSync(file, buf);
  for (const f of fs.readdirSync(dir)) if (f !== path.basename(file)) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch {} }
  return file;
}

async function backgroundUpdate(version, asset, sumAsset) {
  upd.state = 'download'; upd.version = version; upd.error = ''; upd.engine = ''; upd.progress = 0; sendUpd();
  let file;
  try { file = await downloadVerified(version, asset, sumAsset); }
  catch (e) { markFailed(version); upd.state = 'error'; upd.error = e.message; sendUpd(); throw e; }
  spawn(file, ['--silent'], { cwd: path.dirname(file), detached: true, stdio: 'ignore', windowsHide: true }).unref();
  diag.log('info', 'обновление', `Ставлю Liquid ${version} в фоне`);
  watchInstaller(version);
}

// следим за тихим установщиком по файлу состояния
function watchInstaller(version) {
  upd.state = 'building'; upd.version = version; sendUpd();
  clearInterval(upd.poll);
  const tick = () => {
    const st = readUpdStatus();
    if (!st || st.version !== version) return;
    if (st.state === 'ready' && upd.state !== 'ready') {
      upd.state = 'ready'; sendUpd();
      // если браузер свёрнут или в фоне — ещё и уведомление Windows
      try {
        if (!BrowserWindow.getAllWindows().some((w) => w.isFocused()) && Notification.isSupported()) {
          const n = new Notification({ title: upd.engine ? 'Движок Liquid обновлён' : `Liquid ${version} готов`,
            body: 'Новая версия заработает после перезапуска браузера.', silent: true });
          n.on('click', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { w.show(); w.focus(); } });
          n.show();
        }
      } catch {}
    }
    if (st.state === 'error') {
      clearInterval(upd.poll); upd.state = 'error'; upd.error = st.error || 'ошибка установщика'; sendUpd();
      markFailed(upd.engine ? 'engine-' + upd.engine : version);
      diag.log('error', 'обновление', upd.error, 'журнал: ' + path.join(liquidBase(), 'install.log'));
    }
  };
  upd.poll = setInterval(tick, 10000);
  tick(); // уже собранное обновление показываем «готовым» сразу, без ожидания опроса
}

// при запуске: сообщаем, что обновились
function announceUpdate() {
  const st = readUpdStatus();
  // обновление движка «удалось», а движок прежний (npm поставил не ту версию) — считаем неудачей, иначе пересборка каждые 3 часа
  const s0 = loadSettings();
  if (s0.engineTarget && st && st.engine && st.state === 'done') {
    if (process.versions.electron !== s0.engineTarget) {
      markFailed('engine-' + s0.engineTarget);
      diag.log('warn', 'обновление', `Движок не обновился: ждали ${s0.engineTarget}, стоит ${process.versions.electron}`);
      st.announced = true; try { fs.writeFileSync(updStatusFile(), JSON.stringify(st)); } catch {}
    }
    const s1 = loadSettings(); delete s1.engineTarget; saveSettings(s1);
  }
  if (st && st.state === 'done' && st.version === app.getVersion() && !st.announced) {
    st.announced = true; try { fs.writeFileSync(updStatusFile(), JSON.stringify(st)); } catch {}
    // после перезапуска карточка показывает «обновился» и что нового
    const saved = loadSettings().updNotes;
    upd.state = 'done'; upd.version = st.version; upd.engine = st.engine ? process.versions.electron : '';
    upd.notes = saved && saved.version === st.version ? saved.notes : [];
    setTimeout(sendUpd, 2500);
  }
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
    const res = await ses.fetch(CLAUDE_API + '/v1/messages', {
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


// ---------- IPC ----------
function registerIpc() {
  const bw = (e) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.on('win:min', (e) => bw(e)?.minimize());
  ipcMain.on('win:max', (e) => { const w = bw(e); if (w) w.isMaximized() ? w.unmaximize() : w.maximize(); });
  ipcMain.on('win:close', (e) => bw(e)?.close());

  ipcMain.handle('settings:get', () => publicSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    const s = loadSettings();
    if ('claudeKey' in patch) s.claudeKey = patch.claudeKey ? enc(patch.claudeKey.trim()) : '';
    if ('model' in patch) s.model = patch.model;
    if ('search' in patch) s.search = patch.search;
    if ('vpnAuto' in patch) s.vpnAuto = !!patch.vpnAuto;
    if ('autoUpdate' in patch) s.autoUpdate = !!patch.autoUpdate;
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
    if ('antiDpi' in patch) s.antiDpi = !!patch.antiDpi;
    if ('dns' in patch) s.dns = DNS[patch.dns] || patch.dns === 'off' ? patch.dns : 'auto';
    saveSettings(s);
    if ('dns' in patch) { applyDns(); for (const x of allSessions()) x.closeAllConnections().catch(() => {}); }
    if ('antiDpi' in patch) { dpiRestarts = 0; return (s.antiDpi ? startDpi() : stopDpi()).then(() => publicSettings()); }
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
  // подсказки поисковика при вводе (как в Chrome): через сессию без куки и через VPN, если он включён; в инкогнито не шлём
  async function useIconSes() {
    if (iconSes) return iconSes;
    iconSes = session.fromPartition('liquid-icons', { cache: false });
    if (proxyRules) await applyProxy({ sessions: [iconSes], close: false });
    return iconSes;
  }
  const SUGGEST = {
    google: (q) => `https://suggestqueries.google.com/complete/search?client=firefox&hl=ru&ie=utf-8&oe=utf-8&q=${q}`,
    yandex: (q) => `https://suggest.yandex.ru/suggest-ff.cgi?uil=ru&part=${q}`,
    ddg: (q) => `https://duckduckgo.com/ac/?type=list&q=${q}`,
    bing: (q) => `https://api.bing.com/osjson.aspx?query=${q}`,
  };
  const sugCache = new Map();
  // настройки видео для фреймов (в главную страницу их присылает окно браузера)
  ipcMain.handle('video:prefs', () => { const st = loadSettings(); return { sr: ['off', 'mid', 'max'].includes(st.superRes) ? st.superRes : 'off', srHdr: !!st.srHdr, bar: st.vidBar !== false }; });
  ipcMain.handle('search:suggest', async (e, q) => {
    q = String(q || '').trim().slice(0, 120);
    if (!q || e.sender.session !== ses || /^[a-z]+:\/\//i.test(q)) return [];
    const eng = SUGGEST[loadSettings().search] ? loadSettings().search : 'google';
    const key = eng + '\n' + q.toLowerCase();
    if (sugCache.has(key)) return sugCache.get(key);
    await useIconSes();
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 2500);
    try {
      const r = await iconSes.fetch(SUGGEST[eng](encodeURIComponent(q)), { signal: ctrl.signal, credentials: 'omit', headers: { accept: 'application/json' } });
      if (!r.ok) return [];
      const j = JSON.parse(await r.text());
      const list = (Array.isArray(j) && Array.isArray(j[1]) ? j[1] : []).map((x) => String(Array.isArray(x) ? x[0] : x)).filter((x) => x && x.length < 200).slice(0, 8);
      sugCache.set(key, list); if (sugCache.size > 300) sugCache.delete(sugCache.keys().next().value);
      return list;
    } catch { return []; } finally { clearTimeout(t); }
  });

  // Значки для избранного на стартовой: как Chrome — читаем главную сайта и берём самый крупный значок из тех,
  // что сайт указал сам (apple-touch-icon, icon с размерами, manifest), потом /apple-touch-icon.png и /favicon.ico.
  // Качает приложение без куки (сайты не видят открытия стартовой) и через VPN, если он включён; хранится 14 дней
  async function iconFetch(url, ms = 6000) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
    try { return await iconSes.fetch(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'user-agent': UA } }); }
    finally { clearTimeout(t); }
  }
  async function iconCandidates(h) {
    const out = [];
    try {
      const r = await iconFetch('https://' + h + '/');
      if (r.ok && /html/i.test(r.headers.get('content-type') || '')) {
        const base = r.url || 'https://' + h + '/';
        const html = (await r.text()).slice(0, 400000);
        const head = html.slice(0, (html.search(/<\/head>/i) + 1 || 400000));
        const attr = (tag, n) => { const m = tag.match(new RegExp('\\b' + n + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i')); return m ? (m[2] ?? m[3] ?? m[4] ?? '') : ''; };
        const abs = (x) => { try { return new URL(x.replace(/&amp;/g, '&'), base).href; } catch { return ''; } };
        for (const tag of head.match(/<link\b[^>]*>/gi) || []) {
          const rel = attr(tag, 'rel').toLowerCase(), href = attr(tag, 'href');
          if (!href) continue;
          if (rel.includes('manifest')) { out.push({ manifest: abs(href) }); continue; }
          if (!/(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/.test(rel)) continue;
          const sz = Math.max(0, ...attr(tag, 'sizes').split(/\s+/).map((x) => parseInt(x, 10) || 0));
          const svg = /svg/i.test(attr(tag, 'type')) || /\.svg(\?|$)/i.test(href);
          out.push({ url: abs(href), size: svg ? 256 : sz || (rel.includes('apple') ? 180 : 32) });
        }
      }
    } catch {}
    // manifest: там обычно значки 192 и 512
    for (const m of out.filter((x) => x.manifest)) {
      try {
        const r = await iconFetch(m.manifest, 4000); if (!r.ok) continue;
        const j = JSON.parse(await r.text());
        for (const ic of (j.icons || []).slice(0, 20)) {
          if (!ic.src || /maskable/.test(ic.purpose || '')) continue;
          const sz = Math.max(0, ...String(ic.sizes || '').split(/\s+/).map((x) => parseInt(x, 10) || 0));
          out.push({ url: new URL(ic.src, m.manifest).href, size: sz || 96 });
        }
      } catch {}
    }
    const list = out.filter((x) => x.url && /^https?:/.test(x.url));
    // крупный, но не огромный: лучше всего около 128–256
    list.sort((a, b) => Math.abs(Math.min(a.size, 512) - 192) - Math.abs(Math.min(b.size, 512) - 192));
    list.push({ url: 'https://' + h + '/apple-touch-icon.png', size: 180 }, { url: 'https://' + h + '/favicon.ico', size: 32 });
    return list;
  }
  async function iconLoad(c) {
    const r = await iconFetch(c.url, 5000);
    if (!r.ok) return null;
    const type = (r.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 600000) return null;
    if (/svg/.test(type) || /\.svg(\?|$)/i.test(c.url)) {
      const txt = buf.toString('utf8');
      if (!/<svg[\s>]/i.test(txt) || /<script|\bon\w+\s*=|javascript:/i.test(txt)) return null; // только чистая картинка
      return { data: 'data:image/svg+xml;base64,' + buf.toString('base64'), w: 256 };
    }
    if (/webp|avif/.test(type)) return { data: `data:${type.split(';')[0]};base64,` + buf.toString('base64'), w: c.size || 64 };
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return null;
    const w = img.getSize().width;
    if (w < 16) return null;
    return { data: 'data:image/png;base64,' + (w > 256 ? img.resize({ width: 256, quality: 'best' }) : img).toPNG().toString('base64'), w };
  }
  let iconDirReady = false;
  const iconMem = new Map(); // host -> { data, at }
  ipcMain.handle('newtab:icons', async (e, hosts) => {
    let u = ''; try { u = e.sender.getURL(); } catch {}
    if (!/^file:.*\/newtab\.html(#|$)/.test(u) || !Array.isArray(hosts)) return {};
    const dir = path.join(app.getPath('userData'), 'icons2');
    if (!iconDirReady) { // папку готовим один раз за запуск, а не при каждом открытии новой вкладки
      iconDirReady = true; fs.mkdirSync(dir, { recursive: true });
      fs.promises.rm(path.join(app.getPath('userData'), 'icons'), { recursive: true, force: true }).catch(() => {}); // старый кэш мелких значков
    }
    const out = {};
    const want = hosts.slice(0, 80).map(String).map((h) => h.toLowerCase()).filter((h) => /^[a-z0-9.-]{3,100}$/.test(h) && h.includes('.'));
    // значки, которые уже показывали, отдаём из памяти — без диска и без сети
    const todo = want.filter((h) => { const m = iconMem.get(h); if (m && Date.now() - m.at < (m.data ? 14 * 864e5 : 864e5)) { out[h] = m.data; return false; } return true; });
    if (!todo.length) return out;
    await useIconSes();
    await Promise.all(todo.map(async (h) => {
      const f = path.join(dir, h + '.txt'), miss = path.join(dir, h + '.none');
      const fsp = fs.promises; // чтение с диска — без остановки основного процесса
      try { const st = await fsp.stat(f); if (Date.now() - st.mtimeMs < 14 * 864e5) { out[h] = await fsp.readFile(f, 'utf8'); iconMem.set(h, { data: out[h], at: st.mtimeMs }); return; } } catch {}
      try { const st = await fsp.stat(miss); if (Date.now() - st.mtimeMs < 864e5) { out[h] = ''; iconMem.set(h, { data: '', at: st.mtimeMs }); return; } } catch {}
      let best = null;
      for (const c of (await iconCandidates(h)).slice(0, 8)) {
        try {
          const r = await iconLoad(c);
          if (r && (!best || r.w > best.w)) best = r;
          if (best && best.w >= 96) break; // достаточно чёткий — дальше не ищем
        } catch {}
      }
      if (best) { fs.promises.writeFile(f, best.data).catch(() => {}); out[h] = best.data; }
      else { fs.promises.writeFile(miss, '').catch(() => {}); out[h] = ''; }
      iconMem.set(h, { data: out[h], at: Date.now() });
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
  // окно ждёт автозапуска VPN перед тем, как открыть вкладки (не дольше 20 секунд)
  ipcMain.handle('boot:ready', () => bootReady.then(() => true));
  ipcMain.handle('vpn:startup', () => Promise.race([vpnStartup || Promise.resolve(), new Promise((r) => setTimeout(r, 20000))]).then(() => vpnState));
  ipcMain.handle('vpn:unblock', (_e, url) => vpnUnblock(url));
  ipcMain.handle('net:diagnose', (_e, url) => netDiagnose(String(url || '')));
  // Как Chrome: навёл мышь на ссылку или выбрал подсказку в адресной строке — заранее открываем соединение
  // с сайтом (DNS, TCP, TLS), и после клика страница начинает грузиться на 100–300 мс раньше
  const pre = new Map();
  ipcMain.on('net:preconnect', (e, url) => {
    let o; try { o = new URL(String(url)); } catch { return; }
    if (!/^https?:$/.test(o.protocol)) return;
    const now = Date.now();
    if (now - (pre.get(o.origin) || 0) < 10e3) return;
    pre.set(o.origin, now);
    if (pre.size > 300) pre.clear();
    try { (e.sender.session || ses).preconnect({ url: o.origin, numSockets: 1 }); } catch {}
  });
  // данные одного сайта: куки, хранилище, фоновые скрипты, кэш скриптов — как будто открываешь его впервые
  ipcMain.handle('net:clearSite', async (_e, origin) => {
    let o; try { o = new URL(String(origin)).origin; } catch { return false; }
    await ses.clearStorageData({ origin: o }).catch(() => {});
    await ses.clearCodeCaches({ urls: [o] }).catch(() => {});
    diag.log('info', 'диагностика', 'Данные сайта очищены', o);
    return true;
  });

  // окна
  ipcMain.on('win:incognito', () => createWindow({ priv: true }));

  // перевод страниц (вызывается из preload сайтов)
  ipcMain.handle('translate:batch', (e, texts) => {
    if (!Array.isArray(texts) || e.sender.getType() !== 'webview') return null;
    const sess = e.sender.session || ses;
    return translateBatch((u, o) => sess.fetch(u, o), texts.slice(0, 200).map((t) => String(t).slice(0, 2000)), 'ru', (lvl, m) => diag.log(lvl, 'перевод', m));
  });

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

  // игровой режим: вкладки не выгружаем, а замораживаем — скрипты и таймеры стоят, память отдаётся,
  // а страница со всем, что на ней было, остаётся на месте. Размораживаются мгновенно
  const frozen = new Set();
  ipcMain.handle('tabs:freeze', async (e, { ids, on }) => {
    let n = 0;
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, 500)) {
      const wc = webContents.fromId(Number(id));
      if (!wc || wc.isDestroyed() || wc.getType() !== 'webview' || wc.hostWebContents !== e.sender) continue;
      try {
        const dbg = wc.debugger;
        if (on) {
          if (frozen.has(wc.id)) continue;
          if (!dbg.isAttached()) dbg.attach('1.3');
          // скрытую страницу Chromium замораживает сам; видимую (окно браузера под игрой) — ставим скрипты на паузу
          await dbg.sendCommand('Page.enable').catch(() => {});
          await dbg.sendCommand('Page.setWebLifecycleState', { state: 'frozen' }).catch(() => {});
          await dbg.sendCommand('Debugger.enable');
          await dbg.sendCommand('Debugger.pause');
          dbg.sendCommand('Memory.simulatePressureNotification', { level: 'critical' }).catch(() => {});
          frozen.add(wc.id); n++;
          wc.once('destroyed', () => frozen.delete(wc.id));
        } else {
          if (!frozen.has(wc.id)) continue;
          frozen.delete(wc.id);
          await dbg.sendCommand('Debugger.resume').catch(() => {});
          await dbg.sendCommand('Debugger.disable').catch(() => {});
          await dbg.sendCommand('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
          try { dbg.detach(); } catch {}
          n++;
        }
      } catch (err) { diag.log('warn', 'игровой режим', 'заморозка вкладки: ' + err.message); }
    }
    return n;
  });

  // окно поверх игры
  ipcMain.handle('mini:open', (_e, o) => openMini(o || {}));
  ipcMain.on('mini:cmd', (e, { op, d, t } = {}) => {
    if (!mini || mini.isDestroyed() || e.sender !== mini.webContents) return; // команды только от самого окна
    if (op === 'opacity') { mini.setOpacity(Math.min(1, Math.max(0.3, mini.getOpacity() + (Number(d) || 0)))); miniSend({ type: 'miniOpacity', v: mini.getOpacity() }); const s = loadSettings(); s.mini = { ...(s.mini || {}), opacity: mini.getOpacity() }; saveSettings(s); }
    else if (op === 'click') miniClickThrough(!mini.__ct);
    else if (op === 'close') mini.close();
    else if (op === 'back') { const from = mini.__from; mini.close(); try { win?.webContents.send('mini:back', { wcId: from, t }); win?.focus(); } catch {} }
  });
  // «Смотреть вместе»
  ipcMain.handle('watch:join', async (_e, code) => { try { return { ok: true, code: await watchRoom().join(code) }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('watch:send', (_e, m) => (watch ? watch.send(m && typeof m === 'object' ? m : {}) : false));
  ipcMain.on('watch:leave', () => watch?.leave());

  // снимок вкладки для превью при наведении: маленький JPEG, только своих вкладок
  ipcMain.handle('tab:thumb', async (e, wcId) => {
    const wc = webContents.fromId(Number(wcId));
    if (!wc || wc.isDestroyed() || wc.getType() !== 'webview' || wc.hostWebContents !== e.sender) return '';
    try {
      const img = await wc.capturePage();
      if (img.isEmpty()) return '';
      return 'data:image/jpeg;base64,' + img.resize({ width: 360, quality: 'good' }).toJPEG(72).toString('base64');
    } catch { return ''; }
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
    // заметки — в «Загрузки», клипы видео — в «Видео/Liquid», кадры и скриншоты — в «Изображения/Liquid»
    const dir = kind === 'note' ? app.getPath('downloads') : path.join(app.getPath(kind === 'clip' ? 'videos' : 'pictures'), 'Liquid');
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
    diag.flush(); // строки, которые ещё копятся в памяти, — в файл, чтобы попали в отчёт
    try { full += fs.readFileSync(diag.file(), 'utf8').slice(-400_000); } catch {}
    fs.writeFileSync(f, full);
    return f;
  });
  ipcMain.on('diag:clear', () => diag.clear());
  ipcMain.on('diag:seen', () => diag.seen());
  ipcMain.on('diag:folder', () => { diag.flush(); shell.openPath(diag.dir); });
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
  ipcMain.handle('claude:call', (_e, body) => claudeCall(body || {}));
  ipcMain.on('claude:abort', (_e, id) => claudeJobs.get(id)?.abort());
  ipcMain.handle('claude:check', (_e, info) => guardCheck(info));
  ipcMain.on('guard:popup-result', (_e, { id, r }) => { const f = guardWait.get(id); if (f) { guardWait.delete(id); f(r); } });
  ipcMain.handle('display:info', (e) => {
    const w0 = BrowserWindow.fromWebContents(e.sender) || win;
    const d = w0 ? screen.getDisplayMatching(w0.getBounds()) : screen.getPrimaryDisplay();
    const all = screen.getAllDisplays().map((x) => Math.round(x.displayFrequency || 60));
    return { hz: Math.round(d.displayFrequency || 60), all, primary: Math.round(screen.getPrimaryDisplay().displayFrequency || 60) };
  });
  ipcMain.on('app:relaunch', () => { app.relaunch(); app.exit(0); });
  ipcMain.on('clipboard:write', (_e, t) => clipboard.writeText(String(t || '')));
  ipcMain.handle('update:check', async () => { await checkUpdates(true); return { ...upd, poll: undefined, current: app.getVersion(), auto: loadSettings().autoUpdate !== false }; });
  ipcMain.handle('update:state', () => ({ ...upd, poll: undefined, current: app.getVersion(), auto: loadSettings().autoUpdate !== false }));
  // «Перезапустить сейчас»: установщик ждёт закрытия браузера, подменит файлы и откроет новую версию
  ipcMain.on('update:restart', () => { try { fs.writeFileSync(path.join(liquidBase(), 'relaunch.flag'), '1'); } catch {} app.quit(); });
  ipcMain.on('update:later', () => { const s = loadSettings(); s.updSnooze = Date.now() + 3 * 864e5; saveSettings(s); });
  ipcMain.on('update:run', async () => {
    if (pendingSetup) {
      // скачиваем новый установщик, сверяем контрольную сумму и запускаем его в режиме обновления
      try {
        const f = await downloadVerified(pendingSetup.version, pendingSetup.asset, pendingSetup.sum);
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

// ---------- окно видео поверх игры ----------
// Отдельное маленькое окно поверх всех окон (и поверх игры в окне без рамки): в нём тот же сайт, где видео
// растянуто на всё окно. Можно сделать полупрозрачным и «сквозным» — клики уходят в игру (Ctrl+Alt+M).
const MINI_KEY = 'Control+Alt+M';
let mini = null;
function miniSend(msg) { try { mini?.webContents.send('liquid', msg); } catch {} }
function miniClickThrough(on) {
  if (!mini || mini.isDestroyed()) return;
  mini.__ct = on;
  mini.setIgnoreMouseEvents(on, { forward: true });
  miniSend({ type: 'miniCt', on });
}
function openMini({ url, t, wcId }) {
  if (!/^https?:/.test(String(url))) return false;
  if (mini && !mini.isDestroyed()) mini.close();
  const st = loadSettings().mini || {};
  const area = screen.getPrimaryDisplay().workArea;
  const w = new BrowserWindow({
    width: st.w || 480, height: st.h || 270, minWidth: 240, minHeight: 135,
    x: st.x ?? area.x + area.width - (st.w || 480) - 24, y: st.y ?? area.y + area.height - (st.h || 270) - 24,
    frame: false, alwaysOnTop: true, backgroundColor: '#000000', title: 'Liquid — видео поверх', fullscreenable: false,
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: { preload: WEBVIEW_PRELOAD, partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  mini = w; w.__mini = true; w.__from = wcId; w.__ct = false;
  w.setAlwaysOnTop(true, 'screen-saver');
  try { w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  w.setOpacity(Math.min(1, Math.max(0.3, st.opacity || 1)));
  w.webContents.setWindowOpenHandler(({ url: u }) => { if (win && /^https?:/.test(u)) win.webContents.send('tab:open', { url: u }); return { action: 'deny' }; });
  w.webContents.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { e.preventDefault(); w.close(); } });
  w.webContents.on('did-finish-load', () => miniSend({ type: 'mini', t: Number(t) || 0, opacity: w.getOpacity() }));
  let saveT = 0;
  const keep = () => { clearTimeout(saveT); saveT = setTimeout(() => { if (w.isDestroyed()) return; const b = w.getBounds(); const s = loadSettings(); s.mini = { ...(s.mini || {}), x: b.x, y: b.y, w: b.width, h: b.height, opacity: w.getOpacity() }; saveSettings(s); }, 600); };
  w.on('move', keep); w.on('resize', keep);
  w.on('closed', () => { if (mini === w) mini = null; try { globalShortcut.unregister(MINI_KEY); } catch {} });
  try { globalShortcut.register(MINI_KEY, () => miniClickThrough(!mini?.__ct)); } catch {}
  w.loadURL(url).catch(() => {});
  diag.log('info', 'видео поверх', 'Открыто окно поверх', new URL(url).hostname);
  return true;
}

// ---------- «Смотреть вместе» ----------
let watch = null;
function watchRoom() {
  if (!watch) watch = new WatchRoom({
    onMessage: (m) => { try { win?.webContents.send('watch:msg', m); } catch {} },
    onStatus: (s) => { try { win?.webContents.send('watch:status', s); } catch {} },
    log: (lvl, msg) => diag.log(lvl, 'вместе', msg),
  });
  return watch;
}

// ---------- старт ----------
app.whenReady().then(async () => {
  const bootT0 = Date.now();
  Menu.setApplicationMenu(null);
  applyDns();
  ses = session.fromPartition(PARTITION);
  hardenSession(session.defaultSession);
  await smart.start().catch(() => {});
  syncSmartLists();
  adblock = new AdBlock(app.getPath('userData'));
  if (TEST && process.env.LIQUID_PERF_NOADBLOCK) adblock.init = async () => false; // замер скорости без блокировщика
  const st0 = loadSettings();
  adblock.enabled = st0.adblock !== false;
  adblock.allow = new Set(st0.adAllow || []);
  adblock.topUrlOf = (d) => topUrlOf(d);
  // запасной путь для списков рекламы: через VPN Liquid, если он включён
  let listsSes = null, listsProxy = '';
  adblock.extraFetch = async (u, o) => {
    if (!proxyRules) throw new Error('VPN выключен');
    if (!listsSes) listsSes = session.fromPartition('liquid-lists', { cache: false });
    if (listsProxy !== proxyRules) { await listsSes.setProxy({ proxyRules, proxyBypassRules: '<local>' }); listsProxy = proxyRules; }
    return listsSes.fetch(u, o);
  };
  // счётчик рекламы: раньше сообщение в окно уходило на КАЖДЫЙ заблокированный запрос (на тяжёлой странице — сотни),
  // теперь — не чаще 4 раз в секунду на вкладку; обнуление при переходе — сразу
  const adPending = new Map(); let adT = 0;
  const adFlush = () => {
    clearTimeout(adT); adT = 0;
    for (const [id, n] of adPending) { const wc = webContents.fromId(id); const h = hostOf(wc); if (h && !h.isDestroyed()) h.send('adblock:count', { wcId: id, n }); }
    adPending.clear();
  };
  adblock.onCount = (id, n) => { adPending.set(id, n); if (n === 0) adFlush(); else if (!adT) adT = setTimeout(adFlush, 250); };
  setupSession(ses, false);
  adblock.init((url, opts) => ses.fetch(url, opts)).catch(() => {});
  const binDir = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, 'bin');
  xray = new Xray(binDir, app.getPath('userData'));
  dpiXray = new Xray(binDir, app.getPath('userData'), 'xray-dpi');
  // обход упал — сайты из его списка идут напрямую (в PAC есть DIRECT), пробуем поднять его снова, но не бесконечно
  dpiXray.onExit = (code) => {
    if (!smart.dpi) return;
    smart.dpi = ''; applyProxy({ close: false });
    diag.log('warn', 'обход', `xray обхода остановился (код ${code})`, dpiXray.log ? dpiXray.log.trim().split('\n').slice(-3).join(' / ') : '');
    if (dpiRestarts++ < 3) setTimeout(() => startDpi(), 5000);
  };
  // xray неожиданно завершился: снимаем прокси, иначе ни один сайт не откроется
  xray.onExit = (code) => {
    if (!vpnState.on) return;
    diag.log('error', 'vpn', `xray остановился (код ${code})`, xray.log ? xray.log.trim().split('\n').slice(-3).join(' / ') : '');
    vpnDisconnect().then(() => broadcast('toast', { text: 'VPN отключился: xray остановился. Сайты пока открываются напрямую — включи VPN заново.', error: true }));
  };

  exts = new Extensions(app.getPath('userData'));
  // Окно показываем сразу, а медленные шаги запуска идут параллельно, а не друг за другом.
  // Вкладки страницы ждут их через boot:ready (не дольше 3 секунд), поэтому порядок как раньше.
  const limit = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
  bootReady = Promise.all([limit(startDpi(), 3000), limit(exts.loadAll([ses]), 2000)]);
  bootReady.then(() => diag.log('info', 'запуск', `готово за ${Date.now() - bootT0} мс`));

  app.getGPUInfo('basic').then((g) => {
    const dev = (g.gpuDevice || []).find((x) => x.active) || (g.gpuDevice || [])[0];
    gpuLine = dev ? `${dev.vendorId?.toString(16)}:${dev.deviceId?.toString(16)} драйвер ${dev.driverVersion || '?'}` : '?';
  }).catch(() => {});
  registerIpc();
  // VPN при запуске назначаем до окна: иначе вкладки спросят vpn:startup раньше и откроются напрямую
  if (st0.vpnAuto && st0.vpnKey) {
    vpnStartup = bootReady.then(() => vpnConnect()).catch((e) => {
      const say = () => broadcast('toast', { text: 'VPN: ' + e.message, error: true });
      if (win && win.webContents.isLoading()) win.webContents.once('did-finish-load', say); else say();
    });
  }
  createWindow();
  // игровой режим
  let ownPids = null, ownPidsAt = 0;
  game = new GameMode({
    // список процессов браузера обновляем раз в 30 с, а не при каждой проверке (каждые 4 с)
    isOwnPid: (pid) => {
      const now = Date.now();
      if (!ownPids || now - ownPidsAt > 30e3) { ownPids = new Set(app.getAppMetrics().map((m) => m.pid)); ownPidsAt = now; }
      if (ownPids.has(pid)) return true;
      ownPids = new Set(app.getAppMetrics().map((m) => m.pid)); ownPidsAt = now; // новый процесс вкладки — перепроверяем сразу
      return ownPids.has(pid);
    },
    onChange: ({ on, game: name }) => {
      for (const m of app.getAppMetrics()) {
        try { os.setPriority(m.pid, on ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL); } catch {}
      }
      broadcast('game:state', { on, game: name, keepAudio: loadSettings().gameKeepAudio !== false });
    },
  });
  game.enabled = loadSettings().gameMode !== false && !TEST;
  if (!TEST) setTimeout(() => game.start(), 6000);
  announceUpdate();
  fixShortcuts();
  setTimeout(() => checkUpdates(), 60_000);          // через минуту после запуска
  setInterval(() => checkUpdates(), 3 * 3600e3);     // и раз в 3 часа

});

app.on('before-quit', () => { if (xray) xray.stop(); dpiXray?.stop(); game?.stop(); watch?.leave(true); try { globalShortcut.unregisterAll(); } catch {} });
app.on('window-all-closed', () => { if (xray) xray.stop(); app.quit(); });

// Одна копия приложения
if (!firstInstance) app.quit();
else app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); } else createWindow(); });
