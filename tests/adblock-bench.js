// Замер блокировщика рекламы вне Electron: Ghostery (нынешний) против adblock-rust (Brave), на тех же списках, что качает Liquid.
// node tests/adblock-bench.js --requests <requests.json> [--rust <папка adblock-rs>] [--resources <brave-resources.json>] [--lists <папка>]
// requests.json — набор настоящих запросов страниц (из репозитория brave/adblock-rust: data/requests.json, строка = JSON).
// Каждый движок меряется в отдельном процессе (node --expose-gc), чтобы память одного не мешала другому.
// Выход: строки JSON (по одной на замер) — их показывает CI.
const fs = require('fs'); const path = require('path'); const os = require('os');
const { execFileSync } = require('child_process');

// скачивание — через curl: встроенный fetch Node 22 падал на подряд идущих загрузках (assert в undici)
const get = (u, f) => { execFileSync('curl', ['-sSfL', '--retry', '3', '-o', f, u]); return fs.readFileSync(f, 'utf8'); };
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const N = +arg('--n', 50000); // запросов для замера проверки

// ---------------- дочерний процесс: загрузка движка и проверка запросов ----------------
if (process.argv[2] === '--child') {
  const [, , , kind, engineFile, corpusFile, rustDir, resFile] = process.argv;
  const mem = () => { global.gc(); global.gc(); const m = process.memoryUsage(); return { rss: m.rss, heapUsed: m.heapUsed, external: m.external + m.arrayBuffers }; };
  const mb = (x) => Math.round(x / 1048576 * 10) / 10;
  const m0 = mem();
  let lib;
  const ghost = kind.startsWith('ghostery');
  if (ghost) lib = require('@ghostery/adblocker');
  else if (kind === 'rust') lib = require(rustDir);
  const m1 = mem();
  const buf = fs.readFileSync(engineFile);
  const t0 = process.hrtime.bigint();
  let engine;
  if (ghost) engine = lib.FiltersEngine.deserialize(new Uint8Array(buf));
  else { engine = new lib.Engine(new lib.FilterSet(false)); engine.deserialize(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    // ресурсы ($redirect и скриптлеты) в движок adblock-rust не сериализуются — их надо загружать на каждом запуске
    if (resFile) engine.useResources(JSON.parse(fs.readFileSync(resFile, 'utf8'))); }
  const loadMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const m2 = mem();
  // запросы: без самих страниц (Liquid их не проверяет — mainFrame пропускается)
  const reqs = JSON.parse(fs.readFileSync(corpusFile, 'utf8'));
  const times = new Float64Array(reqs.length); let blocked = 0, redirects = 0;
  const firstPassStart = process.hrtime.bigint();
  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i]; const a = process.hrtime.bigint();
    if (ghost) {
      // как ElectronBlocker: разбор адреса (tldts) + сопоставление
      const req = lib.Request.fromRawDetails({ url: r.url, sourceUrl: r.frameUrl, type: r.cpt });
      const res = engine.match(req);
      if (res.match) blocked++; if (res.redirect) redirects++;
    } else {
      const res = engine.check(r.url, r.frameUrl, r.cpt, '', true);
      if (res.should_block) blocked++; if (res.redirect) redirects++;
    }
    times[i] = Number(process.hrtime.bigint() - a) / 1e6;
  }
  const totalMs = Number(process.hrtime.bigint() - firstPassStart) / 1e6;
  const sorted = Float64Array.from(times).sort();
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  // косметика: правила для страницы (то, что блокировщик отдаёт в каждую загружаемую страницу)
  const pages = [...new Set(reqs.map((r) => r.frameUrl))].slice(0, 2000);
  const ct = [];
  for (const u of pages) {
    const a = process.hrtime.bigint();
    if (ghost) {
      const { hostname, domain } = require('tldts-experimental').parse(u);
      engine.getCosmeticsFilters({ url: u, hostname: hostname || '', domain: domain || '', getBaseRules: true, getInjectionRules: true, getExtendedRules: true, getRulesFromHostname: true, getRulesFromDOM: false });
    } else engine.urlCosmeticResources(u);
    ct.push(Number(process.hrtime.bigint() - a) / 1e6);
  }
  ct.sort((x, y) => x - y);
  // что получает страница YouTube / Twitch: CSS-скрытие и скрипты (скриптлеты json-prune и т.п. — главное против рекламы в роликах)
  const site = {};
  for (const u of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.twitch.tv/directory', 'https://dzen.ru/']) {
    const h = new URL(u).hostname.replace(/^www\./, '');
    if (ghost) {
      const { hostname, domain } = require('tldts-experimental').parse(u);
      const r = engine.getCosmeticsFilters({ url: u, hostname, domain, getBaseRules: false, getInjectionRules: true, getExtendedRules: true, getRulesFromHostname: true, getRulesFromDOM: false });
      site[h] = { css: r.styles.length, scripts: r.scripts.length, scriptKb: Math.round(r.scripts.join('').length / 1024) };
    } else {
      const r = engine.urlCosmeticResources(u);
      site[h] = { hide: r.hide_selectors.length, procedural: (r.procedural_actions || []).length, scriptKb: Math.round((r.injected_script || '').length / 1024) };
    }
  }
  const m3 = mem();
  console.log(JSON.stringify({
    kind, engineMb: mb(buf.length), loadMs: Math.round(loadMs * 10) / 10,
    libRssMb: mb(m1.rss - m0.rss), engineRssMb: mb(m2.rss - m1.rss), engineHeapMb: mb(m2.heapUsed - m1.heapUsed), engineExternalMb: mb(m2.external - m1.external),
    afterMatchRssMb: mb(m3.rss - m0.rss), afterMatchHeapMb: mb(m3.heapUsed - m0.heapUsed),
    requests: reqs.length, blocked, redirects,
    matchMedianMs: +q(0.5).toFixed(4), matchP99Ms: +q(0.99).toFixed(4), matchMaxMs: +sorted[sorted.length - 1].toFixed(2), matchTotalMs: Math.round(totalMs),
    site, cosmeticPages: ct.length, cosmeticMedianMs: +ct[Math.floor(ct.length / 2)].toFixed(3), cosmeticP99Ms: +ct[Math.floor(ct.length * 0.99)].toFixed(3),
  }));
  process.exit(0);
}

// ---------------- основной процесс: списки, сборка движков, запуск замеров ----------------
(async () => {
  const listsDir = arg('--lists', path.join(os.tmpdir(), 'liquid-adblock-lists'));
  fs.mkdirSync(listsDir, { recursive: true });
  const lib = require('@ghostery/adblocker');
  // те же списки, что в main/adblock.js
  const urls = [...(lib.adsAndTrackingLists || lib.fullLists), 'https://filters.adtidy.org/extension/ublock/filters/1.txt'];
  const texts = [];
  for (const u of urls) {
    const f = path.join(listsDir, u.replace(/[^a-z0-9.-]+/gi, '_').slice(-150));
    let t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    if (!t) t = get(u, f);
    texts.push(t);
  }
  const text = texts.join('\n');
  const rules = text.split('\n').filter((l) => l && !l.startsWith('!')).length;
  console.log(JSON.stringify({ step: 'списки', lists: urls.length, rules, mb: Math.round(text.length / 1048576 * 10) / 10 }));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-'));
  // Ghostery: как adblock-build.js
  let t = Date.now();
  const g = lib.FiltersEngine.parse(text, { enableCompression: true, loadCosmeticFilters: true, loadNetworkFilters: true, integrityCheck: false });
  const gBuf = g.serialize();
  fs.writeFileSync(path.join(work, 'ghostery.bin'), gBuf);
  console.log(JSON.stringify({ step: 'сборка', kind: 'ghostery', ms: Date.now() - t, mb: Math.round(gBuf.length / 1048576 * 10) / 10 }));

  // то же, но с ресурсами uBlock (скриптлеты и $redirect) — Liquid их сейчас не загружает
  try {
    const PREFIX = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets';
    const res = get(PREFIX + '/ublock-origin/resources.json', path.join(listsDir, 'ghostery-resources.json'));
    t = Date.now();
    g.updateResources(res, 'bench');
    const b2 = g.serialize(); fs.writeFileSync(path.join(work, 'ghostery-res.bin'), b2);
    console.log(JSON.stringify({ step: 'сборка', kind: 'ghostery-res', ms: Date.now() - t, mb: Math.round(b2.length / 1048576 * 10) / 10, resourcesKb: Math.round(res.length / 1024) }));
  } catch (e) { console.log(JSON.stringify({ step: 'ресурсы ghostery', error: e.message })); }

  const rustDir = arg('--rust');
  if (rustDir) {
    const rs = require(path.resolve(rustDir));
    t = Date.now();
    const fset = new rs.FilterSet(false);
    fset.addFilters(text);
    const e = new rs.Engine(fset);
    const res = arg('--resources');
    if (res) e.useResources(JSON.parse(fs.readFileSync(res, 'utf8')));
    const rBuf = Buffer.from(e.serialize());
    fs.writeFileSync(path.join(work, 'rust.bin'), rBuf);
    console.log(JSON.stringify({ step: 'сборка', kind: 'rust', ms: Date.now() - t, mb: Math.round(rBuf.length / 1048576 * 10) / 10 }));
  }

  // запросы: первые N (без страниц)
  const corpus = [];
  const lines = fs.readFileSync(arg('--requests'), 'utf8').split('\n');
  for (const l of lines) { if (corpus.length >= N) break; if (!l) continue; try { const r = JSON.parse(l); if (r.cpt !== 'document' && /^https?:/.test(r.url) && /^https?:/.test(r.frameUrl)) corpus.push(r); } catch {} }
  const cf = path.join(work, 'corpus.json'); fs.writeFileSync(cf, JSON.stringify(corpus));

  const run = (kind) => {
    const out = execFileSync(process.execPath, ['--expose-gc', __filename, '--child', kind, path.join(work, kind + '.bin'), cf, rustDir ? path.resolve(rustDir) : '', arg('--resources') ? path.resolve(arg('--resources')) : ''], { encoding: 'utf8', maxBuffer: 1 << 26 });
    return out.trim().split('\n').pop();
  };
  // по 3 прогона — берём средний по медиане проверки
  for (const kind of ['ghostery', ...(fs.existsSync(path.join(work, 'ghostery-res.bin')) ? ['ghostery-res'] : []), ...(rustDir ? ['rust'] : [])]) {
    const rs = [run(kind), run(kind), run(kind)].map((s) => JSON.parse(s));
    rs.sort((a, b) => a.matchMedianMs - b.matchMedianMs);
    console.log(JSON.stringify(rs[1]));
  }
})().catch((e) => { console.error(e); process.exit(1); });
