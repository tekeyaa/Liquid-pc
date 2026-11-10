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
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(f)); // как обычный сайт: без запрета кэша
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

// новая вкладка с сайтом: от нажатия до загрузки — с заготовленной вкладкой и без неё
test('новые вкладки', async () => {
  test.skip(!!process.env.LIQUID_PERF_CHROMIUM || !!process.env.LIQUID_PERF_NOADBLOCK || !!process.env.LIQUID_PERF_NOHOOKS || !!process.env.LIQUID_PERF_WCV, 'один раз');
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

// память процесса страницы (КБ): рабочий набор и личная память — из app.getAppMetrics()
const memOf = (wcId) => app.evaluate(({ app: a, webContents }, i) => {
  const pid = webContents.fromId(i).getOSProcessId();
  const m = a.getAppMetrics().find((x) => x.pid === pid);
  return m ? { ws: m.memory.workingSetSize, priv: m.memory.privateBytes || 0, type: m.type } : null;
}, wcId);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// Та же страница в WebContentsView из основного процесса (кандидат на замену <webview>): с нашим preload и без него
test('WebContentsView', async () => {
  test.skip(!process.env.LIQUID_PERF_WCV, 'только по запросу');
  test.setTimeout(240_000);
  const bare = process.env.LIQUID_PERF_WCV === 'bare';
  const id = await app.evaluate(({ BrowserWindow, WebContentsView }, bare) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.__liquid) || BrowserWindow.getAllWindows()[0];
    const v = new WebContentsView({ webPreferences: globalThis.__lqTabPrefs(bare) });
    w.contentView.addChildView(v);
    const [cw, ch] = w.getContentSize();
    v.setBounds({ x: 0, y: 90, width: cw, height: ch - 90 });
    globalThis.__pv = v;
    return v.webContents.id;
  }, bare);
  const inV = (js) => app.evaluate(({ webContents }, [i, c]) => webContents.fromId(i).executeJavaScript(c), [id, js]);
  const vUrl = () => app.evaluate(({ webContents }, i) => webContents.fromId(i).getURL(), id);
  const go = (u) => app.evaluate(({ webContents }, [i, x]) => { webContents.fromId(i).loadURL(x).catch(() => {}); }, [id, u]);
  const out = { loads: [], backs: [] };
  for (let k = 0; k < 6; k++) {
    await go(`${base}/heavy.html?k=${k}`);
    await expect.poll(async () => (await vUrl()).includes(`k=${k}`) && (await inV('document.readyState')) === 'complete', { timeout: 30_000 }).toBe(true);
    out.loads.push(await inV(`(() => { const n = performance.getEntriesByType('navigation')[0]; return Math.round(n.loadEventEnd - n.startTime); })()`));
    await go(`${base}/article.html`);
    await expect.poll(async () => (await vUrl()).includes('article') && (await inV('document.readyState')) === 'complete', { timeout: 30_000 }).toBe(true);
    const t0 = Date.now();
    await app.evaluate(({ webContents }, i) => webContents.fromId(i).navigationHistory.goBack(), id);
    await expect.poll(async () => (await vUrl()).includes(`k=${k}`) && (await inV('document.readyState')) === 'complete', { timeout: 30_000, intervals: [20] }).toBe(true);
    out.backs.push({ ms: Date.now() - t0, bf: await inV('!!window.__bf') });
  }
  await new Promise((r) => setTimeout(r, 1500));
  const mem = await memOf(id);
  const r = { mode: bare ? 'WebContentsView без preload (и без перехватов)' : 'WebContentsView (с preload, как вкладка)', loadMedianMs: med(out.loads.slice(1)), backMedianMs: med(out.backs.slice(1).map((b) => b.ms)), backFromCache: out.backs.filter((b) => b.bf).length + '/' + out.backs.length, memKB: mem, loads: out.loads, backs: out.backs.map((b) => b.ms) };
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true }); fs.appendFileSync(path.join(ROOT, 'test-results', 'perf.json'), JSON.stringify(r) + '\n');
  console.log('PERF', JSON.stringify(r));
});

test('замеры', async () => {
  test.skip(!!process.env.LIQUID_PERF_CHROMIUM || !!process.env.LIQUID_PERF_WCV, 'только эталон');
  test.setTimeout(240_000);
  const out = { loads: [], backs: [] };
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
  await new Promise((r) => setTimeout(r, 1500));
  const memKB = await memOf(await win.evaluate(() => active.wv.getWebContentsId()));
  const r = { memKB, mode: process.env.LIQUID_PERF_NOPRELOAD ? 'голый webview (без перехватов и preload)' : process.env.LIQUID_PERF_NOHOOKS ? 'без перехватов запросов' : process.env.LIQUID_PERF_NOADBLOCK ? 'без блокировщика' : 'обычный', why: out.backs.map((b) => b.why).filter(Boolean)[0] || '', version: require(path.join(ROOT, 'package.json')).version, loadMedianMs: med(out.loads.slice(1)), backMedianMs: med(out.backs.slice(1).map((b) => b.ms)), backFromCache: out.backs.filter((b) => b.bf).length + '/' + out.backs.length, loads: out.loads, backs: out.backs.map((b) => b.ms) };
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true }); fs.appendFileSync(path.join(ROOT, 'test-results', 'perf.json'), JSON.stringify(r) + '\n');
  console.log('PERF', JSON.stringify(r));
});

// Плавность интерфейса: длительность кадров, пока идут анимации (меню, вкладки, панель Claude, настройки).
// У серверов GitHub нет видеокарты — всё рисует процессор, поэтому цифры хуже, чем дома, но «до/после» сравнимы
test('плавность', async () => {
  test.skip(!!process.env.LIQUID_PERF_CHROMIUM || !!process.env.LIQUID_PERF_NOADBLOCK || !!process.env.LIQUID_PERF_NOHOOKS || !!process.env.LIQUID_PERF_WCV, 'один раз');
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

