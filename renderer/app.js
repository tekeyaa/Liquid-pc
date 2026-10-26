/* Liquid — логика интерфейса */
const $ = (s) => document.querySelector(s);
const L = window.liquid;
const NEWTAB = new URL('newtab.html', location.href).href;
const ERRPAGE = new URL('error.html', location.href).href;
const PARTITION = L.part || 'persist:liquid';
if (L.incognito) document.body.classList.add('incognito');

const SEARCH = {
  google: 'https://www.google.com/search?q=',
  yandex: 'https://yandex.ru/search/?text=',
  ddg: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
};

let settings = { model: 'claude-sonnet-5-5', search: 'google' };
const tabs = [];
let active = null;
let uid = 0;

if (L.platform === 'darwin') document.body.classList.add('mac');

// ---------- журнал: всё, что ломается в интерфейсе, уходит в лог ----------
window.addEventListener('error', (e) => L.diag.log('error', 'интерфейс', e.message || String(e.error), `${(e.filename || '').split('/').pop()}:${e.lineno}:${e.colno}${e.error && e.error.stack ? ' ' + e.error.stack.split('\n').slice(1, 3).join(' ').trim() : ''}`));
window.addEventListener('unhandledrejection', (e) => L.diag.log('error', 'интерфейс', 'Необработанная ошибка: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason)));


// ---------- утилиты ----------
let toastT;
function toast(text, error, action) {
  if (error) L.diag.log('warn', 'сообщение', text); // всё, что браузер показал как ошибку, тоже пишем
  const t = $('#toast');
  t.textContent = text;
  if (action) {
    const b = document.createElement('button'); b.className = 'toast-act'; b.textContent = action.label;
    b.onclick = () => { t.classList.remove('show'); action.run(); };
    t.appendChild(b);
  }
  t.classList.toggle('act', !!action);
  t.classList.toggle('error', !!error);
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), action ? 6000 : error ? 5200 : 2600);
}

function toUrl(input) {
  const s = input.trim();
  if (!s) return NEWTAB;
  if (/^(https?|file|about|data):/i.test(s)) return s;
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s) || /^\[[0-9a-f:]+\](:\d+)?(\/|$)/i.test(s)) return 'http://' + s;
  if (!/\s/.test(s) && /^[^\s/]+\.[a-zа-яё]{2,}(:\d+)?(\/.*)?$/i.test(s)) return 'https://' + s;
  return (SEARCH[settings.search] || SEARCH.google) + encodeURIComponent(s);
}
const isInternal = (u) => !u || u.startsWith(NEWTAB.split('#')[0]) || u.startsWith(ERRPAGE.split('#')[0]);
const newtabUrl = () => `${NEWTAB}#search=${settings.search}${L.incognito ? '&private=1' : ''}`;

// ---------- вкладки ----------
// Вкладка живёт и без webview: «спящая» вкладка хранит только адрес, заголовок и иконку (почти 0 МБ ОЗУ)
const BLOCK_ERRORS = [-101, -100, -118, -7, -105, -107, -324, -356, -137, -21];
const closedTabs = [];
let split = null; // { left, right, ratio }

function createTab(url, { background = false, lazy = false, title = '', favicon = '', after = null } = {}) {
  const id = ++uid;
  const el = document.createElement('div');
  el.className = 'tab';
  el.innerHTML = `
    <span class="spin"></span>
    <img class="fav" alt="" />
    <span class="title">Новая вкладка</span>
    <svg class="audio" viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/></svg>
    <button class="x" title="Закрыть"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button>`;
  const fav = el.querySelector('.fav');
  fav.src = favicon || 'favicon.svg';
  fav.onerror = () => { fav.src = 'favicon.svg'; };

  const startUrl = url ? toUrl(url) : newtabUrl();
  const tab = { id, wv: null, el, fav, title: title || 'Новая вкладка', url: startUrl, favicon, loading: false, wcId: null, lastActive: Date.now(), page: {}, ads: 0 };
  if (after && tabs.includes(after)) tabs.splice(tabs.indexOf(after) + 1, 0, tab); else tabs.push(tab);

  el.addEventListener('mousedown', (e) => {
    if (e.button === 1) { e.preventDefault(); closeTab(tab); return; }
    if (e.button === 0 && !e.target.closest('.x')) activate(tab);
  });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); tabMenu(tab, e.clientX, e.clientY); });
  el.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab); });

  if (after && tabs.includes(after) && after.el.nextSibling) $('#tabs').insertBefore(el, after.el.nextSibling); else $('#tabs').appendChild(el);
  if (lazy) { tab.sleeping = true; el.classList.add('sleeping'); updateTab(tab); }
  else attachWebview(tab, startUrl);
  if (!background || !active) activate(tab);
  fitTabs();
  saveSession();
  return tab;
}

function attachWebview(tab, url) {
  const wv = document.createElement('webview');
  wv.setAttribute('partition', PARTITION);
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('webpreferences', 'contextIsolation=yes');
  wv.src = url;
  tab.wv = wv;
  tab.sleeping = false;
  tab.loading = true;
  tab.el.classList.remove('sleeping');
  const { fav, el } = tab;

  wv.addEventListener('dom-ready', () => {
    if (!tab.wcId) tab.wcId = wv.getWebContentsId();
    if (isInternal(tab.url) && window.sendTheme) window.sendTheme(wv);
  });
  wv.addEventListener('page-title-updated', (e) => { tab.title = e.title; updateTab(tab); window.historyTitle && window.historyTitle(tab); });
  wv.addEventListener('page-favicon-updated', (e) => { if (e.favicons?.length) { tab.favicon = e.favicons[e.favicons.length - 1]; fav.src = tab.favicon; saveSession(); } });
  wv.addEventListener('did-start-loading', () => { tab.loading = true; updateTab(tab); });
  wv.addEventListener('did-stop-loading', () => { tab.loading = false; updateTab(tab); guardScan(tab); saveSession(); });
  wv.addEventListener('media-started-playing', () => { el.classList.add('playing'); tab.playing = true; });
  wv.addEventListener('media-paused', () => { el.classList.remove('playing'); tab.playing = false; });
  wv.addEventListener('focus', () => { if (split && (tab === split.left || tab === split.right) && active !== tab) focusPane(tab); });
  wv.addEventListener('ipc-message', (e) => {
    if (e.channel !== 'liquid') return;
    const m = e.args[0] || {};
    if (m.type === 'nav') { mouseNav(tab, m.dir); return; }
    window.onPageMsg && window.onPageMsg(tab, m);
  });
  const onNav = (e) => {
    if (e.isMainFrame === false) return;
    tab.url = wv.getURL();
    if (isInternal(tab.url)) { fav.src = 'favicon.svg'; tab.favicon = ''; }
    updateTab(tab);
  };
  wv.addEventListener('did-navigate', (e) => {
    fav.src = 'favicon.svg'; tab.favicon = ''; tab.guard = null; tab.page = {}; tab.translated = false; tab.ads = 0;
    onNav(e);
    if (/^https?:/.test(e.url)) {
      window.historyAdd && window.historyAdd(tab, e.url);
    }
  });
  wv.addEventListener('did-navigate-in-page', (e) => { onNav(e); if (e.isMainFrame && /^https?:/.test(e.url)) window.historyAdd && window.historyAdd(tab, e.url); });
  wv.addEventListener('did-fail-load', async (e) => {
    if (!e.isMainFrame || e.errorCode === -3) return; // -3 = отменено
    const blocked = BLOCK_ERRORS.includes(e.errorCode);
    L.diag.log('warn', 'загрузка', `${e.errorDescription} (${e.errorCode})${blocked ? ' — похоже на блокировку' : ''}`, L.incognito ? '(инкогнито — адрес не записан)' : e.validatedURL);
    // Авто-VPN: сайт похож на заблокированный → пробуем через VPN один раз
    if (blocked && !(tab.unblocked || (tab.unblocked = new Set())).has(e.validatedURL)) {
      tab.unblocked.add(e.validatedURL);
      const r = await L.vpnUnblock(e.validatedURL);
      if (r.ok) {
        toast(`${r.host} похоже заблокирован — открываю через VPN`);
        wv.loadURL(e.validatedURL);
        return;
      }
    }
    const hint = settings._vpnOn ? '' : 'vpn';
    wv.loadURL(`${ERRPAGE}#${encodeURIComponent(JSON.stringify({ url: e.validatedURL, code: e.errorCode, desc: e.errorDescription, hint }))}`);
  });
  // событие «crashed» в новых Electron убрано — падение вкладки приходит только так
  wv.addEventListener('render-process-gone', (e) => {
    const why = (e.details && e.details.reason) || e.reason || '';
    if (why === 'clean-exit') return;
    // в журнал падение пишет основной процесс, здесь только сообщение
    if (tab === active) toast('Вкладка упала — нажми «Обновить». Ошибка записана в журнал.', true);
  });
  wv.addEventListener('enter-html-full-screen', () => document.body.classList.add('fs'));
  wv.addEventListener('leave-html-full-screen', () => document.body.classList.remove('fs'));
  wv.addEventListener('found-in-page', (e) => {
    const r = e.result;
    if (r.finalUpdate) $('#findCount').textContent = r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : '0';
  });
  $('#views').appendChild(wv);
  layoutViews();
  return wv;
}

// боковые кнопки мыши (XButton1/2): назад и вперёд — и над страницей, и над панелью браузера
let lastMouseNav = 0;
function mouseNav(tab, dir) {
  const wv = tab && tab.wv; if (!wv) return;
  // одно нажатие приходит и событием мыши, и командой окна Windows — второе пропускаем
  if (Date.now() - lastMouseNav < 350) return;
  lastMouseNav = Date.now();
  try { if (dir === 'back' ? wv.canGoBack() : wv.canGoForward()) dir === 'back' ? wv.goBack() : wv.goForward(); } catch {}
}
window.mouseNav = mouseNav;
for (const ev of ['mousedown', 'mouseup', 'auxclick']) {
  window.addEventListener(ev, (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    if (ev === 'mouseup') mouseNav(active, e.button === 3 ? 'back' : 'forward');
  }, true);
}

function sleepTab(tab) {
  if (!tab.wv || tab === active || tab.playing || (split && (tab === split.left || tab === split.right))) return false;
  try { tab.url = tab.wv.getURL() || tab.url; } catch {}
  tab.wv.remove();
  tab.wv = null;
  tab.wcId = null;
  tab.sleeping = true;
  tab.loading = false;
  tab.el.classList.add('sleeping');
  tab.el.classList.remove('playing');
  return true;
}
// фоновые вкладки засыпают сами
setInterval(() => {
  const mins = Number(settings.sleepAfter ?? 20);
  if (!mins) return;
  const now = Date.now();
  for (const t of tabs) if (t.wv && t !== active && now - t.lastActive > mins * 60e3) sleepTab(t);
}, 60e3);

function updateTab(tab) {
  const { el } = tab;
  el.classList.toggle('loading', !!tab.loading);
  const title = isInternal(tab.url) ? (tab.url.startsWith(ERRPAGE.split('#')[0]) ? 'Не открылось' : 'Новая вкладка') : (tab.title || tab.url);
  el.querySelector('.title').textContent = title;
  el.title = title + (tab.sleeping ? '\n💤 Спит — проснётся при клике' : '');
  if (tab === active) syncChrome();
}

function activate(tab) {
  if (active === tab) return;
  if (tab.frozen) { tab.frozen = false; tab.el.classList.remove('frozen'); if (tab.wcId) L.tabs.freeze([tab.wcId], false); } // игровой режим: открытую вкладку размораживаем
  // выбрали вкладку не из пары — выходим из режима «два сайта»
  if (split && tab !== split.left && tab !== split.right) endSplit(false);
  if (active) active.lastActive = Date.now();
  active?.el.classList.remove('active');
  active = tab;
  if (!tab.wv) attachWebview(tab, tab.url);
  tab.el.classList.add('active');
  tab.lastActive = Date.now();
  tab.el.scrollIntoView({ inline: 'nearest', behavior: 'smooth' });
  layoutViews();
  syncChrome();
  closeFind();
  window.onTabActivated && window.onTabActivated(tab);
  if (isInternal(tab.url)) setTimeout(() => $('#url').focus(), 60);
  else tab.wv.focus();
  saveSession();
}

function layoutViews() {
  const views = $('#views');
  views.classList.toggle('split', !!split);
  if (split) views.style.setProperty('--split', (split.ratio * 100).toFixed(2) + '%');
  for (const t of tabs) {
    if (!t.wv) continue;
    const l = split && t === split.left, r = split && t === split.right;
    t.wv.classList.toggle('active', t === active || l || r);
    t.wv.classList.toggle('split-l', !!l);
    t.wv.classList.toggle('split-r', !!r);
    t.wv.classList.toggle('focused', !!split && t === active);
    t.el.classList.toggle('paired', !!(l || r));
  }
}

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  if (!L.incognito && !isInternal(tab.url)) { closedTabs.push({ url: tab.wv ? tab.wv.getURL() : tab.url, title: tab.title, i }); if (closedTabs.length > 25) closedTabs.shift(); }
  if (split && (tab === split.left || tab === split.right)) endSplit(true, tab);
  tabs.splice(i, 1);
  tab.el.classList.add('closing');
  if (tab.wv) tab.wv.style.visibility = 'hidden';
  setTimeout(() => { tab.el.remove(); tab.wv?.remove(); fitTabs(); }, 300);
  if (active === tab) {
    active = null;
    if (tabs.length) activate(tabs[Math.min(i, tabs.length - 1)]);
    else createTab();
  }
  saveSession();
}

function reopenClosed() {
  const c = closedTabs.pop();
  if (!c) { toast('Нет закрытых вкладок'); return; }
  const t = createTab(c.url, { title: c.title });
  const at = Math.min(c.i, tabs.length - 1);
  tabs.splice(tabs.indexOf(t), 1); tabs.splice(at, 0, t);
  // вставляем перед следующей вкладкой, а не по номеру элемента: в полосе вкладок есть ещё и подсветка активной
  $('#tabs').insertBefore(t.el, tabs[at + 1]?.el || null);
  saveSession();
}

// ---------- два сайта рядом ----------
function startSplit(rightUrl) {
  if (!active) return;
  const left = active;
  let right = null;
  if (rightUrl === undefined) {
    // берём последнюю открытую другую вкладку, иначе — новую
    right = tabs.filter((t) => t !== left).sort((a, b) => b.lastActive - a.lastActive)[0] || null;
  }
  if (!right) right = createTab(rightUrl || null, { background: true, after: left });
  if (!right.wv) attachWebview(right, right.url);
  split = { left, right, ratio: 0.5 };
  document.body.classList.add('split-on');
  layoutViews();
  focusPane(right);
}
function endSplit(keepActive = true, closing = null) {
  if (!split) return;
  const keep = closing ? (closing === split.left ? split.right : split.left) : active;
  split = null;
  document.body.classList.remove('split-on');
  if (keepActive && keep) { active = null; activate(keep); }
  layoutViews();
}
function focusPane(tab) {
  if (active === tab) return;
  active?.el.classList.remove('active');
  active = tab;
  tab.el.classList.add('active');
  tab.lastActive = Date.now();
  layoutViews();
  syncChrome();
  window.onTabActivated && window.onTabActivated(tab);
}
(() => {
  const bar = $('#splitBar');
  let drag = false;
  bar.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; drag = true; bar.setPointerCapture(e.pointerId); document.body.classList.add('resizing'); });
  bar.addEventListener('pointermove', (e) => {
    if (!drag || !split) return;
    const r = $('#views').getBoundingClientRect();
    split.ratio = Math.min(0.8, Math.max(0.2, (e.clientX - r.left) / r.width));
    $('#views').style.setProperty('--split', (split.ratio * 100).toFixed(2) + '%');
  });
  bar.addEventListener('pointerup', () => { drag = false; document.body.classList.remove('resizing'); });
  $('#splitSwap').onclick = () => { if (!split) return; [split.left, split.right] = [split.right, split.left]; layoutViews(); };
  $('#splitClose').onclick = () => endSplit(true);
})();

// ---------- меню вкладки ----------
function tabMenu(tab, x, y) {
  const m = $('#tabMenu');
  const items = [
    ['Открыть рядом с текущей', () => { if (tab === active) startSplit(); else startSplitWith(active, tab); }],
    [tab.sleeping ? 'Разбудить' : 'Усыпить (освободить память)', () => { if (tab.sleeping) activate(tab); else if (!sleepTab(tab)) toast('Эту вкладку сейчас нельзя усыпить'); }],
    ['Дублировать', () => createTab(tab.wv ? tab.wv.getURL() : tab.url, { after: tab })],
    ['Закрыть другие', () => tabs.filter((t) => t !== tab).forEach(closeTab)],
    ['Закрыть', () => closeTab(tab)],
  ];
  m.innerHTML = items.map(([t], i) => `<button data-i="${i}">${t}</button>`).join('');
  m.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; hideTabMenu(); items[+b.dataset.i][1](); };
  m.style.left = Math.min(x, innerWidth - 240) + 'px';
  m.style.top = y + 6 + 'px';
  m.classList.add('open');
  setTimeout(() => document.addEventListener('mousedown', hideTabMenu, { once: true }), 0);
}
function hideTabMenu(e) { if (e && e.target.closest && e.target.closest('#tabMenu')) { document.addEventListener('mousedown', hideTabMenu, { once: true }); return; } $('#tabMenu').classList.remove('open'); }
function startSplitWith(left, right) {
  if (!right.wv) attachWebview(right, right.url);
  split = { left, right, ratio: 0.5 };
  document.body.classList.add('split-on');
  active?.el.classList.remove('active');
  active = left; left.el.classList.add('active');
  layoutViews(); syncChrome();
}

// ---------- восстановление сессии ----------
let saveT = 0;
function saveSession() {
  if (L.incognito) return;
  clearTimeout(saveT);
  saveT = setTimeout(writeSession, 400);
}
function writeSession() {
  const data = {
    tabs: tabs.map((t) => ({ url: t.wv ? (safeUrl(t.wv) || t.url) : t.url, title: t.title, favicon: t.favicon || '' })),
    active: Math.max(0, tabs.indexOf(active)),
  };
  try { localStorage.setItem('liquid.session', JSON.stringify(data)); } catch {}
}
function safeUrl(wv) { try { return wv.getURL(); } catch { return ''; } }
function restoreSession() {
  if (L.incognito || !settings.restore) return false;
  let data;
  try { data = JSON.parse(localStorage.getItem('liquid.session')); } catch {}
  // номер активной считаем до фильтрации, иначе после выброшенных страниц ошибки откроется соседняя вкладка
  const all = (data?.tabs || []).map((t, i) => ({ ...t, i }));
  const list = all.filter((t) => t.url && !t.url.startsWith(ERRPAGE.split('#')[0]));
  if (!list.length || list.every((t) => isInternal(t.url))) return false;
  let ai = list.findIndex((t) => t.i === (data.active || 0));
  if (ai < 0) ai = list.length - 1;
  list.forEach((t, i) => {
    const internal = isInternal(t.url);
    createTab(internal ? null : t.url, { background: i !== ai, lazy: i !== ai, title: t.title, favicon: t.favicon });
  });
  activate(tabs[ai]);
  return true;
}
window.addEventListener('beforeunload', () => { clearTimeout(saveT); if (!L.incognito) writeSession(); });

function fitTabs() {
  requestAnimationFrame(() => {
    const w = ($('#tabsrow').clientWidth - 230) / Math.max(tabs.length, 1);
    tabs.forEach((t) => t.el.classList.toggle('narrow', w < 90 && t !== active));
  });
}
window.addEventListener('resize', fitTabs);

function syncChrome() {
  if (!active) return;
  const { wv, url, loading } = active;
  const urlInput = $('#url');
  if (document.activeElement !== urlInput) urlInput.value = isInternal(url) ? '' : decodeSafe(url);
  $('#omni').classList.toggle('https', url.startsWith('https://'));
  renderGuard(active);
  const showLoad = loading && !isInternal(url);
  const wasLoading = document.body.classList.contains('loading');
  document.body.classList.toggle('loading', showLoad);
  if (wasLoading && !showLoad) {
    document.body.classList.add('loaded');
    clearTimeout(syncChrome.t);
    syncChrome.t = setTimeout(() => document.body.classList.remove('loaded'), 600);
  }
  try {
    $('#back').disabled = !wv.canGoBack();
    $('#fwd').disabled = !wv.canGoForward();
  } catch { /* webview ещё не готов */ }
  window.syncOmniExtras && window.syncOmniExtras(active);
}
function decodeSafe(u) { try { return decodeURI(u); } catch { return u; } }

function navigate(input) {
  const url = toUrl(input);
  if (!active) return createTab(url);
  if (!active.wv) attachWebview(active, url);
  else active.wv.loadURL(url === NEWTAB ? newtabUrl() : url);
  active.wv.focus();
}

// ---------- навигация ----------
$('#back').onclick = () => active?.wv.canGoBack() && active.wv.goBack();
$('#fwd').onclick = () => active?.wv.canGoForward() && active.wv.goForward();
$('#reload').onclick = () => { if (!active) return; active.loading ? active.wv.stop() : active.wv.reload(); };
$('#newTab').onclick = () => createTab();
$('#omni').addEventListener('submit', (e) => { e.preventDefault(); navigate($('#url').value); $('#url').blur(); });
$('#url').addEventListener('focus', (e) => setTimeout(() => e.target.select(), 0));
$('#url').addEventListener('blur', syncChrome);
$('#url').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#url').blur(); active?.wv.focus(); } });

// окно
$('#winctl').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) L.win[b.dataset.act]();
});
$('.drag-fill').addEventListener('dblclick', () => L.win.max());

// ---------- поповеры ----------
function openPop(id) {
  closePops();
  $(id).classList.add('open');
  document.body.classList.add('popped');
}
function closePops() {
  document.querySelectorAll('.pop.open').forEach((p) => p.classList.remove('open'));
  document.body.classList.remove('popped');
}
$('#scrim').onclick = closePops;

// ---------- VPN ----------
function renderVpn(s) {
  settings._vpnOn = s.on;
  const btn = $('#vpnBtn');
  const pop = $('#vpnPop');
  btn.classList.toggle('on', s.on);
  btn.classList.toggle('busy', !!s.busy);
  pop.classList.toggle('on', s.on);
  pop.classList.toggle('busy', !!s.busy);
  btn.querySelector('.lbl').textContent = s.on ? (s.country || 'VPN') : 'VPN';
  $('#vpnTitle').textContent = s.busy ? 'Подключаю…' : s.on ? 'Подключён' : 'Выключен';
  $('#vpnSub').textContent = s.on
    ? `${s.name}${s.country ? ' · ' + s.country : ''}${s.ip ? ' · ' + s.ip : ''}`
    : settings.hasVpnKey ? `Сохранён ключ: ${settings.vpnName || 'без имени'}` : 'Вставь ключ ниже';
  $('#vpnConnect').textContent = s.on ? 'Отключить' : 'Подключить';
  $('#vpnConnect').disabled = !!s.busy;
}

async function vpnToggle(keyFromField) {
  $('#vpnErr').classList.remove('show');
  const st = await L.vpn.state();
  if (st.on && !keyFromField) { renderVpn((await L.vpn.disconnect()).state); toast('VPN выключен'); return; }
  const key = keyFromField || undefined;
  if (!key && !settings.hasVpnKey) { $('#vpnKey').focus(); showVpnErr('Сначала вставь ключ'); return; }
  const r = await L.vpn.connect(key);
  if (r.ok) {
    settings = await L.settings.get();
    $('#vpnKey').value = '';
    renderVpn(r.state);
    toast(`VPN включён${r.state.country ? ' · ' + r.state.country : ''}`);
    active?.wv.reload();
  } else showVpnErr(r.error);
}
function showVpnErr(t) { const e = $('#vpnErr'); e.textContent = t; e.classList.add('show'); }

$('#vpnBtn').onclick = () => { openPop('#vpnPop'); renderVpnFromState(); };
$('#vpnOrb').onclick = () => vpnToggle($('#vpnKey').value.trim());
$('#vpnConnect').onclick = () => vpnToggle($('#vpnKey').value.trim());
$('#vpnForget').onclick = async () => {
  await L.vpn.disconnect();
  settings = await L.settings.set({ forgetVpn: true });
  renderVpnFromState();
  toast('Ключ удалён');
};
$('#vpnAuto').onchange = async (e) => { settings = await L.settings.set({ vpnAuto: e.target.checked }); };
async function renderVpnFromState() { renderVpn(await L.vpn.state()); }
L.vpn.onState(renderVpn);

// ---------- настройки ----------
window.openSettings = (tab) => {
  openPop('#setPop');
  if (tab) window.setTab(tab);
  setTimeout(refreshFps, 350);
  window.onSettingsOpen && window.onSettingsOpen();
};
window.setTab = (name) => {
  document.querySelectorAll('#setNav button').forEach((b) => b.classList.toggle('on', b.dataset.t === name));
  document.querySelectorAll('#setPop .set-sec').forEach((sec) => sec.classList.toggle('on', sec.dataset.t === name));
  if (name === 'perf') setTimeout(() => { refreshFps(); window.refreshMem && window.refreshMem(); }, 200);
};
$('#setNav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) window.setTab(b.dataset.t); });
$('#saveKey').onclick = async () => {
  const v = $('#claudeKey').value.trim();
  settings = await L.settings.set({ claudeKey: v });
  $('#claudeKey').value = '';
  $('#claudeKey').placeholder = settings.hasClaudeKey ? '•••••••• сохранён' : 'sk-ant-…';
  toast(v ? 'Ключ Claude сохранён' : 'Ключ Claude удалён');
};
$('#claudeMode').onchange = async (e) => { settings = await L.settings.set({ claudeMode: e.target.value }); applyClaudeMode(); };
$('#model').onchange = async (e) => { settings = await L.settings.set({ model: e.target.value }); };
$('#search').onchange = async (e) => { settings = await L.settings.set({ search: e.target.value }); };
$('#clearData').onclick = async () => { await L.settings.clearData(); toast('Куки и кэш очищены'); };
$('#getKey').onclick = (e) => { e.preventDefault(); closePops(); createTab('https://console.anthropic.com/settings/keys'); };


// ---------- Claude-защита ----------
// Известные сайты (и их поддомены) не проверяем — экономим запросы
const TRUSTED = ['google.com', 'youtube.com', 'twitch.tv', 'github.com', 'yandex.ru', 'ya.ru', 'vk.com', 'mail.ru', 'gosuslugi.ru',
  'sberbank.ru', 'tbank.ru', 'tinkoff.ru', 'alfabank.ru', 'vtb.ru', 'ozon.ru', 'wildberries.ru', 'avito.ru', 'microsoft.com', 'live.com',
  'apple.com', 'icloud.com', 'steampowered.com', 'steamcommunity.com', 'discord.com', 'telegram.org', 'reddit.com', 'x.com',
  'anthropic.com', 'claude.ai', 'epicgames.com', 'paypal.com', 'amazon.com', 'facebook.com', 'instagram.com', 'wikipedia.org'];
const guardCache = new Map(); // origin -> {verdict, reason}

function isTrusted(host) { return TRUSTED.some((d) => host === d || host.endsWith('.' + d)); }

async function guardScan(tab, force) {
  if (!settings.guard && !force) return;
  if (isInternal(tab.url) || !/^https?:/.test(tab.url)) return;
  let u; try { u = new URL(tab.url); } catch { return; }
  const origin = u.origin;
  if (guardCache.has(origin) && !force) { tab.guard = guardCache.get(origin); renderGuard(tab); return; }

  let info;
  try {
    info = await tab.wv.executeJavaScript(`(() => {
      const q = (s) => Array.from(document.querySelectorAll(s));
      const pass = q('input[type=password]').length;
      const card = q('input[autocomplete^="cc-"], input[name*="card" i], input[id*="card" i], input[placeholder*="карт" i], input[name*="cvv" i], input[name*="cvc" i]').length;
      const actions = Array.from(new Set(q('form').map(f => { try { return new URL(f.action, location.href).host; } catch { return ''; } }).filter(Boolean)));
      return { pass, card, actions, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, 2500) };
    })()`);
  } catch { return; }
  if (!info || (!info.pass && !info.card && !force)) return;

  tab.guard = { verdict: 'checking' };
  renderGuard(tab);
  tab.guard = await guardVerdict(u, info, force);
  if (tab.guard.verdict !== 'unknown') guardCache.set(origin, tab.guard);
  renderGuard(tab);
  if (tab === active && tab.guard.verdict === 'danger') showDanger(tab.guard.reason);
  if (tab === active && tab.guard.verdict === 'caution') toast('⚠ ' + tab.guard.reason, true);
}

// вердикт для страницы с паролем или картой — одни правила для вкладок и окон входа
async function guardVerdict(u, info, force) {
  if (isTrusted(u.hostname) && !force) return { verdict: 'safe', reason: `${u.hostname} — известный сайт.` };
  if (u.protocol === 'http:' && !force) return { verdict: 'caution', reason: 'Сайт без шифрования (http) просит пароль или карту — данные могут перехватить.' };
  let r = { verdict: 'unknown' };
  if (settings.hasClaudeKey) r = await L.claude.check({ url: u.href, host: u.hostname, title: info.title, passwordFields: info.pass, cardFields: info.card, formTargets: info.actions, text: info.text });
  if (!r || r.verdict === 'unknown') r = localGuard(u, info);
  return r;
}

// Базовая проверка без API: двойники брендов, мусорные домены, формы на чужой сайт
const BRANDS = ['steamcommunity', 'steampowered', 'steam', 'google', 'yandex', 'sberbank', 'tinkoff', 'tbank', 'gosuslugi', 'telegram',
  'discord', 'paypal', 'apple', 'icloud', 'microsoft', 'epicgames', 'twitch', 'binance', 'bybit', 'ozon', 'wildberries', 'avito',
  'alfabank', 'instagram', 'facebook', 'roblox', 'faceit', 'youtube', 'github', 'vkontakte', 'mailru', 'anthropic', 'claude'];
const BAD_TLD = ['top', 'xyz', 'click', 'icu', 'buzz', 'rest', 'cfd', 'sbs', 'cyou', 'monster', 'gq', 'tk', 'ml', 'ga', 'cf', 'shop', 'live', 'fun', 'online', 'site'];
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function localGuard(u, info) {
  const host = u.hostname.toLowerCase();
  const parts = host.split('.');
  const tld = parts[parts.length - 1];
  const base = parts.length > 1 ? parts[parts.length - 2] : host;
  const tokens = host.split(/[.-]/).filter((t) => t.length >= 4);
  for (const b of BRANDS) {
    const tol = b.length >= 7 ? 2 : 1;
    for (const t of tokens) {
      if (t === b) return { verdict: 'danger', reason: `В адресе «${b}», но это не официальный сайт — так выглядят подделки.` };
      if (Math.abs(t.length - b.length) <= tol && lev(t, b) <= tol) return { verdict: 'danger', reason: `«${t}» в адресе очень похоже на «${b}» — вероятно, подделка.` };
    }
  }
  if (host.includes('xn--')) return { verdict: 'caution', reason: 'В адресе спрятаны похожие символы из других алфавитов.' };
  const foreign = (info.actions || []).filter((h) => h && h !== u.host && !h.endsWith('.' + base + '.' + tld));
  if (foreign.length) return { verdict: 'caution', reason: `Форма отправляет данные на другой сайт: ${foreign[0]}.` };
  if (BAD_TLD.includes(tld)) return { verdict: 'caution', reason: `Зона .${tld} часто используется мошенниками — проверь, тот ли это сайт.` };
  if (/бесплатн|подар|выигр|приз|код из смс|скин/i.test(info.text || '')) return { verdict: 'caution', reason: 'На странице обещают подарки или выигрыш и просят войти — частая схема угона аккаунтов.' };
  return { verdict: 'unknown', reason: 'Явных признаков обмана нет (базовая проверка без ключа API).' };
}

const GUARD_TITLE = { checking: 'Claude проверяет сайт…', safe: 'Claude: выглядит безопасно', caution: 'Claude: будь осторожен', danger: 'Claude: опасный сайт', unknown: 'Claude-защита' };
function renderGuard(tab) {
  if (tab !== active) return;
  const omni = $('#omni');
  const g = tab.guard;
  if (!g) { delete omni.dataset.guard; $('#danger').classList.remove('open'); return; }
  omni.dataset.guard = g.verdict;
  $('#shield').title = GUARD_TITLE[g.verdict] + (g.reason ? '\n' + g.reason : '');
  if (g.verdict !== 'danger') $('#danger').classList.remove('open');
}
// окна входа и оплаты: страницу разбирает основной процесс, вердикт считаем здесь теми же правилами, что для вкладок
L.claude.onPopupCheck(async ({ id, url, info }) => {
  let r = { verdict: 'unknown' };
  try {
    const u = new URL(url);
    r = guardCache.get(u.origin) || await guardVerdict(u, info, false);
    if (r.verdict !== 'unknown') guardCache.set(u.origin, r);
  } catch {}
  L.claude.popupResult(id, r);
});

function showDanger(reason) { $('#dangerText').textContent = reason; $('#danger').classList.add('open'); }

$('#shield').onclick = () => {
  const g = active?.guard;
  if (!g || g.verdict === 'checking') return;
  if (g.verdict === 'danger') showDanger(g.reason);
  else toast(`${GUARD_TITLE[g.verdict]}${g.reason ? '\n' + g.reason : ''}`, g.verdict === 'caution');
};
$('#dangerLeave').onclick = () => {
  $('#danger').classList.remove('open');
  if (!active) return;
  if (active.wv.canGoBack()) active.wv.goBack(); else active.wv.loadURL(newtabUrl());
};
$('#dangerStay').onclick = () => $('#danger').classList.remove('open');
$('#guard').onchange = async (e) => { settings = await L.settings.set({ guard: e.target.checked }); };

// ---------- обновления ----------
// автообновление выключено — предлагаем поставить новую версию вручную
L.update.on(({ latest, current }) => {
  $('#updText').textContent = `Вышел Liquid ${latest} (у тебя ${current}). Браузер скачает установщик, закроется, обновится и откроется сам. Что нового — в CHANGELOG.`;
  $('#update').classList.add('open');
});
$('#updRun').onclick = () => { $('#update').classList.remove('open'); L.update.run(); };
$('#updLater').onclick = () => { $('#update').classList.remove('open'); L.update.later(); };


// ---------- плавность: частота монитора и реальный FPS ----------
function measureFps(ms = 1000) {
  return new Promise((res) => {
    let n = 0; const t0 = performance.now();
    const f = (t) => { n++; if (t - t0 < ms) requestAnimationFrame(f); else res(Math.round(n * 1000 / (t - t0))); };
    requestAnimationFrame(f);
  });
}
async function refreshFps() {
  const d = await L.display();
  $('#hzMon').textContent = `${d.hz} Гц`;
  $('#hzReal').textContent = '…';
  const real = await measureFps();
  const target = settings.fps === '60' ? Math.min(60, d.hz) : d.hz;
  const ok = real >= target * 0.9;
  $('#hzReal').textContent = `${Math.min(real, 999)} FPS`;
  $('#hzReal').className = 'fps-big ' + (ok ? 'good' : real < target * 0.75 ? 'bad' : '');
  let hint = '';
  if (settings.fps === '60') hint = 'Анимации ограничены 60 кадрами — меньше нагрузка на видеокарту.';
  else if (!ok && d.hz > 75) {
    hint = d.primary < d.hz
      ? 'Похоже, Windows подстраивается под основной монитор (' + d.primary + ' Гц). Сделай этот монитор основным в «Параметры → Дисплей».'
      : 'Анимации ниже частоты монитора. Проверь в Windows «Параметры → Дисплей → Частота обновления».';
  } else if (ok) hint = 'Всё отлично: анимации идут на полной частоте монитора.';
  $('#fpsHint').textContent = hint;
}
$('#fps').onchange = async (e) => {
  settings = await L.settings.set({ fps: e.target.value });
  toast('Перезапускаю браузер, чтобы применить…');
  setTimeout(() => L.relaunch(), 900);
};

// ---------- поиск по странице ----------
function openFind() {
  $('#find').classList.add('open');
  $('#findInput').focus();
  $('#findInput').select();
}
function closeFind() {
  if (!$('#find').classList.contains('open')) return;
  $('#find').classList.remove('open');
  $('#findCount').textContent = '';
  try { active?.wv.stopFindInPage('clearSelection'); } catch {}
}
function doFind(forward = true, findNext = true) {
  const q = $('#findInput').value;
  if (!q) { try { active.wv.stopFindInPage('clearSelection'); } catch {} $('#findCount').textContent = ''; return; }
  active?.wv.findInPage(q, { forward, findNext });
}
$('#findInput').addEventListener('input', () => doFind(true, false));
$('#findInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doFind(!e.shiftKey, true);
  if (e.key === 'Escape') closeFind();
});
$('#findNext').onclick = () => doFind(true);
$('#findPrev').onclick = () => doFind(false);
$('#findClose').onclick = closeFind;

// ---------- Claude ----------
const chat = { messages: [], busyId: null, useCtx: true };

let sideIdleT = 0;
function toggleSide(force) {
  const on = force ?? !document.body.classList.contains('side');
  clearTimeout(sideIdleT);
  if (!on && claudeWv) sideIdleT = setTimeout(() => { if (!document.body.classList.contains('side') && claudeWv) { claudeWv.remove(); claudeWv = null; } }, 5 * 60e3);
  document.body.classList.toggle('side', on);
  $('#claudeBtn').classList.toggle('on', on);
  if (on && webMode()) ensureClaudeWeb();
  else if (on) setTimeout(() => $('#prompt').focus(), 250);
}

// --- режим «мой аккаунт claude.ai»: настоящий claude.ai в боковой панели, вход своим аккаунтом
const webMode = () => settings.claudeMode !== 'api';
let claudeWv = null;
function ensureClaudeWeb() {
  if (claudeWv) return claudeWv;
  claudeWv = document.createElement('webview');
  claudeWv.setAttribute('partition', PARTITION);
  claudeWv.setAttribute('allowpopups', '');
  claudeWv.src = 'https://claude.ai/new';
  claudeWv.addEventListener('did-fail-load', (e) => {
    if (e.isMainFrame && e.errorCode !== -3) toast('claude.ai не открылся — включи VPN и нажми Claude ещё раз', true);
  });
  $('#claudeWeb').appendChild(claudeWv);
  return claudeWv;
}
async function sendPageToClaudeWeb(extra) {
  const ctx = await pageContext();
  if (!ctx && !extra) { toast('Открой сайт, который нужно отправить Claude'); return; }
  let text = '';
  if (ctx) text += `Вот страница, которую я сейчас смотрю.\nНазвание: ${ctx.title}\nАдрес: ${ctx.url}\n\n${ctx.text.slice(0, 15000)}\n\n`;
  if (extra) text += extra + '\n\n';
  toggleSide(true);
  const wv = ensureClaudeWeb();
  L.copy(text);
  try {
    await wv.executeJavaScript(`(() => { const el = document.querySelector('div[contenteditable="true"], textarea'); if (el) el.focus(); return !!el; })()`);
    wv.focus();
    wv.paste();
    toast('Страница вставлена — допиши вопрос и отправь');
  } catch {
    toast('Текст страницы скопирован — вставь в чат через Ctrl+V');
  }
}
function applyClaudeMode() {
  document.body.classList.toggle('cweb', webMode());
  $('#setPop').classList.toggle('api', !webMode());
  $('#ctxChip').title = webMode() ? 'Вставить текст открытой страницы в чат Claude' : 'Claude видит открытую страницу';
  if (webMode() && document.body.classList.contains('side')) ensureClaudeWeb();
}
$('#claudeBtn').onclick = () => toggleSide();
$('#sideClose').onclick = () => toggleSide(false);
$('#ctxChip').onclick = () => {
  if (webMode()) { sendPageToClaudeWeb(); return; }
  chat.useCtx = !chat.useCtx; $('#ctxChip').classList.toggle('on', chat.useCtx);
};
$('#newChat').onclick = () => {
  if (chat.busyId) L.claude.abort(chat.busyId);
  chat.messages = [];
  $('#msgs').querySelectorAll('.msg').forEach((m) => m.remove());
  $('#empty').style.display = '';
};

async function pageContext() {
  if (!active || isInternal(active.url)) return null;
  try {
    return await active.wv.executeJavaScript(`(() => ({
      title: document.title,
      url: location.href,
      selection: String(getSelection() || '').slice(0, 4000),
      text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 40000)
    }))()`);
  } catch { return null; }
}

function addMsg(role, html) {
  $('#empty').style.display = 'none';
  const d = document.createElement('div');
  d.className = `msg ${role}`;
  if (role === 'user' || role === 'err') d.textContent = html; else d.innerHTML = html;
  $('#msgs').appendChild(d);
  $('#msgs').scrollTop = $('#msgs').scrollHeight;
  return d;
}

const PRESETS = {
  summary: 'Кратко перескажи эту страницу: о чём она и главные мысли.',
  translate: 'Переведи основной текст этой страницы на русский.',
  explain: 'Объясни содержимое этой страницы простыми словами.',
};

async function ask(text) {
  text = text.trim();
  if (!text) return;
  if (webMode()) { sendPageToClaudeWeb(text); return; }
  if (chat.busyId) return;
  toggleSide(true);
  addMsg('user', text);
  chat.messages.push({ role: 'user', content: text });

  let system = 'Ты — Claude, ассистент, встроенный в браузер Liquid. Отвечай на языке пользователя, по делу, без воды. Используй markdown, когда это помогает читать.';
  if (chat.useCtx) {
    const ctx = await pageContext();
    if (ctx) {
      system += `\n\nПользователь сейчас на странице:\nНазвание: ${ctx.title}\nURL: ${ctx.url}`;
      if (ctx.selection) system += `\nВыделенный текст:\n"""${ctx.selection}"""`;
      system += `\nТекст страницы (может быть обрезан):\n"""${ctx.text}"""`;
    }
  }

  const id = 'c' + Date.now();
  chat.busyId = id;
  document.body.classList.add('thinking');
  const bubble = addMsg('ai', '');
  bubble.classList.add('typing');
  let acc = '';
  let raf = 0;
  const paint = () => {
    raf = 0;
    const stick = $('#msgs').scrollHeight - $('#msgs').scrollTop - $('#msgs').clientHeight < 60;
    bubble.innerHTML = window.renderMarkdown(acc);
    if (stick) $('#msgs').scrollTop = $('#msgs').scrollHeight;
  };

  const finish = (err) => {
    offChunk(); offDone(); offErr();
    cancelAnimationFrame(raf);
    bubble.classList.remove('typing');
    if (acc) { paint(); chat.messages.push({ role: 'assistant', content: acc }); }
    else { bubble.remove(); chat.messages.pop(); }
    if (err) addMsg('err', err);
    chat.busyId = null;
    document.body.classList.remove('thinking');
  };
  const offChunk = L.claude.onChunk((d) => { if (d.id !== id) return; acc += d.text; if (!raf) raf = requestAnimationFrame(paint); });
  const offDone = L.claude.onDone((d) => { if (d.id === id) finish(); });
  const offErr = L.claude.onError((d) => { if (d.id === id) finish(d.error); });

  L.claude.send({ id, model: settings.model, system, messages: chat.messages });
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (chat.busyId) { L.claude.abort(chat.busyId); return; }
  const v = $('#prompt').value;
  $('#prompt').value = '';
  autosize();
  ask(v);
});
$('#prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); }
});
function autosize() { const p = $('#prompt'); p.style.height = 'auto'; p.style.height = Math.min(p.scrollHeight, 160) + 'px'; }
$('#prompt').addEventListener('input', autosize);
document.querySelector('.quick').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) ask(PRESETS[b.dataset.q]);
});
$('#msgs').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-href]');
  if (a) { createTab(a.dataset.href); return; }
  const c = e.target.closest('.copy');
  if (c) {
    navigator.clipboard.writeText(c.nextElementSibling.textContent);
    c.textContent = 'скопировано';
    setTimeout(() => (c.textContent = 'копировать'), 1400);
  }
});

L.claude.onAsk((d) => {
  if (d.preset) ask(PRESETS[d.preset]);
  else if (d.text && webMode()) { toggleSide(true); L.copy(`«${d.text}»\n\n`); const wv = ensureClaudeWeb(); wv.focus(); try { wv.paste(); } catch {} }
  else if (d.text) { toggleSide(true); $('#prompt').value = `«${d.text}»\n\n`; autosize(); $('#prompt').focus(); }
});

// ---------- события из main ----------
L.tabs.onOpen(({ url, background, replace }) => {
  if (replace && active && isInternal(active.url)) { navigate(url); return; }
  createTab(url, { background, after: active });
});
L.onSplit(({ url }) => { if (split) endSplit(true); startSplit(url); });
L.tabs.onSearch(({ q }) => createTab((SEARCH[settings.search] || SEARCH.google) + encodeURIComponent(q)));
L.onToast(({ text, error }) => toast(text, error));
// всплывающее окно без нажатия заблокировано — можно разрешить для сайта
L.onPopupBlocked(({ site, url }) => toast('Заблокировано всплывающее окно', false, site ? { label: `Разрешать на ${site}`, run: async () => { await L.popupAllow(site); if (url) createTab(url); toast(`Всплывающие окна на ${site} разрешены. Отменить: Настройки → Защита`); } } : null));
L.win.onState((s) => { if ('full' in s) document.body.classList.toggle('fs', s.full); });

L.onShortcut(({ key, shift }) => {
  switch (key) {
    case 't': shift ? reopenClosed() : createTab(); break;
    case 'n': createTab(); break; // Ctrl+Shift+N (инкогнито) основной процесс обрабатывает сам
    case '\\': split ? endSplit(true) : startSplit(); break;
    case 'h': case 'y': window.openLibrary && window.openLibrary('history'); break;
    case 'b': if (shift) window.openLibrary && window.openLibrary('bookmarks'); break;
    case 'd': window.toggleBookmark && window.toggleBookmark(); break;
    case 'pip': window.togglePip && window.togglePip(); break;
    case 'w': if (active) closeTab(active); break;
    case 'l': case 'k': $('#url').focus(); break;
    case 'r': active?.wv.reload(); break;
    case 'j': toggleSide(); break;
    case 'f': openFind(); break;
    case 'tab': {
      if (tabs.length < 2) break;
      const i = tabs.indexOf(active);
      activate(tabs[(i + (shift ? -1 : 1) + tabs.length) % tabs.length]);
      break;
    }
    case 'back': active?.wv.canGoBack() && active.wv.goBack(); break;
    case 'forward': active?.wv.canGoForward() && active.wv.goForward(); break;
    case '=': case '+': zoom(0.5); break;
    case '-': zoom(-0.5); break;
    case '0': active?.wv.setZoomLevel(0); toast('Масштаб 100%'); break;
    case 'i': if (active?.wcId) L.devtools(active.wcId); break;
    case 'escape': closePops(); closeFind(); window.hideSuggest && window.hideSuggest(); break;
  }
});
function zoom(d) {
  if (!active) return;
  const z = Math.max(-3, Math.min(4, active.wv.getZoomLevel() + d));
  active.wv.setZoomLevel(z);
  toast(`Масштаб ${Math.round(Math.pow(1.2, z) * 100)}%`);
}

// ---------- старт ----------
window.addEventListener('DOMContentLoaded', async function init() {
  // окно уже нарисовано; фоновые шаги запуска (расширения и т.п.) ждём только перед заполнением вкладок
  try { await Promise.race([L.boot(), new Promise((r) => setTimeout(r, 4000))]); } catch {}
  settings = await L.settings.get();
  $('#model').value = settings.model;
  $('#search').value = settings.search;
  $('#vpnAuto').checked = settings.vpnAuto;
  $('#guard').checked = settings.guard;
  $('#claudeMode').value = settings.claudeMode;
  $('#fps').value = settings.fps || 'auto';
  applyClaudeMode();
  $('#claudeKey').placeholder = settings.hasClaudeKey ? '•••••••• сохранён' : 'sk-ant-…';
  renderVpn(await L.vpn.state());
  window.featuresInit && window.featuresInit();
  window.features2Init && window.features2Init();
  // «Включать VPN при запуске»: ждём прокси, чтобы вкладки не успели открыться напрямую
  if (settings.vpnAuto) { try { renderVpn(await L.vpn.startup()); } catch {} }
  if (!restoreSession()) createTab();
});
