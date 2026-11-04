// Режим обучения Liquid RTX: браузер сам собирает пары кадров «1080p → 4K/8K» с YouTube для обучения нейросети.
// Ролики попадают в очередь сами (открыл ролик, у которого есть 1080p и 4K) или списком ссылок из настроек.
// Скрытое окно без звука открывает ролик, ставит на паузу кадр в 1080p, затем тот же кадр в 4K (8K — уменьшенный до 4K,
// почти без следов сжатия) и сохраняет кусочки яркости. Работает, только когда ни одна вкладка не играет звук.
// Данные: %APPDATA%\Liquid\rtx-learn\data\<id>_hr.npy, _lr.npy, _cid.npy (их читает tools/rtx/gpu/train_gpu.py).
const fs = require('fs');
const path = require('path');

const PLACES = 12, CROPS = 3, C = 512, c = C / 2;

// Скрипт страницы YouTube (основной мир страницы — там его плеер). Всё тяжёлое — здесь: кадры в main не ходят,
// назад приходят только кусочки 512² / 256² в uint16 (base64).
const PAGE = `(() => { if (window.__lqLearn) return true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = () => document.getElementById('movie_player');
const V = () => document.querySelector('video.html5-main-video') || document.querySelector('#movie_player video') || document.querySelector('video');
const cv = document.createElement('canvas'); const cx = cv.getContext('2d', { willReadFrequently: true });
const luma = (img) => { const d = img.data, o = new Float32Array(d.length / 4); for (let i = 0, j = 0; i < d.length; i += 4, j++) o[j] = (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722) / 255; return o; };
const b64 = (f) => { const u = new Uint16Array(f.length); for (let i = 0; i < f.length; i++) u[i] = Math.round(Math.min(1, Math.max(0, f[i])) * 65535);
  const b = new Uint8Array(u.buffer); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
const std = (f) => { let m = 0, q = 0; for (const x of f) { m += x; q += x * x; } m /= f.length; return Math.sqrt(Math.max(0, q / f.length - m * m)); };
async function ads() { for (let i = 0; i < 120; i++) { const p = P(); if (!p || !p.classList.contains('ad-showing')) return;
  const s = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern'); if (s) s.click(); await sleep(500); } }
async function until(f, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (f()) return true; } catch {} await sleep(120); } return false; }
let q = '', lo = [];
window.__lqLearn = {
  async info() {
    if (!(await until(() => P() && P().getAvailableQualityLevels && P().getAvailableQualityLevels().length && P().getDuration() > 0, 30000))) return { err: 'плеер не загрузился' };
    await ads(); const p = P(); p.mute && p.mute();
    const L = p.getAvailableQualityLevels();
    const hi = ['highres', 'hd2160'].find((x) => L.includes(x));
    if (!L.includes('hd1080') || !hi) return { err: 'нет 1080p и 4K', levels: L };
    return { dur: p.getDuration(), hi, levels: L };
  },
  async setQ(x) { q = x; const p = P(); p.setPlaybackQualityRange(x, x); p.playVideo(); await sleep(1500); p.pauseVideo(); return p.getPlaybackQuality(); },
  async seek(t, ms = 12000) { const p = P(), v = V(); await ads(); p.seekTo(t, true); p.pauseVideo();
    const ok = await until(() => !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - t) < 0.2 && P().getPlaybackQuality() === q, ms);
    await sleep(250); return ok ? v : null; },
  // 1080p: место t → случайные кусочки 256² (с деталями), держим их тут до прохода 4K
  async grabLo(i, t) {
    const v = await this.seek(t); if (!v) return { err: 'не дождался кадра 1080p' };
    const w = v.videoWidth, h = v.videoHeight; if (h < 1000 && w < 1000) return { err: 'не 1080p: ' + w + '×' + h };
    cv.width = w; cv.height = h; cx.drawImage(v, 0, 0, w, h);
    const out = [];
    for (let k = 0, tries = 0; k < ${CROPS} && tries < 12; tries++) {
      const x = Math.floor(Math.random() * (w - ${c})), y = Math.floor(Math.random() * (h - ${c}));
      const f = luma(cx.getImageData(x, y, ${c}, ${c})); if (std(f) < 0.04) continue;
      out.push({ x, y, f }); k++;
    }
    // рисованное ли (как contentOf в webview-preload.js): доля «плоских» точек на уменьшенном кадре 160×90
    const sm = document.createElement('canvas'); sm.width = 160; sm.height = 90; const sx = sm.getContext('2d', { willReadFrequently: true });
    sx.drawImage(v, 0, 0, 160, 90); const d = sx.getImageData(0, 0, 160, 90).data; let flat = 0, n = 0;
    const Y = (x, y) => { const j = (y * 160 + x) * 4; return d[j] * 0.2126 + d[j + 1] * 0.7152 + d[j + 2] * 0.0722; };
    for (let y = 1; y < 89; y++) for (let x = 1; x < 159; x++) { const c = Y(x, y); if (c <= 24) continue; n++;
      if (Math.max(Math.abs(c - Y(x - 1, y)), Math.abs(c - Y(x + 1, y)), Math.abs(c - Y(x, y - 1)), Math.abs(c - Y(x, y + 1))) < 1.5) flat++; }
    lo[i] = { t, w, h, crops: out }; return { n: out.length, w, h, flat: n ? flat / n : 0 };
  },
  // 4K/8K: тот же кадр (пробуем и соседние: потоки могут разойтись на кадр), 8K рисуем в 4K — среднее 2×2.
  async grabHi(i) {
    const L0 = lo[i]; if (!L0 || !L0.crops.length) return { pairs: [] };
    // Сначала сам кадр: если он хорошо совпал с 1080p (33 дБ и выше — так и бывает почти всегда), соседние кадры
    // не грузим вовсе. Не дождались 4K-кадра за 12 с — место пропускаем, соседние не перебираем (раньше одно такое
    // место стоило больше двух минут: 5 перемоток по 25 с). Соседние кадры — только при плохом совпадении, по 6 с
    let best = null;
    for (const dt of [0, 1 / 60, -1 / 60, 1 / 30, -1 / 30]) {
      const v = await this.seek(L0.t + dt, dt ? 6000 : 12000);
      if (!v) { if (dt === 0) break; continue; }
      const W = v.videoWidth, k = W / L0.w; if (k !== 2 && k !== 4) return { err: 'не вдвое/вчетверо больше: ' + W };
      cv.width = 2 * L0.w; cv.height = 2 * L0.h; cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high'; cx.drawImage(v, 0, 0, cv.width, cv.height);
      const pairs = []; let ps = 0;
      for (const cr of L0.crops) {
        const H = luma(cx.getImageData(2 * cr.x, 2 * cr.y, ${C}, ${C}));
        let e = 0; for (let y = 0; y < ${c}; y++) for (let x = 0; x < ${c}; x++) {
          const j = 2 * y * ${C} + 2 * x; const m = (H[j] + H[j + 1] + H[j + ${C}] + H[j + ${C} + 1]) / 4 - cr.f[y * ${c} + x]; e += m * m; }
        const p = 10 * Math.log10(1 / Math.max(e / (${c} * ${c}), 1e-10)); ps += p; pairs.push({ p, hr: H, lr: cr.f });
      }
      ps /= pairs.length;
      if (!best || ps > best.ps) best = { ps, pairs, k, dt };
      if (best.ps >= 33) break;
    }
    if (!best) return { err: 'не дождался кадра 4K' };
    lo[i] = null;
    return { ps: best.ps, k: best.k, pairs: best.pairs.filter((x) => x.p > 27).map((x) => ({ hr: b64(x.hr), lr: b64(x.lr) })) };
  },
};
return true; })()`;

// Скрипт страницы плейлиста: id роликов из ytInitialData и продолжений (как при прокрутке)
const PLAYLIST = `(async () => {
const ids = new Set(); let token = null;
const walk = (o) => { if (!o || typeof o !== 'object') return;
  if (o.playlistVideoRenderer && o.playlistVideoRenderer.videoId) ids.add(o.playlistVideoRenderer.videoId);
  if (o.continuationCommand && o.continuationCommand.token) token = o.continuationCommand.token;
  for (const k in o) walk(o[k]); };
for (let i = 0; i < 50 && !window.ytInitialData; i++) await new Promise((r) => setTimeout(r, 200));
walk(window.ytInitialData);
const key = window.ytcfg && ytcfg.get('INNERTUBE_API_KEY'), ctx = window.ytcfg && ytcfg.get('INNERTUBE_CONTEXT');
for (let page = 0; token && key && ctx && page < 20 && ids.size < 1000; page++) {
  const t = token; token = null;
  const r = await fetch('/youtubei/v1/browse?prettyPrint=false&key=' + key, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: ctx, continuation: t }) });
  if (!r.ok) break; walk(await r.json());
}
if (!ids.size) document.querySelectorAll('a[href*="watch?v="]').forEach((a) => { const m = a.href.match(/v=([\\w-]{11})/); if (m) ids.add(m[1]); });
return [...ids];
})()`;

// .npy (numpy) без зависимостей
function npy(dtype, shape, buf) {
  let h = `{'descr': '${dtype}', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
  const pad = 64 - ((10 + h.length + 1) % 64); h += ' '.repeat(pad % 64) + '\n';
  const head = Buffer.alloc(10); head.write('\x93NUMPY', 0, 'latin1'); head[6] = 1; head[7] = 0; head.writeUInt16LE(h.length, 8);
  return Buffer.concat([head, Buffer.from(h, 'latin1'), buf]);
}

const ytId = (s) => {
  const m = String(s).match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/) || String(s).trim().match(/^([\w-]{11})$/);
  return m ? m[1] : null;
};

class RtxLearn {
  constructor({ dir, partition, BrowserWindow, webContents, log, settings, urlFor }) {
    Object.assign(this, { dir, partition, BrowserWindow, webContents, log: log || (() => {}), settings });
    this.urlFor = urlFor || ((id) => `https://www.youtube.com/watch?v=${id}`);
    this.data = path.join(dir, 'data'); this.qfile = path.join(dir, 'queue.json');
    try { this.q = JSON.parse(fs.readFileSync(this.qfile, 'utf8')); } catch { this.q = []; }
    if (!Array.isArray(this.q)) this.q = [];
    this.busy = null; this.cur = '';
    this.timer = setInterval(() => this.tick(), 20000); this.timer.unref && this.timer.unref();
  }
  save() { try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(this.qfile, JSON.stringify(this.q)); } catch {} }
  on() { return !!this.settings().rtxLearn; }
  budget() { return Math.max(0.2, Number(this.settings().rtxLearnGb) || 1) * 2 ** 30; }
  bytes() {
    const walk = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).reduce((s, f) => s + (f.isDirectory() ? walk(path.join(d, f.name)) : fs.statSync(path.join(d, f.name)).size), 0); } catch { return 0; } };
    return walk(this.data);
  }
  add(idOrUrl, title, from) {
    const id = ytId(idOrUrl); if (!id) return false;
    if (this.q.some((x) => x.id === id)) return false;
    this.q.push({ id, title: String(title || '').slice(0, 120), from: from || 'link', st: 'new', tries: 0, at: Date.now() });
    if (this.q.length > 2000) this.q = this.q.filter((x) => x.st === 'new').slice(-2000);
    this.save(); const t = setTimeout(() => this.tick(), 3000); if (t.unref) t.unref(); return true;
  }
  // ссылки по одной; ссылка на плейлист (…list=…) разворачивается во все его ролики
  async addText(text) {
    let n = 0;
    for (const s of String(text).split(/[\s,]+/)) {
      if (this.add(s, '', 'link')) n++;
      const m = s.match(/[?&]list=([\w-]{10,})/);
      if (m && !/^(RD|UL|LL|WL)/.test(m[1])) for (const id of await this.playlist(m[1]).catch((e) => { this.log('warn', 'Liquid RTX обучение', `плейлист: ${e.message}`); return []; })) if (this.add(id, '', 'playlist')) n++;
    }
    return n;
  }
  // ролики плейлиста: страница плейлиста в скрытом окне (с твоим входом в YouTube), дальше — тем же запросом,
  // что делает сам YouTube при прокрутке (youtubei/v1/browse с продолжением), до 1000 роликов
  async playlist(list) {
    const w = new this.BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { partition: this.partition, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    w.webContents.__lqLearn = true; w.webContents.setAudioMuted(true); w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    try {
      await w.loadURL(this.urlFor('').replace(/watch\?v=.*$/, '') + 'playlist?list=' + list);
      return await Promise.race([w.webContents.executeJavaScript(PLAYLIST, true), new Promise((_, no) => setTimeout(() => no(new Error('YouTube не ответил')), 120000))]);
    } finally { try { w.destroy(); } catch {} }
  }
  status() {
    const cnt = (st) => this.q.filter((x) => x.st === st).length;
    return { on: this.on(), queued: cnt('new'), done: cnt('done'), anime: this.q.filter((x) => x.st === 'done' && x.kind === 'anime').length, skipped: cnt('skip') + cnt('fail'), pairs: this.q.reduce((s, x) => s + (x.pairs || 0), 0),
      bytes: this.bytes(), budget: this.budget(), busy: !!this.busy, cur: this.cur, dir: this.dir, wait: this.busy ? '' : this.why(), last: this.lastDur || 0 };
  }
  // почему сейчас не нарезает (для строки в настройках)
  why() {
    if (!this.on()) return '';
    if (this.pause && this.pause()) return 'пауза: идёт обучение — сбор продолжится после него';
    if (this.bytes() >= this.budget()) return 'место заполнено';
    if (!this.q.some((x) => x.st === 'new')) return 'очередь пуста — открой ролик с 4K или добавь ссылки';
    if (this.blocked()) return 'пауза: во вкладке играет звук (так выбрано в настройках)';
    return 'начну в течение 20 секунд';
  }
  // мешает ли просмотр сбору: по умолчанию нет — нарезка идёт и пока ты смотришь видео (окно сбора без звука,
  // кадры берёт на паузе, видеокарте это почти ничего не стоит). Можно выключить в настройках («только когда видео не играет»)
  blocked() { return this.settings().rtxLearnWatch === false && this.watching(); }
  // кто-то смотрит/слушает
  watching() {
    return this.webContents.getAllWebContents().some((wc) => wc !== this.wc && !wc.isDestroyed() && wc.isCurrentlyAudible && wc.isCurrentlyAudible());
  }
  tick() {
    if (this.busy || !this.on() || (this.pause && this.pause()) || this.blocked() || this.bytes() >= this.budget()) return;
    const it = this.q.find((x) => x.st === 'new'); if (!it) return;
    const t0 = Date.now();
    this.busy = this.run(it).then(() => { this.lastDur = Date.now() - t0; }).catch((e) => { it.why = String(e && e.message || e).slice(0, 160); if (/^прервано/.test(it.why) || this.stopped) return; it.tries++; if (it.tries >= 3) it.st = 'fail'; else { const j = this.q.indexOf(it); if (j >= 0) { this.q.splice(j, 1); this.q.push(it); } } /* не вышло — в конец очереди: сначала другие ролики */ })
      .finally(() => { this.close(); this.busy = null; this.cur = ''; this.save(); });
  }
  close() { this.stopped = !!this.busy; try { if (this.win && !this.win.isDestroyed()) this.win.destroy(); } catch {} this.win = null; this.wc = null; }
  async run(it) {
    this.stopped = false;
    this.cur = it.title || it.id;
    // Окно рисуется в память (offscreen), а не просто скрыто: у скрытого окна страница «свёрнута», и Chromium для
    // экономии перестаёт декодировать видео (кадры приходят с опозданием или не приходят) — нарезка еле шла.
    // Отрисовка в память держит страницу «видимой»; частота кадров — минимальная, на экран всё равно не выводим
    const w = this.win = new this.BrowserWindow({ show: false, width: 1920, height: 1080, webPreferences: { offscreen: true, partition: this.partition, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
    try { w.webContents.setFrameRate(4); } catch {}
    // YouTube в «свёрнутой» вкладке экономит трафик и не отдаёт высокое качество (в журнале — «не дождался кадра 4K»
    // у многих роликов). Ещё до скриптов страницы говорим ей «вкладка открыта и в фокусе»
    try {
      const dbg = w.webContents.debugger; dbg.attach('1.3');
      await dbg.sendCommand('Page.enable');
      await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(Document.prototype,'hidden',{get:()=>false,configurable:true});Object.defineProperty(Document.prototype,'visibilityState',{get:()=>'visible',configurable:true});Document.prototype.hasFocus=()=>true;" });
      await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    } catch {}
    const wc = this.wc = w.webContents; wc.__lqLearn = true; wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const ex = (js, ms = 90000) => Promise.race([wc.executeJavaScript(js, true), new Promise((_, no) => setTimeout(() => no(new Error('страница не ответила')), ms))]);
    await w.loadURL(this.urlFor(it.id));
    await ex(PAGE);
    const info = await ex('__lqLearn.info()');
    if (info.err) { it.st = 'skip'; it.why = info.err; return; }
    const dur = info.dur;
    if (!(dur > 20)) { it.st = 'skip'; it.why = 'короткий'; return; }
    const ts = Array.from({ length: PLACES }, (_, k) => dur * (0.05 + 0.9 * (k + Math.random()) / PLACES));
    const stop = () => { if (this.blocked() || !this.on()) throw new Error('прервано: включилось видео'); };
    await ex(`__lqLearn.setQ('hd1080')`);
    const flats = [];
    for (let i = 0; i < ts.length; i++) { stop(); const r = await ex(`__lqLearn.grabLo(${i}, ${ts[i].toFixed(3)})`); if (r && r.flat != null) flats.push(r.flat); }
    // аниме и мультики — в свою папку (для своей сети), остальное — в общую
    flats.sort((a, b) => a - b);
    const anime = flats.length >= 3 && flats[flats.length >> 1] > 0.22;
    await ex(`__lqLearn.setQ('${info.hi}')`);
    const HR = [], LR = [], CID = []; let k8 = 0, fails4k = 0;
    for (let i = 0; i < ts.length; i++) {
      stop();
      const r = await ex(`__lqLearn.grabHi(${i})`, 90000);
      if (r.err) {
        this.log('warn', 'Liquid RTX обучение', r.err);
        if (/вдвое/.test(r.err)) { it.st = 'skip'; it.why = r.err; return; }
        // 4K у этого ролика сейчас не грузится — не тратим на него минуты, попробуем позже (до 3 раз)
        if (/4K/.test(r.err) && ++fails4k >= 3) throw new Error('4K не грузится — отложил ролик');
        continue;
      }
      fails4k = 0;
      if (r.k === 4) k8 = 1;
      for (const p of r.pairs) { HR.push(Buffer.from(p.hr, 'base64')); LR.push(Buffer.from(p.lr, 'base64')); CID.push(i); }
    }
    if (!HR.length) { it.st = 'skip'; it.why = 'кадры не совпали'; return; }
    const dir = this.data; // одна сеть для всего — и аниме, и съёмка в одну папку
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, it.id);
    const cid = Buffer.alloc(4 * CID.length); CID.forEach((v, j) => cid.writeInt32LE(v, 4 * j));
    fs.writeFileSync(base + '_lr.npy', npy('<u2', [LR.length, c, c], Buffer.concat(LR)));
    fs.writeFileSync(base + '_cid.npy', npy('<i4', [CID.length], cid));
    fs.writeFileSync(base + '_hr.npy', npy('<u2', [HR.length, C, C], Buffer.concat(HR)));
    Object.assign(it, { st: 'done', pairs: HR.length, src: k8 ? '8K' : '4K', kind: anime ? 'anime' : 'video', why: '' });
    this.log('info', 'Liquid RTX обучение', `${it.title || it.id}: ${HR.length} пар (${it.src}${anime ? ', аниме' : ''})`);
  }
}

module.exports = { RtxLearn, ytId, npy, PAGE };
