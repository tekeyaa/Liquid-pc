// Блокировщик рекламы и трекеров на движке Ghostery (EasyList + EasyPrivacy + uBlock filters + русские списки AdGuard и RU AdList).
// Движок кэшируется на диск, чтобы старт был мгновенным; списки обновляются раз в сутки в фоне.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Собрать движок в служебном процессе (см. adblock-build.js): { same, hash } если списки не изменились, { file, hash } — новый движок в файле.
// Не получилось — null, тогда соберём здесь, как раньше.
// Списки и готовый движок ходят через диск, а не через postMessage: передача 6,5 МБ текста в процесс сборки
// занимала основной процесс на 2,6 с (замер профиля в автотестах) — на каждом суточном обновлении, даже без изменений
function buildAside(parts, oldHash, out, resources) {
  return new Promise((done) => {
    let child;
    try { child = require('electron').utilityProcess.fork(path.join(__dirname, 'adblock-build.js'), [], { serviceName: 'Liquid — сборка блокировщика' }); }
    catch (e) { console.warn('adblock build process', e.message); done(null); return; }
    // не успел или упал — НЕ собираем в основном процессе (это минута подвисаний всего браузера на слабом ПК):
    // остаёмся на прежнем движке и пробуем позже. В основном процессе — только если отдельный процесс не запустить
    const t = setTimeout(() => { try { child.kill(); } catch {} done({ fail: 'сборка не успела за 3 минуты' }); }, 180e3);
    child.once('message', (m) => { clearTimeout(t); if (m && m.ok) done(m.same ? { same: true, hash: m.hash } : m.file ? { file: m.file, hash: m.hash, resErr: m.resErr } : { buf: new Uint8Array(m.buf), hash: m.hash, resErr: m.resErr }); else { console.warn('adblock build', m && m.error); done({ fail: 'сборка: ' + (m && m.error) }); } });
    child.once('exit', () => { clearTimeout(t); done({ fail: 'процесс сборки завершился' }); });
    child.postMessage({ parts, exceptions: EXCEPTIONS, oldHash, out, resources });
  });
}

// Наши исключения из списков. Правило EasyList прячет весь ролик Shorts, если в его контейнере есть рекламный блок;
// YouTube переиспользует контейнеры, блок остаётся — и обычные Shorts пропадают вместе с кнопками.
// Рекламные ролики в Shorts вырезают скриптлеты json-prune из ответа YouTube — но только когда загружены ресурсы
// uBlock (RESOURCES ниже) и включена настройка «Вырезать рекламу внутри страниц». Без них Shorts-реклама остаётся видна.
const EXCEPTIONS = [
  'youtube.com#@##shorts-inner-container > .ytd-shorts:has(> .ytd-reel-video-renderer > ytd-ad-slot-renderer)',
];
// Ресурсы uBlock: тела скриптлетов (json-prune, set-constant…) и заглушки для $redirect. Без них правила вида
// youtube.com##+js(json-prune, …) в списках есть, а внедрять нечего — YouTube получал 0 скриптов вместо ~30
const RESOURCES = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json';
// каналы, по которым скрипт-предзагрузка Ghostery (во всех фреймах сессии) просит косметику
const IPC_INJECT = '@ghostery/adblocker/inject-cosmetic-filters', IPC_MO = '@ghostery/adblocker/is-mutation-observer-enabled';

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
    // ru3: движок без контрольной суммы — её проверка (crc32 нескольких МБ) занимала основной процесс на каждом запуске
    // и после каждого обновления списков. Повреждённый файл всё равно не загрузится, и движок соберётся заново
    // ru4: без RU AdList (ломал Авито и Кинопоиск) — новое имя, чтобы старый движок с ним не прожил ещё сутки
    this.cacheFile = path.join(userData, 'adblock-engine-ru4.bin');
    for (const old of ['adblock-engine-ru3.bin', 'adblock-engine-ru3.bin.sha256']) fs.promises.rm(path.join(userData, old), { force: true }).catch(() => {});
    for (const old of ['adblock-engine-ru.bin', 'adblock-engine-ru2.bin', 'adblock-engine-ru2.bin.sha256']) fs.promises.rm(path.join(userData, old), { force: true }).catch(() => {});
    this.blocker = null;
    this.sessions = new Set();
    this.allow = new Set(); // сайты, где блокировщик выключен
    this.enabled = true;
    this.scripts = true; // скриптлеты (settings.adScripts)
    this.counts = new Map(); // webContentsId -> число заблокированных на текущей странице
    this.onCount = () => {};
    this.hookScripts();
  }

  async init(fetchFn) {
    let lib;
    try { lib = require('@ghostery/adblocker-electron'); } catch (e) { console.warn('adblock lib missing', e.message); return false; }
    const { ElectronBlocker } = lib;
    // 1) быстрый старт из кэша
    try {
      if (fs.existsSync(this.cacheFile)) {
        const t0 = Date.now();
        this.blocker = ElectronBlocker.deserialize(new Uint8Array(await fs.promises.readFile(this.cacheFile)));
        this.loadMs = Date.now() - t0; if (this.loadMs > 150) console.info(`[adblock] движок из кэша загружен за ${this.loadMs} мс`);
      }
    } catch { this.blocker = null; }
    if (this.blocker) this.logScripts('из кэша');
    const stale = !fs.existsSync(this.cacheFile) || Date.now() - fs.statSync(this.cacheFile).mtimeMs > 864e5;
    // 2) свежие списки (первый запуск — ждём, дальше — фоном)
    // Каждый список качаем отдельно: прямо, потом через зеркало, потом другими путями (VPN). Не скачался —
    // берём его прошлую копию с диска. Раньше один оборванный провайдером список (ERR_CONNECTION_RESET)
    // срывал всё обновление, и блокировщик неделями работал на старых правилах.
    const refresh = async () => {
      let built = null;
      try {
        // реклама Яндекса, ЖЖ, VK и других русских сайтов есть только в русских списках
        // RU AdList (advblock.txt) убран в 1.22: с нашим движком он ломал Авито и Кинопоиск (стили и скрипты сайтов),
        // а русскую рекламу и так режет AdGuard Russian
        const RU = ['https://filters.adtidy.org/extension/ublock/filters/1.txt'];
        const base = lib.adsAndTrackingLists || lib.fullLists;
        let fresh;
        if (base) {
          // ресурсы скриптлетов — так же, как списки: сеть → зеркало → VPN → копия с диска
          const [res, ...got] = await Promise.all([RESOURCES, ...base, ...RU].map((u) => this.fetchList(u, fetchFn)));
          const missing = got.filter((g) => !g.text).map((g) => g.url);
          // какой-то список не скачался и копии нет. Движок уже есть — оставляем его (в нём все списки) и пробуем позже.
          // Движка нет (первый запуск или новое имя кэша) — собираем из того, что есть: без одного списка лучше,
          // чем совсем без блокировщика. Раньше один оборванный провайдером RU AdList оставлял браузер без блокировки.
          if (missing.length && (this.blocker || missing.length > got.length / 2)) throw new Error('не скачались и нет копии: ' + missing.join(', '));
          if (missing.length) console.info(`[adblock] собираю без ${missing.length} списков (не скачались): ${missing.join(', ')}`);
          const net = got.filter((g) => g.text && g.from !== 'кэш').length;
          // ресурсы не скачались и копии нет — собираем без них (как раньше), повторим через полчаса вместе со списками
          if (!res.text) console.info('[adblock] ресурсы скриптлетов не скачались — движок без скриптлетов, попробую через полчаса');
          this.lastNet = net === got.length && !!res.text && res.from !== 'кэш';
          const resPart = res.file ? { file: res.file } : res.text ? { text: res.text } : null;
          // списки не изменились с прошлой сборки — пересобирать незачем; сравнивает и собирает служебный процесс
          const hashFile = this.cacheFile + '.sha256';
          let old = ''; try { old = await fs.promises.readFile(hashFile, 'utf8'); } catch {}
          const t0 = Date.now();
          // процессу сборки — пути к сохранённым спискам (текстом — только если сохранить на диск не вышло)
          // отпечаток считается и по ресурсам: после обновления Liquid движок пересоберётся один раз (с ними), дальше — только при изменениях
          const r = await buildAside(got.map((g) => (g.file ? { file: g.file } : { text: g.text })), this.blocker ? old : '', this.cacheFile + '.new', resPart);
          if (r && r.fail) throw new Error(r.fail); // попробуем через полчаса (finally), прежний движок работает
          if (r && r.same) { console.info(`[adblock] списки не изменились (${net} из ${got.length} из сети) — пересборка не нужна`); return; }
          if (r && r.resErr) console.warn('adblock resources', r.resErr); // формат ресурсов не подошёл — движок без скриптлетов
          let hash = r && r.hash;
          const buf = r && (r.file ? new Uint8Array(await fs.promises.readFile(r.file)) : r.buf);
          built = buf;
          if (buf) { const t1 = Date.now(); fresh = ElectronBlocker.deserialize(buf); const dt = this.loadMs = Date.now() - t1; if (dt > 150) console.info(`[adblock] новый движок загружен за ${dt} мс`); }
          else {
            const text = got.map((g) => g.text).join('\n');
            const h = crypto.createHash('sha256').update(text).update(EXCEPTIONS.join('\n'));
            if (res.text) h.update('\n#resources\n').update(res.text);
            hash = h.digest('hex');
            if (this.blocker && old === hash) { console.info('[adblock] списки не изменились — пересборка не нужна'); return; }
            fresh = ElectronBlocker.parse(text, { enableCompression: true, loadCosmeticFilters: true, loadNetworkFilters: true, integrityCheck: false }); withExceptions(lib, fresh);
            if (res.text) { try { fresh.updateResources(res.text, hash.slice(0, 16)); } catch (e) { console.warn('adblock resources', e.message); } }
          }
          if (!missing.length) fs.promises.writeFile(hashFile, hash).catch(() => {}); // неполная сборка — пересоберём, когда скачается всё
          console.info(`[adblock] сборка за ${Date.now() - t0} мс ${buf ? 'в отдельном процессе' : 'в основном процессе'}${buf ? ` (движок ${(buf.length / 1048576).toFixed(2)} МБ, загружен за ${this.loadMs} мс)` : ''}`);
          console.info(`[adblock] списки обновлены: ${net} из ${got.length} из сети${got.some((g) => g.from === 'зеркало') ? ' (часть через зеркало)' : ''}${net < got.length - missing.length ? ', остальные из сохранённой копии' : ''}${missing.length ? `, ${missing.length} не скачались — попробую через полчаса` : ''}`);
        } else { fresh = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetchFn); withExceptions(lib, fresh); }
        // готовый двоичный движок — без повторной упаковки; собранный в отдельном процессе уже лежит рядом, его просто переименовываем
        if (built && fs.existsSync(this.cacheFile + '.new')) fs.promises.rename(this.cacheFile + '.new', this.cacheFile).catch(() => {});
        else fs.promises.writeFile(this.cacheFile, Buffer.from(built || fresh.serialize())).catch(() => {});
        this.blocker = fresh;
        if (this.testRules) this.addTestRules([]); // правила автотеста — и в новый движок
        // косметика и скриптлеты берут движок из this.blocker при каждом запросе; сетевой обработчик — переставляем
        for (const s of this.sessions) this.attach(s);
        this.logScripts('после обновления');
      } catch (e) { console.warn('adblock lists', e.message); this.lastNet = false; }
      finally {
        // не всё пришло из сети — пробуем ещё раз через полчаса (не больше 6 раз за запуск); пересборка — только если списки изменились
        if (!this.lastNet && (this.retries = (this.retries || 0) + 1) <= 6) setTimeout(refresh, 30 * 60e3);
      }
    };
    // движок из кэша собран без ресурсов (прежние версии Liquid их не загружали) — обновляем сразу, а не через сутки.
    // Не чаще раза в 6 часов: если ресурсы не качаются совсем, не гоняем все списки на каждом запуске
    const tryFile = this.cacheFile + '.restry';
    let noRes = false;
    if (this.blocker && !this.scriptletCount()) {
      let last = 0; try { last = fs.statSync(tryFile).mtimeMs; } catch {}
      noRes = Date.now() - last > 6 * 3600e3;
      if (noRes) fs.promises.writeFile(tryFile, String(Date.now())).catch(() => {});
    }
    if (!this.blocker) await refresh(); else if (stale || noRes) refresh();
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
        // сохраняем до сборки: процесс сборки читает списки с диска
        let saved = null; try { await fs.promises.mkdir(dir, { recursive: true }); await fs.promises.writeFile(file, text); saved = file; } catch {}
        return { url, text, from, file: saved };
      } catch (e) { console.info(`[adblock] ${from}: ${url} — ${e.message}`); } finally { clearTimeout(t); }
    }
    try { return { url, text: await fs.promises.readFile(file, 'utf8'), from: 'кэш', file }; } catch { return { url, text: '', from: '' }; }
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
    // Раньше — b.enableBlockingInSession(sess). Ghostery регистрирует свои каналы ipcMain.handle на ВСЁ приложение,
    // и для второй сессии (окно инкогнито) это бросало «second handler»: сетевые правила там не вставали.
    // Теперь каналы — свои, один раз (hookIpc), а в сессию ставим только скрипт-предзагрузку и сетевой фильтр.
    // Его обработчик ответов ($csp) не ставим вовсе: он ждал основной процесс на каждом файле каждого сайта
    this.hookIpc();
    if (!sess.__liquidAdPreload) {
      const file = preloadPath();
      try {
        if (file && sess.registerPreloadScript) sess.registerPreloadScript({ type: 'frame', filePath: file });
        else if (file) sess.setPreloads([...sess.getPreloads(), file]);
        sess.__liquidAdPreload = true;
      } catch (e) { console.warn('adblock preload', e.message); }
    }
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

  // блокировщик работает на этой странице: включён и сайт не в «рекламе разрешено»
  activeFor(url) { return this.enabled && /^https?:/i.test(url || '') && !(this.allow.size && this.allow.has(this.hostOf(url))); }

  hookIpc() {
    if (this.ipcHooked) return;
    this.ipcHooked = true;
    const { ipcMain } = require('electron');
    for (const ch of [IPC_INJECT, IPC_MO]) { try { ipcMain.removeHandler(ch); } catch {} }
    // косметика (CSS-скрытие) — как в Ghostery, но с учётом выключателя и сайтов-исключений (раньше CSS вставлялся и там).
    // Скриптлеты отсюда не внедряем: их раньше и синхронно вставляет webview-preload.js (см. scriptsFor)
    ipcMain.handle(IPC_INJECT, (e, url, msg) => {
      const b = this.blocker;
      if (!b || !this.activeFor(url)) return;
      const { hostname, domain } = this.parseUrl(url);
      const first = msg === undefined;
      const { active, styles } = b.getCosmeticsFilters({
        url, hostname, domain, classes: msg?.classes, hrefs: msg?.hrefs, ids: msg?.ids,
        getBaseRules: first, getInjectionRules: false, getExtendedRules: false, getRulesFromHostname: first, getRulesFromDOM: !first,
        callerContext: { frameId: e.frameId, processId: e.processId, lifecycle: msg?.lifecycle },
      });
      if (active !== false && styles.length) e.sender.insertCSS(styles, { cssOrigin: 'user' }).catch(() => {});
    });
    ipcMain.handle(IPC_MO, () => !!(this.blocker && this.blocker.config.enableMutationObserver));
  }

  // Скриптлеты (json-prune, set-constant…) должны встать ДО скриптов страницы: YouTube кладёт данные плеера с рекламой
  // прямо в HTML. Асинхронный путь Ghostery (запрос → ответ → executeJavaScript) успевал уже после них.
  // Поэтому webview-preload.js спрашивает синхронно и вставляет сам. Слушатель — с самого старта, до загрузки движка,
  // и ответ — всегда: на синхронный вопрос без ответа страница ждала бы вечно
  hookScripts() {
    try {
      require('electron').ipcMain.on('adblock:scripts', (e, url) => {
        let out = [];
        try { out = this.scriptsFor(url); } catch (err) { console.warn('adblock scripts', err.message); }
        e.returnValue = out;
      });
    } catch (e) { console.warn('adblock scripts hook', e.message); }
  }

  parseUrl(url) {
    try { const r = require('@ghostery/adblocker-electron').Request.fromRawDetails({ url }); return { hostname: r.hostname || '', domain: r.domain || '' }; }
    catch { return { hostname: this.hostOf(url), domain: '' }; }
  }

  // скрипты для верхнего фрейма страницы url: [] — если скриптлеты выключены, сайт в исключениях или правил нет
  scriptsFor(url) {
    const b = this.blocker;
    if (!b || !this.scripts || !this.activeFor(url)) return [];
    const { hostname, domain } = this.parseUrl(url);
    if (!hostname) return [];
    const { active, scripts } = b.getCosmeticsFilters({ url, hostname, domain, getBaseRules: false, getInjectionRules: true, getExtendedRules: false, getRulesFromHostname: true, getRulesFromDOM: false });
    if (active === false || !scripts.length) return [];
    this.injected = (this.injected || 0) + 1;
    return scripts;
  }

  scriptletCount() { try { return ((this.blocker && this.blocker.resources && this.blocker.resources.scriptlets) || []).length; } catch { return 0; } }
  logScripts(when) {
    const n = this.scriptletCount();
    console.info(n ? `[adblock] скриптлетов доступно: ${n} (${when})${this.scripts ? '' : ' — выключены в настройках'}`
      : `[adblock] скриптлеты пока недоступны (${when}): ресурсы uBlock ещё не загружены — реклама внутри YouTube и др. не вырезается`);
  }
  // для настроек: строка под выключателем (автоматическое ограничение — не молча)
  scriptsInfo() {
    if (!this.blocker) return 'Блокировщик ещё загружается';
    const n = this.scriptletCount();
    return n ? `Доступно скриптлетов: ${n}` : 'Пока недоступно: не скачались ресурсы uBlock — повторю через полчаса';
  }

  // автотест: свои правила (например, 127.0.0.1##+js(json-prune, …)) поверх списков
  // без новых строк — все прежние (в только что собранный движок)
  addTestRules(lines) {
    if (lines.length) this.testRules = [...(this.testRules || []), ...lines];
    const b = this.blocker;
    if (!b) return 0;
    const { CosmeticFilter, NetworkFilter } = require('@ghostery/adblocker-electron');
    const cos = [], netf = [];
    for (const l of lines.length ? lines : this.testRules || []) { const isCos = l.includes('#'); const f = isCos ? CosmeticFilter.parse(l) : NetworkFilter.parse(l); if (f) (isCos ? cos : netf).push(f); }
    b.update({ newCosmeticFilters: cos, newNetworkFilters: netf });
    return cos.length + netf.length;
  }

  resetCount(id) { this.counts.set(id, 0); this.onCount(id, 0); }
}

// скрипт-предзагрузка Ghostery (просит косметику по IPC_INJECT); пакет — зависимость @ghostery/adblocker-electron
function preloadPath() {
  try { return require.resolve('@ghostery/adblocker-electron-preload', { paths: [path.dirname(require.resolve('@ghostery/adblocker-electron'))] }); }
  catch (e) { console.warn('adblock preload path', e.message); return null; }
}

module.exports = { AdBlock, RESOURCES };
