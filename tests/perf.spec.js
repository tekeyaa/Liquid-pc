// Замеры скорости Liquid (не проверка — только цифры). Результат — в test-results/perf.json, его печатает шаг в GitHub.
const { test, expect, _electron: electron } = require('@playwright/test');
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
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(fs.readFileSync(f));
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
test('замеры', async () => {
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
    out.backs.push({ ms: Date.now() - t0, bf: await inTab('!!window.__bf') });
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const r = { version: require(path.join(ROOT, 'package.json')).version, loadMedianMs: med(out.loads.slice(1)), backMedianMs: med(out.backs.slice(1).map((b) => b.ms)), backFromCache: out.backs.filter((b) => b.bf).length + '/' + out.backs.length, loads: out.loads, backs: out.backs.map((b) => b.ms) };
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'test-results', 'perf.json'), JSON.stringify(r));
  console.log('PERF', JSON.stringify(r));
});
