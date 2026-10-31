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

let app, win, server, base, dataDir, mqttBroker, brokerUrl;

// Свой MQTT-брокер поверх WebSocket для теста «Смотреть вместе»: публичные брокеры с серверов GitHub
// работают через раз, а проверяем мы логику Liquid, а не их доступность. Только CONNECT/SUBSCRIBE/PUBLISH QoS 0.
function startBroker() {
  const { WebSocketServer } = require('ws');
  const subs = new Map();
  mqttBroker = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: (p) => (p.has('mqtt') ? 'mqtt' : false) });
  const rd = (b, o) => { const l = b.readUInt16BE(o); return b.subarray(o + 2, o + 2 + l).toString(); };
  mqttBroker.on('connection', (ws) => {
    subs.set(ws, new Set());
    ws.on('message', (data) => {
      const b = Buffer.from(data), type = b[0] >> 4;
      let len = 0, mul = 1, i = 1, x; do { x = b[i++]; len += (x & 127) * mul; mul *= 128; } while (x & 128);
      const body = b.subarray(i, i + len);
      if (type === 1) ws.send(Buffer.from([0x20, 2, 0, 0]));
      else if (type === 8) { subs.get(ws).add(rd(body, 2)); ws.send(Buffer.from([0x90, 3, body[0], body[1], 0])); }
      else if (type === 3) { const t = rd(body, 0); for (const [c, s] of subs) if (s.has(t)) c.send(b.subarray(0, i + len)); }
      else if (type === 12) ws.send(Buffer.from([0xd0, 0]));
    });
    ws.on('close', () => subs.delete(ws));
  });
  return new Promise((ok) => mqttBroker.on('listening', () => { brokerUrl = `ws://127.0.0.1:${mqttBroker.address().port}/mqtt`; ok(); }));
}
const hits = { hang: 0 };
const claudeReqs = []; // что браузер отправлял подставному Claude

// маленький сайт для тестов: страницы и видео из tests/site (с поддержкой Range — видео без неё не перематывается)
function startServer() {
  return new Promise((ok) => {
    server = http.createServer((req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      if (p === '/timedtext') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ events: [
        { tStartMs: 0, segs: [{ utf8: 'Привет, это вступление' }] }, { tStartMs: 12000, segs: [{ utf8: 'про вкладки' }] },
        { tStartMs: 35000, segs: [{ utf8: 'теперь про видео' }] }, { tStartMs: 95000, segs: [{ utf8: 'и выводы' }] }] })); return; }
      if (p === '/v1/messages') return fakeClaude(req, res);
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

// Подставной Claude API. Потоковый ответ — для чата (сравнение вкладок), обычный — для «действий на странице»:
// по шагам вводит «ноутбук» в поле, жмёт «Найти», пытается «Оплатить заказ» и заканчивает.
function fakeClaude(req, res) {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    claudeReqs.push(j);
    if (j.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Сравнение готово. Смотри [1:05].' } });
      ev({ type: 'message_stop' });
      res.end();
      return;
    }
    const step = j.messages.filter((m) => m.role === 'assistant').length;
    const lm = j.messages[j.messages.length - 1];
    const last = typeof lm.content === 'string' ? lm.content : lm.content.map((c) => c.content || c.text || '').join('\n');
    const ref = (re) => { const m = re.exec(last); return m ? +m[1] : 0; };
    const use = (name, input) => ({ type: 'tool_use', id: 't' + step, name, input });
    const content = step === 0 ? [{ type: 'text', text: 'Ищу.' }, use('type', { ref: ref(/#(\d+) input[^\n]*Что найти/), text: 'ноутбук' })]
      : step === 1 ? [use('click', { ref: ref(/#(\d+) button[^\n]*Найти/) })]
      : step === 2 ? [use('click', { ref: ref(/#(\d+) button[^\n]*Оплатить/) })]
      : [use('finish', { summary: 'Нашёл, оплату не делал' })];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content, stop_reason: 'tool_use' }));
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
  await startBroker();
  // папка данных браузера — внутри test-results: при падении её журнал попадает в отчёт
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
  dataDir = fs.mkdtempSync(path.join(ROOT, 'test-results', 'userdata-'));
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, LIQUID_TEST: '1', LIQUID_USER_DATA: dataDir, LIQUID_CLAUDE_API: base, LIQUID_WATCH_BROKERS: brokerUrl },
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  server?.closeAllConnections?.(); server?.close(); mqttBroker?.close();
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
  // у серверов тестов нет видеокарты: чёткость и видео считает процессор — выключаем, чтобы не мешать следующим тестам
  await win.evaluate(() => document.querySelector('#srLevel [data-v="off"]').click());
  await inTab(`document.getElementById('v').pause()`);
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
  await win.evaluate((u) => navigate(u), `${base}/hang`);
  await expect.poll(() => hits.hang, { timeout: 10_000 }).toBe(1);
  // через 15 секунд браузер должен сам перезагрузить её (второй запрос) и записать это
  await expect.poll(() => hits.hang, { timeout: 30_000 }).toBe(2);
  await expect.poll(() => /грузится и пустая.*127\.0\.0\.1/.test(logText()), { timeout: 5_000 }).toBe(true);
  // уходим с зависшей страницы, чтобы она не мешала дальше
  await win.evaluate((x) => navigate(x), `${base}/article.html`);
  await expect.poll(activeUrl, { timeout: 15_000 }).toContain('/article.html');
});

test('списки блокировщика рекламы скачиваются и собираются', async () => {
  test.setTimeout(120_000);
  await expect.poll(() => /списки обновлены|adblock lists/.test(logText()), { timeout: 100_000, intervals: [2000] }).toBe(true);
  expect(logText(), 'списки рекламы не собрались').toMatch(/списки обновлены/);
});

// ---------------- 1.12.1: заготовленная вкладка ----------------
test('новая вкладка берёт заготовку и открывает нужный сайт', async () => {
  await expect.poll(() => win.evaluate(() => window.spareReady()), { timeout: 15_000 }).toBe(true);
  const r = await win.evaluate((u) => new Promise((done) => {
    const t = createTab(u);
    t.wv.addEventListener('did-finish-load', () => done({ url: t.wv.getURL(), back: t.wv.canGoBack(), id: t.wcId }), { once: true });
  }), `${base}/article.html`);
  expect(r.url).toContain('/article.html');
  expect(r.back).toBe(false);   // в истории вкладки нет пустой заготовки
  expect(r.id).toBeGreaterThan(0);
  await expect.poll(() => win.evaluate(() => window.spareReady()), { timeout: 15_000 }).toBe(true); // и заготовлена следующая
  await win.evaluate(() => closeTab(active));
});

// ---------------- 1.9: вкладки ----------------
// открыть адрес в текущей вкладке (печать в адресной строке проверяет отдельный тест выше)
const openUrl = async (u) => { await win.evaluate((x) => navigate(x), u); await expect.poll(activeUrl, { timeout: 15_000 }).toContain(u.replace(base, '')); };

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
  // пункт меню открывает окошко для названия и ждёт ввода — не дожидаемся его здесь
  await win.evaluate(() => { tabMenuExtra(active).find((i) => i && i[0] === 'Новая группа…')[1](); });
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

// ---------------- 1.10: видео и игры ----------------
const vt = (js) => inTab(`(() => { const v = document.getElementById('v'); return ${js}; })()`);

test('окно поверх игры: открывается с тем же видео, вкладка на паузе', async () => {
  await openUrl(`${base}/video.html`);
  // страница могла ещё не дорисоваться — ждём, пока на ней появится видео
  await expect.poll(() => inTab(`!!document.getElementById('v')`).catch(() => false), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => vt('v.currentTime'), { timeout: 15_000 }).toBeGreaterThan(0.3);
  await win.evaluate(() => window.openMini());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.__mini).length), { timeout: 15_000 }).toBe(1);
  // в маленьком окне видео растянуто на всё окно и играет
  const miniJs = (js) => app.evaluate(({ BrowserWindow }, code) => BrowserWindow.getAllWindows().find((w) => w.__mini).webContents.executeJavaScript(code), js);
  await expect.poll(() => miniJs(`!!document.querySelector('[data-lq-mini]')`), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => miniJs(`(() => { const v = document.querySelector('[data-lq-mini]'); return !v.paused && v.getBoundingClientRect().width >= innerWidth - 1; })()`), { timeout: 10_000 }).toBe(true);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.__mini).isAlwaysOnTop())).toBe(true);
  expect(await vt('v.paused')).toBe(true); // во вкладке видео встало на паузу
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.__mini).close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.__mini).length)).toBe(0);
});

test('клип: буфер пишет, «Сохранить клип» кладёт файл в Видео/Liquid', async () => {
  test.setTimeout(60_000);
  await vt('v.play()');
  const dir = path.join(await app.evaluate(({ app }) => app.getPath('videos')), 'Liquid');
  const before = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  await win.evaluate(() => window.toggleClipBuffer());
  await win.waitForTimeout(4000);
  await win.evaluate(() => window.saveClip());
  await expect.poll(() => (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => !before.has(f) && /^Клип/.test(f)).length, { timeout: 20_000 }).toBe(1);
  const f = fs.readdirSync(dir).find((x) => !before.has(x) && /^Клип/.test(x));
  expect(fs.statSync(path.join(dir, f)).size).toBeGreaterThan(10_000);
  fs.unlinkSync(path.join(dir, f));
  await win.evaluate(() => window.toggleClipBuffer()); // выключаем буфер
  await vt('v.pause()');
});

test('смотреть вместе: комната, пауза и перемотка от друга, чат', async () => {
  test.setTimeout(150_000);
  const W = require(path.join(ROOT, 'main', 'watch.js'));
  W.BROKERS.splice(0, W.BROKERS.length, brokerUrl); // друг — на том же тестовом брокере
  const { WatchRoom } = W;
  await win.evaluate(() => window.openWatch());
  await win.locator('#wtName').fill('Тестер');
  await win.locator('#wtCreate').click();
  await expect.poll(() => win.evaluate(() => window.watchState().state), { timeout: 20_000 }).toBe('online');
  const code = await win.evaluate(() => window.watchState().code);
  const got = [];
  const friend = new WatchRoom({ onMessage: (m) => got.push(m), onStatus: () => {}, log: () => {} });
  await friend.join(code);
  // как настоящий Liquid: дождаться пары брокеров и повторять «я здесь», пока нас не увидят
  await expect.poll(() => friend.online().length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2).catch(() => {}); // хватит и одного общего
  const hi = () => friend.send({ type: 'hello', name: 'Друг' });
  hi(); const hiAgain = setInterval(hi, 3000);
  await expect.poll(() => win.evaluate(() => window.watchState().people), { timeout: 40_000 }).toBe(1).finally(() => clearInterval(hiAgain));
  // друг ставит на паузу на 1,5 секунде — у нас видео встаёт туда же
  // (как настоящий Liquid, друг напоминает своё состояние — публичный брокер может потерять одно сообщение)
  const pause = () => friend.send({ type: 'state', url: `${base}/video.html`, t: 1.5, paused: true, rate: 1, reason: 'pause', name: 'Друг' });
  pause(); const again = setInterval(pause, 3000);
  await expect.poll(() => vt('v.paused && Math.abs(v.currentTime - 1.5) < 0.6'), { timeout: 20_000 }).toBe(true).finally(() => clearInterval(again));
  // мы нажимаем «играть» — друг получает это
  await vt('v.play()');
  // если само «играть» потерялось, его догонит напоминание раз в 5 секунд
  await expect.poll(() => got.some((m) => m.type === 'state' && m.paused === false), { timeout: 30_000 }).toBe(true);
  const chat = () => friend.send({ type: 'chat', text: 'привет из теста', name: 'Друг' });
  chat(); const chatAgain = setInterval(chat, 4000);
  await expect(win.locator('#wtChat')).toContainText('привет из теста', { timeout: 30_000 }).finally(() => clearInterval(chatAgain));
  friend.leave();
  await win.locator('#wtLeave').click();
  expect(await win.evaluate(() => window.watchState().code)).toBe('');
  await win.evaluate(() => closePops());
});

// ---------------- 1.11: Claude ----------------
test('пересказ видео: расшифровка с таймкодами из плеера', async () => {
  await openUrl(`${base}/fakeyt.html`);
  const r = await win.evaluate(() => window.videoPrompt(active));
  expect(r.prompt).toContain('Как устроен браузер');
  expect(r.prompt).toContain('[0:00] Привет, это вступление про вкладки'); // реплики склеены в блоки по ~30 с
  expect(r.prompt).toContain('[0:35] теперь про видео');
  expect(r.prompt).toContain('[1:35] и выводы');
});

test('Claude (API): сравнение вкладок и кликабельные таймкоды', async () => {
  await win.evaluate(() => closePops());
  {
    const s = await win.evaluate(async () => { settings = await L.settings.set({ claudeMode: 'api', claudeKey: 'test-key' }); applyClaudeMode(); return settings.claudeMode; });
    expect(s).toBe('api');
  }
  // диагностика: отвечают ли окно и основной процесс (в прошлый раз Enter в адресной строке завис)
  const alive = await Promise.race([win.evaluate(() => 'ui ok'), new Promise((r) => setTimeout(() => r('ui НЕ отвечает'), 5000))]);
  const mainAlive = await Promise.race([app.evaluate(() => 'main ok'), new Promise((r) => setTimeout(() => r('main НЕ отвечает'), 5000))]);
  expect(`${alive}, ${mainAlive}`).toBe('ui ok, main ok');
  await win.evaluate((u) => navigate(u), `${base}/article.html`);
  await expect.poll(activeUrl, { timeout: 15_000 }).toContain('/article.html');
  await win.evaluate((u) => createTab(u), `${base}/form.html`);
  await expect.poll(activeUrl, { timeout: 15_000 }).toContain('/form.html');
  await win.evaluate(() => window.openCompare());
  await win.locator('#cmpQ').fill('что полезнее');
  await win.locator('#cmpGo').click();
  await expect.poll(() => claudeReqs.filter((r) => r.stream).length, { timeout: 30_000 }).toBe(1);
  const sent = JSON.stringify(claudeReqs.find((r) => r.stream).messages);
  expect(sent).toContain('Сравни');
  expect(sent).toContain('The quick brown fox'); // текст первой страницы
  expect(sent).toContain('Магазин');             // и второй
  await expect(win.locator('#msgs .msg.ai a.tc')).toHaveText('[1:05]', { timeout: 15_000 });
});

test('Claude (API) действует на странице и спрашивает перед «Оплатить»', async () => {
  test.setTimeout(60_000);
  // тест не должен зависеть от предыдущего: режим API включаем сам
  await win.evaluate(async () => { closePops(); settings = await L.settings.set({ claudeMode: 'api', claudeKey: 'test-key' }); applyClaudeMode(); });
  await openUrl(`${base}/form.html`);
  await win.evaluate(() => { window.runAgent('найди ноутбук'); });
  // на третьем шаге Claude хочет нажать «Оплатить заказ» — должен появиться вопрос
  await expect(win.locator('#actPop')).toHaveClass(/open/, { timeout: 30_000 });
  await expect(win.locator('#actText')).toContainText('Оплатить');
  await win.locator('#actNo').click();
  await expect.poll(() => win.evaluate(() => window.agentState().busy), { timeout: 20_000 }).toBe(false);
  expect(await inTab(`document.getElementById('q').value`)).toBe('ноутбук');
  expect(await inTab(`document.getElementById('out').textContent`)).toBe('Найдено: ноутбук');
  expect(await inTab(`!!document.getElementById('paid')`)).toBe(false); // оплата не нажата
  await expect(win.locator('#msgs .agent-log').last()).toContainText('Не разрешено');
  await expect(win.locator('#msgs .agent-log').last()).toContainText('Нашёл, оплату не делал');
});

test('заминки основного процесса (для сведения)', async () => {
  const lines = logText().split('\n').filter((l) => /заминка|списки обновлены|блокировщик\]/.test(l));
  fs.writeFileSync(path.join(ROOT, 'test-results', 'stalls.txt'), lines.join('\n'));
});

test('в журнале нет ошибок браузера', async () => {
  await win.waitForTimeout(1500); // журнал пишет пачками раз в секунду
  expect(logErrors()).toEqual([]);
});
