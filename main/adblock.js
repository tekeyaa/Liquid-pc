// Блокировщик рекламы и трекеров на движке Ghostery (EasyList + EasyPrivacy + uBlock filters + русские списки AdGuard и RU AdList).
// Движок кэшируется на диск, чтобы старт был мгновенным; списки обновляются раз в сутки в фоне.
const path = require('path');
const fs = require('fs');

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
    const refresh = async () => {
      try {
        // реклама Яндекса, ЖЖ, VK и других русских сайтов есть только в русских списках
        const RU = ['https://filters.adtidy.org/extension/ublock/filters/1.txt', 'https://easylist-downloads.adblockplus.org/advblock.txt'];
        const base = lib.adsAndTrackingLists || lib.fullLists;
        const fresh = base
          ? await ElectronBlocker.fromLists(fetchFn, [...base, ...RU], { enableCompression: true, loadCosmeticFilters: true, loadNetworkFilters: true })
          : await ElectronBlocker.fromPrebuiltAdsAndTracking(fetchFn);
        withExceptions(lib, fresh);
        fs.writeFileSync(this.cacheFile, Buffer.from(fresh.serialize()));
        const was = this.blocker;
        this.blocker = fresh;
        if (was) for (const s of this.sessions) { try { was.disableBlockingInSession(s); } catch {} this.attach(s); }
        else for (const s of this.sessions) this.attach(s);
      } catch (e) { console.warn('adblock lists', e.message); }
    };
    if (!this.blocker) await refresh(); else if (stale) refresh();
    if (this.blocker) for (const s of this.sessions) this.attach(s);
    return !!this.blocker;
  }

  hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
  pageHost(d) {
    let top = '';
    try { top = d.frame?.top?.url || ''; } catch {}
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
    // Перехватываем сетевой фильтр, чтобы работали «выключить на этом сайте» и счётчик
    sess.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
      if (!this.enabled || d.resourceType === 'mainFrame' || this.allow.has(this.pageHost(d))) return cb({});
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
