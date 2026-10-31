// Блокировщик рекламы и трекеров на движке Ghostery (EasyList + EasyPrivacy + uBlock filters + русские списки AdGuard и RU AdList).
// Движок кэшируется на диск, чтобы старт был мгновенным; списки обновляются раз в сутки в фоне.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Собрать движок в служебном процессе (см. adblock-build.js). Не получилось — null, тогда соберём здесь, как раньше
function buildAside(text) {
  return new Promise((done) => {
    let child;
    try { child = require('electron').utilityProcess.fork(path.join(__dirname, 'adblock-build.js'), [], { serviceName: 'Liquid — сборка блокировщика' }); }
    catch (e) { console.warn('adblock build process', e.message); done(null); return; }
    const t = setTimeout(() => { try { child.kill(); } catch {} done(null); }, 60e3);
    child.once('message', (m) => { clearTimeout(t); if (m && m.ok) done(new Uint8Array(m.buf)); else { console.warn('adblock build', m && m.error); done(null); } });
    child.once('exit', () => { clearTimeout(t); done(null); });
    child.postMessage({ text, exceptions: EXCEPTIONS });
  });
}

// Наши исключения из списков. Правило EasyList прячет весь ролик Shorts, если в его контейнере есть рекламный блок;
// YouTube переиспользует контейнеры, блок остаётся — и обычные Shorts пропадают вместе с кнопками.
// Рекламные ролики в Shorts и так вырезаются правилами json-prune из ответа YouTube.
const EXCEPTIONS = [
  'youtube.com#@##shorts-inner-container > .ytd-shorts:has(> .ytd-reel-video-renderer > ytd-ad-slot-renderer)',
];
function withExceptions(lib, engine) {
  try {
    const CF = lib.CosmeticFilter || require('@ghostery/adblocker').CosmeticFilter;
    const list = EXCEPTIONS.map((l) => CF.parse(l)).filter(Boolean);
    if (list.length) engine.update({ newCosmeticFilters: list });
  } catch (e) { console.warn('adblock exceptions', e.message); }
  return engine;
}

class AdBlock {
  constructor(userData) {
    this.cacheFile = path.join(userData, 'adblock-engine-ru2.bin'); // новое имя: в кэше русские списки и наши исключения
    try { fs.rmSync(path.join(userData, 'adblock-engine-ru.bin'), { force: true }); } catch {}
    this.blocker = null;
    this.sessions = new Set();
    this.allow = new Set(); // сайты, где блокировщик выключен
    this.enabled = true;
    this.counts = new Map(); // webContentsId -> число заблокированных на текущей странице
    this.onCount = () => {};
  }

  async init(fetchFn) {
    let lib;
    try { lib = require('@ghostery/adblocker-electron'); } catch (e) { console.warn('adblock lib missing', e.message); return false; }
    const { ElectronBlocker } = lib;
    // 1) быстрый старт из кэша
    try {
      if (fs.existsSync(this.cacheFile)) {
        this.blocker = ElectronBlocker.deserialize(new Uint8Array(fs.readFileSync(this.cacheFile)));
      }
    } catch { this.blocker = null; }
    const stale = !fs.existsSync(this.cacheFile) || Date.now() - fs.statSync(this.cacheFile).mtimeMs > 864e5;
    // 2) свежие списки (первый запуск — ждём, дальше — фоном)
    // Каждый список качаем отдельно: прямо, потом через зеркало, потом другими путями (VPN). Не скачался —
    // берём его прошлую копию с диска. Раньше один оборванный провайдером список (ERR_CONNECTION_RESET)
    // срывал всё обновление, и блокировщик неделями работал на старых правилах.
    const refresh = async () => {
      let built = null;
      try {
        // реклама Яндекса, ЖЖ, VK и других русских сайтов есть только в русских списках
        const RU = ['https://filters.adtidy.org/extension/ublock/filters/1.txt', 'https://easylist-downloads.adblockplus.org/advblock.txt'];
        const base = lib.adsAndTrackingLists || lib.fullLists;
        let fresh;
        if (base) {
          const got = await Promise.all([...base, ...RU].map((u) => this.fetchList(u, fetchFn)));
          const missing = got.filter((g) => !g.text).map((g) => g.url);
          // какой-то список не скачался и копии нет. Движок уже есть — оставляем его (в нём все списки) и пробуем позже.
          // Движка нет (первый запуск или новое имя кэша) — собираем из того, что есть: без одного списка лучше,
          // чем совсем без блокировщика. Раньше один оборванный провайдером RU AdList оставлял браузер без блокировки.
          if (missing.length && (this.blocker || missing.length > got.length / 2)) throw new Error('не скачались и нет копии: ' + missing.join(', '));
          if (missing.length) console.info(`[adblock] собираю без ${missing.length} списков (не скачались): ${missing.join(', ')}`);
          const net = got.filter((g) => g.text && g.from !== 'кэш').length;
          this.lastNet = net === got.length;
          const text = got.map((g) => g.text).join('\n');
          // списки не изменились с прошлой сборки — пересобирать незачем (раньше пересобирали каждый раз)
          const hash = crypto.createHash('sha256').update(text).update(EXCEPTIONS.join('\n')).digest('hex');
          const hashFile = this.cacheFile + '.sha256';
          let old = ''; try { old = fs.readFileSync(hashFile, 'utf8'); } catch {}
          if (this.blocker && old === hash) { console.info(`[adblock] списки не изменились (${net} из ${got.length} из сети) — пересборка не нужна`); return; }
          const t0 = Date.now();
          const buf = await buildAside(text);
          built = buf;
          if (buf) fresh = ElectronBlocker.deserialize(buf);
          else { fresh = ElectronBlocker.parse(text, { enableCompression: true, loadCosmeticFilters: true, loadNetworkFilters: true }); withExceptions(lib, fresh); }
          if (!missing.length) fs.promises.writeFile(hashFile, hash).catch(() => {}); // неполная сборка — пересоберём, когда скачается всё
          console.info(`[adblock] сборка за ${Date.now() - t0} мс ${buf ? 'в отдельном процессе' : 'в основном процессе'}`);
          console.info(`[adblock] списки обновлены: ${net} из ${got.length} из сети${got.some((g) => g.from === 'зеркало') ? ' (часть через зеркало)' : ''}${net < got.length - missing.length ? ', остальные из сохранённой копии' : ''}${missing.length ? `, ${missing.length} не скачались — попробую через полчаса` : ''}`);
        } else { fresh = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetchFn); withExceptions(lib, fresh); }
        fs.promises.writeFile(this.cacheFile, Buffer.from(built || fresh.serialize())).catch(() => {}); // готовый двоичный движок — без повторной упаковки
        const was = this.blocker;
        this.blocker = fresh;
        if (was) for (const s of this.sessions) { try { was.disableBlockingInSession(s); } catch {} this.attach(s); }
        else for (const s of this.sessions) this.attach(s);
      } catch (e) { console.warn('adblock lists', e.message); this.lastNet = false; }
      finally {
        // не всё пришло из сети — пробуем ещё раз через полчаса (не больше 6 раз за запуск); пересборка — только если списки изменились
        if (!this.lastNet && (this.retries = (this.retries || 0) + 1) <= 6) setTimeout(refresh, 30 * 60e3);
      }
    };
    if (!this.blocker) await refresh(); else if (stale) refresh();
    if (this.blocker) for (const s of this.sessions) this.attach(s);
    return !!this.blocker;
  }

  // один список: прямо → зеркало (jsDelivr для GitHub) → запасные пути (VPN) → копия с диска
  async fetchList(url, fetchFn) {
    const dir = path.join(path.dirname(this.cacheFile), 'adblock-lists');
    const file = path.join(dir, url.replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]+/gi, '_').slice(-150));
    const mirror = (u) => { const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(u); return m ? `https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}` : null; };
    const tries = [['сеть', url, fetchFn], ['зеркало', mirror(url), fetchFn], ...(this.extraFetch ? [['VPN', url, this.extraFetch]] : [])].filter((t) => t[1]);
    for (const [from, u, f] of tries) {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 45e3);
      try {
        const r = await f(u, { signal: ctrl.signal, cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const text = await r.text();
        if (text.length < 200 || /^\s*</.test(text)) throw new Error('пустой ответ'); // страница-заглушка провайдера вместо списка
        try { fs.mkdirSync(dir, { recursive: true }); fs.promises.writeFile(file, text).catch(() => {}); } catch {}
        return { url, text, from };
      } catch (e) { console.info(`[adblock] ${from}: ${url} — ${e.message}`); } finally { clearTimeout(t); }
    }
    try { return { url, text: await fs.promises.readFile(file, 'utf8'), from: 'кэш' }; } catch { return { url, text: '', from: '' }; }
  }

  hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
  pageHost(d) {
    let top = '';
    if (this.topUrlOf) top = this.topUrlOf(d); // адрес вкладки из таблицы основного процесса — без обращения к фрейму
    else { try { top = d.frame?.top?.url || ''; } catch {} }
    return this.hostOf(top || d.referrer || d.url);
  }

  addSession(sess) {
    this.sessions.add(sess);
    if (this.blocker) this.attach(sess);
  }

  attach(sess) {
    const b = this.blocker;
    if (!b || sess.__liquidAdblock === b) return;
    b.enableBlockingInSession(sess); // косметика (скрытие баннеров) + сетевые правила
    // Его обработчик ответов стоит на каждом запросе, а нужен только для редких правил $csp на страницах.
    // Снимаем: каждый файл каждого сайта больше не ждёт основной процесс лишний раз
    try { sess.webRequest.onHeadersReceived(null); } catch {}
    // Перехватываем сетевой фильтр, чтобы работали «выключить на этом сайте» и счётчик
    sess.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
      // адрес страницы разбираем, только если есть сайты-исключения (раньше — на каждый запрос)
      if (!this.enabled || d.resourceType === 'mainFrame' || (this.allow.size && this.allow.has(this.pageHost(d)))) return cb({});
      b.onBeforeRequest(d, (res) => {
        if (res && (res.cancel || res.redirectURL)) {
          const id = d.webContentsId;
          if (id) { const n = (this.counts.get(id) || 0) + 1; this.counts.set(id, n); this.onCount(id, n); }
        }
        cb(res || {});
      });
    });
    sess.__liquidAdblock = b;
  }

  resetCount(id) { this.counts.set(id, 0); this.onCount(id, 0); }
}

module.exports = { AdBlock };
