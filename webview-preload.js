// Preload для сайтов (изолированный мир: сайт не видит этот код). Работает на странице и во фреймах.
// 1) Вход Google: маскировка под Firefox.  2) Перевод страницы на месте, без поломки вёрстки.
// 3) Сведения о странице для браузера (язык, есть ли видео).  4) Тема оформления для стартовой страницы.
// 5) Режим чтения.  6) Видео: скорость, громкость до 300 %, фильтры.  7) Liquid RTX — супер-чёткость (WebGL2, RAVU + FSR).
// 8) Кружок с панелью видео.  Плюс боковые кнопки мыши и команды от браузера.
const { contextBridge, webFrame, ipcRenderer } = require('electron');
// стартовая страница хранит избранное в настройках приложения, а не в localStorage (его стирает «Очистить данные»)
if (location.protocol === 'file:' && /\/newtab\.html$/.test(location.pathname)) {
  try { contextBridge.exposeInMainWorld('liquidNewtab', { tiles: (t) => ipcRenderer.invoke('newtab:tiles', t), icons: (h) => ipcRenderer.invoke('newtab:icons', h), suggest: (q) => ipcRenderer.invoke('search:suggest', q) }); } catch {}
}

const toHost = (msg) => { try { ipcRenderer.sendToHost('liquid', msg); } catch {} };
// Этот код работает и во фреймах (встроенные плееры фильмов, видео соцсетей, YouTube на чужих сайтах).
// Во фрейме нужны только видео и кнопки мыши; перевод, режим чтения и сведения о странице — только на самой странице
// ошибки нашего кода на странице — в журнал отладки браузера (раньше функции не было, и сама запись об ошибке падала)
function report(where, err) {
  try {
    const msg = String((err && err.message) || err || 'ошибка');
    ipcRenderer.send('diag:log', { level: 'warn', source: 'страница: ' + where, message: msg, extra: location.hostname + (err && err.stack ? '\n' + String(err.stack).split('\n').slice(1, 4).join('\n') : '') });
  } catch {}
}
const IS_FRAME = (() => { try { return window.top !== window; } catch { return true; } })();

// Вставка своей разметки. YouTube и другие сайты включают Trusted Types: любой разбор HTML-строки
// (innerHTML, DOMParser, даже в отдельном документе) там запрещён. Поэтому разбираем свою разметку сами
// и собираем элементы через createElement — это защита сайта не трогает.
const VOID = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['style', 'script', 'textarea', 'title']);
const SVG_NS = 'http://www.w3.org/2000/svg';
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', times: '×', middot: '·', mdash: '—', ndash: '–', laquo: '«', raquo: '»' };
const decode = (t) => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});
function buildNodes(html) {
  const out = document.createDocumentFragment();
  const stack = [{ el: out, svg: false }];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|[^<]+|</g;
  const attrRe = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    const tok = m[0];
    if (tok.startsWith('<!--')) continue;
    if (m[1]) { // закрывающий тег
      const name = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === name) { stack.length = i; break; }
      continue;
    }
    if (m[2]) { // открывающий тег
      const name = m[2];
      const lower = name.toLowerCase();
      const svg = top.svg || lower === 'svg';
      const el = svg ? document.createElementNS(SVG_NS, name) : document.createElement(lower);
      attrRe.lastIndex = 0; let a;
      while ((a = attrRe.exec(m[3] || ''))) {
        const an = a[1]; const av = decode(a[2] ?? a[3] ?? a[4] ?? '');
        if (/^on/i.test(an)) continue; // обработчики вешаем только кодом
        try { el.setAttribute(an, av); } catch {}
      }
      top.el.appendChild(el);
      if (RAW.has(lower) && !svg) { // содержимое style/textarea — как есть, до закрывающего тега
        const end = html.toLowerCase().indexOf('</' + lower, re.lastIndex);
        const stop = end < 0 ? html.length : end;
        el.textContent = lower === 'textarea' ? decode(html.slice(re.lastIndex, stop)) : html.slice(re.lastIndex, stop);
        re.lastIndex = end < 0 ? html.length : html.indexOf('>', end) + 1;
        continue;
      }
      if (!m[4] && !VOID.has(lower)) stack.push({ el, svg, name: lower });
      continue;
    }
    top.el.appendChild(document.createTextNode(decode(tok)));
  }
  return out;
}
function setHTML(target, html) { target.replaceChildren(buildNodes(html)); }

// ---------- 0. YouTube: 4K в 60 кадров ----------
// YouTube отдаёт 60 кадров, только если браузер на вопрос «потянешь плавно?» (mediaCapabilities.decodingInfo) говорит «да».
// Chromium отвечает по своей статистике пропущенных кадров в профиле — стоит ей хоть раз записать «не плавно»
// (например, пока Liquid RTX собирал шейдеры), и YouTube навсегда режет 4K до 30 кадров. Для поддерживаемых форматов
// отвечаем «плавно» — как и есть на любой видеокарте, которая этот формат декодирует
if (/(^|\.)youtube\.com$/.test(location.hostname)) {
  const fix = () => {
    try {
      const P = MediaCapabilities.prototype, orig = P.decodingInfo;
      if (orig.__lq) return;
      const f = function (cfg) { return orig.call(this, cfg).then((r) => (r && r.supported ? Object.assign({}, r, { smooth: true, powerEfficient: true }) : r)); };
      f.__lq = true; P.decodingInfo = f;
    } catch {}
  };
  if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: fix });
  else webFrame.executeJavaScript(`(${fix.toString()})()`);
}

// ---------- 1. Google: «этот браузер может быть небезопасным» ----------
const AUTH = /^(accounts\.google\.com|accounts\.youtube\.com|myaccount\.google\.com)$/;
if (AUTH.test(location.hostname)) {
  const ffVer = 128 + Math.floor((Date.now() - Date.UTC(2024, 6, 9)) / (28 * 864e5)) - 1;
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${ffVer}.0) Gecko/20100101 Firefox/${ffVer}.0`;
  const patch = (ua) => {
    try {
      const N = Navigator.prototype;
      const def = (k, v) => Object.defineProperty(N, k, { get: () => v, configurable: true });
      def('userAgent', ua); def('appVersion', '5.0 (Windows)'); def('vendor', ''); def('productSub', '20100101');
      def('userAgentData', undefined); def('webdriver', false); def('oscpu', 'Windows NT 10.0; Win64; x64'); def('buildID', '20181001000000');
      try { delete window.chrome; } catch {}
    } catch {}
  };
  if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: patch, args: [ua] });
  else webFrame.executeJavaScript(`(${patch.toString()})(${JSON.stringify(ua)})`);
}

// ---------- 2. Перевод ----------
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'SVG', 'MATH', 'KBD', 'SAMP', 'TEMPLATE', 'IFRAME', 'CANVAS']);
const tr = { on: false, orig: new Map(), observer: null, queue: new Set(), timer: 0, busy: false, done: 0 };
const hasLetters = (s) => /\p{L}{2,}/u.test(s);
const mostlyCyr = (s) => { const l = s.match(/\p{L}/gu) || []; const c = s.match(/[а-яё]/giu) || []; return l.length && c.length / l.length > 0.5; };

function okNode(n) {
  const t = n.nodeValue;
  if (!t || t.trim().length < 2 || !hasLetters(t) || mostlyCyr(t)) return false;
  for (let p = n.parentElement; p; p = p.parentElement) {
    if (SKIP.has(p.tagName) || p.isContentEditable || p.getAttribute('translate') === 'no' || p.classList.contains('notranslate')) return false;
  }
  return true;
}
function collect(root) {
  const out = [];
  if (!root) return out;
  if (root.nodeType === 3) { if (okNode(root) && !tr.orig.has(root)) out.push(root); return out; }
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (!tr.orig.has(n) && okNode(n)) out.push(n);
  return out;
}
function visibleFirst(nodes) {
  const h = innerHeight * 1.5;
  const score = (n) => { const r = n.parentElement?.getBoundingClientRect(); return r && r.bottom > -50 && r.top < h ? 0 : 1; };
  return nodes.map((n) => [score(n), n]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}
async function translateNodes(nodes) {
  nodes = visibleFirst(nodes);
  let ok = 0, failed = false;
  for (let i = 0; i < nodes.length && tr.on; i += 120) {
    const part = nodes.slice(i, i + 120);
    const texts = part.map((n) => n.nodeValue.trim());
    let res;
    try { res = await ipcRenderer.invoke('translate:batch', texts); } catch { res = null; }
    if (!res && tr.on) console.warn(`[liquid] перевод: переводчик не ответил (${part.length} фраз) @ ${location.hostname}`);
    if (!res) { failed = true; break; }
    if (!tr.on) break;
    ok++;
    part.forEach((n, k) => {
      const orig = n.nodeValue;
      const t = res[k];
      if (!t || t === texts[k]) return;
      const lead = orig.match(/^\s*/)[0];
      const trail = orig.match(/\s*$/)[0];
      tr.orig.set(n, orig);
      n.nodeValue = lead + t + trail;
    });
    tr.done += part.length;
  }
  return !(failed && !ok);
}
async function translateOn() {
  if (tr.on) return;
  tr.on = true;
  toHost({ type: 'translate', state: 'working' });
  document.documentElement.setAttribute('data-liquid-translated', '');
  const nodes = collect(document.body);
  if (!(await translateNodes(nodes)) && nodes.length) {
    // ни один движок перевода не ответил — честно говорим об этом и выключаемся
    tr.on = false;
    document.documentElement.removeAttribute('data-liquid-translated');
    toHost({ type: 'translate', state: 'error' });
    return;
  }
  if (document.title && !mostlyCyr(document.title) && tr.on) {
    try { const [t] = await ipcRenderer.invoke('translate:batch', [document.title]); tr.title = document.title; if (t) document.title = t; } catch {}
  }
  // новые куски страницы (ленты, подгрузка) тоже переводим
  tr.observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') { if (!tr.orig.has(m.target)) tr.queue.add(m.target); continue; }
      m.addedNodes.forEach((n) => tr.queue.add(n));
    }
    clearTimeout(tr.timer);
    tr.timer = setTimeout(flushQueue, 350);
  });
  tr.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  if (tr.on) toHost({ type: 'translate', state: 'on' });
}
async function flushQueue() {
  if (!tr.on || tr.busy) return;
  tr.busy = true;
  const nodes = [];
  for (const n of tr.queue) nodes.push(...collect(n));
  tr.queue.clear();
  if (nodes.length) await translateNodes(nodes);
  tr.busy = false;
  if (tr.queue.size) flushQueue();
}
function translateOff() {
  tr.on = false;
  tr.observer?.disconnect();
  tr.observer = null;
  for (const [n, t] of tr.orig) { try { n.nodeValue = t; } catch {} }
  tr.orig.clear();
  if (tr.title) document.title = tr.title;
  document.documentElement.removeAttribute('data-liquid-translated');
  toHost({ type: 'translate', state: 'off' });
}

// ---------- 3. Сведения о странице ----------
// Образец текста для определения языка. Раньше брали document.body.innerText — он заставляет браузер
// пересчитать раскладку и собирает текст ВСЕЙ страницы (на длинных лентах — десятки мс), а нужно 4000 символов
const NO_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'svg']);
function textSample(max) {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentNode && NO_TEXT.has(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let s = '';
  for (let n = w.nextNode(); n && s.length < max; n = w.nextNode()) { const v = n.nodeValue.trim(); if (v) s += v + ' '; }
  return s.slice(0, max);
}
function pageInfo() {
  if (IS_FRAME || !/^https?:$/.test(location.protocol) || !document.body) return;
  const sample = textSample(4000);
  const letters = (sample.match(/\p{L}/gu) || []).length;
  const cyr = (sample.match(/[а-яё]/giu) || []).length;
  const lang = (document.documentElement.lang || '').toLowerCase();
  const foreign = letters > 150 ? cyr / letters < 0.25 : !!lang && !/^(ru|uk|be)/.test(lang);
  const vids = [...document.querySelectorAll('video')].filter((v) => v.offsetWidth > 200);
  let ptext = 0, pcount = 0;
  for (const p of document.querySelectorAll('p')) { const n = (p.textContent || '').trim().length; if (n > 80) { ptext += n; pcount++; } if (ptext > 3000) break; }
  toHost({ type: 'page', lang, foreign, video: vids.length > 0, translated: tr.on, readable: pcount >= 4 && ptext > 1500 });
}
// повторные проверки — в свободное время страницы, чтобы не отнимать кадры у её загрузки и анимаций
const idleInfo = () => (window.requestIdleCallback ? requestIdleCallback(pageInfo, { timeout: 1500 }) : pageInfo());
window.addEventListener('DOMContentLoaded', () => { idleInfo(); setTimeout(idleInfo, 2500); setTimeout(idleInfo, 8000); });
window.addEventListener('load', () => setTimeout(idleInfo, 600));

// ---------- 4. Тема стартовой страницы ----------
function applyTheme(t) {
  if (location.protocol !== 'file:' || !document.documentElement) return;
  const r = document.documentElement.style;
  if (t.accent) r.setProperty('--accent', t.accent);
  if (t.accentHi) r.setProperty('--accent-hi', t.accentHi);
  if (t.accentLo) r.setProperty('--accent-lo', t.accentLo);
  if (t.glass != null) r.setProperty('--glass-a', String(t.glass));
  const apply = () => {
    const bg = document.querySelector('.bg');
    if (bg && t.wall) bg.style.background = t.wall;
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', apply); else apply();
}


// ---------- 5. Режим чтения ----------
const rd = { host: null, prefs: { size: 20, font: 'serif', theme: 'dark', width: 720 } };
function findArticle() {
  const score = new Map();
  const add = (el, n) => { if (el && el !== document.documentElement) score.set(el, (score.get(el) || 0) + n); };
  for (const p of document.querySelectorAll('p, pre, blockquote')) {
    const n = (p.textContent || '').trim().length;
    if (n < 40) continue;
    add(p.parentElement, n);
    add(p.parentElement?.parentElement, n / 2);
  }
  let best = null, bestScore = 0;
  for (const [el, sc] of score) {
    const text = (el.textContent || '').length || 1;
    let links = 0;
    el.querySelectorAll('a').forEach((a) => { links += (a.textContent || '').length; });
    const s2 = sc * (1 - Math.min(0.9, links / text));
    if (s2 > bestScore) { bestScore = s2; best = el; }
  }
  const art = document.querySelector('article');
  if (art && best && art.contains(best) && (art.textContent || '').length < (best.textContent || '').length * 3) best = art;
  return best;
}
const JUNK = /comment|share|social|related|promo|advert|banner|footer|sidebar|subscribe|newsletter|popup|modal|cookie|breadcrumb|recommend|sponsor|widget|nav/i;
function cleanClone(node) {
  const c = node.cloneNode(true);
  c.querySelectorAll('script,style,noscript,iframe:not([src*="youtube"]),form,button,input,select,textarea,nav,aside,footer,svg,canvas,[aria-hidden="true"],[hidden]').forEach((e) => e.remove());
  const total = (c.textContent || '').length || 1;
  c.querySelectorAll('*').forEach((e) => {
    const id = (e.id || '') + ' ' + (typeof e.className === 'string' ? e.className : '');
    if (JUNK.test(id) && (e.textContent || '').length < total * 0.3) { e.remove(); return; }
    if (e.tagName === 'IMG') {
      const src = e.getAttribute('data-src') || e.getAttribute('data-lazy-src') || e.getAttribute('data-original') || e.currentSrc || e.src;
      if (src) e.setAttribute('src', new URL(src, location.href).href);
      e.removeAttribute('srcset'); e.removeAttribute('sizes'); e.removeAttribute('loading');
    }
    if (e.tagName === 'A' && e.getAttribute('href')) { try { e.setAttribute('href', new URL(e.getAttribute('href'), location.href).href); } catch {} e.setAttribute('target', '_blank'); }
    for (const a of [...e.attributes]) if (!['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'target'].includes(a.name)) e.removeAttribute(a.name);
  });
  return c;
}
const READER_CSS = `
:host { all: initial; }
.wrap { position: fixed; inset: 0; z-index: 2147483647; overflow-y: auto; background: var(--bg); color: var(--fg); animation: in .35s cubic-bezier(.22,1,.36,1); scroll-behavior: smooth; }
.wrap.dark { --bg: #121117; --fg: #e8e6ef; --mut: #9c98ab; --acc: #f2a07b; --bar: rgba(30,28,38,.82); }
.wrap.sepia { --bg: #f4ecd8; --fg: #3b3024; --mut: #7a6a55; --acc: #b35a2c; --bar: rgba(244,236,216,.86); }
.wrap.light { --bg: #fbfbfd; --fg: #1c1c22; --mut: #6b6b78; --acc: #c9633f; --bar: rgba(251,251,253,.86); }
@keyframes in { from { opacity: 0; transform: translateY(14px); } }
.bar { position: sticky; top: 12px; margin: 12px auto 0; width: max-content; display: flex; gap: 4px; padding: 5px; border-radius: 16px; background: var(--bar); backdrop-filter: blur(18px) saturate(160%); border: 1px solid rgba(128,128,128,.22); box-shadow: 0 10px 30px -14px rgba(0,0,0,.5); z-index: 2; font: 13px "Segoe UI", system-ui, sans-serif; }
.bar button { all: unset; cursor: pointer; padding: 7px 11px; border-radius: 11px; color: var(--fg); opacity: .85; transition: background .2s; }
.bar button:hover { background: rgba(128,128,128,.18); opacity: 1; }
.bar button.on { background: rgba(128,128,128,.25); opacity: 1; }
.bar .sep { width: 1px; background: rgba(128,128,128,.25); margin: 4px 3px; }
.page { max-width: var(--w); margin: 0 auto; padding: 40px 28px 120px; font-size: var(--fs); line-height: 1.7; }
.page.serif { font-family: Georgia, "Times New Roman", serif; }
.page.sans { font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }
.meta { color: var(--mut); font: 13.5px "Segoe UI", system-ui, sans-serif; margin-bottom: 8px; }
h1.title { font: 700 calc(var(--fs) * 1.75)/1.2 "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif; margin: 6px 0 22px; letter-spacing: -.5px; }
.body h1, .body h2, .body h3, .body h4 { font-family: "Segoe UI", system-ui, sans-serif; line-height: 1.3; margin: 1.6em 0 .6em; }
.body p { margin: 0 0 1.05em; }
.body a { color: var(--acc); text-decoration: none; border-bottom: 1px solid currentColor; }
.body img, .body video, .body iframe { max-width: 100%; height: auto; border-radius: 12px; display: block; margin: 1.2em auto; }
.body figure { margin: 1.4em 0; } .body figcaption { color: var(--mut); font-size: .8em; text-align: center; }
.body blockquote { margin: 1.2em 0; padding: .2em 0 .2em 1em; border-left: 3px solid var(--acc); color: var(--mut); }
.body pre, .body code { font-family: "Cascadia Code", Consolas, monospace; font-size: .82em; background: rgba(128,128,128,.14); border-radius: 8px; }
.body pre { padding: 14px; overflow-x: auto; } .body code { padding: 1px 5px; }
.body table { border-collapse: collapse; width: 100%; font-size: .85em; } .body td, .body th { border: 1px solid rgba(128,128,128,.3); padding: 6px 8px; }
.body article, .body section, .body div { margin: 0; padding: 0; max-width: none; }
.body ul, .body ol { padding-left: 1.4em; } .body li { margin: .3em 0; }
.progress { position: fixed; top: 0; left: 0; height: 3px; background: var(--acc); width: 0; z-index: 3; transition: width .1s; }`;
function readerOpen(prefs) {
  if (rd.host) return;
  Object.assign(rd.prefs, prefs || {});
  const main = findArticle();
  if (!main) { toHost({ type: 'reader', state: 'none' }); return; }
  const body = cleanClone(main);
  const h1 = document.querySelector('h1');
  const title = (h1 && (h1.textContent || '').trim()) || document.title;
  body.querySelectorAll('h1').forEach((h) => { if ((h.textContent || '').trim() === title) h.remove(); });
  const words = (body.textContent || '').trim().split(/\s+/).length;
  const mins = Math.max(1, Math.round(words / 190));
  const site = document.querySelector('meta[property="og:site_name"]')?.content || location.hostname.replace(/^www\./, '');
  const author = document.querySelector('meta[name="author"]')?.content || '';
  const host = document.createElement('lq-reader');
  const root = host.attachShadow({ mode: 'closed' });
  setHTML(root, `<style>${READER_CSS}</style><div class="wrap"><div class="progress"></div>
    <div class="bar">
      <button data-a="close" title="Закрыть (Esc)">✕</button><span class="sep"></span>
      <button data-a="smaller">A−</button><button data-a="bigger">A+</button><span class="sep"></span>
      <button data-a="font"></button><span class="sep"></span>
      <button data-t="dark">Тёмная</button><button data-t="sepia">Сепия</button><button data-t="light">Светлая</button><span class="sep"></span>
      <button data-a="narrow">⇥⇤</button><button data-a="wide">⇤⇥</button>
    </div>
    <div class="page"><div class="meta"></div><h1 class="title"></h1><div class="body"></div></div></div>`);
  root.querySelector('.meta').textContent = `${site}${author ? ' · ' + author : ''} · ${mins} мин чтения`;
  root.querySelector('.title').textContent = title;
  root.querySelector('.body').appendChild(body);
  const wrap = root.querySelector('.wrap');
  const art = root.querySelector('.page');
  const apply = () => {
    const p = rd.prefs;
    wrap.className = 'wrap ' + p.theme;
    art.className = 'page ' + p.font;
    art.style.setProperty('--fs', p.size + 'px');
    art.style.setProperty('--w', p.width + 'px');
    root.querySelector('[data-a="font"]').textContent = p.font === 'serif' ? 'С засечками' : 'Без засечек';
    root.querySelectorAll('[data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === p.theme));
  };
  apply();
  root.querySelector('.bar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const p = rd.prefs;
    if (b.dataset.t) p.theme = b.dataset.t;
    else switch (b.dataset.a) {
      case 'close': return readerClose();
      case 'smaller': p.size = Math.max(14, p.size - 1); break;
      case 'bigger': p.size = Math.min(32, p.size + 1); break;
      case 'font': p.font = p.font === 'serif' ? 'sans' : 'serif'; break;
      case 'narrow': p.width = Math.max(520, p.width - 80); break;
      case 'wide': p.width = Math.min(1100, p.width + 80); break;
    }
    apply();
    toHost({ type: 'readerPrefs', prefs: p });
  });
  wrap.addEventListener('scroll', () => {
    const max = wrap.scrollHeight - wrap.clientHeight;
    root.querySelector('.progress').style.width = (max > 0 ? (wrap.scrollTop / max) * 100 : 0) + '%';
  }, { passive: true });
  rd.onKey = (e) => { if (e.key === 'Escape') readerClose(); };
  document.addEventListener('keydown', rd.onKey, true);
  rd.overflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  document.documentElement.appendChild(host);
  rd.host = host;
  toHost({ type: 'reader', state: 'on', mins });
}
function readerClose() {
  if (!rd.host) return;
  rd.host.remove();
  rd.host = null;
  document.documentElement.style.overflow = rd.overflow || '';
  document.removeEventListener('keydown', rd.onKey, true);
  toHost({ type: 'reader', state: 'off' });
}

// ---------- 6. Видео: скорость, громкость до 300%, картинка ----------
const vt = { graphs: new WeakMap(), want: {}, hud: null, hudT: 0, svg: false };
function videos() {
  const out = [...document.querySelectorAll('video')];
  // плееры-компоненты прячут <video> в shadow DOM — заглядываем в открытые
  const walk = (root, depth) => {
    if (depth > 3) return;
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { out.push(...el.shadowRoot.querySelectorAll('video')); walk(el.shadowRoot, depth + 1); }
  };
  if (!out.length) { try { walk(document, 0); } catch {} } // обходим, только если обычных <video> нет — это дорого
  return out;
}
function videoAt(x, y) {
  const els = document.elementsFromPoint(x, y);
  const v = els.find((el) => el.tagName === 'VIDEO');
  if (v) return v;
  for (const el of els.slice(0, 8)) {
    if (!el.shadowRoot) continue;
    const inner = [...el.shadowRoot.querySelectorAll('video')].find((iv) => { const r = iv.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; });
    if (inner) return inner;
  }
  return null;
}
function mainVideo() {
  const vs = videos().filter((v) => v.offsetWidth > 120);
  return vs.find((v) => !v.paused) || vs.sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight)[0] || null;
}
function graph(v) {
  let g = vt.graphs.get(v);
  if (g) return g;
  const ctx = new AudioContext();
  const src = ctx.createMediaElementSource(v);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -26; comp.knee.value = 28; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.25;
  const gain = ctx.createGain();
  src.connect(gain); gain.connect(ctx.destination);
  g = { ctx, src, comp, gain, compOn: false };
  vt.graphs.set(v, g);
  const resume = () => { if (ctx.state === 'suspended') ctx.resume(); };
  document.addEventListener('pointerdown', resume, true);
  v.addEventListener('play', resume);
  resume();
  return g;
}
function setVolume(v, vol) {
  vol = Math.max(0, Math.min(3, vol));
  const g = vt.graphs.get(v);
  if (vol <= 1 && !g) { v.volume = vol; v.muted = vol === 0; }
  else { const gg = graph(v); v.volume = 1; v.muted = false; gg.gain.gain.value = vol; }
  v.__lqVol = vol;
}
function getVolume(v) { return v.__lqVol ?? (v.muted ? 0 : v.volume); }
function setComp(v, on) {
  const g = graph(v);
  if (g.compOn === on) return;
  g.src.disconnect();
  if (on) { g.src.connect(g.comp); g.comp.connect(g.gain); }
  else { try { g.comp.disconnect(); } catch {} g.src.connect(g.gain); }
  g.compOn = on;
}
function ensureSharpSvg() {
  if (vt.svg && vt.svg.isConnected) return;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none';
  // lq-sharp — ручная «резкость» из панели; lq-sharp-mid/max — лёгкий режим супер-чёткости
  for (const [id, k] of [['lq-sharp', 0.6], ['lq-sharp-mid', 0.2], ['lq-sharp-max', 0.4]]) {
    const filter = document.createElementNS(ns, 'filter'); filter.setAttribute('id', id); filter.setAttribute('color-interpolation-filters', 'sRGB');
    const conv = document.createElementNS(ns, 'feConvolveMatrix');
    conv.setAttribute('order', '3'); conv.setAttribute('preserveAlpha', 'true');
    conv.setAttribute('kernelMatrix', `0 ${-k} 0 ${-k} ${1 + 4 * k} ${-k} 0 ${-k} 0`);
    filter.appendChild(conv); svg.appendChild(filter);
  }
  (document.body || document.documentElement).appendChild(svg);
  vt.svg = svg;
}
// видео, кадры которого видеокарте читать нельзя (чужой сервер без CORS) или которое обрезано object-fit: cover —
// для них супер-чёткость работает «легко»: резкость и HDR-цвет фильтрами на самом видео, без апскейла
vt.lite = new WeakSet();
function applyFilter(v) {
  const w = vt.want;
  const parts = [];
  if (w.bright != null && w.bright !== 1) parts.push(`brightness(${w.bright})`);
  if (w.contrast != null && w.contrast !== 1) parts.push(`contrast(${w.contrast})`);
  if (w.sat != null && w.sat !== 1) parts.push(`saturate(${w.sat})`);
  if (w.sharp) { ensureSharpSvg(); parts.push('url(#lq-sharp)'); }
  if (vt.lite.has(v) && vt.sr !== 'off' && !vt.srBroken) {
    ensureSharpSvg(); parts.push(`url(#lq-sharp-${vt.sr === 'max' ? 'max' : 'mid'})`);
    if (vt.srHdr) parts.push('saturate(1.28) contrast(1.1) brightness(1.03)');
  }
  const f = parts.join(' ');
  if (v.style.filter !== f) v.style.filter = f;
}
function hud(v, text) {
  if (!vt.hud) {
    vt.hud = document.createElement('lq-hud');
    const r = vt.hud.attachShadow({ mode: 'closed' });
    setHTML(r, '<style>div{position:fixed;z-index:2147483647;padding:8px 14px;border-radius:14px;background:rgba(20,18,28,.72);backdrop-filter:blur(14px);color:#fff;font:600 15px "Segoe UI",system-ui,sans-serif;border:1px solid rgba(255,255,255,.18);pointer-events:none;opacity:0;transform:scale(.9);transition:opacity .18s,transform .3s cubic-bezier(.2,.9,.25,1.2)}div.on{opacity:1;transform:none}</style><div></div>');
    vt.hudEl = r.querySelector('div');
    if (!vt.hudEl) { vt.hud = null; return; }
    document.documentElement.appendChild(vt.hud);
  }
  const b = v.getBoundingClientRect();
  vt.hudEl.style.left = Math.max(8, b.left + 16) + 'px';
  vt.hudEl.style.top = Math.max(8, b.top + 16) + 'px';
  vt.hudEl.textContent = text;
  vt.hudEl.classList.add('on');
  clearTimeout(vt.hudT);
  vt.hudT = setTimeout(() => vt.hudEl.classList.remove('on'), 900);
}
const fmtRate = (r) => (Math.round(r * 100) / 100).toString().replace('.', ',') + '×';
// Shift/Alt + колесо над видео — скорость и громкость. Обработчик, который может отменить прокрутку, заставляет
// браузер перед КАЖДЫМ шагом колеса ждать скрипт страницы — на тяжёлых сайтах прокрутка от этого дёргается.
// Поэтому такой обработчик висит только пока зажат Shift или Alt, а обычная прокрутка идёт без ожидания.
let wheelHot = false;
function wheelMode(on) {
  if (on === wheelHot) return;
  wheelHot = on;
  if (on) window.addEventListener('wheel', onVideoWheel, { capture: true, passive: false });
  else window.removeEventListener('wheel', onVideoWheel, { capture: true });
}
window.addEventListener('keydown', (e) => { if (e.key === 'Shift' || e.key === 'Alt') wheelMode(true); }, true);
window.addEventListener('keyup', (e) => { if (!e.shiftKey && !e.altKey) wheelMode(false); }, true);
window.addEventListener('blur', () => wheelMode(false));
// клавишу зажали, пока фокус был не на странице (например, в адресной строке): включаемся с первого же шага колеса
window.addEventListener('wheel', (e) => { if (e.shiftKey || e.altKey) wheelMode(true); }, { capture: true, passive: true });
function onVideoWheel(e) {
  if (!e.shiftKey && !e.altKey) return;
  const v = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.tagName === 'VIDEO');
  if (!v) return;
  e.preventDefault(); e.stopPropagation();
  const dir = (e.deltaY || e.deltaX) < 0 ? 1 : -1;
  if (e.shiftKey) {
    const r = Math.max(0.25, Math.min(4, Math.round((v.playbackRate + dir * 0.25) * 4) / 4));
    v.playbackRate = r; vt.want.speed = r;
    hud(v, `Скорость ${fmtRate(r)}`);
    toHost({ type: 'videoPrefs', speed: r });
  } else {
    const vol = Math.max(0, Math.min(3, Math.round((getVolume(v) + dir * 0.1) * 10) / 10));
    setVolume(v, vol);
    hud(v, `Громкость ${Math.round(vol * 100)}%`);
  }
}
// сайты (YouTube) сбрасывают скорость при смене ролика — возвращаем выбранную
let framePrefs = null;
document.addEventListener('loadedmetadata', (e) => {
  const v = e.target;
  if (v.tagName !== 'VIDEO') return;
  // во фрейм настройки видео браузер сам не присылает — спрашиваем один раз
  if (IS_FRAME && !framePrefs) framePrefs = ipcRenderer.invoke('video:prefs').then((m) => { if (m) videoCmd({ op: 'prefs', ...m }); }).catch(() => {});
  if (vt.want.speed && v.playbackRate !== vt.want.speed) v.playbackRate = vt.want.speed;
  if (vt.want.bright || vt.want.contrast || vt.want.sat || vt.want.sharp) applyFilter(v);
}, true);
function videoCmd(m) {
  const v = mainVideo();
  if (m.op === 'prefs') {
    if (m.speed) vt.want.speed = m.speed;
    if (m.remember != null) vt.remember = !!m.remember;
    if (m.bar != null) vt.barOn = m.bar;
    if (m.lpAuto != null) vt.lpAuto = !!m.lpAuto;
    if (m.amb != null) vt.amb = !!m.amb;
    if (m.srContent) vt.srContent = m.srContent;
    if (m.learn != null) vt.learn = !!m.learn;
    if (m.sr != null) { vt.sr = m.sr; vt.srHdr = !!m.srHdr; srSync(); if (lp.open) { lp.dirty = true; lpRender(); } }
    return;
  }
  if (m.op === 'overlay') { const v0 = mainVideo(); if (v0) { barShow(v0, true); barOpen(!bar.open); } return; }
  if (m.op === 'pip') { pipToggle(); return; }
  if (m.op === 'player') { const v0 = mainVideo(); if (v0) lpOpen(v0); return; }
  if (m.op === 'mini') { miniOut(); return; }
  if (m.op === 'clipbuf') { const v0 = mainVideo(); if (v0) clip.v === v0 ? clipStop(true) : clipStart(v0); return; }
  if (m.op === 'clip') { clipSave(); return; }
  if (m.op === 'seekPlay') { const v0 = mainVideo(); if (v0) { if (m.t > 0 && Math.abs(v0.currentTime - m.t) > 1) v0.currentTime = m.t; v0.play().catch(() => {}); } return; }
  if (!v) return;
  try {
    if (m.op === 'reset') {
      vt.want = {}; v.playbackRate = 1; v.loop = false;
      applyFilter(v); // яркость и контраст сбрасываются, лёгкий режим чёткости (если включён) остаётся
      if (vt.graphs.get(v)) { setComp(v, false); setVolume(v, 1); } else v.volume = 1;
    } else if (m.op === 'frame') {
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      toHost({ type: 'frame', data: c.toDataURL('image/png'), t: Math.floor(v.currentTime) });
      return;
    }
  } catch (err) {
    report('видео ' + m.op, err);
    const sec = err && (err.name === 'SecurityError' || /tainted|cross-origin/i.test(err.message || ''));
    toHost({ type: 'videoErr', error: sec ? 'этот сайт не разрешает сохранять кадры своего видео' : String(err && err.message || err) });
  }
}


// ---------- 7. Liquid RTX (супер-чёткость): апскейл на видеокарте — аналог RTX Video Super Resolution ----------
// Ступени (лучшая, которую тянет видеокарта; не успевает — ступенька вниз):
//  3) Нейросеть Liquid RTX — своя свёрточная сеть ×2 (main/rtx), обученная как у NVIDIA на кадрах, уменьшенных
//     вдвое и сжатых H.264 / VP9 / AV1: одновременно убирает следы сжатия (блоки, «москитов», полосы) и
//     восстанавливает детали. Работает по яркости в сетке кадра (WebGL2, текстуры RGBA16F), цвет — из кадра.
//  2/1) RAVU-Zoom-AR радиуса 3 / 2 (bjin/mpv-prescalers, LGPL-3, main/ravu) — обученный фильтр без звона.
//  0) AMD FSR 1 EASU (MIT) — без WebGL2 или на слабой видеокарте.
// Затем — резкость RCAS (FSR 1.0.2, MIT): не выходит за цвета соседей (нет ореолов) и слабее на шуме (нет ряби),
// HDR-цвет и дизеринг против полос. «Чисто» — почти без добавочной резкости, «Чётко» — сильнее.
// Движок общий: им рисуют и слой поверх плеера сайта, и Liquid Player (раздел 10).
vt.sr = 'off'; vt.srHdr = false; vt.barOn = true; vt.remember = false; vt.lpAuto = true;
const SR_VS = `attribute vec2 p; uniform float flip; varying vec2 uv; void main(){ uv = p * 0.5 + 0.5; if (flip > 0.5) uv.y = 1.0 - uv.y; gl_Position = vec4(p, 0.0, 1.0); }`;
const SR_VS3 = `#version 300 es
in vec2 p; uniform float flip; out vec2 uv; void main(){ uv = p * 0.5 + 0.5; if (flip > 0.5) uv.y = 1.0 - uv.y; gl_Position = vec4(p, 0.0, 1.0); }`;
// «как было»: просто растянуть кадр (так его показывает сам браузер) — для режима «Выкл» и сравнения
const SR_BILIN = `precision highp float; varying vec2 uv; uniform sampler2D t; uniform vec4 crop; void main(){ gl_FragColor = vec4(texture2D(t, crop.xy + uv * crop.zw).rgb, 1.0); }`;
// уменьшение (видео крупнее слоя, слой нужен только ради HDR-цвета): бикубическое
const SR_DOWN = `precision highp float; varying vec2 uv; uniform sampler2D t; uniform vec2 src; uniform vec4 crop;
vec4 cub(float x){ float x2=x*x, x3=x2*x; return vec4(-0.5*x3+x2-0.5*x, 1.5*x3-2.5*x2+1.0, -1.5*x3+2.0*x2+0.5*x, 0.5*x3-0.5*x2); }
void main(){
  vec2 px = (crop.xy + uv * crop.zw) * src - 0.5; vec2 f = fract(px); vec2 b = (floor(px) + 0.5) / src; vec2 d = 1.0 / src;
  vec4 wx = cub(f.x), wy = cub(f.y); vec3 c = vec3(0.0);
  for (int j = 0; j < 4; j++) { vec3 row = vec3(0.0);
    for (int i = 0; i < 4; i++) row += texture2D(t, b + d * vec2(float(i) - 1.0, float(j) - 1.0)).rgb * wx[i];
    c += row * wy[j]; }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
// FSR 1 EASU (AMD FidelityFX, MIT): увеличение по направлению краёв, итог ограничен 4 ближайшими точками — без ореолов
const SR_EASU = `precision highp float; varying vec2 uv; uniform sampler2D t; uniform vec2 src; uniform vec4 crop;
vec3 T(vec2 p){ return texture2D(t, (p + 0.5) / src).rgb; }
float Lm(vec3 c){ return c.b * 0.5 + (c.r * 0.5 + c.g); }
void setF(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE){
  float dc = lD - lC, cb = lC - lB;
  float lenX = 1.0 / max(max(abs(dc), abs(cb)), 1.0 / 65536.0);
  float dirX = lD - lB; dir.x += dirX * w;
  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0); lenX *= lenX; len += lenX * w;
  float ec = lE - lC, ca = lC - lA;
  float lenY = 1.0 / max(max(abs(ec), abs(ca)), 1.0 / 65536.0);
  float dirY = lE - lA; dir.y += dirY * w;
  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0); lenY *= lenY; len += lenY * w;
}
void tap(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len2, float lob, float clp, vec3 c){
  vec2 v = vec2(off.x * dir.x + off.y * dir.y, off.y * dir.x - off.x * dir.y) * len2;
  float d2 = min(dot(v, v), clp);
  float wB = 0.4 * d2 - 1.0, wA = lob * d2 - 1.0;
  wB *= wB; wA *= wA;
  wB = 1.5625 * wB - 0.5625;
  float w = wB * wA;
  aC += c * w; aW += w;
}
void main(){
  vec2 pp = (crop.xy + uv * crop.zw) * src - 0.5;
  vec2 fp = floor(pp); pp -= fp;
  vec3 b = T(fp + vec2(0.0, -1.0)), c = T(fp + vec2(1.0, -1.0));
  vec3 e = T(fp + vec2(-1.0, 0.0)), f = T(fp), g = T(fp + vec2(1.0, 0.0)), h = T(fp + vec2(2.0, 0.0));
  vec3 i = T(fp + vec2(-1.0, 1.0)), j = T(fp + vec2(0.0, 1.0)), k = T(fp + vec2(1.0, 1.0)), l = T(fp + vec2(2.0, 1.0));
  vec3 n = T(fp + vec2(0.0, 2.0)), o = T(fp + vec2(1.0, 2.0));
  float bL = Lm(b), cL = Lm(c), eL = Lm(e), fL = Lm(f), gL = Lm(g), hL = Lm(h), iL = Lm(i), jL = Lm(j), kL = Lm(k), lL = Lm(l), nL = Lm(n), oL = Lm(o);
  vec2 dir = vec2(0.0); float len = 0.0;
  setF(dir, len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
  setF(dir, len, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);
  setF(dir, len, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);
  setF(dir, len, pp.x * pp.y, gL, jL, kL, lL, oL);
  float dirR = dot(dir, dir);
  if (dirR < 1.0 / 32768.0) { dirR = 1.0; dir.x = 1.0; } else dirR = inversesqrt(dirR);
  dir *= dirR;
  len = len * 0.5; len *= len;
  float stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
  float clp = 1.0 / lob;
  vec3 mn4 = min(min(f, g), min(j, k)), mx4 = max(max(f, g), max(j, k));
  vec3 aC = vec3(0.0); float aW = 0.0;
  tap(aC, aW, vec2(0.0, -1.0) - pp, dir, len2, lob, clp, b);
  tap(aC, aW, vec2(1.0, -1.0) - pp, dir, len2, lob, clp, c);
  tap(aC, aW, vec2(-1.0, 1.0) - pp, dir, len2, lob, clp, i);
  tap(aC, aW, vec2(0.0, 1.0) - pp, dir, len2, lob, clp, j);
  tap(aC, aW, vec2(0.0, 0.0) - pp, dir, len2, lob, clp, f);
  tap(aC, aW, vec2(-1.0, 0.0) - pp, dir, len2, lob, clp, e);
  tap(aC, aW, vec2(1.0, 1.0) - pp, dir, len2, lob, clp, k);
  tap(aC, aW, vec2(2.0, 1.0) - pp, dir, len2, lob, clp, l);
  tap(aC, aW, vec2(2.0, 0.0) - pp, dir, len2, lob, clp, h);
  tap(aC, aW, vec2(1.0, 0.0) - pp, dir, len2, lob, clp, g);
  tap(aC, aW, vec2(1.0, 2.0) - pp, dir, len2, lob, clp, o);
  tap(aC, aW, vec2(0.0, 2.0) - pp, dir, len2, lob, clp, n);
  gl_FragColor = vec4(min(mx4, max(mn4, aC / aW)), 1.0);
}`;
// FSR 1.0.2 RCAS (MIT): резкость, ограниченная соседями (без ореолов), слабее там, где похоже на шум (без ряби).
// split — режим «сравнить»: левее этой доли ширины показываем кадр как есть (как его растянул бы сам браузер)
const SR_RCAS = `precision highp float; varying vec2 uv; uniform sampler2D t; uniform sampler2D raw; uniform vec4 crop; uniform float split;
uniform vec2 dst; uniform float sharp; uniform float hdr;
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float L2(vec3 c){ return c.b * 0.5 + (c.r * 0.5 + c.g); }
void main(){
  if (uv.x < split) { gl_FragColor = vec4(texture2D(raw, crop.xy + vec2(uv.x, 1.0 - uv.y) * crop.zw).rgb, 1.0); return; }
  vec2 d = 1.0 / dst;
  vec3 e = texture2D(t, uv).rgb;
  vec3 b = texture2D(t, uv + vec2(0.0, -d.y)).rgb, h = texture2D(t, uv + vec2(0.0, d.y)).rgb;
  vec3 dd = texture2D(t, uv + vec2(-d.x, 0.0)).rgb, f = texture2D(t, uv + vec2(d.x, 0.0)).rgb;
  float bL = L2(b), dL = L2(dd), eL = L2(e), fL = L2(f), hL = L2(h);
  float nz = 0.25 * (bL + dL + fL + hL) - eL;
  float rng = max(max(max(bL, dL), max(eL, fL)), hL) - min(min(min(bL, dL), min(eL, fL)), hL);
  nz = 1.0 - 0.5 * clamp(abs(nz) / max(rng, 1.0 / 1024.0), 0.0, 1.0);
  vec3 mn4 = min(min(b, dd), min(f, h)), mx4 = max(max(b, dd), max(f, h));
  vec3 hitMin = min(mn4, e) / (4.0 * mx4 + 1e-5);
  vec3 hitMax = (1.0 - max(mx4, e)) / (4.0 * mn4 - 4.0 - 1e-5);
  vec3 lobeRGB = max(-hitMin, hitMax);
  float lobe = max(-0.1875, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * sharp * nz;
  vec3 c = (lobe * (b + dd + f + h) + e) / (4.0 * lobe + 1.0);
  if (hdr > 0.5) {
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, 1.28);                       // насыщенность
    c = c * c * (3.0 - 2.0 * c) * 0.55 + c * 0.45;   // S-кривая: глубже тени, ярче света
    c = pow(max(c, 0.0), vec3(0.92));                // светлее середина
  }
  c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;        // дизеринг: без полос в плавных градиентах (небо, тени)
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
// RAVU: шейдер mpv как есть + обёртка: HOOKED_* — исходный кадр, crop — видимая часть кадра
const ravuFS = (d) => `#version 300 es
precision highp float; in vec2 uv; out vec4 fragColor; uniform sampler2D HOOKED_raw; uniform vec2 HOOKED_size; uniform vec4 crop;
${d.luts.map((l) => `uniform sampler2D ${l.name};`).join('\n')}
#define HOOKED_pt (1.0 / HOOKED_size)
#define HOOKED_tex(pos) texture(HOOKED_raw, pos)
vec2 HOOKED_pos;
${d.body}
void main(){ HOOKED_pos = crop.xy + uv * crop.zw; fragColor = vec4(clamp(hook().rgb, 0.0, 1.0), 1.0); }`;
// ---- нейросеть Liquid RTX: свёрточная сеть ×2, обученная на кадрах, уменьшенных вдвое и сжатых H.264 / VP9 / AV1
// (как видео на YouTube): одновременно убирает следы сжатия и восстанавливает детали. Работает по яркости в сетке
// кадра; признаки — текстуры RGBA16F по 4 канала, все выходы слоя за один проход; веса — константы в шейдере.
// <netShaders>
function netShaders(net) {
  const f = (x) => { const s = (+x).toPrecision(6); return /[.e]/.test(s) ? s : s + '.0'; };
  const L = net.layers, dims = net.dims;
  const head = '#version 300 es\nprecision highp float; precision highp int;\nconst vec3 W709 = vec3(0.2126, 0.7152, 0.0722);\n';
  // p — точка во входной текстуре (своя полоса кадра или весь кадр), sz — её размер: края повторяются, как при обучении
  const fetch = (tex, i) => `texelFetch(${tex}, clamp(p + ivec2(${(i % 3) - 1}, ${Math.floor(i / 3) - 1}), ivec2(0), sz - 1), 0)`;
  const out = [];
  for (let li = 0; li < L.length; li++) {
    const cin = dims[li], cout = dims[li + 1], w = L[li].w, b = L[li].b, last = li === L.length - 1;
    const nIn = Math.ceil(cin / 4), nOut = Math.ceil(cout / 4);
    let s = head + 'uniform ivec2 sz; uniform ivec2 org;\n';
    if (li === 0) s += 'uniform sampler2D src;\n'; else for (let t = 0; t < nIn; t++) s += `uniform sampler2D f${t};\n`;
    for (let o = 0; o < nOut; o++) s += `layout(location = ${o}) out vec4 o${o};\n`;
    s += 'void main(){\n  ivec2 p = ivec2(gl_FragCoord.xy) + org;\n';
    for (let o = 0; o < nOut; o++) s += `  vec4 a${o} = vec4(${[0, 1, 2, 3].map((k) => f(b[4 * o + k] || 0)).join(', ')});\n`;
    for (let tap = 0; tap < 9; tap++) {
      if (li === 0) {
        s += `  { float y = dot(${fetch('src', tap)}.rgb, W709);\n`;
        for (let o = 0; o < nOut; o++) s += `    a${o} += y * vec4(${[0, 1, 2, 3].map((k) => f(w[tap][4 * o + k] || 0)).join(', ')});\n`;
        s += '  }\n';
      } else {
        for (let t = 0; t < nIn; t++) {
          s += `  { vec4 v = ${fetch('f' + t, tap)};\n`;
          for (let o = 0; o < nOut; o++) {
            // столбец j — веса входного канала 4t+j для выходов 4o..4o+3
            const cols = [0, 1, 2, 3].map((j) => `vec4(${[0, 1, 2, 3].map((k) => f(w[(4 * t + j) * 9 + tap][4 * o + k] || 0)).join(', ')})`);
            s += `    a${o} += mat4(${cols.join(', ')}) * v;\n`;
          }
          s += '  }\n';
        }
      }
    }
    for (let o = 0; o < nOut; o++) s += `  o${o} = ${!last ? `max(a${o}, 0.0)` : `a${o}`};\n`;
    out.push({ fs: s + '}\n', nIn: li === 0 ? 0 : nIn, nOut });
  }
  // яркость 2×: билинейная основа (из исходного кадра) + подпиксель из сети.
  // Стабильность во времени: где кадр не изменился (средняя яркость 3×3 сдвинулась меньше чем на пару уровней —
  // зерно и шум сжатия при этом усредняются, а сдвиг краёв нет), смешиваем с прошлым итогом: шум перестаёт «кипеть»
  // на неподвижных местах (стены, небо, фон в интервью). На движении не трогаем — шлейфов нет
  const hr = head + `uniform sampler2D src; uniform sampler2D prev; uniform sampler2D res; uniform sampler2D hrPrev; uniform vec2 lsz; uniform float tw; out vec4 o;
void main(){
  ivec2 q = ivec2(gl_FragCoord.xy); ivec2 p = q >> 1; int k = (q.y & 1) * 2 + (q.x & 1);
  vec4 r = texelFetch(res, p, 0);
  float base = dot(texture(src, (vec2(q) + 0.5) / (2.0 * lsz)).rgb, W709);
  float y = base + (k == 0 ? r.x : k == 1 ? r.y : k == 2 ? r.z : r.w);
  if (tw > 0.0) {
    // только ровные места: в текстуре (трава, листва) медленное движение почти не меняет средние — там не смешиваем
    ivec2 sz = ivec2(lsz); float m = 0.0, lo = 1.0, hi = 0.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { ivec2 c = clamp(p + ivec2(i, j), ivec2(0), sz - 1);
      float a = dot(texelFetch(src, c, 0).rgb, W709), b = dot(texelFetch(prev, c, 0).rgb, W709);
      m += a - b; lo = min(lo, a); hi = max(hi, a); }
    float w = (1.0 - smoothstep(1.5 / 255.0, 5.0 / 255.0, abs(m) / 9.0)) * (1.0 - smoothstep(6.0 / 255.0, 14.0 / 255.0, hi - lo));
    y = mix(y, texelFetch(hrPrev, q, 0).r, tw * w);
  }
  o = vec4(y, 0.0, 0.0, 1.0);
}`;
  // Цвет по яркости. В видео цвет хранится в половинном разрешении (4:2:0) — у 1080p это 960×540, на 4K его
  // растягивают вчетверо, и цветные края «плывут». Направленный фильтр (He et al.): в окне 5×5 цвет ≈ a·яркость + b;
  // a и b отсюда, а яркость берём уже чёткую (из сети) — цветные края становятся такими же резкими, как яркостные
  const cfl = head + `uniform sampler2D src; uniform ivec2 sz; uniform float eps; out vec4 o;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  float sy = 0.0, sb = 0.0, sr = 0.0, syy = 0.0, syb = 0.0, syr = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec3 c = texelFetch(src, clamp(p + ivec2(i, j), ivec2(0), sz - 1), 0).rgb; float y = dot(c, W709);
    float cb = (c.b - y) / 1.8556, cr = (c.r - y) / 1.5748;
    sy += y; sb += cb; sr += cr; syy += y * y; syb += y * cb; syr += y * cr;
  }
  sy /= 25.0; sb /= 25.0; sr /= 25.0;
  float vy = syy / 25.0 - sy * sy;
  float ab = (syb / 25.0 - sy * sb) / (vy + eps), ar = (syr / 25.0 - sy * sr) / (vy + eps);
  o = vec4(ab, sb - ab * sy, ar, sr - ar * sy);
}`;
  // итог в размер экрана: яркость 2× (бикубически под любой масштаб) + цвет по яркости (или из кадра)
  const compose = head + `in vec2 uv; out vec4 o; uniform sampler2D src; uniform sampler2D hr; uniform sampler2D cf; uniform vec2 hsz; uniform vec4 crop; uniform float cfl;
vec4 cub(float x){ float x2 = x * x, x3 = x2 * x; return vec4(-0.5*x3 + x2 - 0.5*x, 1.5*x3 - 2.5*x2 + 1.0, -1.5*x3 + 2.0*x2 + 0.5*x, 0.5*x3 - 0.5*x2); }
void main(){
  vec2 s = crop.xy + uv * crop.zw;
  vec2 px = s * hsz - 0.5; vec2 fr = fract(px); vec2 b = (floor(px) + 0.5) / hsz; vec2 d = 1.0 / hsz;
  vec4 wx = cub(fr.x), wy = cub(fr.y); float y = 0.0;
  for (int j = 0; j < 4; j++) { float row = 0.0;
    for (int i = 0; i < 4; i++) row += texture(hr, b + d * vec2(float(i) - 1.0, float(j) - 1.0)).r * wx[i];
    y += row * wy[j]; }
  vec3 c = texture(src, s).rgb; float y0 = dot(c, W709);
  float cb = (c.b - y0) / 1.8556, cr = (c.r - y0) / 1.5748;
  if (cfl > 0.0) { vec4 k = texture(cf, s); cb = mix(cb, k.x * y + k.y, cfl); cr = mix(cr, k.z * y + k.w, cfl); }
  vec3 r; r.r = y + 1.5748 * cr; r.b = y + 1.8556 * cb; r.g = (y - 0.2126 * r.r - 0.0722 * r.b) / 0.7152;
  o = vec4(clamp(r, 0.0, 1.0), 1.0);
}`;
  return { layers: out, hr, cfl, compose };
}
// </netShaders>
const SR_RAVU = {}; // таблицы весов RAVU: одна загрузка на страницу (r2 ~1,5 МБ, r3 ~2,6 МБ) — только если нейросеть недоступна
const ravuData = (r) => SR_RAVU[r] || (SR_RAVU[r] = ipcRenderer.invoke('sr:ravu', r).catch(() => null));
const SR_NET = {}; // веса нейросетей (из main/rtx): pro — большая для сильных видеокарт, lite — лёгкая, anime — для рисованного
const netData = (n) => SR_NET[n] || (SR_NET[n] = ipcRenderer.invoke('sr:net', n).catch(() => null));
// ступени качества (cap): 4 — нейросеть Pro, 3 — лёгкая (и аниме), 2 — RAVU-3, 1 — RAVU-2, 0 — FSR.
// Видеокарта не успевает — ступенька вниз.
const SR_TIER = { fsr: 0, r2: 1, r3: 2, net: 3, anime: 3, pro: 4 };
const SR_NAMES = { pro: 'нейросеть Liquid RTX Pro', net: 'нейросеть Liquid RTX', anime: 'нейросеть Liquid RTX · аниме', r3: 'RAVU-3', r2: 'RAVU-2', fsr: 'FSR', down: 'уменьшение', off: 'выкл' };
// резкость RCAS после увеличения: у нейросети своя резкость уже есть — «Чисто» почти без добавки, «Чётко» — заметнее
const SR_SHARP_K = { net: { mid: 0.1, max: 0.4 }, anime: { mid: 0.15, max: 0.45 }, ravu: { mid: 0.4, max: 0.7 }, fsr: { mid: 0.4, max: 0.7 } };
const SR_NET_FILE = { pro: 'pro', net: 'lite', anime: 'anime' };
// Движок Liquid RTX: один WebGL2-контекст на своём холсте, рисует кадр видео в размер холста.
// Им пользуются и слой поверх плеера сайта, и Liquid Player.
class RtxEngine {
  constructor(canvas) {
    this.c = canvas;
    const opts = { alpha: true, premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance', desynchronized: false };
    const gl = canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts);
    if (!gl) throw new Error('nogl');
    this.gl = gl; this.gl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    this.par = gl.getExtension('KHR_parallel_shader_compile'); // тяжёлые шейдеры собираются, не останавливая страницу
    this.fbf = this.gl2 && gl.getExtension('EXT_color_buffer_float'); // без него нейросети некуда писать признаки
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.pEasu = this.prog(SR_EASU); this.pRcas = this.prog(SR_RCAS); this.pDown = this.prog(SR_DOWN); this.pBilin = this.prog(SR_BILIN);
    for (const p of [this.pEasu, this.pRcas, this.pDown, this.pBilin]) if (!gl.getProgramParameter(p.p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p.p) || 'link');
    // два исходных кадра по очереди: текущий и прошлый (для стабильности во времени)
    this.tSrcs = [this.tex(), this.tex()]; this.si = 0; this.tSrc = this.tSrcs[0]; this.tMid = this.tex();
    this.fb = gl.createFramebuffer();
    this.ravu = {}; this.ravuReq = {}; this.nets = {}; this.netReq = {}; this.nb = null;
    // смешивание с прошлым кадром (temporal) проверено и выключено: на медленном движении по текстуре давало шлейф
    this.cap = 4; this.used = ''; this.ow = 0; this.oh = 0; this.cfl = 1; this.temporal = 0;
    this.mem = { out: 0, net: 0 }; this.netFrames = 0; this.cfEps = 0.0004;
  }
  tex(filter) {
    const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t;
  }
  // программа + адреса её параметров (узнаём один раз, а не на каждом кадре)
  prog(fs, vs) {
    const gl = this.gl;
    const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); return o; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs || SR_VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    const locs = new Map();
    return { p, a: -1, u: (n) => { if (!locs.has(n)) locs.set(n, gl.getUniformLocation(p, n)); return locs.get(n); } };
  }
  ready(P) { // собрался ли шейдер (не останавливая страницу, если видеокарта умеет собирать в фоне)
    const gl = this.gl;
    if (P.ok || P.bad) return P.ok;
    if (this.par && !gl.getProgramParameter(P.p, this.par.COMPLETION_STATUS_KHR)) return false;
    if (gl.getProgramParameter(P.p, gl.LINK_STATUS)) P.ok = true;
    else { P.bad = true; console.warn('[liquid] Liquid RTX: видеокарта не собрала шейдер:', gl.getProgramInfoLog(P.p)); }
    return P.ok;
  }
  size(ow, oh) {
    if (ow === this.ow && oh === this.oh) return;
    const gl = this.gl;
    this.ow = this.c.width = Math.max(2, ow); this.oh = this.c.height = Math.max(2, oh);
    gl.bindTexture(gl.TEXTURE_2D, this.tMid);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.ow, this.oh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tMid, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.mem.out = this.ow * this.oh * 4 * 3; // промежуточный кадр + холст (два буфера)
  }
  // сколько видеопамяти занято (оценка, МБ)
  vram() { return Math.round((this.mem.out + this.mem.net + (this.lastSrcBytes || 0) * 2) / 1048576); }
  // ---- RAVU (запасной путь)
  loadRavu(r) {
    if (this.ravuReq[r]) return;
    this.ravuReq[r] = true;
    ravuData(r).then((d) => {
      if (this.dead || !d || !d.luts) return;
      const gl = this.gl;
      const luts = d.luts.map((l) => {
        let u8 = l.data instanceof Uint8Array ? l.data : new Uint8Array(l.data);
        if (u8.byteOffset % 4) u8 = u8.slice();
        const t = this.tex();
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, l.w, l.h, 0, gl.RGBA, gl.FLOAT, new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength >> 2));
        return [l.name, t];
      });
      this.ravu[r] = { name: r, ...this.prog(ravuFS(d), SR_VS3), luts };
    }).catch((e) => console.warn('[liquid] RAVU не загрузился:', e && e.message));
  }
  // RAVU больше не нужен (работает нейросеть) — отдаём его таблицы и шейдеры
  freeRavu() {
    const gl = this.gl;
    for (const R of Object.values(this.ravu)) { if (!R) continue; for (const [, t] of R.luts) gl.deleteTexture(t); gl.deleteProgram(R.p); }
    this.ravu = {}; this.ravuReq = {};
  }
  // ---- нейросети
  loadNet(name) {
    if (this.netReq[name] || !this.fbf) return;
    this.netReq[name] = true;
    netData(SR_NET_FILE[name]).then((d) => {
      if (this.dead) return;
      if (!d || !d.layers) { this.nets[name] = null; return; } // нет такой сети — возьмём следующую
      const S = netShaders(d);
      this.nets[name] = { name, F: d.dims[1], L: d.layers.length, layers: S.layers.map((l) => ({ ...this.prog(l.fs, SR_VS3), nIn: l.nIn, nOut: l.nOut })),
        hr: this.prog(S.hr, SR_VS3), cfl: this.prog(S.cfl, SR_VS3), compose: this.prog(S.compose, SR_VS3), ok: false };
    }).catch((e) => { this.nets[name] = null; console.warn('[liquid] нейросеть Liquid RTX не загрузилась:', e && e.message); });
  }
  netReady(N) {
    if (!N || N.bad) return false;
    if (N.ok) return true;
    for (const P of [...N.layers, N.hr, N.cfl, N.compose]) { if (!this.ready(P)) { if (P.bad) N.bad = true; return false; } }
    return (N.ok = true);
  }
  // Память под сеть. Кадр считаем ПОЛОСАМИ (~270 строк + поля под размах свёрток): признаки занимают в 3–4 раза
  // меньше видеопамяти, чем на весь кадр сразу. Плюс добавка сети, яркость 2× (нынешняя и прошлая) и цвет.
  netAlloc(N, vw, vh) {
    const gl = this.gl, nb = this.nb;
    const n = Math.ceil(N.F / 4), m = N.L, strips = Math.max(1, Math.ceil(vh / 272)), rs = Math.ceil(vh / strips), hs = Math.min(vh, rs + 2 * m);
    if (nb && nb.w === vw && nb.h === vh && nb.n === n && nb.hs === hs) return nb;
    if (nb) { for (const t of [...nb.fA, ...nb.fB, nb.tRes, ...nb.hr, nb.tCf]) if (t) gl.deleteTexture(t); for (const f of [nb.fbA, nb.fbB, nb.fbRes, ...nb.fbH, nb.fbCf]) if (f) gl.deleteFramebuffer(f); }
    const mk = (fmt, w, h, filt) => { const t = this.tex(filt); gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, fmt === gl.R16F ? gl.RED : gl.RGBA, gl.HALF_FLOAT, null); return t; };
    const fbo = (texs) => { const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      texs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0)); return f; };
    const B = { w: vw, h: vh, n, hs, rs, hi: 0, fA: [], fB: [] };
    B.fA = Array.from({ length: n }, () => mk(gl.RGBA16F, vw, hs, gl.NEAREST)); B.fB = Array.from({ length: n }, () => mk(gl.RGBA16F, vw, hs, gl.NEAREST));
    B.tRes = mk(gl.RGBA16F, vw, vh, gl.NEAREST);
    const h0 = mk(gl.R16F, vw * 2, vh * 2, gl.LINEAR);
    B.hr = [h0, this.temporal ? mk(gl.R16F, vw * 2, vh * 2, gl.LINEAR) : null]; B.tCf = mk(gl.RGBA16F, vw, vh, gl.LINEAR);
    B.fbA = fbo(B.fA); B.fbB = fbo(B.fB); B.fbRes = fbo([B.tRes]); B.fbH = B.hr.map((t) => (t ? fbo([t]) : null)); B.fbCf = fbo([B.tCf]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.mem.net = (2 * n * vw * hs + 2 * vw * vh) * 8 + vw * vh * 4 * 2 * (this.temporal ? 2 : 1);
    this.prevKey = '';
    return (this.nb = B);
  }
  run(P, fb, w, h, texs, set, nOut, vp) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    if (vp) gl.viewport(vp[0], vp[1], vp[2], vp[3]); else gl.viewport(0, 0, w, h);
    gl.useProgram(P.p);
    if (this.gl2 && fb) gl.drawBuffers(Array.from({ length: nOut || 1 }, (_, i) => gl.COLOR_ATTACHMENT0 + i));
    if (P.a < 0) P.a = gl.getAttribLocation(P.p, 'p');
    gl.enableVertexAttribArray(P.a); gl.vertexAttribPointer(P.a, 2, gl.FLOAT, false, 0, 0);
    texs.forEach(([n, t], i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(P.u(n), i); });
    set(P.u); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  // какой способ увеличения сейчас: лучший из готовых, не выше ступени cap.
  // Пока шейдер нейросети собирается (секунда-другая), рисуем FSR — RAVU ради этого не грузим (лишняя память)
  pick(level, content) {
    if (!this.gl2) return null;
    if (this.cap >= 3 && this.fbf) {
      const order = content === 'anime' ? ['anime', 'net'] : this.cap >= 4 ? ['pro', 'net'] : ['net'];
      // лучшая готовая из списка; пока лучшая собирается — рисует следующая готовая (а не FSR)
      let wait = false;
      for (const n of order) {
        this.loadNet(n);
        const N = this.nets[n];
        if (N && this.netReady(N)) return N;
        if (N === undefined || (N && !N.bad)) wait = true; // веса ещё идут из main или шейдер собирается
      }
      if (wait) return null;
    }
    if (this.cap >= 1) {
      const want = level === 'max' && this.cap >= 2 ? 'r3' : 'r2';
      this.loadRavu(want);
      for (const r of want === 'r3' ? ['r3', 'r2'] : ['r2']) { const R = this.ravu[r]; if (R && this.ready(R)) return R; }
    }
    return null;
  }
  drawNet(N, vw, vh, k) {
    const gl = this.gl, B = this.netAlloc(N, vw, vh), m = N.L, last = N.layers.length - 1;
    const prev = this.tSrcs[this.si ^ 1];
    const key = `${N.name}|${vw}x${vh}`, tw = this.temporal && this.prevKey === key ? this.temporal : 0;
    for (let y0 = 0; y0 < vh; y0 += B.rs) {
      const y1 = Math.min(vh, y0 + B.rs), r0 = Math.max(0, y0 - m), r1 = Math.min(vh, y1 + m), rh = r1 - r0;
      let inT = null, fbOut = B.fbA, outT = B.fA;
      N.layers.forEach((P, i) => {
        if (i === 0) {
          this.run(P, fbOut, vw, rh, [['src', this.tSrc]], (u) => { gl.uniform1f(u('flip'), 0); gl.uniform2i(u('sz'), vw, vh); gl.uniform2i(u('org'), 0, r0); }, P.nOut, [0, 0, vw, rh]);
        } else if (i < last) {
          this.run(P, fbOut, vw, rh, inT.map((t, j) => ['f' + j, t]), (u) => { gl.uniform1f(u('flip'), 0); gl.uniform2i(u('sz'), vw, rh); gl.uniform2i(u('org'), 0, 0); }, P.nOut, [0, 0, vw, rh]);
        } else {
          // последний слой пишет сразу в общую текстуру добавки — только свои строки полосы
          this.run(P, B.fbRes, vw, vh, inT.map((t, j) => ['f' + j, t]), (u) => { gl.uniform1f(u('flip'), 0); gl.uniform2i(u('sz'), vw, rh); gl.uniform2i(u('org'), 0, -r0); }, 1, [0, y0, vw, y1 - y0]);
        }
        if (i < last) { inT = outT; [fbOut, outT] = outT === B.fA ? [B.fbB, B.fB] : [B.fbA, B.fA]; }
      });
    }
    const t2 = !!B.hr[1], hi = t2 ? B.hi : 0, hrNow = B.hr[hi], hrPrev = t2 ? B.hr[hi ^ 1] : B.tRes; // без смешивания — заглушка
    this.run(N.hr, B.fbH[hi], vw * 2, vh * 2, [['src', this.tSrc], ['prev', prev], ['res', B.tRes], ['hrPrev', hrPrev]], (u) => {
      gl.uniform1f(u('flip'), 0); gl.uniform2f(u('lsz'), vw, vh); gl.uniform1f(u('tw'), t2 ? tw : 0);
    });
    if (t2) B.hi ^= 1;
    this.prevKey = key;
    if (this.cfl) this.run(N.cfl, B.fbCf, vw, vh, [['src', this.tSrc]], (u) => { gl.uniform1f(u('flip'), 0); gl.uniform2i(u('sz'), vw, vh); gl.uniform1f(u('eps'), this.cfEps); });
    this.run(N.compose, this.fb, this.ow, this.oh, [['src', this.tSrc], ['hr', hrNow], ['cf', B.tCf]], (u) => {
      gl.uniform1f(u('flip'), 1); gl.uniform2f(u('hsz'), vw * 2, vh * 2); gl.uniform4f(u('crop'), k[0], k[1], k[2], k[3]); gl.uniform1f(u('cfl'), this.cfl);
    });
  }
  // рисует кадр src (видео или VideoFrame) размером vw×vh; crop — видимая часть кадра; split — доля «как было» слева;
  // content — 'video' или 'anime' (рисованное: своя сеть)
  draw(src, vw, vh, crop, level, hdr, split, content) {
    const gl = this.gl, k = crop;
    this.si ^= 1; this.tSrc = this.tSrcs[this.si]; this.lastSrcBytes = vw * vh * 4;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tSrc);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); // кросс-доменное видео без CORS здесь бросит SecurityError
    // видео не меньше холста (4K на 4K-экране, слой ради HDR) — увеличивать нечего: только уменьшаем/копируем
    const down = vw * k[2] >= this.ow * 0.97 && vh * k[3] >= this.oh * 0.97 || vw * k[2] > this.ow * 1.05 || vh * k[3] > this.oh * 1.05;
    const M = down || level === 'off' ? null : this.pick(level, content);
    if (M && M.layers) {
      this.drawNet(M, vw, vh, k);
      if (Object.keys(this.ravu).length && ++this.netFrames > 120) this.freeRavu(); // нейросеть работает стабильно — запасной RAVU не держим
    } else if (M) {
      this.prevKey = '';
      this.run(M, this.fb, this.ow, this.oh, [['HOOKED_raw', this.tSrc], ...M.luts], (u) => {
        gl.uniform1f(u('flip'), 1); gl.uniform2f(u('HOOKED_size'), vw, vh); gl.uniform4f(u('crop'), k[0], k[1], k[2], k[3]);
      });
    } else {
      this.prevKey = '';
      this.run(down ? this.pDown : level === 'off' ? this.pBilin : this.pEasu, this.fb, this.ow, this.oh, [['t', this.tSrc]], (u) => {
        gl.uniform1f(u('flip'), 1); gl.uniform2f(u('src'), vw, vh); gl.uniform4f(u('crop'), k[0], k[1], k[2], k[3]);
      });
    }
    if (!M || !M.layers) this.netFrames = 0;
    this.used = level === 'off' ? 'off' : M ? M.name : down ? 'down' : 'fsr';
    const sk = SR_SHARP_K[this.used === 'pro' || this.used === 'net' ? 'net' : this.used === 'anime' ? 'anime' : /^r\d/.test(this.used) ? 'ravu' : 'fsr'];
    this.run(this.pRcas, null, this.ow, this.oh, [['t', this.tMid], ['raw', this.tSrc]], (u) => {
      gl.uniform2f(u('dst'), this.ow, this.oh); gl.uniform1f(u('flip'), 0);
      gl.uniform1f(u('sharp'), down || level === 'off' ? 0 : sk[level] ?? sk.mid);
      gl.uniform1f(u('hdr'), hdr ? 1 : 0); gl.uniform1f(u('split'), split || 0); gl.uniform4f(u('crop'), k[0], k[1], k[2], k[3]);
    });
    return this.used;
  }
  // ступенька вниз: нейросеть Pro → лёгкая → RAVU-3 → RAVU-2 → FSR
  slower() { const i = SR_TIER[this.used]; if (i > 0) { this.cap = Math.min(this.cap, i - 1); return true; } return false; }
  destroy() { this.dead = true; try { this.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {} }
}
// Следит, успевает ли видеокарта: браузер пропускает кадры видео или наша отрисовка тормозит кадры экрана.
class RtxPerf {
  constructor() { this.q0 = null; this.dts = []; this.last = 0; }
  frame(now) { if (this.last) { this.dts.push(now - this.last); if (this.dts.length > 120) this.dts.shift(); } this.last = now; }
  reset() { this.q0 = null; this.dts = []; this.last = 0; }
  // true — пора ступенька вниз
  check(v, used) {
    const q = v.getVideoPlaybackQuality && v.getVideoPlaybackQuality();
    if (!q || v.paused || document.hidden || !used || used === 'fsr' || used === 'off' || used === 'down') { this.reset(); return false; }
    if (!this.q0 || this.q0.used !== used) { this.q0 = { n: q.totalVideoFrames, d: q.droppedVideoFrames, used }; this.dts = []; return false; }
    const n = q.totalVideoFrames - this.q0.n, d = q.droppedVideoFrames - this.q0.d;
    let slow = false;
    if (n >= 48) { slow = d / n > 0.12; this.q0 = { n: q.totalVideoFrames, d: q.droppedVideoFrames, used }; }
    // кадры экрана: обычно ~7–17 мс; если медиана выросла до 40+ мс при идущем видео — не успеваем
    if (this.dts.length >= 60) { const s = [...this.dts].sort((a, b) => a - b); if (s[s.length >> 1] > 40) slow = true; this.dts = []; }
    if (slow) this.reset();
    return slow;
  }
}
// Рисованное ли видео (аниме, мультики): у них большие идеально ровные заливки, у съёмки — зерно и текстура везде.
// Раз в 4 с уменьшаем кадр до 160×90 и считаем долю «ровных» точек (без тёмных — ночь и полосы не в счёт).
// Проверка на фото и рисунках: у съёмки 0,4–15 %, у рисованного 33–86 %. Решение меняем после 3 одинаковых ответов подряд.
vt.srContent = 'auto';
vt.animeNet = true; // своя сеть для рисованного (main/rtx/liquid-rtx-anime.json)
function contentOf(v) {
  if (!vt.animeNet) return 'video';
  if (vt.srContent === 'video' || vt.srContent === 'anime') return vt.srContent;
  const now = performance.now(), st = v.__lqKind || (v.__lqKind = { kind: 'video', t: 0, votes: 0 });
  if (now - st.t < 4000 || v.readyState < 2) return st.kind;
  st.t = now;
  try {
    const c = vt.kindCv || (vt.kindCv = Object.assign(document.createElement('canvas'), { width: 160, height: 90 }));
    const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high'; g.drawImage(v, 0, 0, 160, 90);
    const a = g.getImageData(0, 0, 160, 90).data, L = (i) => a[i] * 0.2126 + a[i + 1] * 0.7152 + a[i + 2] * 0.0722;
    let flat = 0, n = 0;
    for (let y = 1; y < 89; y++) for (let x = 1; x < 159; x++) {
      const i = (y * 160 + x) * 4, l = L(i);
      if (l < 24) continue;
      n++;
      if (Math.max(Math.abs(l - L(i - 4)), Math.abs(l - L(i + 4)), Math.abs(l - L(i - 640)), Math.abs(l - L(i + 640))) < 1.5) flat++;
    }
    if (n < 800) return st.kind;
    const k = flat / n > 0.22 ? 'anime' : 'video';
    if (k === st.kind) st.votes = 0; else if (++st.votes >= (st.t0 ? 3 : 1)) { st.kind = k; st.votes = 0; }
    st.t0 = 1;
  } catch {} // чужое видео без CORS — считать нельзя, остаётся «видео»
  return st.kind;
}
class SuperRes {
  constructor(v) {
    this.v = v;
    this.c = document.createElement('canvas');
    this.c.setAttribute('data-lq-sr', '');
    this.c.style.cssText = 'position:absolute;pointer-events:none;margin:0;padding:0;border:0;';
    this.eng = new RtxEngine(this.c);
    this.gl = this.eng.gl;
    this.perfMon = new RtxPerf();
    this.used = '';
    this.level = 'mid'; this.hdr = false; this.alive = true; this.ow = 0; this.oh = 0; this.crop = [0, 0, 1, 1];
    this.frames = 0; this.lastT = -1; this.dirty = true; this.bad = 0; this.retestAt = 0; this.idle = 0;
    this.c.style.visibility = 'hidden';
    // Видеокарта может сбросить холст (WebGL context lost): много холстов на странице (Liquid Player открыли-закрыли,
    // сменили качество), сброс драйвера. Сброшенный холст Chromium рисует белым квадратом поверх видео — прячем его,
    // пишем в журнал и пересоздаём слой; три сброса подряд на одном видео — оставляем обычное видео
    this.c.addEventListener('webglcontextlost', (e) => {
      if (!this.alive) return; // это мы сами освободили холст
      e.preventDefault();
      this.c.style.visibility = 'hidden';
      const n = (vt.lostN.get(this.v) || 0) + 1; vt.lostN.set(this.v, n);
      console.warn(`[liquid] Liquid RTX: видеокарта сбросила холст слоя (${n}-й раз) — ${n <= 3 ? 'пересоздаю' : 'показываю обычное видео'}`);
      const v0 = this.v; this.destroy();
      if (n <= 3) setTimeout(srSync, 800); else vt.skip.set(v0, 'lost');
    });
    v.insertAdjacentElement('afterend', this.c);
    this.ro = new ResizeObserver(() => this.place()); this.ro.observe(v);
    this.posT = setInterval(() => { if (!document.hidden) this.place(); }, 700); // свёрнутую вкладку не пересчитываем
    this.perfT = setInterval(() => this.perf(), 2000);
    this.place();
    this.loop();
  }
  perf() {
    if (this.big) { this.perfMon.reset(); return; }
    if (this.perfMon.check(this.v, this.used) && this.eng.slower()) {
      console.warn(`[liquid] Liquid RTX: видеокарта не успевает (${this.used} ${this.ow}×${this.oh}) — ступенька вниз`);
      this.slow = true; barRender();
    }
  }
  place() {
    const v = this.v, c = this.c;
    if (!v.isConnected) return this.destroy();
    if (!c.isConnected) v.insertAdjacentElement('afterend', c);
    // учитываем «чёрные полосы» (object-fit: contain)
    const cs = getComputedStyle(v);
    const fit = cs.objectFit;
    if (fit === 'none' || fit === 'scale-down') { setTimeout(() => this.fail('cover'), 0); return; }
    const ew = v.offsetWidth, eh = v.offsetHeight, vw = v.videoWidth || ew, vh = v.videoHeight || eh;
    let w, h, x, y;
    this.crop = [0, 0, 1, 1]; // какая часть кадра видна: x, y, ширина, высота (доли)
    if (fit === 'cover') {
      // видео растянуто с обрезкой краёв (так теперь показывает YouTube): слой во весь элемент, а в шейдер —
      // только видимая часть кадра
      const k = Math.max(ew / vw, eh / vh) || 1;
      const cw = Math.min(1, ew / (vw * k)), ch = Math.min(1, eh / (vh * k));
      const pos = String(cs.objectPosition || '50% 50%').split(/\s+/).map((t) => (/%$/.test(t) ? parseFloat(t) / 100 : 0.5));
      this.crop = [(1 - cw) * (pos[0] ?? 0.5), (1 - ch) * (pos[1] ?? 0.5), cw, ch];
      w = ew; h = eh; x = v.offsetLeft; y = v.offsetTop;
    } else {
      const k = Math.min(ew / vw, eh / vh) || 1;
      w = fit === 'fill' ? ew : Math.round(vw * k); h = fit === 'fill' ? eh : Math.round(vh * k);
      x = v.offsetLeft + (ew - w) / 2; y = v.offsetTop + (eh - h) / 2;
    }
    // ничего не сдвинулось — не трогаем стили и не перерисовываем кадр заново (место проверяется каждые 0,7 с)
    const sig = `${x},${y},${w},${h},${this.crop},${cs.zIndex},${cs.transform},${window.devicePixelRatio},${v.readyState >= 2 && this.frames > 0}`;
    if (sig === this.sig) return;
    this.sig = sig;
    Object.assign(c.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    c.style.zIndex = cs.zIndex === 'auto' ? '' : cs.zIndex; c.style.transform = cs.transform === 'none' ? '' : cs.transform;
    // реальные точки экрана (4K-монитор при масштабе 150 % — 1,5 точки на пиксель страницы), но не больше 4K
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let ow = Math.round(w * dpr), oh = Math.round(h * dpr);
    const cap = Math.sqrt((3840 * 2160) / Math.max(1, ow * oh)); if (cap < 1) { ow = Math.round(ow * cap); oh = Math.round(oh * cap); }
    this.eng.size(ow, oh); this.ow = this.eng.ow; this.oh = this.eng.oh;
    if (v.readyState < 2 || !this.frames || this.bigNow()) c.style.visibility = 'hidden';
    else c.style.visibility = 'visible';
    this.dirty = true;
  }
  // Видео в кадре крупнее, чем место под него на экране (4K в окне 1785×1004): увеличивать нечего, а уменьшать
  // кадр шейдером хуже, чем это делает сам Chromium (мельтешение на мелких деталях). Тогда слой прячем и
  // показываем видео как есть. С HDR-цветом обрабатываем всё равно — его без нас не будет.
  bigNow() {
    const v = this.v, k = this.crop;
    this.big = !this.hdr && !!this.ow && v.videoWidth * k[2] >= this.ow * 0.97 && v.videoHeight * k[3] >= this.oh * 0.97;
    return this.big;
  }
  draw() {
    const v = this.v;
    if (v.readyState < 2 || !v.videoWidth || !this.ow) return; // слой ещё не получил размер — рисовать некуда
    this.used = this.eng.draw(v, v.videoWidth, v.videoHeight, this.crop, this.level, this.hdr, 0, contentOf(v));
    if (/^(pro|net|anime|r\d)$/.test(this.used) && !this.c.dataset.lqSrBest) this.c.dataset.lqSrBest = this.used;
    this.c.dataset.lqSr = this.used;
  }
  // Рисуем по кадрам экрана и только когда у видео сменился кадр.
  // (requestVideoFrameCallback не используем: когда наш слой закрывает видео, Chromium может перестать его вызывать — картинка «застывала»)
  loop() {
    if (!this.alive) return;
    const v = this.v;
    const t = v.currentTime, now = performance.now();
    this.perfMon.frame(now);
    // шейдер нейросети / RAVU собрался, пока видео на паузе, — перерисуем кадр уже им
    if (v.paused && !this.dirty && !this.big && /^(fsr|r2|r3|net)$/.test(this.used) && (++this.idle % 30) === 0) {
      const best = this.eng.pick(this.level, contentOf(this.v)); if ((best ? best.name : 'fsr') !== this.used) this.dirty = true;
    }
    if (v.readyState >= 2 && (t !== this.lastT || this.dirty) && this.bigNow()) {
      // показываем видео как есть, видеокарту не нагружаем; размер окна или HDR поменяются — слой вернётся
      if (this.c.style.visibility !== 'hidden') this.c.style.visibility = 'hidden';
      this.lastT = t; this.dirty = false;
    } else if (v.readyState >= 2 && (t !== this.lastT || this.dirty)) {
      if (this.frames && this.c.style.visibility === 'hidden') this.c.style.visibility = 'visible';
      this.lastT = t; this.dirty = false;
      const was = this.used;
      try { this.draw(); this.frames++; } catch (e) { this.fail('cors'); return; }
      if (was !== this.used && bar.v === v) barRender();
      const f = this.frames;
      if (f === 8 || f === 60 || f % 600 === 0 || f === this.retestAt) { if (!this.selfTest()) return; }
      if (f === 1) { this.c.style.visibility = 'visible'; this.uiCheck(); }
    }
    requestAnimationFrame(() => this.loop());
  }
  // Проверяем, что видеокарта реально отдаёт кадр, а не чёрный экран
  // Видеокарта иногда отдаёт пустой кадр на переходах (реклама, смена ролика, перемотка) — это не поломка.
  // Сравниваем 5 одинаковых точек кадра: видео и наш слой. Сбой — только если слой чёрный там, где видео светлое,
  // в большинстве точек и три проверки подряд; одна неудачная проверка просто назначает повторную через 10 кадров.
  selfTest() {
    const v = this.v, gl = this.gl;
    try {
      const W = 32, H = 18;
      const s2 = this.probe || (this.probe = Object.assign(document.createElement('canvas'), { width: W, height: H }));
      const g = s2.getContext('2d', { willReadFrequently: true });
      g.drawImage(v, 0, 0, W, H);
      const a = g.getImageData(0, 0, W, H).data;
      const px = new Uint8Array(4 * 4);
      let bad = 0;
      for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        // точка слоя (fx, fy) показывает точку кадра с учётом обрезки краёв
        const c = this.crop, sx = c[0] + fx * c[2], sy = c[1] + fy * c[3];
        const i = (Math.min(H - 1, Math.floor(sy * H)) * W + Math.min(W - 1, Math.floor(sx * W))) * 4;
        const sv = (a[i] + a[i + 1] + a[i + 2]) / 3;
        gl.readPixels(Math.floor(fx * this.ow), Math.floor((1 - fy) * this.oh), 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let sg = 0; for (let k = 0; k < 16; k += 4) sg += (px[k] + px[k + 1] + px[k + 2]) / 3;
        if (sv > 24 && sg / 4 < 4) bad++;
      }
      if (bad >= 3) {
        this.bad++;
        if (this.bad >= 3) { this.fail('gpu'); return false; }
        this.retestAt = this.frames + 10;
      } else this.bad = 0;
    } catch (e) { /* кросс-доменное видео — сравнить не можем, верим отрисовке */ }
    return true;
  }
  // слой появился — не закрыл ли он кнопки плеера; плееры меняют интерфейс (Shorts — при каждом ролике), поэтому повторяем
  uiCheck() {
    if (!this.alive) return;
    // в свёрнутой вкладке кнопки плеера никто не видит — проверим, когда вернутся
    if (document.hidden) { clearTimeout(this.uiT); this.uiT = setTimeout(() => this.uiCheck(), 3000); return; }
    if (uiAtRisk(this.v)) {
      const v = this.v;
      console.warn(`[liquid] супер-чёткость закрывала бы кнопки плеера — выключена для этого видео @ ${location.hostname}`);
      this.destroy(); vt.skip.set(v, 'ui'); barRender();
      return;
    }
    clearTimeout(this.uiT); this.uiT = setTimeout(() => this.uiCheck(), 3000);
  }
  fail(reason) {
    if (reason === 'cors' || reason === 'cover') {
      const v = this.v;
      console.warn(`[liquid] супер-чёткость в лёгком режиме: ${reason} @ ${location.hostname}`);
      this.destroy(); vt.lite.add(v); liteApply(v); barRender();
      return;
    }
    console.warn(`[liquid] супер-чёткость отключена: ${reason}, видео ${this.v.videoWidth}x${this.v.videoHeight} @ ${location.hostname}`);
    this.destroy();
    vt.srBroken = true; vt.srWhy = reason;
    toHost({ type: 'srFail', reason });
    barRender();
  }
  destroy() { if (!this.alive) return; this.alive = false; clearInterval(this.posT); clearInterval(this.perfT); clearTimeout(this.uiT); this.ro.disconnect(); this.c.remove(); this.eng.destroy(); vt.srMap.delete(this.v); }
}
vt.srMap = new Map();
vt.lostN = new WeakMap(); // сколько раз видеокарта сбрасывала холст слоя на этом видео
vt.skip = new WeakMap(); // видео, которые не улучшаем: 'drm' — защищённое, 'ui' — улучшение закрыло бы кнопки плеера
// Кнопки и подписи плеера поверх видео (YouTube Shorts и др.). Наш слой и фильтр поднимают видео в порядке
// отрисовки, и элементы плеера, у которых нет своего слоя, оказываются под ним — интерфейс «пропадает».
// Проверяем честно: что лежит выше в стопке на месте каждой кнопки — она или наше видео/слой.
// Рисуется ли элемент el выше видео v только благодаря порядку в документе. Холст и фильтр поднимают видео
// в слой «позиционированных» элементов, и такие кнопки оказываются под ним — интерфейс «пропадает» (YouTube Shorts и др.).
// Считаем по правилам CSS, а не по клику: у видео есть свой невидимый слой, который всегда «сверху» для elementsFromPoint.
function layered(n) {
  const cs = getComputedStyle(n);
  if (cs.position !== 'static') return true;
  if (cs.zIndex !== 'auto' && n.parentElement && /flex|grid/.test(getComputedStyle(n.parentElement).display)) return true;
  return parseFloat(cs.opacity) < 1 || cs.transform !== 'none' || cs.filter !== 'none' || cs.isolation === 'isolate' || cs.mixBlendMode !== 'normal' ||
    /transform|opacity|filter/.test(cs.willChange) || /paint|strict|content/.test(cs.contain);
}
function paintRoot(el, stop) {
  for (let n = el; n && n !== stop; n = n.parentElement) if (layered(n)) return n;
  return null;
}
function uiAtRisk(v) {
  if (layered(v)) return false; // видео и так в своём слое — наш холст/фильтр порядок не меняет
  const vr = v.getBoundingClientRect();
  if (vr.width < 50) return false;
  let root = v; for (let i = 0; i < 6 && root.parentElement; i++) root = root.parentElement;
  for (const el of root.querySelectorAll('button, a, [role="button"], svg, img, h1, h2, h3, yt-formatted-string, span')) {
    if (el === v || el.contains(v) || el.closest('lq-video-bar')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6 || r.left >= vr.right || r.right <= vr.left || r.top >= vr.bottom || r.bottom <= vr.top) continue;
    if (getComputedStyle(el).visibility === 'hidden') continue;
    let ca = v.parentElement; while (ca && !ca.contains(el)) ca = ca.parentElement; // общий предок
    const pr = paintRoot(el, ca);
    if (!pr) return true; // кнопка в обычном потоке — окажется под поднятым видео
    const z = getComputedStyle(pr).zIndex;
    // слой без z-index, который в документе раньше видео, тоже окажется под ним
    if ((z === 'auto' || z === '0') && (pr.compareDocumentPosition(v) & Node.DOCUMENT_POSITION_FOLLOWING)) return true;
  }
  return false;
}
// лёгкий режим: фильтр прямо на видео — если только он не утопит кнопки плеера
function liteApply(v) {
  const f0 = v.style.filter; v.style.filter = '';
  const risk = uiAtRisk(v);
  v.style.filter = f0;
  if (risk && vt.sr !== 'off') { vt.skip.set(v, 'ui'); vt.lite.delete(v); }
  applyFilter(v);
  if (vt.lite.has(v)) liteWatch(v);
}
// Сторож лёгкого режима: фильтр стоит прямо на плеере сайта, и если после этого видео не идёт
// (не на паузе, но время 4 секунды стоит на месте) — снимаем фильтр с этого видео насовсем
function liteWatch(v) {
  if (v.__lqWatch) return;
  let lastT = v.currentTime, still = 0;
  v.__lqWatch = setInterval(() => {
    if (!vt.lite.has(v) || !v.isConnected) { clearInterval(v.__lqWatch); v.__lqWatch = 0; return; }
    if (v.paused || document.hidden || v.currentTime !== lastT) { lastT = v.currentTime; still = 0; return; }
    if (++still < 4) return;
    clearInterval(v.__lqWatch); v.__lqWatch = 0;
    console.warn(`[liquid] лёгкий режим чёткости снят: видео не шло с фильтром @ ${location.hostname}`);
    vt.lite.delete(v); vt.skip.set(v, 'stall'); applyFilter(v); barRender();
  }, 1000);
}
function srSync() {
  for (const v of videos()) {
    const big = v.offsetWidth >= 240;
    let r = vt.srMap.get(v);
    if (vt.sr === 'off' || !big) { if (r) r.destroy(); if (vt.lite.has(v)) applyFilter(v); continue; }
    // защищённое видео (DRM: кинотеатры, платные сервисы) видеокарте не отдаётся, а фильтры могут его зачернить
    if (v.mediaKeys) { if (r) r.destroy(); vt.skip.set(v, 'drm'); continue; }
    if (vt.skip.has(v)) continue;
    if (!r && !vt.lite.has(v) && uiAtRisk(v)) { vt.skip.set(v, 'ui'); continue; } // улучшение закрыло бы кнопки плеера
    if (vt.lite.has(v)) {
      liteApply(v);
      continue;
    }
    if (!r) { if (vt.srBroken) continue; try { r = new SuperRes(v); vt.srMap.set(v, r); } catch (e) { toHost({ type: 'srFail', reason: 'nogl' }); continue; } }
    r.level = vt.sr; r.hdr = vt.srHdr;
  }
  barRender();
}
// Новое видео в том же плеере (YouTube переносит один плеер с превью на главной в ролик и меняет в нём видео):
// забываем всё, что решили для прошлого видео, — как будто страницу перезагрузили. Раньше «лёгкий режим»
// от превью оставался на ролике, и видео стояло на чёрном экране до перезагрузки страницы.
document.addEventListener('loadstart', (e) => {
  const v = e.target;
  if (!v || v.tagName !== 'VIDEO') return;
  vt.srMap.get(v)?.destroy();
  const hadLite = vt.lite.delete(v);
  if (vt.skip.get(v) !== 'drm') vt.skip.delete(v);
  if (hadLite) applyFilter(v); // снимаем резкость и HDR-фильтр лёгкого режима с плеера
}, true);
document.addEventListener('play', () => setTimeout(srSync, 50), true);
document.addEventListener('loadeddata', () => setTimeout(srSync, 50), true);

// ---------- 8. Кнопка на видео: кружок в углу, по нажатию — компактная панель ----------
const BAR_CSS = `
:host { all: initial; }
.dot, .bar { position: fixed; z-index: 2147483647; box-sizing: border-box;
  background: linear-gradient(180deg, rgba(40,38,52,.74), rgba(22,20,30,.8)); backdrop-filter: blur(18px) saturate(170%);
  border: 1px solid rgba(255,255,255,.18); box-shadow: inset 0 1px 0 rgba(255,255,255,.25), 0 12px 30px -12px rgba(0,0,0,.7);
  font: 12px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; color: rgba(255,255,255,.92); user-select: none; }
.dot { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; cursor: pointer; padding: 0;
  opacity: 0; transform: scale(.8); pointer-events: none; transition: opacity .2s, transform .35s cubic-bezier(.2,.9,.25,1.2), background .2s; }
.dot.vis { opacity: 1; transform: none; pointer-events: auto; }
.dot:hover, .dot.open { background: linear-gradient(180deg, #e88a68, #c9633f); }
.dot svg { width: 18px; height: 18px; }
.bar { width: 268px; display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 16px;
  opacity: 0; transform: translateY(-6px) scale(.96); transform-origin: top right; transition: opacity .18s, transform .3s cubic-bezier(.2,.9,.25,1.15); pointer-events: none; }
.bar.on { opacity: 1; transform: none; pointer-events: auto; }
.row { display: flex; align-items: center; gap: 3px; }
.grow { flex: 1; }
button { all: unset; cursor: pointer; height: 28px; min-width: 28px; padding: 0 7px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; box-sizing: border-box; color: rgba(255,255,255,.85); transition: background .15s, transform .3s cubic-bezier(.2,.9,.25,1.2); white-space: nowrap; }
button:hover { background: rgba(255,255,255,.12); color: #fff; }
button:active { transform: scale(.92); }
button.on { background: linear-gradient(180deg, #e88a68, #c9633f); color: #fff; box-shadow: inset 0 1px 0 rgba(255,255,255,.3); }
button.sr { min-width: 98px; } button.sr.on { background: linear-gradient(180deg, #34d399, #059669); }
button.lp { background: rgba(232,138,104,.22); color: #fff; } button.lp:hover { background: linear-gradient(180deg, #e88a68, #c9633f); }
button.sr i { font-style: normal; font-size: 10px; font-weight: 700; opacity: .85; }
svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
.val { width: 36px; text-align: center; font-weight: 650; font-variant-numeric: tabular-nums; }
input[type=range] { -webkit-appearance: none; appearance: none; flex: 1; min-width: 0; height: 4px; border-radius: 4px; background: rgba(255,255,255,.2); outline: none; }
input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 13px; height: 13px; border-radius: 50%; background: #fff; box-shadow: 0 2px 6px rgba(0,0,0,.5); }
.more { display: none; flex-direction: column; gap: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,.1); }
.bar.x .more { display: flex; }
.more label { display: flex; align-items: center; gap: 8px; color: rgba(255,255,255,.65); }
.more label span { width: 92px; } .more label b { width: 34px; text-align: right; color: #fff; font-weight: 600; }
.st { font-size: 11px; line-height: 1.35; color: rgba(255,255,255,.55); padding: 0 4px; } .st:empty { display: none; } .st.ok { color: #6ee7b7; } .st.bad { color: #fca5a5; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; } .chips button { height: 26px; font-size: 11.5px; background: rgba(255,255,255,.06); }`;
const IC = {
  minus: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>', plus: '<svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  pip: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="12" y="11.5" width="7" height="5.5" rx="1.2" fill="currentColor" stroke="none"/></svg>',
  sr: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18" cy="12" r="1.3" fill="currentColor"/></svg>',
  mini: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2.5"/><path d="M8 20.5h8"/><rect x="11.5" y="9.5" width="6.5" height="4.5" rx="1" fill="currentColor" stroke="none"/></svg>',
  dot: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
  play: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor"/></svg>',
};
const bar = { host: null, root: null, el: null, dot: null, v: null, hideT: 0, hover: false, open: false };
function barBuild() {
  if (bar.host) return;
  bar.host = document.createElement('lq-video-bar');
  bar.root = bar.host.attachShadow({ mode: 'closed' });
  setHTML(bar.root, `<style>${BAR_CSS}</style><button class="dot" title="Настройки видео: скорость, громкость, чёткость (Alt+V)">${IC.dot}</button><div class="bar">
    <div class="row">
      <button data-a="slower" title="Медленнее (Shift+колесо)">${IC.minus}</button><span class="val" data-v="speed">1×</span><button data-a="faster" title="Быстрее">${IC.plus}</button>
      <span class="grow"></span>
      <button data-a="pip" title="Картинка в картинке (Alt+P)">${IC.pip}</button>
      <button data-a="mini" title="Окно поверх игры: маленькое окно над всеми окнами, можно сделать прозрачным">${IC.mini}</button>
      <button data-a="more" title="Яркость, контраст и другое">${IC.more}</button>
    </div>
    <div class="row">
      <button data-a="mute" title="Громкость до 300% (Alt+колесо)">${IC.vol}</button><input type="range" data-r="vol" min="0" max="300" step="5"><span class="val" data-v="vol">100%</span>
    </div>
    <div class="row">
      <button class="sr" data-a="sr" title="Liquid RTX на плеере сайта: нейросеть убирает сжатие и увеличивает до разрешения экрана. Нажимай: выкл → чисто → чётко">${IC.sr}Чёткость <i data-v="sr"></i></button>
      <button data-a="hdr" title="HDR-цвет">HDR</button><span class="grow"></span>
      <button data-a="player" class="lp" title="Liquid Player: смотреть на весь экран в своём плеере с Liquid RTX (Alt+Enter)">${IC.play}Плеер</button>
    </div>
    <div class="st" data-v="st"></div>
    <div class="more">
      <label><span>Яркость</span><input type="range" data-r="bright" min="50" max="180" step="5"><b data-v="bright"></b></label>
      <label><span>Контраст</span><input type="range" data-r="contrast" min="50" max="180" step="5"><b data-v="contrast"></b></label>
      <label><span>Насыщенность</span><input type="range" data-r="sat" min="0" max="200" step="5"><b data-v="sat"></b></label>
      <div class="chips">
        ${/(^|\.)youtube\.com$/.test(location.hostname) ? '<button data-a="summary">Пересказать (Claude)</button>' : ''}<button data-a="watch">Смотреть вместе</button><button data-a="clipbuf">Буфер клипа</button><button data-a="clip">Сохранить клип</button>
        <button data-a="comp">Ровная громкость</button><button data-a="loop">Повтор</button><button data-a="remember">Запомнить скорость</button>
        <button data-a="frame">Кадр в PNG</button><button data-a="reset">Сбросить</button>
      </div>
    </div></div>`);
  bar.el = bar.root.querySelector('.bar');
  bar.dot = bar.root.querySelector('.dot');
  if (!bar.el || !bar.dot) { report('панель видео', 'не удалось собрать разметку'); bar.host = null; bar.broken = true; return; }
  const stop = (e) => e.stopPropagation();
  for (const el of [bar.el, bar.dot]) {
    for (const ev of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'keydown']) el.addEventListener(ev, stop);
    el.addEventListener('mouseenter', () => { bar.hover = true; clearTimeout(bar.hideT); });
    el.addEventListener('mouseleave', () => { bar.hover = false; barHideSoon(); });
  }
  bar.dot.addEventListener('click', () => barOpen(!bar.open));
  bar.el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); const v = bar.v;
    if (!b || !v) return;
    const a = b.dataset.a;
    if (a === 'slower' || a === 'faster') { const r = Math.max(0.25, Math.min(4, Math.round((v.playbackRate + (a === 'faster' ? 0.25 : -0.25)) * 4) / 4)); v.playbackRate = r; vt.want.speed = r; if (vt.remember) toHost({ type: 'videoRemember', on: true, speed: r }); }
    else if (a === 'mute') setVolume(v, getVolume(v) > 0 ? 0 : 1);
    else if (a === 'sr') {
      if (vt.srBroken) { vt.srBroken = false; vt.srWhy = ''; if (vt.sr === 'off') vt.sr = 'mid'; } // после сбоя — пробуем снова
      else vt.sr = vt.sr === 'off' ? 'mid' : vt.sr === 'mid' ? 'max' : 'off';
      srSync(); toHost({ type: 'srPref', level: vt.sr, hdr: vt.srHdr });
    }
    else if (a === 'hdr') { vt.srHdr = !vt.srHdr; if (vt.srHdr) { vt.srBroken = false; vt.srWhy = ''; if (vt.sr === 'off') vt.sr = 'mid'; } srSync(); toHost({ type: 'srPref', level: vt.sr, hdr: vt.srHdr }); }
    else if (a === 'pip') pipToggle(v);
    else if (a === 'player') { barOpen(false); lpOpen(v); }
    else if (a === 'more') { barExpand(!bar.el.classList.contains('x')); barPlace(); }
    else if (a === 'comp') setComp(v, !vt.graphs.get(v)?.compOn);
    else if (a === 'loop') v.loop = !v.loop;
    else if (a === 'remember') { vt.remember = !vt.remember; toHost({ type: 'videoRemember', on: vt.remember, speed: v.playbackRate }); }
    else if (a === 'frame') videoCmd({ op: 'frame' });
    else if (a === 'mini') { barOpen(false); miniOut(v); }
    else if (a === 'watch') { barOpen(false); toHost({ type: 'watchOpen' }); }
    else if (a === 'summary') { barOpen(false); toHost({ type: 'summarize' }); }
    else if (a === 'clipbuf') clip.v === v ? clipStop(true) : clipStart(v);
    else if (a === 'clip') clipSave();
    else if (a === 'reset') videoCmd({ op: 'reset' });
    barRender();
  });
  bar.el.addEventListener('input', (e) => {
    const r = e.target.dataset.r; const v = bar.v; if (!r || !v) return;
    const x = +e.target.value;
    if (r === 'vol') setVolume(v, x / 100);
    else { vt.want[r] = x / 100; applyFilter(v); }
    barRender();
  });
  // нажатие мимо панели закрывает её
  document.addEventListener('pointerdown', (e) => { if (bar.open && !e.composedPath().includes(bar.host)) barOpen(false); }, true);
  document.documentElement.appendChild(bar.host);
}
function barRender() {
  if (!bar.el || !bar.v) return;
  const v = bar.v, q = (s2) => bar.root.querySelector(s2);
  q('[data-v="speed"]').textContent = fmtRate(v.playbackRate);
  const vol = Math.round(getVolume(v) * 100);
  q('[data-r="vol"]').value = vol; q('[data-v="vol"]').textContent = vol + '%';
  const sr = q('[data-a="sr"]'); sr.classList.toggle('on', vt.sr !== 'off');
  q('[data-v="sr"]').textContent = vt.sr === 'off' ? '' : vt.sr === 'mid' ? 'чисто' : 'чётко';
  q('[data-a="hdr"]').classList.toggle('on', vt.srHdr);
  const st = q('[data-v="st"]'), r = vt.srMap.get(v);
  const WHY = { cors: 'сайт не даёт обработать своё видео', gpu: 'видеокарта не отдала кадр', stall: 'кадры перестали обновляться', nogl: 'нет WebGL', small: 'видео слишком маленькое' };
  if (vt.sr !== 'off' && vt.skip.get(v) === 'drm') { st.className = 'st'; st.textContent = 'Защищённое видео (DRM) — сервис не разрешает его обрабатывать.'; }
  else if (vt.sr !== 'off' && vt.skip.get(v) === 'stall') { st.className = 'st'; st.textContent = 'Для этого видео выключено: с улучшением оно не запускалось.'; }
  else if (vt.sr !== 'off' && vt.skip.get(v) === 'ui') { st.className = 'st'; st.textContent = 'Для этого плеера выключено: улучшение закрыло бы его кнопки.'; }
  else if (vt.srBroken) { st.className = 'st bad'; st.textContent = `Не работает: ${WHY[vt.srWhy] || 'ошибка'}. Нажми «Чёткость», чтобы попробовать снова.`; }
  else if (vt.sr !== 'off' && vt.lite.has(v)) { st.className = 'st ok'; st.textContent = `Работает в лёгком режиме: резкость${vt.srHdr ? ' и HDR-цвет' : ''} без апскейла — этот плеер не отдаёт кадры видеокарте.`; }
  else if (vt.sr !== 'off' && r && r.big) { st.className = 'st ok'; st.textContent = `Не нужна: видео ${v.videoWidth}×${v.videoHeight} крупнее плеера на экране (${r.ow}×${r.oh}) — показываю как есть. В полном экране включится сама.`; }
  else if (vt.sr !== 'off' && r && r.frames > 0) {
    // каким способом сейчас увеличиваем: RAVU-3 / RAVU-2 (обученный фильтр) или FSR (запасной)
    const how = SR_NAMES[r.used] ? ' · ' + SR_NAMES[r.used] + (r.slow ? ' (видеокарта не успевала за лучшим)' : '') : '';
    st.className = 'st ok'; st.textContent = `Работает: ${v.videoWidth}×${v.videoHeight} → ${r.ow}×${r.oh}${how}${vt.srHdr ? ' · HDR' : ''}`;
  }
  else if (vt.sr !== 'off' && v.offsetWidth < 240) { st.className = 'st'; st.textContent = 'Включится, когда видео станет больше.'; }
  else if (vt.sr !== 'off') { st.className = 'st'; st.textContent = 'Включается…'; setTimeout(barRender, 600); }
  else { st.className = 'st'; st.textContent = ''; }
  q('[data-a="pip"]').classList.toggle('on', document.pictureInPictureElement === v);
  for (const k of ['bright', 'contrast', 'sat']) { const val = Math.round((vt.want[k] ?? 1) * 100); q(`[data-r="${k}"]`).value = val; q(`[data-v="${k}"]`).textContent = val + '%'; }
  q('[data-a="comp"]').classList.toggle('on', !!vt.graphs.get(v)?.compOn);
  q('[data-a="loop"]').classList.toggle('on', v.loop);
  q('[data-a="remember"]').classList.toggle('on', !!vt.remember);
  q('[data-a="clipbuf"]').classList.toggle('on', clip.v === v);
  q('[data-a="clipbuf"]').textContent = clip.v === v ? `Буфер клипа · ${clipSecs()} с` : 'Буфер клипа';
  q('[data-a="watch"]').classList.toggle('on', wt.on);
}
// кружок — в правом верхнем углу видео, панель раскрывается под ним, прижатая к правому краю
function barPlace() {
  if (!bar.v || !bar.el) return;
  const r = bar.v.getBoundingClientRect();
  const top = Math.max(8, r.top + 12), right = Math.min(innerWidth - 8, r.right - 12);
  bar.dot.style.left = (right - 36) + 'px'; bar.dot.style.top = top + 'px';
  bar.el.style.left = Math.max(8, right - 268) + 'px'; bar.el.style.top = (top + 44) + 'px';
}
function barShow(v, force) {
  if (bar.broken || (!vt.barOn && !force) || v.offsetWidth < 300 || v.offsetHeight < 150) return;
  barBuild();
  if (!bar.el) return;
  const fs = document.fullscreenElement;
  const parent = fs && fs.contains(v) ? fs : document.documentElement;
  if (bar.host.parentNode !== parent) parent.appendChild(bar.host);
  if (bar.v !== v) { bar.v = v; barOpen(false); }
  barRender(); barPlace();
  bar.dot.classList.add('vis');
  barHideSoon();
}
function barOpen(on) {
  if (!bar.el) return;
  bar.open = on;
  bar.el.classList.toggle('on', on); bar.dot.classList.toggle('open', on);
  if (!on) barExpand(false); else { barRender(); barPlace(); clearTimeout(bar.hideT); }
}
function barExpand(on) { if (bar.el) bar.el.classList.toggle('x', on); }
function barHideSoon() {
  clearTimeout(bar.hideT);
  bar.hideT = setTimeout(() => { if (!bar.hover && !bar.open) bar.dot && bar.dot.classList.remove('vis'); }, 2400);
}
// Видео под курсором ищем не на каждом кадре движения мыши (на 180 Гц — 180 раз в секунду на любом сайте),
// а раз в 60 мс; на страницах без обычных <video> — раз в 0,4 с (видео там может быть только внутри компонентов).
let barT = 0, barLast = 0, barX = 0, barY = 0;
const liveVideos = document.getElementsByTagName('video'); // «живой» список: узнать, есть ли видео, ничего не стоит
document.addEventListener('mousemove', (e) => {
  barX = e.clientX; barY = e.clientY;
  if (barT) return;
  const gap = liveVideos.length ? 60 : 400;
  barT = setTimeout(() => {
    barT = 0; barLast = performance.now();
    const v = videoAt(barX, barY);
    if (v) barShow(v);
  }, Math.max(0, barLast + gap - performance.now()));
}, { passive: true, capture: true });
document.addEventListener('scroll', () => { if (bar.dot && bar.dot.classList.contains('vis')) barPlace(); }, { passive: true, capture: true });
document.addEventListener('fullscreenchange', () => { if (bar.v) setTimeout(() => barShow(bar.v), 100); for (const r of vt.srMap.values()) setTimeout(() => r.place(), 120); });
async function pipToggle(v) {
  v = v || mainVideo();
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (v) { v.disablePictureInPicture = false; v.removeAttribute('disablepictureinpicture'); await v.requestPictureInPicture(); }
  } catch (e) { console.warn('[liquid] картинка в картинке: ' + e.message + ' @ ' + location.hostname); toHost({ type: 'pipFail' }); }
  barRender();
}

// ---------- 9. Окно поверх игры ----------
// Во вкладке: ставим видео на паузу и просим браузер открыть этот же адрес в маленьком окне с того же места.
function miniOut(v) {
  v = v || mainVideo();
  if (!v) { toHost({ type: 'videoErr', error: 'на странице нет видео' }); return; }
  const t = v.currentTime;
  try { v.pause(); } catch {}
  toHost({ type: 'mini', url: location.href, t, live: !isFinite(v.duration) });
}
// В самом маленьком окне: видео на всё окно, сверху — панель с прозрачностью, «сквозь окно», «во вкладку»
const mini = { on: false, bar: null, root: null, hideT: 0, userPaused: false };
const MINI_CSS = `html,body{overflow:hidden!important;background:#000!important}
[data-lq-mini]{position:fixed!important;inset:0!important;left:0!important;top:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;
margin:0!important;z-index:2147483646!important;object-fit:contain!important;background:#000!important;transform:none!important;visibility:visible!important;opacity:1!important}`;
function miniMode({ t, opacity }) {
  if (mini.on || IS_FRAME) return;
  mini.on = true; vt.barOn = false;
  const st = document.createElement('style'); st.textContent = MINI_CSS;
  (document.head || document.documentElement).appendChild(st);
  let seeked = !(t > 1);
  const grab = () => {
    const v = mainVideo() || videos()[0];
    if (!v) return;
    if (!v.hasAttribute('data-lq-mini')) {
      document.querySelectorAll('[data-lq-mini]').forEach((x) => x.removeAttribute('data-lq-mini'));
      v.setAttribute('data-lq-mini', '');
      // у родителей видео убираем то, из-за чего «на всё окно» не работает (transform и contain)
      for (let p = v.parentElement; p; p = p.parentElement) for (const k of ['transform', 'contain', 'filter', 'will-change']) p.style.setProperty(k, k === 'will-change' ? 'auto' : 'none', 'important');
      v.addEventListener('pause', () => { if (!mini.seeking) mini.userPaused = true; });
      v.addEventListener('play', () => { mini.userPaused = false; });
    }
    if (!seeked && v.readyState >= 1 && isFinite(v.duration) && v.duration > t) { seeked = true; mini.seeking = true; v.currentTime = t; setTimeout(() => { mini.seeking = false; }, 500); }
    if (v.paused && !mini.userPaused) v.play().catch(() => {});
  };
  grab(); setInterval(grab, 700); // сайт может заменить <video> (реклама, смена качества)
  miniBuild(opacity);
}
function miniBuild(opacity) {
  const host = document.createElement('lq-mini-bar');
  const root = host.attachShadow({ mode: 'closed' });
  setHTML(root, `<style>
:host{all:initial}
.bar{position:fixed;left:0;right:0;top:0;height:38px;z-index:2147483647;display:flex;align-items:center;gap:4px;padding:0 6px;box-sizing:border-box;
 background:linear-gradient(180deg,rgba(10,10,16,.85),rgba(10,10,16,0));-webkit-app-region:drag;opacity:0;transition:opacity .2s;font:12px "Segoe UI",system-ui,sans-serif;color:#fff}
.bar.on{opacity:1}
button{all:unset;-webkit-app-region:no-drag;cursor:pointer;height:26px;min-width:26px;padding:0 8px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;background:rgba(255,255,255,.1);box-sizing:border-box;white-space:nowrap}
button:hover{background:rgba(255,255,255,.22)} button.on{background:linear-gradient(180deg,#e88a68,#c9633f)}
.grow{flex:1} .val{min-width:34px;text-align:center;opacity:.8}
.ct{position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:2147483647;padding:6px 12px;border-radius:10px;background:rgba(10,10,16,.75);font:12px "Segoe UI",system-ui,sans-serif;color:#fff;display:none}
.ct.on{display:block}
</style><div class="bar"><button data-a="play" title="Пауза / играть">⏯</button><span class="grow"></span>
<button data-a="op-" title="Прозрачнее">−</button><span class="val"></span><button data-a="op+" title="Плотнее">+</button>
<button data-a="click" title="Сквозь окно: клики уходят в игру. Вернуть — Ctrl+Alt+M">Сквозь</button>
<button data-a="back" title="Вернуть во вкладку">Во вкладку</button><button data-a="close" title="Закрыть (Esc)">✕</button></div>
<div class="ct">Окно пропускает клики насквозь — Ctrl+Alt+M, чтобы вернуть</div>`);
  mini.root = root; mini.bar = root.querySelector('.bar');
  miniBarOpacity(opacity || 1);
  root.querySelector('.bar').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const a = b.dataset.a, v = document.querySelector('[data-lq-mini]');
    if (a === 'play' && v) { v.paused ? v.play().catch(() => {}) : v.pause(); }
    else if (a === 'op-' || a === 'op+') ipcRenderer.send('mini:cmd', { op: 'opacity', d: a === 'op-' ? -0.1 : 0.1 });
    else if (a === 'click') ipcRenderer.send('mini:cmd', { op: 'click' });
    else if (a === 'back') ipcRenderer.send('mini:cmd', { op: 'back', t: v ? v.currentTime : 0 });
    else if (a === 'close') ipcRenderer.send('mini:cmd', { op: 'close' });
  });
  const show = () => { mini.bar.classList.add('on'); clearTimeout(mini.hideT); mini.hideT = setTimeout(() => mini.bar.classList.remove('on'), 2200); };
  document.addEventListener('mousemove', show, { passive: true, capture: true });
  document.documentElement.appendChild(host);
  show();
}
function miniBarCt(on) { if (!mini.root) return; mini.root.querySelector('[data-a="click"]').classList.toggle('on', on); mini.root.querySelector('.ct').classList.toggle('on', on); }
function miniBarOpacity(v) { if (mini.root) mini.root.querySelector('.val').textContent = Math.round(v * 100) + '%'; }

// ---------- 10. Клип последних 30 секунд ----------
// Пока включён «Буфер клипа», видео записывается двумя сменяющимися записями (новая каждые 30 с, живут по минуте).
// «Сохранить клип» берёт старшую из них: в ней последние 30–60 секунд. Кодирует видеокарта (H.264), если умеет.
const clip = { v: null, stream: null, recs: [], timer: 0, mime: '', t0: 0 };
function clipMime() {
  for (const m of ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'])
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
  return '';
}
function clipSecs() { return clip.recs.length ? Math.min(60, Math.round((performance.now() - clip.recs[0].t0) / 1000)) : 0; }
function clipSpawn() {
  try {
    const rec = { chunks: [], t0: performance.now() };
    rec.r = new MediaRecorder(clip.stream, { mimeType: clip.mime, videoBitsPerSecond: 6e6 });
    rec.r.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    rec.r.start(1000);
    clip.recs.push(rec);
    while (clip.recs.length > 2) { const old = clip.recs.shift(); try { old.r.stop(); } catch {} }
  } catch (e) { report('буфер клипа', e); clipStop(); toHost({ type: 'videoErr', error: /secur|origin/i.test(String(e && e.message)) ? 'этот сайт не разрешает записывать своё видео' : 'буфер клипа не запустился: ' + (e && e.message) }); }
}
function clipStart(v) {
  clipStop();
  if (v.mediaKeys) { toHost({ type: 'videoErr', error: 'защищённое видео (DRM) записывать нельзя' }); return; }
  try { clip.stream = v.captureStream(); } catch (e) { toHost({ type: 'videoErr', error: 'этот сайт не разрешает записывать своё видео' }); return; }
  clip.v = v; clip.mime = clipMime();
  clipSpawn();
  if (!clip.v) return;
  clip.timer = setInterval(() => { clipSpawn(); barRender(); }, 30e3);
  clip.tick = setInterval(() => { if (bar.open) barRender(); }, 1000);
  toHost({ type: 'clipState', on: true });
  barRender();
}
function clipStop(say) {
  clearInterval(clip.timer); clearInterval(clip.tick);
  for (const r of clip.recs) { try { r.r.stop(); } catch {} }
  clip.recs = []; clip.v = null; clip.stream = null;
  if (say) toHost({ type: 'clipState', on: false });
  barRender();
}
function clipSave() {
  const rec = clip.recs[0];
  if (!rec) { const v = mainVideo(); if (v) { clipStart(v); toHost({ type: 'videoErr', error: 'буфер клипа был выключен — включил, сохранить можно будет через несколько секунд' }); } return; }
  const secs = clipSecs(), mime = clip.mime;
  rec.r.onstop = async () => {
    try {
      const buf = await new Blob(rec.chunks, { type: mime }).arrayBuffer();
      toHost({ type: 'clip', data: buf, mime, secs });
    } catch (e) { report('клип', e); }
  };
  clip.recs.shift();
  try { rec.r.stop(); } catch (e) { report('клип', e); }
  clipSpawn(); // буфер продолжает писать дальше
}

// ---------- 11. Смотреть вместе ----------
// Браузер сообщает о каждом действии с видео (пауза, игра, перемотка, скорость), а чужие действия применяет.
// Пока применяем чужое действие, свои события не отправляем — иначе получится бесконечное эхо.
const wt = { on: false, v: null, mute: 0, bound: new WeakSet() };
function wtState(reason) {
  const v = wt.v || mainVideo(); if (!v) return null;
  return { url: location.href, t: v.currentTime, paused: v.paused, rate: v.playbackRate, live: !isFinite(v.duration), reason };
}
function wtBind(v) {
  if (!v) return;
  wt.v = v;
  if (wt.bound.has(v)) return;
  wt.bound.add(v);
  for (const ev of ['play', 'pause', 'seeked', 'ratechange']) v.addEventListener(ev, () => {
    if (!wt.on || v !== wt.v || performance.now() < wt.mute) return;
    const st = wtState(ev); if (st) toHost({ type: 'wtState', state: st });
  });
}
function wtSet(on) { wt.on = !!on; if (on) wtBind(mainVideo()); }
function wtApply(s) {
  const v = mainVideo(); if (!v) return;
  wtBind(v);
  wt.mute = performance.now() + 1000;
  if (s.rate && Math.abs(v.playbackRate - s.rate) > 0.01) v.playbackRate = s.rate;
  if (!s.live && typeof s.t === 'number') {
    const target = s.t + (s.paused ? 0 : 0.3); // пока сообщение шло, у отправителя видео ушло вперёд
    if (Math.abs(v.currentTime - target) > (s.reason === 'beat' ? 2.5 : 0.8)) v.currentTime = target;
  }
  if (s.paused && !v.paused) v.pause();
  else if (!s.paused && v.paused) v.play().catch(() => {});
}
document.addEventListener('loadedmetadata', (e) => { if (wt.on && e.target.tagName === 'VIDEO' && !IS_FRAME) wtBind(mainVideo()); }, true);

// ---------- 12. Предварительное соединение со ссылкой под мышью (как в Chrome) ----------
// Мышь задержалась на ссылке 80 мс или кнопка нажата — просим браузер заранее открыть соединение с сайтом.
let preT = 0, preHref = '';
function preconnect(a) {
  if (!a || !a.href || a.href === preHref || !/^https?:/.test(a.href)) return;
  try { if (new URL(a.href).origin === location.origin) return; } catch { return; } // свой сайт и так на связи
  preHref = a.href; ipcRenderer.send('net:preconnect', a.href);
}
document.addEventListener('pointerover', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  clearTimeout(preT);
  if (a) preT = setTimeout(() => preconnect(a), 80);
}, { passive: true, capture: true });
document.addEventListener('pointerdown', (e) => preconnect(e.target.closest && e.target.closest('a[href]')), { passive: true, capture: true });

// ---------- нажатия — для разрешения всплывающих окон ----------
// Браузер открывает окно сайта, только если человек недавно нажимал мышь или клавишу. Сообщаем о нажатиях сами:
// раньше для этого основной процесс получал каждое событие ввода, включая движение мыши и прокрутку
{
  let lastAct = 0;
  const act = (e) => { if (!e.isTrusted) return; const now = Date.now(); if (now - lastAct < 400) return; lastAct = now; try { ipcRenderer.send('user:act'); } catch {} };
  window.addEventListener('pointerdown', act, { capture: true, passive: true });
  window.addEventListener('keydown', act, { capture: true, passive: true });
}

// ---------- боковые кнопки мыши: назад / вперёд (Electron сам их не обрабатывает) ----------
for (const ev of ['mousedown', 'mouseup', 'auxclick']) {
  window.addEventListener(ev, (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault(); e.stopPropagation();
    if (ev === 'mouseup') toHost({ type: 'nav', dir: e.button === 3 ? 'back' : 'forward' });
  }, true);
}

// ---------- команды от браузера ----------
window.addEventListener('error', (e) => { if (e.filename && /webview-preload|liquid/i.test(e.filename)) report('скрипт страницы', e.error || e.message); });
ipcRenderer.on('liquid', (_e, msg) => { try { liquidCmd(msg); } catch (err) { report('команда ' + (msg && msg.type), err); } });
// ---------- 10. Liquid Player: свой плеер поверх любого сайта ----------
// Берёт видео сайта (YouTube, VK, Rutube, любое <video>) и показывает его на весь экран через Liquid RTX:
// кадр за кадром на видеокарте в реальное разрешение экрана (1080p → 4K). Звук, буферизация, реклама и перемотка
// остаются у сайта — мы управляем его же <video>, поэтому работает везде, где видео не защищено DRM.
// Открывается: кнопкой на видео, Alt+Enter, из меню правой кнопки и сам вместо полноэкранного режима сайта.
const LP_CSS = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483647; background: #000; display: block; }
.wrap { position: absolute; inset: 0; overflow: hidden; cursor: none; font: 13px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; color: #fff; user-select: none; }
.wrap.ui { cursor: default; }
canvas { position: absolute; display: block; }
.ui-l { position: absolute; left: 0; right: 0; opacity: 0; transition: opacity .25s; pointer-events: none; }
.wrap.ui .ui-l { opacity: 1; pointer-events: auto; }
.top { top: 0; padding: 18px 24px 40px; background: linear-gradient(rgba(0,0,0,.7), transparent); display: flex; align-items: center; gap: 12px; }
.title { flex: 1; font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.badge { font-size: 12px; padding: 5px 10px; border-radius: 10px; background: rgba(16,185,129,.18); color: #6ee7b7; border: 1px solid rgba(110,231,183,.3); white-space: nowrap; }
.badge.off { background: rgba(255,255,255,.08); color: rgba(255,255,255,.7); border-color: rgba(255,255,255,.15); }
.bot { bottom: 0; padding: 40px 24px 18px; background: linear-gradient(transparent, rgba(0,0,0,.78)); }
.seek { position: relative; height: 18px; cursor: pointer; display: flex; align-items: center; }
.seek .tr { position: absolute; left: 0; right: 0; height: 4px; border-radius: 4px; background: rgba(255,255,255,.2); transition: height .15s; }
.seek:hover .tr { height: 7px; }
.seek .bf, .seek .pl { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; }
.seek .bf { background: rgba(255,255,255,.3); } .seek .pl { background: linear-gradient(90deg, #e88a68, #f2a081); }
.seek .knob { position: absolute; width: 14px; height: 14px; margin-left: -7px; border-radius: 50%; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.5); }
.seek .tip { position: absolute; bottom: 22px; transform: translateX(-50%); padding: 3px 7px; border-radius: 6px; background: rgba(0,0,0,.8); font-size: 12px; font-variant-numeric: tabular-nums; display: none; }
.seek:hover .tip { display: block; }
.row { display: flex; align-items: center; gap: 4px; margin-top: 8px; }
.grow { flex: 1; }
button { all: unset; cursor: pointer; height: 38px; min-width: 38px; padding: 0 10px; border-radius: 11px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; box-sizing: border-box; color: rgba(255,255,255,.9); font-size: 13px; transition: background .15s, transform .25s cubic-bezier(.2,.9,.25,1.2); white-space: nowrap; }
button:hover { background: rgba(255,255,255,.14); color: #fff; } button:active { transform: scale(.92); }
button.on { background: linear-gradient(180deg, #34d399, #059669); color: #fff; }
button.acc.on { background: linear-gradient(180deg, #e88a68, #c9633f); }
svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
svg.fill { fill: currentColor; stroke: none; }
.time { font-variant-numeric: tabular-nums; color: rgba(255,255,255,.85); padding: 0 8px; }
input[type=range] { -webkit-appearance: none; appearance: none; width: 90px; height: 4px; border-radius: 4px; background: rgba(255,255,255,.25); outline: none; }
input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 13px; height: 13px; border-radius: 50%; background: #fff; }
.seg { display: inline-flex; background: rgba(255,255,255,.08); border-radius: 12px; padding: 2px; }
.seg button { height: 34px; border-radius: 10px; padding: 0 12px; }
.menu { position: absolute; bottom: 92px; right: 24px; min-width: 200px; padding: 6px; border-radius: 14px; background: rgba(24,22,32,.92); backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,.14); display: none; flex-direction: column; }
.menu.on { display: flex; } .menu button { justify-content: flex-start; height: 34px; } .menu b { padding: 6px 10px 4px; font-size: 11px; font-weight: 600; color: rgba(255,255,255,.5); text-transform: uppercase; letter-spacing: .04em; }
.split { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: rgba(255,255,255,.85); box-shadow: 0 0 10px rgba(0,0,0,.6); display: none; cursor: ew-resize; }
.split.on { display: block; }
.split::before { content: ''; position: absolute; left: -14px; right: -14px; top: 0; bottom: 0; }
.split i { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 34px; height: 34px; border-radius: 50%; background: rgba(255,255,255,.92); box-shadow: 0 4px 14px rgba(0,0,0,.5); }
.split .l, .split .r { position: absolute; top: 18px; padding: 4px 9px; border-radius: 8px; background: rgba(0,0,0,.65); font-size: 12px; white-space: nowrap; font-style: normal; }
.split .l { right: 14px; } .split .r { left: 14px; color: #6ee7b7; }
.cap { position: absolute; left: 50%; bottom: 9%; transform: translateX(-50%); max-width: 80%; text-align: center; pointer-events: none; }
.cap span { display: inline; padding: 2px 8px; line-height: 1.55; font-size: 26px; background: rgba(8,8,8,.75); color: #fff; -webkit-box-decoration-break: clone; box-decoration-break: clone; white-space: pre-line; }
.wrap.ui .cap { bottom: calc(9% + 70px); }
.hud { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%) scale(.9); padding: 14px 22px; border-radius: 16px; background: rgba(0,0,0,.6); font-size: 20px; font-weight: 600; opacity: 0; transition: opacity .2s, transform .3s; pointer-events: none; }
.hud.on { opacity: 1; transform: translate(-50%, -50%); }
.spin { position: absolute; left: 50%; top: 50%; width: 46px; height: 46px; margin: -23px; border-radius: 50%; border: 3px solid rgba(255,255,255,.2); border-top-color: #fff; animation: r 0.9s linear infinite; display: none; }
.spin.on { display: block; } @keyframes r { to { transform: rotate(360deg); } }
.err { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); max-width: 520px; padding: 18px 22px; border-radius: 16px; background: rgba(30,20,24,.9); color: #fecaca; text-align: center; display: none; }
.err.on { display: block; }
.skip { position: absolute; right: 24px; bottom: 110px; height: 42px; padding: 0 18px; border-radius: 12px; background: rgba(0,0,0,.7); border: 1px solid rgba(255,255,255,.3); font-size: 15px; display: none; }
.skip.on { display: inline-flex; }`;
const LPI = {
  play: '<svg class="fill" viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg class="fill" viewBox="0 0 24 24"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M11 7 6 12l5 5M18 7l-5 5 5 5"/></svg>', fwd: '<svg viewBox="0 0 24 24"><path d="m13 7 5 5-5 5M6 7l5 5-5 5"/></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/></svg>',
  cmp: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M12 3v18"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  pip: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="12" y="11.5" width="7" height="5.5" rx="1.2" fill="currentColor" stroke="none"/></svg>',
};
const lp = { host: null, root: null, wrap: null, cv: null, eng: null, perf: null, v: null, open: false, fs: false, split: 0, uiT: 0, hudT: 0,
  last: -1, lastT: -1, dirty: true, raf: 0, frames: 0, ytQ: null, capObs: null, offs: [], fromFs: false, used: '' };
const fmtT = (s) => { if (!isFinite(s)) return '∞'; s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
function lpBuild() {
  if (lp.host) return;
  lp.host = document.createElement('lq-player');
  lp.root = lp.host.attachShadow({ mode: 'closed' });
  setHTML(lp.root, `<style>${LP_CSS}</style><div class="wrap">
    <canvas></canvas><div class="split"><i></i><em class="l">Как было</em><em class="r">Liquid RTX</em></div>
    <div class="cap"></div><div class="spin"></div><div class="hud"></div><div class="err"></div><button class="skip" data-a="skip">Пропустить рекламу ›</button>
    <div class="ui-l top"><div class="title"></div><span class="badge"></span><button data-a="close" title="Закрыть Liquid Player (Esc)">${LPI.close}</button></div>
    <div class="menu" data-m="q"></div>
    <div class="ui-l bot">
      <div class="seek"><div class="tr"><div class="bf"></div><div class="pl"></div></div><div class="knob"></div><div class="tip"></div></div>
      <div class="row">
        <button data-a="play" title="Пауза / играть (пробел)">${LPI.play}</button>
        <button data-a="back" title="Назад 10 с (←)">${LPI.back}</button><button data-a="fwd" title="Вперёд 10 с (→)">${LPI.fwd}</button>
        <button data-a="mute" title="Звук (M)">${LPI.vol}</button><input type="range" data-r="vol" min="0" max="300" step="5">
        <span class="time"></span><span class="grow"></span>
        <span class="seg" title="Liquid RTX: Выкл — как в обычном плеере; Чисто — нейросеть убирает сжатие и восстанавливает детали; Чётко — плюс резкость">
          <button data-sr="off">Выкл</button><button data-sr="mid">Чисто</button><button data-sr="max">Чётко</button></span>
        <button data-a="hdr" class="acc" title="HDR-цвет">HDR</button>
        <button data-a="cmp" class="acc" title="Сравнить: слева как было, справа Liquid RTX (C)">${LPI.cmp}</button>
        <button data-a="speed" title="Скорость (Shift+< / >)"><span data-v="speed">1×</span></button>
        <button data-a="q" title="Качество и настройки">${LPI.gear}</button>
        <button data-a="pip" title="Картинка в картинке">${LPI.pip}</button>
        <button data-a="full" title="Во весь экран (F)">${LPI.full}</button>
      </div>
    </div></div>`);
  const q = (s) => lp.root.querySelector(s);
  lp.wrap = q('.wrap'); lp.cv = q('canvas');
  if (!lp.wrap || !lp.cv) { report('Liquid Player', 'не удалось собрать разметку'); lp.host = null; return; }
  lp.wrap.addEventListener('mousemove', () => lpUi());
  lp.wrap.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) { if (e.target === lp.cv || e.target === lp.wrap) { lpMenu(false); lpToggle(); } return; }
    e.stopPropagation(); lpAct(b);
  });
  lp.wrap.addEventListener('dblclick', (e) => { if (e.target === lp.cv) lpFull(); });
  lp.wrap.addEventListener('wheel', (e) => { e.preventDefault(); lpVol(getVolume(lp.v) + (e.deltaY < 0 ? 0.05 : -0.05)); }, { passive: false });
  q('[data-r="vol"]').addEventListener('input', (e) => lpVol(+e.target.value / 100));
  // перемотка: нажал и тянешь
  const sk = q('.seek');
  const at = (e) => { const r = sk.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  sk.addEventListener('pointerdown', (e) => {
    sk.setPointerCapture(e.pointerId); lp.seeking = true;
    const mv = (ev) => { const d = lp.v.duration; if (isFinite(d)) { lp.seekTo = at(ev) * d; lpRenderTime(); } };
    const up = (ev) => { sk.removeEventListener('pointermove', mv); sk.removeEventListener('pointerup', up); lp.seeking = false;
      const d = lp.v.duration; if (isFinite(d)) lp.v.currentTime = at(ev) * d; lp.seekTo = null; };
    sk.addEventListener('pointermove', mv); sk.addEventListener('pointerup', up); mv(e);
  });
  sk.addEventListener('mousemove', (e) => { const d = lp.v && lp.v.duration; const tip = q('.tip'); if (!isFinite(d)) return; tip.textContent = fmtT(at(e) * d); tip.style.left = (at(e) * 100) + '%'; });
  // разделитель «сравнить» тянется мышью
  const sp = q('.split');
  sp.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); sp.setPointerCapture(e.pointerId);
    const mv = (ev) => { const r = lp.cv.getBoundingClientRect(); lp.split = Math.max(0.02, Math.min(0.98, (ev.clientX - r.left) / r.width)); lp.dirty = true; lpPlaceSplit(); };
    const up = () => { sp.removeEventListener('pointermove', mv); sp.removeEventListener('pointerup', up); };
    sp.addEventListener('pointermove', mv); sp.addEventListener('pointerup', up);
  });
  for (const ev of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'keydown', 'keyup']) lp.host.addEventListener(ev, (e) => e.stopPropagation());
  new ResizeObserver(() => lpLayout()).observe(lp.wrap);
}
function lpUi() {
  if (!lp.wrap) return;
  lp.wrap.classList.add('ui');
  clearTimeout(lp.uiT);
  lp.uiT = setTimeout(() => { if (!lp.v || lp.v.paused || lp.menu) return; lp.wrap.classList.remove('ui'); }, 2600);
}
function lpHud(t) { const h = lp.root.querySelector('.hud'); h.textContent = t; h.classList.add('on'); clearTimeout(lp.hudT); lp.hudT = setTimeout(() => h.classList.remove('on'), 700); }
function lpToggle() { const v = lp.v; if (!v) return; if (v.paused) v.play().catch(() => {}); else v.pause(); }
function lpVol(x) { setVolume(lp.v, Math.max(0, Math.min(3, Math.round(x * 100) / 100))); lpHud('Громкость ' + Math.round(getVolume(lp.v) * 100) + '%'); lpRender(); }
function lpSeek(d) { const v = lp.v; v.currentTime = Math.max(0, Math.min((v.duration || 1e9) - 0.1, v.currentTime + d)); lpHud((d > 0 ? '+' : '−') + Math.abs(d) + ' с'); }
function lpRate(d) { const v = lp.v; const r = Math.max(0.25, Math.min(4, Math.round((v.playbackRate + d) * 4) / 4)); v.playbackRate = r; vt.want.speed = r; lpHud('Скорость ' + fmtRate(r)); lpRender(); }
async function lpFull() {
  if (document.fullscreenElement === lp.host) { try { await document.exitFullscreen(); } catch {} return; }
  if (!(await lpFullscreen())) lpHud('Полный экран: нажми F');
}
// Полный экран для нашего плеера. Нужен «жест пользователя», а его уже мог израсходовать сам сайт (он только что
// ушёл в свой полный экран) — тогда просим браузер повторить запрос от имени пользователя (main → этот же фрейм)
async function lpFullscreen() {
  if (!lp.open) return false;
  if (navigator.userActivation && navigator.userActivation.isActive) { try { await lp.host.requestFullscreen({ navigationUI: 'hide' }); return true; } catch {} }
  const done = new Promise((ok) => { const t = setTimeout(ok, 1500); document.addEventListener('fullscreenchange', function f() { if (document.fullscreenElement === lp.host) { clearTimeout(t); document.removeEventListener('fullscreenchange', f); ok(); } }); });
  try { await ipcRenderer.invoke('lp:gesture'); } catch {}
  await done;
  return document.fullscreenElement === lp.host;
}
document.addEventListener('liquid:lpfs', () => { if (lp.open && document.fullscreenElement !== lp.host) lp.host.requestFullscreen({ navigationUI: 'hide' }).catch(() => {}); });
function lpAct(b) {
  const a = b.dataset.a, v = lp.v;
  if (b.dataset.sr) { vt.sr = b.dataset.sr; toHost({ type: 'srPref', level: vt.sr, hdr: vt.srHdr }); lp.dirty = true; lpRender(); return; }
  if (b.dataset.q) { lpSetQuality(b.dataset.q); lpMenu(false); return; }
  if (b.dataset.rate) { v.playbackRate = +b.dataset.rate; vt.want.speed = +b.dataset.rate; lpMenu(false); lpRender(); return; }
  if (b.dataset.content) { vt.srContent = b.dataset.content; toHost({ type: 'srPref', level: vt.sr, hdr: vt.srHdr, content: vt.srContent }); lp.dirty = true; lpMenu('q'); return; }
  if (a === 'close') lpClose();
  else if (a === 'play') lpToggle();
  else if (a === 'back') lpSeek(-10);
  else if (a === 'fwd') lpSeek(10);
  else if (a === 'mute') setVolume(v, getVolume(v) > 0 ? 0 : 1);
  else if (a === 'hdr') { vt.srHdr = !vt.srHdr; toHost({ type: 'srPref', level: vt.sr, hdr: vt.srHdr }); lp.dirty = true; }
  else if (a === 'cmp') { lp.split = lp.split ? 0 : 0.5; lp.dirty = true; lpPlaceSplit(); }
  else if (a === 'full') lpFull();
  else if (a === 'pip') pipToggle(v);
  else if (a === 'speed') lpMenu(lp.menu === 'speed' ? false : 'speed');
  else if (a === 'q') lpMenu(lp.menu === 'q' ? false : 'q');
  else if (a === 'auto') { vt.lpAuto = !vt.lpAuto; toHost({ type: 'lpPref', auto: vt.lpAuto }); lpMenu('q'); }
  else if (a === 'skip') { const sk = ytSkip(); if (sk) sk.click(); }
  lpRender();
}
// меню: качество (на YouTube), скорость, «открывать сам»
async function lpMenu(kind) {
  lp.menu = kind || null;
  const m = lp.root.querySelector('.menu');
  if (!kind) { m.classList.remove('on'); return; }
  let h = '';
  if (kind === 'speed') {
    h = '<b>Скорость</b>' + [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3].map((r) => `<button data-rate="${r}" class="${lp.v.playbackRate === r ? 'on' : ''}">${fmtRate(r)}</button>`).join('');
  } else {
    const yq = await ytQualities();
    if (yq && yq.list.length) {
      const NAME = { hd2160: '2160p (4K)', hd1440: '1440p', hd1080: '1080p', hd720: '720p', large: '480p', medium: '360p', small: '240p', tiny: '144p', auto: 'Авто' };
      h += '<b>Качество YouTube</b>' + yq.list.map((x) => `<button data-q="${x}" class="${x === yq.cur ? 'on' : ''}">${NAME[x] || x}</button>`).join('');
    }
    if (vt.animeNet) {
      const kind = contentOf(lp.v);
      h += `<b>Содержимое</b>` + [['auto', `Авто (сейчас: ${kind === 'anime' ? 'рисованное' : 'видео'})`], ['video', 'Видео (съёмка)'], ['anime', 'Аниме и мультики']]
        .map(([k, t]) => `<button data-content="${k}" class="${vt.srContent === k ? 'on' : ''}">${t}</button>`).join('');
    }
    h += `<b>Liquid Player</b><button data-a="auto" class="${vt.lpAuto ? 'on' : ''}">Открывать вместо полного экрана сайта</button>`;
    if (lp.eng) h += `<b>Видеопамять: ~${lp.eng.vram()} МБ</b>`;
  }
  setHTML(m, h);
  m.classList.add('on'); lpUi();
}
// YouTube: список качеств и выбор — через его собственный плеер (он в странице, не в нашем изолированном мире)
async function ytQualities() {
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return null;
  try { return await webFrame.executeJavaScript(`(() => { const p = document.getElementById('movie_player'); if (!p || !p.getAvailableQualityLevels) return null;
    return { list: p.getAvailableQualityLevels(), cur: p.getPlaybackQuality() }; })()`); } catch { return null; }
}
async function lpSetQuality(q) {
  try { await webFrame.executeJavaScript(`(() => { const p = document.getElementById('movie_player'); if (p && p.setPlaybackQualityRange) p.setPlaybackQualityRange(${JSON.stringify(q)}, ${JSON.stringify(q)}); })()`); lpHud('Качество: ' + q.replace('hd', '').replace(/^(\d+)$/, '$1p')); } catch {}
}
// при открытии на YouTube просим лучшее доступное качество: плеер сайта под нашим не видно, и он мог выбрать меньшее
async function ytBest() {
  const yq = await ytQualities();
  if (!yq || !yq.list.length) return;
  const best = yq.list.find((x) => x !== 'auto');
  if (best && best !== yq.cur) lpSetQuality(best);
}
// Проверка «страница загрузилась, но сломана» — для журнала: такие поломки не дают ошибок (блокировщик отрезал
// стили или скрипты сайта, сайт не дорисовался). Через 6 с после загрузки: стили, которые не загрузились,
// и страница без текста и картинок
if (!IS_FRAME && /^https?:$/.test(location.protocol)) window.addEventListener('load', () => setTimeout(() => {
  try {
    const bad = [...document.querySelectorAll('link[rel~="stylesheet"]')].filter((l) => l.href && !l.disabled && !l.sheet);
    if (bad.length) console.warn(`[liquid] ${location.hostname}: не загрузились стили сайта (${bad.length}): ${bad.slice(0, 3).map((l) => { try { const u = new URL(l.href); return u.hostname + u.pathname.slice(0, 50); } catch { return l.href.slice(0, 60); } }).join(', ')} — страница может выглядеть сломанной (блокировщик или сеть)`);
    const text = ((document.body && document.body.innerText) || '').trim().length;
    if (document.body && text < 20 && document.querySelectorAll('img,video,canvas,svg,iframe').length < 3) console.warn(`[liquid] ${location.hostname}: страница загрузилась, но пустая — скорее всего, не загрузились скрипты сайта (блокировщик или сеть)`);
  } catch {}
}, 6000), { once: true });

// Подсветка под видео: окно браузера подстраивается под цвета ролика (как «атмосфера» на YouTube).
// Раз в секунду кадр уменьшается до 32×18 на видеокарте (без копии 4K-кадра в память), считаем цвет углов
// и всего кадра. Только верхняя страница, только большое видео на экране; на паузе подсветка остаётся
vt.amb = true;
if (!IS_FRAME) toHost({ type: 'ambient', c: null }); // новая страница — прежняя подсветка вкладки больше не её
let ambCv = null, ambKey = '', ambOn = false;
const ambBad = new WeakSet();
const ambTone = ([r, g, b]) => {   // ярче цвет, но не светлее середины — белый текст вкладок должен читаться
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const k = Math.min(1.25, 95 / Math.max(y, 1));
  return [r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, (y + (c - y) * 1.35) * k)) / 12) * 12); // шаг 12: мелкие колебания не шлём
};
if (!IS_FRAME) setInterval(() => {
  let v = vt.amb && !document.hidden ? mainVideo() : null;
  if (v && (v.readyState < 2 || ambBad.has(v) || !v.videoWidth)) v = null;
  if (v) {
    const r = v.getBoundingClientRect();
    const vis = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    if (vis < innerWidth * innerHeight * 0.18) v = null;
  }
  if (!v) { if (ambOn) { ambOn = false; ambKey = ''; toHost({ type: 'ambient', c: null }); } return; }
  if (v.paused) return; // на паузе — оставляем как было (и не включаем, если ещё не играло)
  try {
    if (!ambCv) { ambCv = document.createElement('canvas'); ambCv.width = 32; ambCv.height = 18; }
    const cx = ambCv.getContext('2d');
    cx.drawImage(v, 0, 0, 32, 18);
    const d = cx.getImageData(0, 0, 32, 18).data;
    const q = (x0, y0, x1, y1) => { let r = 0, g = 0, b = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * 32 + x) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; } return [r / n, g / n, b / n]; };
    const c = [q(0, 0, 32, 18), q(0, 0, 13, 8), q(19, 0, 32, 8), q(0, 10, 13, 18), q(19, 10, 32, 18)].map(ambTone);
    const key = c.join(';');
    if (key !== ambKey) { ambKey = key; ambOn = true; toHost({ type: 'ambient', c }); }
  } catch { ambBad.add(v); } // видео с чужого сайта без разрешения (CORS) — кадр не прочитать, подсветки не будет
}, 1000);

// Режим обучения Liquid RTX: у ролика есть 1080p и 4K/8K — в очередь. Кадры нарежет фоновое окно браузера,
// когда ни одна вкладка не играет звук (main/rtx-learn.js). Проверка раз в 7 с, только при включённом режиме
const learnSeen = new Set();
if (!IS_FRAME && /(^|\.)youtube\.com$/.test(location.hostname)) setInterval(async () => {
  if (!vt.learn || location.pathname !== '/watch') return;
  const id = new URLSearchParams(location.search).get('v'); if (!id || learnSeen.has(id)) return;
  const v = mainVideo(); if (!v || v.paused || v.currentTime < 3 || document.querySelector('#movie_player.ad-showing')) return;
  const yq = await ytQualities(); if (!yq || !yq.list.length) return;
  learnSeen.add(id);
  if (yq.list.includes('hd1080') && (yq.list.includes('hd2160') || yq.list.includes('highres'))) ipcRenderer.send('rtx:seen', { id, title: document.title.replace(/ - YouTube$/, '') });
}, 7000);
// субтитры: YouTube рисует их своими элементами (под нашим плеером их не видно) — повторяем текст у себя;
// у остальных сайтов — дорожки textTracks в режиме «показывать»
const ytSkip = () => { const b = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern'); return b && b.offsetParent ? b : null; };
function lpCaptions() {
  const box = lp.root.querySelector('.cap'), v = lp.v;
  if (!v.isConnected) { lpClose(); return; } // сайт убрал видео (ушли на другую страницу)
  lp.root.querySelector('.skip').classList.toggle('on', !!ytSkip());
  let t = '';
  const yt = document.querySelector('.ytp-caption-window-container');
  if (yt) t = [...yt.querySelectorAll('.ytp-caption-segment')].map((s) => s.textContent).join(' ').trim();
  else for (const tr of v.textTracks || []) if (tr.mode === 'showing' && tr.activeCues) t += [...tr.activeCues].map((c) => c.text || '').join('\n');
  if (box.__t === t) return;
  box.__t = t; setHTML(box, t ? '<span></span>' : ''); if (t) box.firstChild.textContent = t.replace(/<[^>]+>/g, '');
}
function lpLayout() {
  if (!lp.open || !lp.v) return;
  const W = lp.wrap.clientWidth, H = lp.wrap.clientHeight, v = lp.v;
  const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
  const k = Math.min(W / vw, H / vh);
  const w = Math.round(vw * k), h = Math.round(vh * k);
  Object.assign(lp.cv.style, { width: w + 'px', height: h + 'px', left: Math.round((W - w) / 2) + 'px', top: Math.round((H - h) / 2) + 'px' });
  // настоящие точки экрана: 4K-монитор с масштабом 150 % — 1,5 точки на пиксель страницы → холст 3840×2160
  const dpr = window.devicePixelRatio || 1;
  lp.eng.size(Math.round(w * dpr), Math.round(h * dpr));
  lp.dirty = true; lpPlaceSplit();
}
function lpPlaceSplit() {
  const sp = lp.root.querySelector('.split'); sp.classList.toggle('on', !!lp.split);
  if (!lp.split) return;
  const r = lp.cv.getBoundingClientRect(), wr = lp.wrap.getBoundingClientRect();
  sp.style.left = (r.left - wr.left + r.width * lp.split) + 'px'; sp.style.top = (r.top - wr.top) + 'px'; sp.style.height = r.height + 'px'; sp.style.bottom = 'auto';
}
function lpRenderTime() {
  const v = lp.v, q = (s) => lp.root.querySelector(s), d = v.duration, t = lp.seekTo ?? v.currentTime;
  q('.time').textContent = fmtT(t) + ' / ' + fmtT(d);
  const p = isFinite(d) && d > 0 ? t / d : 0;
  q('.pl').style.width = (p * 100) + '%'; q('.knob').style.left = (p * 100) + '%';
  let bf = 0; try { for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= t + 0.5) bf = Math.max(bf, v.buffered.end(i)); } catch {}
  q('.bf').style.width = (isFinite(d) && d > 0 ? Math.min(1, bf / d) * 100 : 0) + '%';
}
function lpRender() {
  if (!lp.open || !lp.v) return;
  const v = lp.v, q = (s) => lp.root.querySelector(s);
  setHTML(q('[data-a="play"]'), v.paused ? LPI.play : LPI.pause);
  const vol = getVolume(v); setHTML(q('[data-a="mute"]'), vol > 0 ? LPI.vol : LPI.mute); q('[data-r="vol"]').value = Math.round(vol * 100);
  q('[data-v="speed"]').textContent = fmtRate(v.playbackRate);
  for (const b of lp.root.querySelectorAll('[data-sr]')) b.classList.toggle('on', b.dataset.sr === vt.sr);
  q('[data-a="hdr"]').classList.toggle('on', vt.srHdr); q('[data-a="cmp"]').classList.toggle('on', !!lp.split);
  q('.title').textContent = document.title.replace(/ - YouTube$/, '');
  const bd = q('.badge'), out = `${lp.eng.ow}×${lp.eng.oh}`;
  const how = SR_NAMES[lp.used] || '';
  if (vt.sr === 'off') { bd.className = 'badge off'; bd.textContent = `${v.videoWidth}×${v.videoHeight} → ${out} · Liquid RTX выкл`; }
  else if (lp.used === 'down') { bd.className = 'badge off'; bd.textContent = `Видео ${v.videoWidth}×${v.videoHeight} — уже не меньше экрана, показываю как есть`; }
  else { bd.className = 'badge'; bd.textContent = `${v.videoWidth}×${v.videoHeight} → ${out} · ${how}${lp.slow ? ' (видеокарта не успевала за лучшим)' : ''}${vt.srHdr ? ' · HDR' : ''}`; }
  q('.spin').classList.toggle('on', v.readyState < 3 && !v.paused);
  lpRenderTime();
}
// кадр: рисуем, только когда у видео действительно новый кадр (VideoFrame знает его время), иначе — по времени видео
function lpLoop() {
  if (!lp.open) return;
  lp.raf = requestAnimationFrame(lpLoop);
  const v = lp.v, now = performance.now();
  lp.perf.frame(now);
  if (v.readyState < 2 || !v.videoWidth) return;
  if (lp.vw !== v.videoWidth || lp.vh !== v.videoHeight) { lp.vw = v.videoWidth; lp.vh = v.videoHeight; lpLayout(); }
  let src = v, vf = null, stamp = v.currentTime;
  if (typeof VideoFrame === 'function' && !lp.noVF) {
    try { vf = new VideoFrame(v); stamp = vf.timestamp; src = vf; } catch (e) { lp.noVF = true; }
  }
  if (stamp === lp.last && !lp.dirty) { if (vf) vf.close(); return; }
  lp.last = stamp; lp.dirty = false;
  try {
    const was = lp.used;
    lp.used = lp.eng.draw(src, v.videoWidth, v.videoHeight, [0, 0, 1, 1], vt.sr, vt.srHdr, lp.split, contentOf(v));
    lp.frames++;
    lp.host.dataset.lqUsed = lp.used;
    if (was !== lp.used) lpRender();
  } catch (e) {
    lpError('Этот сайт не разрешает обрабатывать своё видео (защита от копирования или чужой сервер). Открой обычный плеер.');
  } finally { if (vf) vf.close(); }
  // пока на паузе: шейдер нейросети мог собраться — перерисуем лучшим
  if (v.paused && vt.sr !== 'off' && /^(fsr|r2|r3|net)$/.test(lp.used) && lp.frames % 30 === 0) { const best = lp.eng.pick(vt.sr, contentOf(v)); if ((best ? best.name : 'fsr') !== lp.used) lp.dirty = true; }
}
function lpError(t) { const e = lp.root.querySelector('.err'); e.textContent = t; e.classList.add('on'); }
// клавиши — как в обычных плеерах; сайт их не получает, пока открыт наш
function lpKey(e) {
  if (!lp.open) return;
  const k = e.code, v = lp.v;
  const map = {
    Space: () => lpToggle(), KeyK: () => lpToggle(), ArrowLeft: () => lpSeek(-5), ArrowRight: () => lpSeek(5), KeyJ: () => lpSeek(-10), KeyL: () => lpSeek(10),
    ArrowUp: () => lpVol(getVolume(v) + 0.05), ArrowDown: () => lpVol(getVolume(v) - 0.05), KeyM: () => { setVolume(v, getVolume(v) > 0 ? 0 : 1); lpRender(); },
    KeyF: () => lpFull(), KeyC: () => { lp.split = lp.split ? 0 : 0.5; lp.dirty = true; lpPlaceSplit(); lpRender(); },
    Period: () => e.shiftKey && lpRate(0.25), Comma: () => e.shiftKey && lpRate(-0.25), Escape: () => { if (document.fullscreenElement !== lp.host) lpClose(); },
  };
  if (/^Digit\d$/.test(k) && isFinite(v.duration)) { v.currentTime = v.duration * (+k.slice(5)) / 10; }
  else if (map[k] && !e.ctrlKey && !e.metaKey && !e.altKey) map[k]();
  else return;
  e.preventDefault(); e.stopImmediatePropagation(); lpUi();
}
const LP_EV = ['play', 'pause', 'volumechange', 'ratechange', 'progress', 'waiting', 'playing', 'seeked', 'durationchange'];
function lpOpen(v, fromFs) {
  if (!v || lp.open) return;
  if (v.mediaKeys) { toHost({ type: 'videoErr', error: 'защищённое видео (DRM) — сервис не разрешает показывать его в своём плеере' }); return; }
  lpBuild(); if (!lp.host) return;
  // свежий холст на каждое открытие: у закрытого плеера контекст видеокарты освобождён, второй раз его не получить
  const cv = document.createElement('canvas'); lp.cv.replaceWith(cv); lp.cv = cv;
  // холст плеера сброшен видеокартой — не оставляем белый экран: закрываем плеер, остаётся видео сайта
  cv.addEventListener('webglcontextlost', (e) => { if (!lp.open || lp.cv !== cv) return; e.preventDefault(); console.warn('[liquid] Liquid Player: видеокарта сбросила холст — закрываю плеер'); lpClose(); });
  try { lp.eng = new RtxEngine(lp.cv); } catch (e) { toHost({ type: 'videoErr', error: 'нет WebGL — Liquid Player не может рисовать видео' }); return; }
  lp.v = v; lp.open = true; lp.fromFs = !!fromFs; lp.perf = new RtxPerf(); lp.used = ''; lp.slow = false; lp.last = -1; lp.dirty = true; lp.frames = 0; lp.split = 0;
  lp.root.querySelector('.err').classList.remove('on');
  // слой чёткости поверх плеера сайта не нужен, пока открыт наш (видеокарта занята одним)
  vt.srMap.get(v)?.destroy();
  document.documentElement.appendChild(lp.host);
  lp.onEv = () => lpRender(); lp.onTime = () => { lpRenderTime(); lpCaptions(); };
  for (const ev of LP_EV) v.addEventListener(ev, lp.onEv);
  v.addEventListener('timeupdate', lp.onTime);
  window.addEventListener('keydown', lpKey, true);
  lp.perfT = setInterval(() => { if (lp.perf.check(v, lp.used) && lp.eng.slower()) { lp.slow = true; console.warn('[liquid] Liquid Player: видеокарта не успевает — ступенька вниз'); lpRender(); } }, 2000);
  lp.capT = setInterval(lpCaptions, 250);
  if (!fromFs) lpFullscreen(); // не вышло — остаёмся во всё окно, F или кнопка включат полный экран
  lpLayout(); lpRender(); lpUi(); lpLoop();
  ytBest();
  toHost({ type: 'lpOpen', on: true });
}
async function lpClose(keepFs) {
  if (!lp.open) return;
  const v = lp.v;
  lp.open = false; cancelAnimationFrame(lp.raf); clearInterval(lp.perfT); clearInterval(lp.capT); clearTimeout(lp.uiT);
  for (const ev of LP_EV) v.removeEventListener(ev, lp.onEv);
  v.removeEventListener('timeupdate', lp.onTime);
  window.removeEventListener('keydown', lpKey, true);
  lpMenu(false);
  // выходим из полного экрана целиком (под нашим мог остаться полноэкранный плеер сайта)
  if (!keepFs) for (let i = 0; i < 3 && document.fullscreenElement; i++) { try { await document.exitFullscreen(); } catch { break; } }
  lp.eng.destroy(); lp.eng = null;
  lp.host.remove(); lp.v = null; lp.closedAt = performance.now();
  toHost({ type: 'lpOpen', on: false });
  setTimeout(srSync, 100);
}
// сайт ушёл в полный экран со своим плеером — подменяем его нашим (нажатие пользователя ещё действует)
document.addEventListener('fullscreenchange', () => {
  const fs = document.fullscreenElement;
  if (lp.open) {
    // наш плеер вышел из полного экрана: открыт вместо полноэкранного плеера сайта — закрываемся совсем
    // (под нами мог остаться полноэкранный плеер сайта — выходим и из него); открыт кнопкой — остаёмся в окне
    if (fs === lp.host) return;
    if (fs || lp.fromFs) lpClose();
    return;
  }
  if (!fs || !vt.lpAuto || vt.sr === 'off' || fs === lp.host || performance.now() - (lp.closedAt || -1e9) < 1500) return;
  const v = fs.tagName === 'VIDEO' ? fs : [...fs.querySelectorAll('video')].sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight)[0];
  if (!v || !v.videoWidth || v.mediaKeys || vt.skip.get(v) === 'drm') return;
  lpOpen(v, true);
  if (lp.open) lpFullscreen().then((ok) => { if (!ok && lp.open && document.fullscreenElement !== lp.host) lpClose(true); }); // не вышло — остаётся плеер сайта
});
// Alt+Enter — открыть видео под курсором (или главное) в Liquid Player
window.addEventListener('keydown', (e) => {
  if (!e.altKey || e.code !== 'Enter' || e.ctrlKey || e.metaKey || lp.open) return;
  const v = videoAt(barX, barY) || mainVideo();
  if (!v) return;
  e.preventDefault(); e.stopImmediatePropagation(); lpOpen(v);
}, true);
// из меню правой кнопки: браузер присылает событие с «нажатием пользователя», чтобы можно было включить полный экран
document.addEventListener('liquid:player', (e) => { const d = e.detail || {}; const v = (d.x != null && videoAt(d.x, d.y)) || mainVideo(); if (v) lpOpen(v); });

function liquidCmd(msg) {
  if (!msg) return;
  if (msg.type === 'translate') msg.on ? translateOn() : translateOff();
  else if (msg.type === 'theme') applyTheme(msg.theme || {});
  else if (msg.type === 'info') pageInfo();
  else if (msg.type === 'reader') msg.on === false || (msg.on == null && rd.host) ? readerClose() : readerOpen(msg.prefs);
  else if (msg.type === 'video') videoCmd(msg);
  else if (msg.type === 'mini') miniMode(msg);
  else if (msg.type === 'miniCt') miniBarCt(msg.on);
  else if (msg.type === 'miniOpacity') miniBarOpacity(msg.v);
  else if (msg.type === 'wt') wtSet(msg.on);
  else if (msg.type === 'wtApply') wtApply(msg.state || {});
  else if (msg.type === 'wtPoll') { const st = wtState('beat'); if (st) toHost({ type: 'wtState', state: st }); }
}
