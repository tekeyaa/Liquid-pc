// Замеры скорости Liquid (не проверка — только цифры). Результат — в test-results/perf.json, его печатает шаг в GitHub.
const { test, expect, _electron: electron, chromium } = require('@playwright/test');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..'), SITE = path.join(__dirname, 'site');
const PX = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
let app, win, server, base;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/px') { res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' }); res.end(PX); return; }
    if (p === '/js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end('window.__n=(window.__n||0)+1;'); return; }
    const f = path.join(SITE, p); if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': f.endsWith('.webm') ? 'video/webm' : 'text/html; charset=utf-8' }); res.end(fs.readFileSync(f)); // как обычный сайт: без запрета кэша
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok)); base = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(ROOT, 'test-results', 'perfdata-'));
  app = await electron.launch({ args: [ROOT], env: { ...process.env, LIQUID_TEST: '1', LIQUID_USER_DATA: dataDir } });
  win = await app.firstWindow(); await win.waitForLoadState('domcontentloaded');
  await expect.poll(() => win.evaluate(() => tabs.length), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
});
test.afterAll(async () => { await app?.close().catch(() => {}); server?.closeAllConnections?.(); server?.close(); });
const inTab = async (js) => { const id = await win.evaluate(() => active.wv.getWebContentsId()); return app.evaluate(({ webContents }, [i, c]) => webContents.fromId(i).executeJavaScript(c), [id, js]); };
const url = () => win.evaluate(() => active.wv.getURL());
// опыты «без части работы» (переменные окружения только для замеров): обычные замеры памяти и плавности в них не нужны
const EXP = !!(process.env.LIQUID_PERF_AB || process.env.LIQUID_PERF_NOADBLOCK || process.env.LIQUID_PERF_NOHOOKS || process.env.LIQUID_PERF_NOSEND || process.env.LIQUID_PERF_NOUI || process.env.LIQUID_PERF_NOBAR);
// что делает окно во время загрузки вкладки: NOUI — окно не обновляет вкладку, историю, сессию, проверку сайта и полоску;
// NOBAR — только без анимаций загрузки (полоска и кружок на вкладке)
const expUi = () => win.evaluate(([noUi, noBar]) => {
  if (noBar || noUi === '1') document.head.insertAdjacentHTML('beforeend', '<style>#progress,.tab .spin{display:none!important;animation:none!important}</style>');
  // NOUI=dom — только вид вкладки и панели, guard — только проверка сайта, store — только история и сессия
  const groups = { dom: ['updateTab', 'syncChrome', 'syncOmniExtras'], guard: ['guardScan'], store: ['saveSession', 'historyAdd', 'historyTitle'] };
  if (noUi) for (const f of groups[noUi] || [].concat(...Object.values(groups))) window[f] = () => {};
}, [process.env.LIQUID_PERF_NOUI || '', !!process.env.LIQUID_PERF_NOBAR]);
// эталон: та же страница в обычном Chromium на той же машине
test('эталон: Chromium', async () => {
  test.skip(!process.env.LIQUID_PERF_CHROMIUM, 'эталон только по запросу');
  const b = await chromium.launch();
  const pg = await b.newPage();
  const loads = [];
  for (let k = 0; k < 6; k++) {
    await pg.goto(`${base}/heavy.html?k=${k}`, { waitUntil: 'load' });
    loads.push(await pg.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return Math.round(n.loadEventEnd - n.startTime); }));
  }
  await b.close();
  const s = loads.slice(1).sort((x, y) => x - y);
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
  fs.appendFileSync(path.join(ROOT, 'test-results', 'perf.json'), JSON.stringify({ mode: 'Chromium (эталон)', loadMedianMs: s[Math.floor(s.length / 2)], loads }) + '\n');
});

// Память: сколько занимает Liquid целиком и по типам процессов (МБ) — пустая вкладка; 5 сайтов; те же 5, из них 4 спят.
// Первым тестом — пока браузер свежий. workingSet — «Память» в диспетчере задач, private — только своя (без общих библиотек)
test('память', async () => {
  test.skip(!!process.env.LIQUID_PERF_CHROMIUM || EXP, 'один раз');
  test.setTimeout(240_000);
  const snap = async (name) => {
    await win.waitForTimeout(4000); // страницы догрузились, процессы успокоились
    const m = await app.evaluate(({ app, webContents }) => {
      const urlOf = new Map();
      for (const w of webContents.getAllWebContents()) { try { if (w.getType() === 'webview') urlOf.set(w.getOSProcessId(), w.getURL()); } catch {} }
      return { metrics: app.getAppMetrics().map((x) => ({ pid: x.pid, type: x.type, name: x.name || x.serviceName || '', ws: x.memory?.workingSetSize || 0, priv: x.memory?.privateBytes || 0, url: urlOf.get(x.pid) || '' })), main: process.memoryUsage() };
    });
    const MB = (kb) => Math.round(kb / 1024);
    const by = {};
    for (const x of m.metrics) {
      const k = x.type === 'Tab' ? (x.url ? 'Tab' : 'Tab (окно и служебные)') : x.type;
      by[k] = by[k] || { n: 0, ws: 0, priv: 0 }; by[k].n++; by[k].ws += x.ws; by[k].priv += x.priv;
    }
    for (const k in by) { by[k].ws = MB(by[k].ws); by[k].priv = MB(by[k].priv); }
    const tabsMb = m.metrics.filter((x) => x.url).map((x) => `${(x.url.split('/').pop() || x.url).slice(0, 24)}:${MB(x.ws)}`);
    return { name, totalWs: MB(m.metrics.reduce((a, x) => a + x.ws, 0)), totalPriv: MB(m.metrics.reduce((a, x) => a + x.priv, 0)), procs: m.metrics.length, by, tabs: tabsMb,
      main: { rss: Math.round(m.main.rss / 1048576), heapUsed: Math.round(m.main.heapUsed / 1048576) } };
  };
  const out = [];
  out.push(await snap('пустая вкладка'));
  const pages = ['article.html', 'heavy.html', 'form.html', 'fakeyt.html', 'video.html'];
  await win.evaluate((u) => navigate(u), `${base}/${pages[0]}`);
  for (const p of pages.slice(1)) await win.evaluate((u) => createTab(u), `${base}/${p}`);
  await expect.poll(() => win.evaluate(() => tabs.length === 5 && tabs.every((t) => t.wv && !t.loading)), { timeout: 60_000 }).toBe(true);
  out.push(await snap('5 сайтов'));
  const slept = await win.evaluate(() => tabs.filter((t) => t !== active).map((t) => sleepTab(t)).filter(Boolean).length);
  const s3 = await snap(`5 сайтов, ${slept} спят`);
  out.push(s3);
  s3.freedWs = out[1].totalWs - s3.totalWs; s3.freedPriv = out[1].totalPriv - s3.totalPriv; // сколько освободил сон
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
  for (const o of out) fs.appendFileSync(path.join(ROOT, 'test-results', 'perf.json'), JSON.stringify({ mode: 'память (МБ)', ...o }) + '\n');
  // обратно к одной вкладке — для следующих замеров
  await win.evaluate(() => { for (const t of tabs.slice(1)) closeTab(t); activate(tabs[0]); });
});

// новая вкладка с сайтом: от нажатия до загрузки — с заготовленной вкладкой и без неё
test('новые вкладки', async () => {
  test.skip(!!process.env.LIQUID_PERF_CHROMIUM || EXP, 'один раз');
  test.setTimeout(240_000);
  const open = (u) => win.evaluate((x) => new Promise((done) => {
    const t0 = performance.now(), t = createTab(x);
    t.wv.addEventListener('did-finish-load', () => { const ms = Math.round(performance.now() - t0); closeTab(t); done(ms); }, { once: true });
  }), u);
  const res = {};
  for (const mode of ['с заготовкой', 'без заготовки']) {
    if (mode === 'без заготовки') await win.evaluate(() => { localStorage.setItem('liquid.noSpare', '1'); });
    const ms = [];
    for (let k = 0; k < 7; k++) {
      if (mode === 'с заготовкой') await expect.poll(() => win.evaluate(() => window.spareReady()), { timeout: 15_000 }).toBe(true);
      else await win.waitForTimeout(1500);
      ms.push(await open(`${base}/article.html?n=${k}`));
    }
    const s = ms.slice(1).sort((a, b) => a - b);
    res[mode] = { median: s[Math.floor(s.length / 2)], all: ms };
  }
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
  fs.appendFileSync(path.join(ROOT, 'test-results', 'perf.json'), JSON.stringify({ mode: 'новая вкладка', ...res }) + '\n');
});

test('замеры', async () => {
  test.skip(!!process.env.LIQUID_PERF_CHROMIUM || !!process.env.LIQUID_PERF_AB, 'только эталон');
  test.setTimeout(240_000);
  const out = { loads: [], backs: [] };
  await expUi();
  // профиль окна и основного процесса во время загрузок (LIQUID_PROFILE): кто из них занят, пока грузится вкладка
  let cdp = null;
  const prof = process.env.LIQUID_PROFILE && !EXP ? path.join(ROOT, process.env.LIQUID_PROFILE) : '';
  let profPage = 0;
  if (prof) {
    try { cdp = await win.context().newCDPSession(win); await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); } catch { cdp = null; }
    await app.evaluate(() => global.__lqStartProfile && global.__lqStartProfile());
    // и сама вкладка: сколько в ней занимает наш preload, пока грузится страница
    const id = await win.evaluate(() => active.wv.getWebContentsId());
    await app.evaluate(async ({ webContents }, i) => { const d = webContents.fromId(i).debugger; if (!d.isAttached()) d.attach('1.3'); await d.sendCommand('Profiler.enable'); await d.sendCommand('Profiler.setSamplingInterval', { interval: 250 }); await d.sendCommand('Profiler.start'); }, id).catch(() => {});
    profPage = id;
  }
  for (let k = 0; k < 6; k++) {
    await win.evaluate((u) => navigate(u), `${base}/heavy.html?k=${k}`);
    await expect.poll(async () => (await url()).includes(`k=${k}`) && (await inTab('document.readyState')) === 'complete', { timeout: 30_000 }).toBe(true);
    const nav = await inTab(`(() => { const n = performance.getEntriesByType('navigation')[0]; return Math.round(n.loadEventEnd - n.startTime); })()`);
    out.loads.push(nav);
    await win.evaluate((u) => navigate(u), `${base}/article.html`);
    await expect.poll(async () => (await url()).includes('article') && (await inTab('document.readyState')) === 'complete', { timeout: 30_000 }).toBe(true);
    const t0 = Date.now();
    await win.evaluate(() => active.wv.goBack());
    await expect.poll(async () => (await url()).includes(`k=${k}`) && (await inTab('document.readyState')) === 'complete', { timeout: 30_000, intervals: [20] }).toBe(true);
    out.backs.push({ ms: Date.now() - t0, bf: await inTab('!!window.__bf'), why: await inTab(`(() => { try { const r = performance.getEntriesByType('navigation')[0].notRestoredReasons; return r ? JSON.stringify((r.reasons || []).map((x) => x.reason)).slice(0, 200) : ''; } catch { return ''; } })()`) });
  }
  if (prof) {
    try { if (cdp) { const { profile } = await cdp.send('Profiler.stop'); fs.mkdirSync(prof, { recursive: true }); fs.writeFileSync(path.join(prof, `perfui-${Date.now()}.cpuprofile`), JSON.stringify(profile)); } } catch {}
    try { await app.evaluate((_e, d) => global.__lqSaveProfile && global.__lqSaveProfile(d, 'perfmain'), prof); } catch {}
    try {
      const p = await app.evaluate(async ({ webContents }, i) => { const d = webContents.fromId(i).debugger; const { profile } = await d.sendCommand('Profiler.stop'); d.detach(); return JSON.stringify(profile); }, profPage);
      fs.writeFileSync(path.join(prof, `perfpage-${Date.now()}.cpuprofile`), p);
    } catch (e) { console.log('профиль вкладки: ' + e.message); }
    await win.waitForTimeout(1500);
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const r = { mode: process.env.LIQUID_PERF_NOUI ? `окно не обновляет вкладку: ${process.env.LIQUID_PERF_NOUI} (опыт)` : process.env.LIQUID_PERF_NOBAR ? 'без анимации загрузки (опыт)' : process.env.LIQUID_PERF_NOSEND ? 'без подмены заголовков (опыт)' : process.env.LIQUID_PERF_NOPRELOAD ? 'голый webview (без перехватов и preload)' : process.env.LIQUID_PERF_NOHOOKS ? 'без перехватов запросов' : process.env.LIQUID_PERF_NOADBLOCK ? 'без блокировщика' : 'обычный', why: out.backs.map((b) => b.why).filter(Boolean)[0] || '', version: require(path.join(ROOT, 'package.json')).version, loadMedianMs: med(out.loads.slice(1)), backMedianMs: med(out.backs.slice(1).map((b) => b.ms)), backFromCache: out.backs.filter((b) => b.bf).length + '/' + out.backs.length, loads: out.loads, backs: out.backs.map((b) => b.ms) };
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true }); fs.appendFileSync(path.join(ROOT, 'test-results', 'perf.json'), JSON.stringify(r) + '\n');
  console.log('PERF', JSON.stringify(r));
});

// Опыт (LIQUID_PERF_AB=1): что в окне мешает загрузке. Режимы чередуются в ОДНОМ запуске браузера (между запусками
// разброс серверов ±40 мс больше самого эффекта): обычный, окно не трогает вкладку, только без полоски/кружка, только без DOM
test('опыты: окно во время загрузки', async () => {
  test.skip(!process.env.LIQUID_PERF_AB, 'только по запросу');
  test.setTimeout(400_000);
  // CI 42940172896: без updateTab −80…−100, без syncChrome −60…−85, без syncOmniExtras −40, без классов загрузки −25.
  // Делим syncChrome: адрес / классы body / только вкладка; и пробуем изоляцию панелей (contain + свой слой)
  // v4 (после правки: признак загрузки на #bar, кружок и «стоп» без смены раскладки, выделение без пустых записей):
  // если окно больше не мешает — «обычный» ≈ «без updateTab»
  // CI 42942841332 (после правки): обычный 818/790, без syncChrome 751/682, без updateTab 709/638 — разрыв остался.
  // v5: по одному источнику перерисовки окна: выделение вкладки, полоса загрузки, кружок, заголовок вкладки
  // CI 42943853120 (v5): по отдельности ничего (выделение −7, полоса +30, кружок 0, заголовок +6), без updateTab −50…−63:
  // всё делается в одном кадре, дорог сам кадр окна. v6: адрес и заголовок не чаще раза в 100 мс (queueTab) против «как раньше»
  // CI 42944874723 (v6): обычный 755/759, как раньше 747/758 (≈0 — число кадров не главное), без updateTab 663/652.
  const MODES = ['обычный', 'без updateTab'];
  await win.evaluate(() => {
    window.__orig = {}; for (const f of ['updateTab', 'saveSession', 'guardScan', 'historyAdd', 'historyTitle', 'syncChrome', 'syncOmniExtras']) window.__orig[f] = window[f];
    const st = document.createElement('style'); st.id = 'abIso'; st.textContent = ''; st.disabled = true; document.head.appendChild(st);
    // копия syncChrome с выключателями частей
    window.__sc = (noUrl, noBody) => function () {
      if (!active) return;
      const { url, loading } = active;
      const urlInput = $('#url');
      if (!noUrl && document.activeElement !== urlInput) setProp(urlInput, 'value', isInternal(url) ? '' : decodeURI(url));
      $('#omni').classList.toggle('https', url.startsWith('https://'));
      renderGuard(active);
      if (!noBody) document.body.classList.toggle('loading', loading && !isInternal(url));
      setProp($('#back'), 'disabled', !active.canBack);
      setProp($('#fwd'), 'disabled', !active.canFwd);
      window.syncOmniExtras && window.syncOmniExtras(active);
    };
    // что именно меняется в окне за одну загрузку (по первому кругу «обычного»)
    window.__muts = []; window.__gl = []; window.__t0 = 0;
    // где активная вкладка и полоса вкладок на каждом кадре загрузки — двигается ли выделение по делу
    window.__geo = new Set();
    const geo = () => { if (window.__rec) { const e = active.el, b = document.getElementById('tabs'); window.__geo.add([e.offsetLeft, e.offsetTop, e.offsetWidth, e.offsetHeight, b.offsetWidth, b.offsetHeight].join(',')); } requestAnimationFrame(geo); };
    requestAnimationFrame(geo);
    new MutationObserver((ms) => { if (!window.__rec) return; for (const m of ms) { const t = m.target.nodeType === 1 ? m.target : m.target.parentElement; window.__muts.push(`${m.type}:${t?.id || t?.className?.toString().slice(0, 20) || t?.tagName}${m.attributeName ? '@' + m.attributeName : ''}`);
      if (t?.classList?.contains('glider') && window.__gl.length < 12) window.__gl.push(Math.round(performance.now() - window.__t0) + ' ' + t.getAttribute('style')); } })
      .observe(document.documentElement, { subtree: true, attributes: true, childList: true, characterData: true });
  });
  const setMode = (m) => win.evaluate((m) => {
    for (const f of Object.keys(window.__orig)) window[f] = window.__orig[f];
    const css = { 'без выделения': '.tab-glider{display:none!important}', 'без полосы': '#progress{display:none!important}', 'без кружка': '.tab .spin{display:none!important}' };
    const st = document.getElementById('abIso'); st.textContent = css[m] || ''; st.disabled = !css[m];
    if (m === 'без updateTab') window.updateTab = () => {};
    // заголовок вкладки не меняется во время загрузки (остальное — как обычно)
    if (m === 'без заголовка') window.updateTab = (t) => { const ti = t.title; t.title = t.el.querySelector('.title').textContent; try { window.__orig.updateTab(t); } finally { t.title = ti; } };
  }, m);
  const res = Object.fromEntries(MODES.map((m) => [m, []])); const out0 = {};
  for (let r = 0; r < 9; r++) {
    for (const m of r % 2 ? [...MODES].reverse() : MODES) {
      await setMode(m);
      const k = `${r}-${m.length}`;
      await win.evaluate((u) => navigate(u), `${base}/article.html?ab=${k}`);
      await expect.poll(async () => (await url()).includes(`ab=${k}`) && (await inTab('document.readyState')) === 'complete', { timeout: 30_000 }).toBe(true);
      await win.waitForTimeout(300);
      if (r === 1 && m === 'обычный') await win.evaluate(() => { window.__rec = true; window.__t0 = performance.now(); });
      await win.evaluate((u) => navigate(u), `${base}/heavy.html?ab=${k}`);
      await expect.poll(async () => (await url()).includes(`heavy.html?ab=${k}`) && (await inTab('document.readyState')) === 'complete', { timeout: 30_000 }).toBe(true);
      const ms = await inTab(`(() => { const n = performance.getEntriesByType('navigation')[0]; return Math.round(n.loadEventEnd - n.startTime); })()`);
      if (r) res[m].push(ms); // первый круг — разогрев
      if (r === 1 && m === 'обычный') Object.assign(out0, await win.evaluate(() => { window.__rec = false; const c = {}; for (const x of window.__muts) c[x] = (c[x] || 0) + 1; return { muts: c, glider: window.__gl, geo: [...window.__geo].slice(0, 12) }; }));
      await win.waitForTimeout(300);
    }
  }
  // v7: трасса Chromium (все процессы) на 4 загрузках heavy в каждом режиме — кто занят: окно, вкладка, основной, GPU
  const pids = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => ({ t: w.getType(), u: w.getURL().slice(0, 40), pid: w.getOSProcessId() })));
  for (const m of ['обычный', 'без updateTab', 'без updateTab', 'обычный']) {
    await setMode(m);
    await app.evaluate(({ contentTracing }) => contentTracing.startRecording({ included_categories: ['toplevel', 'viz', 'gpu', 'cc', 'blink', 'ipc', 'mojom', 'disabled-by-default-devtools.timeline'], trace_buffer_size_in_kb: 300000 }));
    for (let r = 0; r < 4; r++) {
      const k = `tr${m.length}-${r}-${Date.now()}`;
      await win.evaluate((u) => navigate(u), `${base}/article.html?ab=${k}`);
      await expect.poll(async () => (await url()).includes(`ab=${k}`) && (await inTab('document.readyState')) === 'complete', { timeout: 30_000 }).toBe(true);
      await win.waitForTimeout(300);
      await win.evaluate((u) => navigate(u), `${base}/heavy.html?ab=${k}`);
      await expect.poll(async () => (await url()).includes(`heavy.html?ab=${k}`) && (await inTab('document.readyState')) === 'complete', { timeout: 30_000 }).toBe(true);
      await win.waitForTimeout(300);
    }
    // трасса в формате perfetto (proto) — разбирает tests/trace_sum.py в шаге workflow
    const dir = path.join(ROOT, 'perftrace'); fs.mkdirSync(dir, { recursive: true });
    const n = fs.readdirSync(dir).length;
    await app.evaluate(({ contentTracing }, f) => contentTracing.stopRecording(f), path.join(dir, `${n}-${m === 'обычный' ? 'normal' : 'noupd'}.pftrace`));
    fs.writeFileSync(path.join(dir, `${n}-pids.json`), JSON.stringify(pids));
  }
  await setMode('обычный');
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const out = { mode: 'опыт: окно во время загрузки (один запуск, чередование)', ...out0 };
  for (const m of MODES) out[m] = { median: med(res[m]), all: res[m] };
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
  fs.appendFileSync(path.join(ROOT, 'test-results', 'perf.json'), JSON.stringify(out) + '\n');
});

// Плавность интерфейса: длительность кадров, пока идут анимации (меню, вкладки, панель Claude, настройки).
// У серверов GitHub нет видеокарты — всё рисует процессор, поэтому цифры хуже, чем дома, но «до/после» сравнимы
test('плавность', async () => {
  test.skip(!!process.env.LIQUID_PERF_CHROMIUM || EXP, 'один раз');
  test.setTimeout(240_000);
  await win.evaluate((u) => navigate(u), `${base}/article.html`);
  await win.waitForTimeout(1500);
  const run = (name) => win.evaluate(async (name) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const frames = []; let on = true, last = performance.now();
    const tick = (t) => { frames.push(t - last); last = t; if (on) requestAnimationFrame(tick); };
    requestAnimationFrame((t) => { last = t; requestAnimationFrame(tick); });
    await sleep(100);
    const steps = {
      'меню': async () => { for (let i = 0; i < 5; i++) { openPop('#menuPop'); await sleep(450); closePops(); await sleep(450); } },
      'новая вкладка': async () => { for (let i = 0; i < 5; i++) { createTab(); await sleep(550); closeTab(active); await sleep(550); } },
      'переключение вкладок': async () => { const a = active, b = createTab(); await sleep(800); for (let i = 0; i < 6; i++) { activate(i % 2 ? b : a); await sleep(400); } closeTab(b); activate(a); await sleep(400); },
      'панель Claude': async () => { for (let i = 0; i < 3; i++) { toggleSide(true); await sleep(650); toggleSide(false); await sleep(650); } },
      'настройки': async () => { for (let i = 0; i < 3; i++) { window.openSettings(); await sleep(600); closePops(); await sleep(500); } },
    };
    await steps[name]();
    on = false; await sleep(50);
    const s = frames.slice(1).sort((x, y) => x - y);
    const q = (k) => Math.round(s[Math.min(s.length - 1, Math.floor(s.length * k))] * 10) / 10;
    return { name, frames: s.length, p50: q(0.5), p95: q(0.95), max: Math.round(s[s.length - 1] || 0), jank: s.filter((x) => x > 34).length };
  }, name);
  const out = [];
  for (const n of ['меню', 'новая вкладка', 'переключение вкладок', 'панель Claude', 'настройки']) out.push(await run(n));
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
  fs.appendFileSync(path.join(ROOT, 'test-results', 'perf.json'), JSON.stringify({ mode: 'плавность (кадры, мс)', out }) + '\n');
});

