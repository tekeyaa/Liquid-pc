// Preload для сайтов (изолированный мир: сайт не видит этот код).
// 1) Вход Google: маскировка под Firefox.
// 2) Перевод страницы на месте, без поломки вёрстки.
// 3) Сведения о странице для браузера (язык, есть ли видео).
// 4) Тема оформления для стартовой страницы.
const { contextBridge, webFrame, ipcRenderer } = require('electron');
// стартовая страница хранит избранное в настройках приложения, а не в localStorage (его стирает «Очистить данные»)
if (location.protocol === 'file:' && /\/newtab\.html$/.test(location.pathname)) {
  try { contextBridge.exposeInMainWorld('liquidNewtab', { tiles: (t) => ipcRenderer.invoke('newtab:tiles', t), icons: (h) => ipcRenderer.invoke('newtab:icons', h), suggest: (q) => ipcRenderer.invoke('search:suggest', q) }); } catch {}
}

const toHost = (msg) => { try { ipcRenderer.sendToHost('liquid', msg); } catch {} };

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
function pageInfo() {
  if (!/^https?:$/.test(location.protocol) || !document.body) return;
  const sample = (document.body.innerText || '').slice(0, 4000);
  const letters = (sample.match(/\p{L}/gu) || []).length;
  const cyr = (sample.match(/[а-яё]/giu) || []).length;
  const lang = (document.documentElement.lang || '').toLowerCase();
  const foreign = letters > 150 ? cyr / letters < 0.25 : !!lang && !/^(ru|uk|be)/.test(lang);
  const vids = [...document.querySelectorAll('video')].filter((v) => v.offsetWidth > 200);
  let ptext = 0, pcount = 0;
  for (const p of document.querySelectorAll('p')) { const n = (p.textContent || '').trim().length; if (n > 80) { ptext += n; pcount++; } if (ptext > 3000) break; }
  toHost({ type: 'page', lang, foreign, video: vids.length > 0, translated: tr.on, readable: pcount >= 4 && ptext > 1500 });
}
window.addEventListener('DOMContentLoaded', () => { pageInfo(); setTimeout(pageInfo, 2500); setTimeout(pageInfo, 8000); });
window.addEventListener('load', () => setTimeout(pageInfo, 600));

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
function videos() { return [...document.querySelectorAll('video')]; }
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
  if (vt.svg) return;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.style.position = 'absolute';
  const filter = document.createElementNS(ns, 'filter'); filter.setAttribute('id', 'lq-sharp');
  const conv = document.createElementNS(ns, 'feConvolveMatrix');
  conv.setAttribute('order', '3'); conv.setAttribute('preserveAlpha', 'true'); conv.setAttribute('kernelMatrix', '0 -0.6 0 -0.6 3.4 -0.6 0 -0.6 0');
  filter.appendChild(conv); svg.appendChild(filter);
  (document.body || document.documentElement).appendChild(svg);
  vt.svg = true;
}
function applyFilter(v) {
  const w = vt.want;
  const parts = [];
  if (w.bright != null && w.bright !== 1) parts.push(`brightness(${w.bright})`);
  if (w.contrast != null && w.contrast !== 1) parts.push(`contrast(${w.contrast})`);
  if (w.sat != null && w.sat !== 1) parts.push(`saturate(${w.sat})`);
  if (w.sharp) { ensureSharpSvg(); parts.push('url(#lq-sharp)'); }
  v.style.filter = parts.join(' ');
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
window.addEventListener('wheel', (e) => {
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
}, { capture: true, passive: false });
// сайты (YouTube) сбрасывают скорость при смене ролика — возвращаем выбранную
document.addEventListener('loadedmetadata', (e) => {
  const v = e.target;
  if (v.tagName !== 'VIDEO') return;
  if (vt.want.speed && v.playbackRate !== vt.want.speed) v.playbackRate = vt.want.speed;
  if (vt.want.bright || vt.want.contrast || vt.want.sat || vt.want.sharp) applyFilter(v);
}, true);
function videoState() {
  const v = mainVideo();
  if (!v) return { has: false };
  return { has: true, speed: v.playbackRate, volume: getVolume(v), loop: v.loop, comp: !!vt.graphs.get(v)?.compOn,
    bright: vt.want.bright ?? 1, contrast: vt.want.contrast ?? 1, sat: vt.want.sat ?? 1, sharp: !!vt.want.sharp };
}
function videoCmd(m) {
  const v = mainVideo();
  if (m.op === 'prefs') {
    if (m.speed) vt.want.speed = m.speed;
    if (m.remember != null) vt.remember = !!m.remember;
    if (m.bar != null) vt.barOn = m.bar;
    if (m.sr != null) { vt.sr = m.sr; vt.srHdr = !!m.srHdr; srSync(); }
    return;
  }
  if (m.op === 'overlay') { const v0 = mainVideo(); if (v0) { barShow(v0, true); barOpen(!bar.open); } return; }
  if (m.op === 'pip') { pipToggle(); return; }
  if (!v) { toHost({ type: 'videoState', has: false }); return; }
  try {
    if (m.op === 'set') {
      if (m.speed != null) { v.playbackRate = m.speed; vt.want.speed = m.speed; }
      if (m.volume != null) setVolume(v, m.volume);
      if (m.loop != null) v.loop = m.loop;
      if (m.comp != null) setComp(v, m.comp);
      for (const k of ['bright', 'contrast', 'sat', 'sharp']) if (m[k] != null) vt.want[k] = m[k];
      if (['bright', 'contrast', 'sat', 'sharp'].some((k) => m[k] != null)) applyFilter(v);
    } else if (m.op === 'reset') {
      vt.want = {}; v.playbackRate = 1; v.loop = false; v.style.filter = '';
      if (vt.graphs.get(v)) { setComp(v, false); setVolume(v, 1); } else v.volume = 1;
    } else if (m.op === 'frame') {
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      toHost({ type: 'frame', data: c.toDataURL('image/png'), t: Math.floor(v.currentTime) });
      return;
    }
  } catch (err) { report('видео ' + m.op, err); toHost({ type: 'videoErr', error: String(err && err.message || err) }); }
  toHost({ type: 'videoState', ...videoState() });
}


// ---------- 7. Супер-чёткость: апскейл на видеокарте (WebGL) — аналог RTX Video Super Resolution ----------
// Проход 1: бикубическое (Catmull-Rom) увеличение до размера на экране. Проход 2: адаптивная резкость RCAS (как в AMD FSR) + HDR-цвет.
vt.sr = 'off'; vt.srHdr = false; vt.barOn = true; vt.remember = false;
const SR_VS = `attribute vec2 p; uniform float flip; varying vec2 uv; void main(){ uv = p * 0.5 + 0.5; if (flip > 0.5) uv.y = 1.0 - uv.y; gl_Position = vec4(p, 0.0, 1.0); }`;
const SR_UP = `precision highp float; varying vec2 uv; uniform sampler2D t; uniform vec2 src;
vec4 cub(float x){ float x2=x*x, x3=x2*x; return vec4(-0.5*x3+x2-0.5*x, 1.5*x3-2.5*x2+1.0, -1.5*x3+2.0*x2+0.5*x, 0.5*x3-0.5*x2); }
void main(){
  vec2 px = uv * src - 0.5; vec2 f = fract(px); vec2 b = (floor(px) + 0.5) / src; vec2 d = 1.0 / src;
  vec4 wx = cub(f.x), wy = cub(f.y); vec3 c = vec3(0.0);
  for (int j = 0; j < 4; j++) { vec3 row = vec3(0.0);
    for (int i = 0; i < 4; i++) row += texture2D(t, b + d * vec2(float(i) - 1.0, float(j) - 1.0)).rgb * wx[i];
    c += row * wy[j]; }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
const SR_SHARP = `precision highp float; varying vec2 uv; uniform sampler2D t; uniform vec2 dst; uniform float sharp; uniform float hdr; uniform float boost;
void main(){
  vec2 d = 1.0 / dst; vec3 e = texture2D(t, uv).rgb;
  vec3 b = texture2D(t, uv + vec2(0.0, -d.y)).rgb, h = texture2D(t, uv + vec2(0.0, d.y)).rgb;
  vec3 dd = texture2D(t, uv + vec2(-d.x, 0.0)).rgb, f = texture2D(t, uv + vec2(d.x, 0.0)).rgb;
  vec3 mn = min(min(b, dd), min(f, h)), mx = max(max(b, dd), max(f, h));
  vec3 hitMin = mn / (4.0 * mx + 1e-5), hitMax = (1.0 - mx) / (4.0 * mn - 4.0 - 1e-5);
  vec3 lobeRGB = max(-hitMin, hitMax);
  float lobe = max(-0.1875, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * sharp;
  vec3 c = (lobe * (b + dd + f + h) + e) / (4.0 * lobe + 1.0);
  // дополнительная детализация по яркости (без цветных ореолов), ограничена соседями — без звона
  float lc = dot(c, vec3(0.299, 0.587, 0.114)), lb = dot((b + dd + f + h) * 0.25, vec3(0.299, 0.587, 0.114));
  c = clamp(c + (lc - lb) * boost, mn - 0.04, mx + 0.04);
  if (hdr > 0.5) {
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, 1.28);                       // насыщенность
    c = c * c * (3.0 - 2.0 * c) * 0.55 + c * 0.45;   // S-кривая: глубже тени, ярче света
    c = pow(max(c, 0.0), vec3(0.92));                // светлее середина
  }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
class SuperRes {
  constructor(v) {
    this.v = v;
    this.c = document.createElement('canvas');
    this.c.setAttribute('data-lq-sr', '');
    this.c.style.cssText = 'position:absolute;pointer-events:none;margin:0;padding:0;border:0;';
    const gl = this.c.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('nogl');
    this.gl = gl;
    const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    const prog = (fs) => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, SR_VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); return p; };
    this.pUp = prog(SR_UP); this.pSh = prog(SR_SHARP);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const tex = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
    this.tSrc = tex(); this.tMid = tex();
    this.fb = gl.createFramebuffer();
    this.level = 'mid'; this.hdr = false; this.alive = true; this.ow = 0; this.oh = 0;
    this.frames = 0; this.lastT = -1; this.dirty = true; this.lastDraw = performance.now();
    this.c.style.visibility = 'hidden';
    v.insertAdjacentElement('afterend', this.c);
    this.ro = new ResizeObserver(() => this.place()); this.ro.observe(v);
    this.posT = setInterval(() => this.place(), 700);
    this.place();
    this.loop();
  }
  place() {
    const v = this.v, c = this.c;
    if (!v.isConnected) return this.destroy();
    if (!c.isConnected) v.insertAdjacentElement('afterend', c);
    // учитываем «чёрные полосы» (object-fit: contain)
    const ew = v.offsetWidth, eh = v.offsetHeight, vw = v.videoWidth || ew, vh = v.videoHeight || eh;
    const k = Math.min(ew / vw, eh / vh) || 1;
    const w = Math.round(vw * k), h = Math.round(vh * k);
    const x = v.offsetLeft + (ew - w) / 2, y = v.offsetTop + (eh - h) / 2;
    Object.assign(c.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    const cs = getComputedStyle(v); c.style.zIndex = cs.zIndex === 'auto' ? '' : cs.zIndex; c.style.transform = cs.transform === 'none' ? '' : cs.transform;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let ow = Math.round(w * dpr), oh = Math.round(h * dpr);
    const cap = Math.sqrt((3840 * 2160) / Math.max(1, ow * oh)); if (cap < 1) { ow = Math.round(ow * cap); oh = Math.round(oh * cap); }
    if (ow !== this.ow || oh !== this.oh) {
      this.ow = c.width = Math.max(2, ow); this.oh = c.height = Math.max(2, oh);
      const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.tMid);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.ow, this.oh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tMid, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    if (v.readyState < 2 || !this.frames) c.style.visibility = 'hidden';
    else c.style.visibility = 'visible';
    this.dirty = true;
  }
  draw() {
    const gl = this.gl, v = this.v;
    if (v.readyState < 2 || !v.videoWidth) return;
    gl.bindTexture(gl.TEXTURE_2D, this.tSrc);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v); // кросс-доменное видео без CORS здесь бросит SecurityError
    const run = (p, fb, tex, w, h, set) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, w, h); gl.useProgram(p);
      const loc = gl.getAttribLocation(p, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(gl.getUniformLocation(p, 't'), 0);
      set(p); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    run(this.pUp, this.fb, this.tSrc, this.ow, this.oh, (p) => { gl.uniform2f(gl.getUniformLocation(p, 'src'), v.videoWidth, v.videoHeight); gl.uniform1f(gl.getUniformLocation(p, 'flip'), 1); });
    this.lastDraw = performance.now();
    run(this.pSh, null, this.tMid, this.ow, this.oh, (p) => {
      gl.uniform2f(gl.getUniformLocation(p, 'dst'), this.ow, this.oh);
      gl.uniform1f(gl.getUniformLocation(p, 'flip'), 0);
      gl.uniform1f(gl.getUniformLocation(p, 'sharp'), this.level === 'max' ? 1.0 : 0.75);
      gl.uniform1f(gl.getUniformLocation(p, 'boost'), this.level === 'max' ? 0.6 : 0.25);
      gl.uniform1f(gl.getUniformLocation(p, 'hdr'), this.hdr ? 1 : 0);
    });
  }
  // Рисуем по кадрам экрана и только когда у видео сменился кадр.
  // (requestVideoFrameCallback не используем: когда наш слой закрывает видео, Chromium может перестать его вызывать — картинка «застывала»)
  loop() {
    if (!this.alive) return;
    const v = this.v;
    // вкладка была скрыта или окно свёрнуто — кадры не рисовались не по нашей вине, отсчёт «зависания» начинаем заново
    const now = performance.now();
    if (now - (this.lastLoop || now) > 400 || document.hidden) this.lastDraw = now;
    this.lastLoop = now;
    const t = v.currentTime;
    if (v.readyState >= 2 && (t !== this.lastT || this.dirty)) {
      this.lastT = t; this.dirty = false;
      try { this.draw(); this.frames++; } catch (e) { this.fail('cors'); return; }
      if (this.frames === 8 || this.frames === 60 || this.frames % 600 === 0) { if (!this.selfTest()) return; }
      if (this.frames === 1) this.c.style.visibility = 'visible';
    }
    // видео идёт, а мы давно ничего не рисовали — значит что-то сломалось, показываем обычное видео
    if (!v.paused && v.readyState >= 3 && this.frames > 0 && performance.now() - this.lastDraw > 1500) { this.fail('stall'); return; }
    requestAnimationFrame(() => this.loop());
  }
  // Проверяем, что видеокарта реально отдаёт кадр, а не чёрный экран
  selfTest() {
    const v = this.v, gl = this.gl;
    try {
      const s2 = this.probe || (this.probe = Object.assign(document.createElement('canvas'), { width: 8, height: 8 }));
      const g = s2.getContext('2d', { willReadFrequently: true });
      const vw = v.videoWidth, vh = v.videoHeight;
      g.drawImage(v, vw * 0.3, vh * 0.3, vw * 0.4, vh * 0.4, 0, 0, 8, 8);
      const a = g.getImageData(0, 0, 8, 8).data;
      let sv = 0; for (let i = 0; i < a.length; i += 4) sv += a[i] + a[i + 1] + a[i + 2];
      const px = new Uint8Array(4 * 64);
      gl.readPixels(Math.floor(this.ow * 0.5) - 4, Math.floor(this.oh * 0.5) - 4, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let sg = 0; for (let i = 0; i < px.length; i += 4) sg += px[i] + px[i + 1] + px[i + 2];
      sv /= 64 * 3; sg /= 64 * 3;
      if (sv > 18 && sg < 3) { this.fail('gpu'); return false; }
    } catch (e) { /* кросс-доменное видео — сравнить не можем, верим отрисовке */ }
    return true;
  }
  fail(reason) {
    console.warn(`[liquid] супер-чёткость отключена: ${reason}, видео ${this.v.videoWidth}x${this.v.videoHeight} @ ${location.hostname}`);
    this.destroy();
    vt.srBroken = true; vt.srWhy = reason;
    toHost({ type: 'srFail', reason });
    barRender();
  }
  destroy() { if (!this.alive) return; this.alive = false; clearInterval(this.posT); this.ro.disconnect(); this.c.remove(); vt.srMap.delete(this.v); }
}
vt.srMap = new Map();
function srSync() {
  for (const v of videos()) {
    const big = v.offsetWidth >= 240;
    let r = vt.srMap.get(v);
    if (vt.sr === 'off' || !big) { if (r) r.destroy(); continue; }
    if (!r) { if (vt.srBroken) continue; try { r = new SuperRes(v); vt.srMap.set(v, r); } catch (e) { toHost({ type: 'srFail', reason: 'nogl' }); continue; } }
    r.level = vt.sr; r.hdr = vt.srHdr;
  }
  barRender();
}
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
button.sr { width: 98px; } button.sr.on { background: linear-gradient(180deg, #34d399, #059669); }
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
  dot: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
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
      <button data-a="more" title="Яркость, контраст и другое">${IC.more}</button>
    </div>
    <div class="row">
      <button data-a="mute" title="Громкость до 300% (Alt+колесо)">${IC.vol}</button><input type="range" data-r="vol" min="0" max="300" step="5"><span class="val" data-v="vol">100%</span>
    </div>
    <div class="row">
      <button class="sr" data-a="sr" title="Супер-чёткость: апскейл и резкость на видеокарте. Нажимай: выкл → средне → сильно">${IC.sr}Чёткость <i data-v="sr"></i></button>
      <button data-a="hdr" title="HDR-цвет">HDR</button>
    </div>
    <div class="st" data-v="st"></div>
    <div class="more">
      <label><span>Яркость</span><input type="range" data-r="bright" min="50" max="180" step="5"><b data-v="bright"></b></label>
      <label><span>Контраст</span><input type="range" data-r="contrast" min="50" max="180" step="5"><b data-v="contrast"></b></label>
      <label><span>Насыщенность</span><input type="range" data-r="sat" min="0" max="200" step="5"><b data-v="sat"></b></label>
      <div class="chips">
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
    else if (a === 'more') { barExpand(!bar.el.classList.contains('x')); barPlace(); }
    else if (a === 'comp') setComp(v, !vt.graphs.get(v)?.compOn);
    else if (a === 'loop') v.loop = !v.loop;
    else if (a === 'remember') { vt.remember = !vt.remember; toHost({ type: 'videoRemember', on: vt.remember, speed: v.playbackRate }); }
    else if (a === 'frame') videoCmd({ op: 'frame' });
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
  q('[data-v="sr"]').textContent = vt.sr === 'off' ? '' : vt.sr === 'mid' ? '×1' : '×2';
  q('[data-a="hdr"]').classList.toggle('on', vt.srHdr);
  const st = q('[data-v="st"]'), r = vt.srMap.get(v);
  const WHY = { cors: 'сайт не даёт обработать своё видео', gpu: 'видеокарта не отдала кадр', stall: 'кадры перестали обновляться', nogl: 'нет WebGL', small: 'видео слишком маленькое' };
  if (vt.srBroken) { st.className = 'st bad'; st.textContent = `Не работает: ${WHY[vt.srWhy] || 'ошибка'}. Нажми «Чёткость», чтобы попробовать снова.`; }
  else if (vt.sr !== 'off' && r && r.frames > 0) { st.className = 'st ok'; st.textContent = `Работает: ${v.videoWidth}×${v.videoHeight} → ${r.ow}×${r.oh}${vt.srHdr ? ' · HDR' : ''}`; }
  else if (vt.sr !== 'off' && v.offsetWidth < 240) { st.className = 'st'; st.textContent = 'Включится, когда видео станет больше.'; }
  else if (vt.sr !== 'off') { st.className = 'st'; st.textContent = 'Включается…'; setTimeout(barRender, 600); }
  else { st.className = 'st'; st.textContent = ''; }
  q('[data-a="pip"]').classList.toggle('on', document.pictureInPictureElement === v);
  for (const k of ['bright', 'contrast', 'sat']) { const val = Math.round((vt.want[k] ?? 1) * 100); q(`[data-r="${k}"]`).value = val; q(`[data-v="${k}"]`).textContent = val + '%'; }
  q('[data-a="comp"]').classList.toggle('on', !!vt.graphs.get(v)?.compOn);
  q('[data-a="loop"]').classList.toggle('on', v.loop);
  q('[data-a="remember"]').classList.toggle('on', !!vt.remember);
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
let barRaf = 0;
document.addEventListener('mousemove', (e) => {
  if (barRaf) return;
  barRaf = requestAnimationFrame(() => {
    barRaf = 0;
    const v = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.tagName === 'VIDEO');
    if (v) barShow(v);
  });
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
function liquidCmd(msg) {
  if (!msg) return;
  if (msg.type === 'translate') msg.on ? translateOn() : translateOff();
  else if (msg.type === 'theme') applyTheme(msg.theme || {});
  else if (msg.type === 'info') pageInfo();
  else if (msg.type === 'reader') msg.on === false || (msg.on == null && rd.host) ? readerClose() : readerOpen(msg.prefs);
  else if (msg.type === 'video') videoCmd(msg);
}
