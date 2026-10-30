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
const hits = { hang: 0 };

// маленький сайт для тестов: страницы и видео из tests/site (с поддержкой Range — видео без неё не перематывается)
function startServer() {
  return new Promise((ok) => {
    server = http.createServer((req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      // страница, которая начинает грузиться и зависает пустой (как сайт, которому мешает провайдер)
      if (p === '/hang') { hits.hang++; res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.write('<!doctype html><html><head><title>hang</title></head><body>'); return; }
      // «замедление провайдера»: первые 16 КБ отдаются, дальше данные перестают идти
      if (p === '/throttle') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.write('<!doctype html><p>' + 'x'.repeat(16 * 1024)); return; }
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
  // папка данных браузера — внутри test-results: при падении её журнал попадает в отчёт
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
  dataDir = fs.mkdtempSync(path.join(ROOT, 'test-results', 'userdata-'));
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, LIQUID_TEST: '1', LIQUID_USER_DATA: dataDir },
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  server?.closeAllConnections?.(); server?.close();
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
  // видео в плеере ролика не стоит: за 2 секунды проигрывается хотя бы секунда
  // (видео короткое и идёт по кругу, поэтому складываем шаги вперёд, а переход на начало считаем отдельно)
  await win.waitForTimeout(1500);
  const played = await inTab(`new Promise((done) => {
    const v = document.getElementById('v'); let last = v.currentTime, sum = 0, n = 0;
    const t = setInterval(() => {
      const c = v.currentTime, d = c - last; last = c;
      sum += d >= 0 ? d : c; // перескок на начало круга: засчитываем то, что прошло с начала
      if (++n >= 8) { clearInterval(t); done(sum); }
    }, 250);
  })`);
  expect(played, 'видео в плеере ролика стоит на месте').toBeGreaterThan(1);
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

// ---------------- 1.8: надёжность ----------------
const logText = () => { try { const d = path.join(dataDir, 'logs'); return fs.readdirSync(d).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join('\n'); } catch { return ''; } };

test('безопасный DNS включается и выключается в настройках', async () => {
  expect(await win.evaluate(() => settings.dns)).toBe('auto');
  await win.evaluate(() => { const s = document.getElementById('dns'); s.value = 'off'; s.dispatchEvent(new Event('change')); });
  await expect.poll(() => win.evaluate(() => settings.dns)).toBe('off');
  await win.evaluate(() => { const s = document.getElementById('dns'); s.value = 'auto'; s.dispatchEvent(new Event('change')); });
  await expect.poll(() => win.evaluate(() => settings.dns)).toBe('auto');
});

test('«Почему не открылось?»: рабочий сайт — «отвечает нормально»', async () => {
  const r = await win.evaluate((u) => L.net.diagnose(u), `${base}/article.html`);
  expect(r.verdict).toContain('отвечает нормально');
  expect(r.checks.find((c) => c.title.startsWith('Напрямую')).status).toBe('ok');
});

test('«Почему не открылось?»: узнаёт обрыв после 16 КБ', async () => {
  const r = await win.evaluate((u) => L.net.diagnose(u), `${base}/throttle`);
  expect(r.verdict).toContain('16 КБ');
});

test('зависшая пустая страница перезагружается сама и пишется в журнал', async () => {
  test.setTimeout(80_000);
  await win.locator('#url').fill(`${base}/hang`);
  await win.locator('#url').press('Enter');
  await expect.poll(() => hits.hang, { timeout: 10_000 }).toBe(1);
  // через 15 секунд браузер должен сам перезагрузить её (второй запрос) и записать это
  await expect.poll(() => hits.hang, { timeout: 30_000 }).toBe(2);
  await expect.poll(() => /грузится и пустая.*127\.0\.0\.1/.test(logText()), { timeout: 5_000 }).toBe(true);
  // уходим с зависшей страницы, чтобы она не мешала дальше
  await win.locator('#url').fill(`${base}/article.html`);
  await win.locator('#url').press('Enter');
  await expect.poll(activeUrl, { timeout: 15_000 }).toContain('/article.html');
});

test('списки блокировщика рекламы скачиваются и собираются', async () => {
  test.setTimeout(120_000);
  await expect.poll(() => /списки обновлены|adblock lists/.test(logText()), { timeout: 100_000, intervals: [2000] }).toBe(true);
  expect(logText(), 'списки рекламы не собрались').toMatch(/списки обновлены/);
});

// ---------------- 1.9: вкладки ----------------
const openUrl = async (u) => { await win.locator('#url').fill(u); await win.locator('#url').press('Enter'); await expect.poll(activeUrl, { timeout: 15_000 }).toContain(u.replace(base, '')); };

test('превью вкладки: снимок страницы делается', async () => {
  await openUrl(`${base}/article.html`);
  await expect.poll(() => win.evaluate(() => (active.thumb || '').slice(0, 23)), { timeout: 15_000 }).toBe('data:image/jpeg;base64,');
});

test('Ctrl+K (и с русской раскладкой): командная строка закрывает вкладки по слову', async () => {
  await win.locator('#newTab').click();
  await openUrl(`${base}/article.html`);
  const n = await tabCount();
  await press('KeyK', 'л', 75, CTRL);
  await expect(win.locator('#palette')).toHaveClass(/open/);
  await win.locator('#palInput').fill('закрой test article');
  await expect(win.locator('#palList .pal-row').first()).toContainText('Закрыть вкладки');
  await win.locator('#palInput').press('Enter');
  await expect.poll(tabCount).toBeLessThan(n);
});

test('группа вкладок: создаётся, сворачивается, разворачивается', async () => {
  await openUrl(`${base}/article.html`);
  await win.evaluate(() => tabMenuExtra(active).find((i) => i && i[0] === 'Новая группа…')[1]());
  await win.locator('#askInput').fill('Тест');
  await win.locator('#askInput').press('Enter');
  await expect(win.locator('#tabs .tgroup')).toHaveText(/Тест/);
  await win.evaluate(() => createTab(null, { after: active })); // открытая из группы вкладка попадает в группу
  await expect.poll(() => win.evaluate(() => tabs.filter((t) => t.group && t.group === active.group).length)).toBe(2);
  await win.locator('#tabs .tgroup').click();
  await expect(win.locator('#tabs .tab.g-collapsed')).toHaveCount(1); // активная вкладка остаётся видна
  await win.locator('#tabs .tgroup').click();
  await expect(win.locator('#tabs .tab.g-collapsed')).toHaveCount(0);
});

test('пространства: свои вкладки, переключение туда и обратно', async () => {
  const mainTabs = await win.evaluate(() => visibleTabs().length);
  await win.evaluate(() => openPalette());
  await win.locator('#palInput').fill('новое пространство');
  await win.locator('#palInput').press('Enter');
  await win.locator('#askInput').fill('Игры');
  await win.locator('#askInput').press('Enter');
  await expect(win.locator('#spaceBtn')).toContainText('Игры');
  await expect.poll(() => win.evaluate(() => visibleTabs().length)).toBe(1); // в новом пространстве — одна новая вкладка
  await expect(win.locator('#tabs .tab:not(.off-space)')).toHaveCount(1);
  await win.evaluate(() => setSpace(JSON.parse(localStorage.getItem('liquid.spaces'))[0].id));
  await expect.poll(() => win.evaluate(() => visibleTabs().length)).toBe(mainTabs);
  // сессия запоминает пространство каждой вкладки
  await win.evaluate(() => writeSession());
  const saved = await win.evaluate(() => JSON.parse(localStorage.getItem('liquid.session')).tabs.map((t) => t.space));
  expect(new Set(saved).size).toBe(2);
});

test('в журнале нет ошибок браузера', async () => {
  await win.waitForTimeout(1500); // журнал пишет пачками раз в секунду
  expect(logErrors()).toEqual([]);
});
