// Автотесты Liquid: запускают настоящий браузер (Electron) и проверяют то, что уже ломалось или важно каждый день.
// Гоняются в GitHub на Windows перед каждой сборкой установщика — если что-то упало, релиз не выходит.
// Запуск у себя: npm install --no-save @playwright/test  →  npx playwright test
const { test, expect, _electron: electron } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(__dirname, 'site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.webm': 'video/webm' };

let app, win, server, base, dataDir;

// маленький сайт для тестов: страницы и видео из tests/site (с поддержкой Range — видео без неё не перематывается)
function startServer() {
  return new Promise((ok) => {
    server = http.createServer((req, res) => {
      const file = path.join(SITE, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!file.startsWith(SITE) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      const size = fs.statSync(file).size, type = TYPES[path.extname(file)] || 'application/octet-stream';
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (m) {
        const start = Number(m[1] || 0), end = m[2] ? Number(m[2]) : size - 1;
        res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
        fs.createReadStream(file, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size });
        fs.createReadStream(file).pipe(res);
      }
    });
    server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; ok(); });
  });
}

// код на странице активной вкладки (webview) — через основной процесс браузера
async function inTab(js) {
  const id = await win.evaluate(() => active && active.wv && active.wv.getWebContentsId());
  return app.evaluate(({ webContents }, [wcId, code]) => webContents.fromId(wcId).executeJavaScript(code), [id, js]);
}
const tabCount = () => win.evaluate(() => tabs.length);
const activeUrl = () => win.evaluate(() => (active && active.wv ? active.wv.getURL() : ''));

// нажатие так, как его присылает Windows: место клавиши (code) отдельно от буквы (key) — так проверяется русская раскладка
async function press(code, key, vk, modifiers) {
  const cdp = await win.context().newCDPSession(win);
  for (const type of ['rawKeyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, modifiers, code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }
  await cdp.detach();
}
const CTRL = 2;

// записи журнала Liquid уровня «ошибка» и «сбой»
function logErrors() {
  const dir = path.join(dataDir, 'logs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n'))
    .filter((l) => /\[(ERROR|CRASH)\]/.test(l));
}

test.beforeAll(async () => {
  await startServer();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liquid-test-'));
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, LIQUID_TEST: '1', LIQUID_USER_DATA: dataDir },
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  // журнал — в отчёт теста, чтобы при падении было видно, что браузер записал
  try { for (const f of fs.readdirSync(path.join(dataDir, 'logs'))) fs.copyFileSync(path.join(dataDir, 'logs', f), path.join(test.info().outputDir || os.tmpdir(), f)); } catch {}
  await app?.close().catch(() => {});
  server?.close();
});

test('браузер запускается и открывает вкладку', async () => {
  await expect.poll(tabCount, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  await expect(win.locator('#url')).toBeVisible();
  await expect(win.locator('#tabs .tab.active')).toHaveCount(1);
});

test('сайт открывается из адресной строки', async () => {
  await win.locator('#url').click();
  await win.locator('#url').fill(`${base}/article.html`);
  await win.locator('#url').press('Enter');
  await expect.poll(activeUrl, { timeout: 15_000 }).toContain('/article.html');
  await expect(win.locator('#tabs .tab.active .title')).toHaveText('Test article', { timeout: 10_000 });
});

test('вкладки: кнопка «+», закрытие крестиком', async () => {
  const n = await tabCount();
  await win.locator('#newTab').click();
  await expect.poll(tabCount).toBe(n + 1);
  await win.locator('#tabs .tab.active .x').click();
  await expect.poll(tabCount).toBe(n);
});

test('горячие клавиши работают и с русской раскладкой (Ctrl+Т/Е, Ctrl+W/Ц)', async () => {
  const n = await tabCount();
  await press('KeyT', 'е', 84, CTRL); // русская раскладка: на месте T буква Е
  await expect.poll(tabCount).toBe(n + 1);
  await press('KeyW', 'ц', 87, CTRL);
  await expect.poll(tabCount).toBe(n);
  await press('KeyT', 't', 84, CTRL); // и английская
  await expect.poll(tabCount).toBe(n + 1);
  await press('KeyW', 'w', 87, CTRL);
  await expect.poll(tabCount).toBe(n);
});

test('видео с превью «главной» идёт в плеере ролика (чёрный экран из 1.7.9)', async () => {
  // включаем «Чёткость» так же, как кнопкой в настройках
  await win.evaluate(() => document.querySelector('#srLevel [data-v="mid"]').click());
  await win.locator('#url').fill(`${base}/youtube.html`);
  await win.locator('#url').press('Enter');
  await expect.poll(activeUrl, { timeout: 15_000 }).toContain('/youtube.html');
  // превью играет
  await expect.poll(() => inTab(`document.getElementById('v').currentTime`), { timeout: 15_000 }).toBeGreaterThan(0.5);
  await win.waitForTimeout(1500); // даём улучшению видео включиться на превью
  await inTab('openVideo()');
  // видео в плеере ролика не стоит: время идёт
  const t0 = await (async () => { await win.waitForTimeout(1500); return inTab(`document.getElementById('v').currentTime`); })();
  await win.waitForTimeout(2000);
  const t1 = await inTab(`document.getElementById('v').currentTime`);
  expect(t1 - t0, 'видео в плеере ролика стоит на месте').toBeGreaterThan(1);
  const st = await inTab(`(() => {
    const v = document.getElementById('v'), c = document.querySelector('#watch canvas[data-lq-sr]');
    const gl = !!document.createElement('canvas').getContext('webgl');
    return { filter: v.style.filter || '', gl, layer: !!c, layerVisible: !!c && c.style.visibility === 'visible', layerW: c ? c.offsetWidth : 0 };
  })()`);
  // на плеере сайта не должно остаться фильтров «лёгкого режима» от превью
  expect(st.filter, 'на плеере остался фильтр от превью').not.toContain('lq-sharp');
  if (st.gl) {
    // полная чёткость: свой слой поверх плеера ролика, во всю его ширину (видео с обрезкой краёв)
    expect(st.layer, 'нет слоя чёткости в плеере ролика').toBe(true);
    expect(st.layerVisible).toBe(true);
    expect(st.layerW).toBeGreaterThan(800);
  }
});

test('в журнале нет ошибок браузера', async () => {
  await win.waitForTimeout(1500); // журнал пишет пачками раз в секунду
  expect(logErrors()).toEqual([]);
});
