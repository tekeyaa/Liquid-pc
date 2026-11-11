// Автотесты Liquid: запускают настоящий браузер (Electron) и проверяют то, что уже ломалось или важно каждый день.
// Гоняются в GitHub на Windows перед каждой сборкой установщика — если что-то упало, релиз не выходит.
// Запуск у себя: npm install --no-save @playwright/test  →  npx playwright test
const { test, expect, _electron: electron } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(__dirname, 'site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.webm': 'video/webm' };

let app, win, server, base, dataDir, cdp = null;

const hits = { hang: 0 };

// Настоящий прокси-сервер (HTTP CONNECT) для проверки VPN: браузер подключается к нему как к серверу VPN,
// а тест видит, какие соединения через него прошли, и может его «уронить»
function startProxy() {
  const p = { hits: [], socks: new Set() };
  p.server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  p.server.on('connect', (req, sock, head) => {
    p.hits.push(req.url);
    const [h, port] = req.url.split(':');
    const up = net.connect(Number(port) || 443, h, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head && head.length) up.write(head); up.pipe(sock); sock.pipe(up); });
    p.socks.add(sock); p.socks.add(up);
    const kill = () => { sock.destroy(); up.destroy(); };
    up.on('error', kill); sock.on('error', kill); up.on('close', kill); sock.on('close', kill);
  });
  p.stop = () => { p.server.close(); for (const x of p.socks) x.destroy(); };
  return new Promise((ok) => p.server.listen(0, '127.0.0.1', () => { p.port = p.server.address().port; ok(p); }));
}
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const pt = s.address().port; s.close(() => ok(pt)); }); });
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
      if (p === '/hdrs') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(req.headers)); return; }
      // подписка VPN (как у панелей 3x-ui / Marzban: base64 со списком ключей) и общий список заблокированных сайтов
      if (p === '/sub') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(Buffer.from('socks5://127.0.0.1:9#Из подписки 1\nvless://1d6b8f2e-0000-4000-8000-000000000001@203.0.113.7:443?security=reality&sni=example.com&pbk=AbCdEf&sid=01&type=tcp&fp=chrome#Из подписки 2\n').toString('base64')); return; }
      if (p === '/blocklist') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('blocked-e2e.test\n.zz-e2e\n'); return; }
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
  // папка данных браузера — внутри test-results: при падении её журнал попадает в отчёт
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
  dataDir = fs.mkdtempSync(path.join(ROOT, 'test-results', 'userdata-'));
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, LIQUID_TEST: '1', LIQUID_USER_DATA: dataDir, LIQUID_CLAUDE_API: base, LIQUID_BLOCKLIST_URL: `${base}/blocklist` },
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // профиль окна браузера (только в рабочих ветках): какие функции интерфейса занимают время
  if (process.env.LIQUID_PROFILE) {
    try { cdp = await win.context().newCDPSession(win); await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 1000 }); await cdp.send('Profiler.start'); } catch (e) { cdp = null; console.log('профиль окна не запустился: ' + e.message); }
  }
});

test.afterAll(async () => {
  if (process.env.LIQUID_PROFILE) {
    try { if (cdp) { const { profile } = await cdp.send('Profiler.stop'); fs.mkdirSync(process.env.LIQUID_PROFILE, { recursive: true }); fs.writeFileSync(path.join(process.env.LIQUID_PROFILE, `ui-${Date.now()}.cpuprofile`), JSON.stringify(profile)); } } catch {}
    try { await app.evaluate(() => global.__lqSaveProfile && global.__lqSaveProfile()); } catch {}
  }
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

// Меню и плашки интерфейса не прячутся под страницей. У <webview> страница — часть html окна (z-index ниже меню);
// у движка «view» страница рисуется поверх окна, поэтому под меню она прячется (на её месте снимок),
// а под плашками (поиск, сообщение внизу) — уменьшается так, чтобы плашку было видно
test('меню и плашки интерфейса видны поверх страницы', async () => {
  await win.evaluate((u) => navigate(u), `${base}/article.html`);
  await expect.poll(activeUrl, { timeout: 15_000 }).toContain('/article.html');
  const engine = await win.evaluate(() => window.TAB_ENGINE);
  const rectOf = (sel) => win.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; }, sel);
  if (engine !== 'view') {
    // одна картина наложения: меню выше страницы
    await win.evaluate(() => openPop('#menuPop'));
    const z = await win.evaluate(() => ({ pop: +getComputedStyle(document.getElementById('menuPop')).zIndex, page: +getComputedStyle(active.wv).zIndex || 0 }));
    expect(z.pop).toBeGreaterThan(z.page);
    await win.evaluate(() => closePops());
    return;
  }
  const id = await win.evaluate(() => active.wv.getWebContentsId());
  const view = () => app.evaluate((_e, i) => globalThis.__lqTabViews.state().find((v) => v.id === i), id);
  const page = () => rectOf('#views liquid-view.active');
  await expect.poll(async () => (await view())?.shown, { timeout: 10_000 }).toBe(true);
  const p = await page();
  expect(Math.abs((await view()).bounds.height - (p.bottom - p.top))).toBeLessThanOrEqual(2); // страница — ровно на своём месте
  // меню: страница спрятана, вместо неё — снимок
  for (const open of [() => openPop('#menuPop'), () => window.openSettings()]) {
    await win.evaluate(open);
    await expect.poll(async () => (await view()).shown, { timeout: 5_000 }).toBe(false);
    await expect.poll(() => win.evaluate(() => getComputedStyle(active.wv).backgroundImage), { timeout: 5_000 }).toContain('data:image/jpeg');
    await win.evaluate(() => closePops());
    await expect.poll(async () => (await view()).shown, { timeout: 5_000 }).toBe(true);
  }
  // сообщение внизу: страница кончается выше него
  await win.evaluate(() => toast('Проверка: сообщение поверх страницы'));
  await expect.poll(async () => { const v = await view(), t = await rectOf('#toast'); return v.shown && v.bounds.y + v.bounds.height <= t.top + 1; }, { timeout: 5_000 }).toBe(true);
  // поиск по странице: страница начинается ниже панели поиска
  await win.evaluate(() => openFind());
  await expect.poll(async () => { const v = await view(), f = await rectOf('#find'); return v.shown && v.bounds.y >= f.bottom - 1; }, { timeout: 5_000 }).toBe(true);
  await win.evaluate(() => closeFind());
  // всё закрыто — страница снова во всю область
  await expect.poll(async () => { const v = await view(), r = await page(); return v.shown && Math.abs(v.bounds.y - r.top) <= 1; }, { timeout: 8_000 }).toBe(true);
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
    const gl2 = !!document.createElement('canvas').getContext('webgl2');
    return { filter: v.style.filter || '', gl, gl2, layer: !!c, layerVisible: !!c && c.style.visibility === 'visible', layerW: c ? c.offsetWidth : 0 };
  })()`);
  // на плеере сайта не должно остаться фильтров «лёгкого режима» от превью
  expect(st.filter, 'на плеере остался фильтр от превью').not.toContain('lq-sharp');
  if (st.gl) {
    // полная чёткость: свой слой поверх плеера ролика, во всю его ширину (видео с обрезкой краёв)
    expect(st.layer, 'нет слоя чёткости в плеере ролика').toBe(true);
    expect(st.layerVisible).toBe(true);
    expect(st.layerW).toBeGreaterThan(800);
    // Liquid RTX: лучшая ступень, которую умеет видеокарта, — нейросеть (веса из main) или RAVU (таблицы из main)
    if (st.gl2) await expect.poll(() => inTab(`document.querySelector('#watch canvas[data-lq-sr]')?.dataset.lqSrBest || ''`), { timeout: 30_000 }).toMatch(/^(rtx2|pro|net|anime|r2)$/);
  }
  // у серверов тестов нет видеокарты: чёткость и видео считает процессор — выключаем, чтобы не мешать следующим тестам
  await win.evaluate(() => document.querySelector('#srLevel [data-v="off"]').click());
  await inTab(`document.getElementById('v').pause()`);
});

// код на странице «с нажатием пользователя» (так приходят команды из меню правой кнопки) — можно включать полный экран
async function inTabGesture(js) {
  const id = await win.evaluate(() => active && active.wv && active.wv.getWebContentsId());
  return app.evaluate(({ webContents }, [wcId, code]) => webContents.fromId(wcId).executeJavaScript(code, true), [id, js]);
}

test('Liquid Player: свой плеер на весь экран рисует нейросетью, управляет видео сайта, закрывается', async () => {
  test.setTimeout(180_000); // без видеокарты (SwiftShader) шейдеры большой сети собираются долго и тормозят всё окно
  await win.evaluate(() => document.querySelector('#srLevel [data-v="mid"]').click());
  // напрямую, а не Enter в адресной строке: без видеокарты (SwiftShader) окно в этот момент собирает шейдеры
  // и не успевает принять нажатие — тест падал не из-за плеера
  await win.evaluate((u) => navigate(u), `${base}/video.html`);
  await expect.poll(activeUrl, { timeout: 15_000 }).toContain('/video.html');
  await expect.poll(() => inTab(`document.getElementById('v').currentTime`), { timeout: 15_000 }).toBeGreaterThan(0.3);
  const caps = await inTab(`(() => { const g = document.createElement('canvas').getContext('webgl2'); return { gl2: !!g, fbf: !!(g && g.getExtension('EXT_color_buffer_float')) }; })()`);
  // как из меню «Смотреть в Liquid Player»
  await inTabGesture(`document.dispatchEvent(new CustomEvent('liquid:player'))`);
  await expect.poll(() => inTab(`!!document.querySelector('lq-player')`)).toBe(true);
  await expect.poll(() => inTab(`document.fullscreenElement ? document.fullscreenElement.tagName : ''`)).toBe('LQ-PLAYER');
  if (caps.gl2) await expect.poll(() => inTab(`document.querySelector('lq-player').dataset.lqUsed || ''`), { timeout: 40_000 }).toMatch(caps.fbf ? /^(rtx2|pro|net|anime)$/ : /^r2$/);
  // 60 кадров: частота видео определена верно (тестовое видео — 25 кадров), кадры и с дорисовкой продолжают идти
  if (caps.fbf) {
    await expect.poll(() => inTab(`+(document.querySelector('lq-player').dataset.lqFps || 0)`), { timeout: 30_000 }).toBeGreaterThan(23);
    expect(await inTab(`+document.querySelector('lq-player').dataset.lqFps`)).toBeLessThanOrEqual(30); // 25 к/с — дорисовка положена
    console.log('60 кадров: дорисовка', await inTab(`document.querySelector('lq-player').dataset.lqFg`));
    // включаем дорисовку принудительно (здесь экран обновляется редко) — кадры идут, ошибок нет
    await inTab(`document.dispatchEvent(new CustomEvent('liquid:fgtest'))`);
    await expect.poll(() => inTab(`document.querySelector('lq-player').dataset.lqFg`), { timeout: 60_000 }).toBe('1'); // без видеокарты шейдеры поиска сдвига собираются долго
    const f0 = await inTab(`document.getElementById('v').currentTime`);
    await win.waitForTimeout(1500);
    expect(await inTab(`document.getElementById('v').currentTime`)).not.toBe(f0);
    expect(await inTab(`document.querySelector('lq-player').dataset.lqErr || ''`)).toBe('');
    expect(await inTab(`document.querySelector('lq-player').dataset.lqUsed || ''`)).not.toBe('');
  }
  // ручной выбор сети: «Аниме» — рисует аниме-сеть, «авто» — снова по видеокарте
  if (caps.fbf) {
    await win.evaluate(() => window.saveSrPref({ srNet: 'anime' }));
    await expect.poll(() => inTab(`document.querySelector('lq-player').dataset.lqUsed || ''`), { timeout: 60_000 }).toBe('anime');
    await win.evaluate(() => window.saveSrPref({ srNet: 'auto' }));
    await expect.poll(() => inTab(`document.querySelector('lq-player').dataset.lqUsed || ''`), { timeout: 40_000 }).toMatch(/^(rtx2|pro|net|anime)$/);
  }
  // видео сайта продолжает идти под нашим плеером
  const t0 = await inTab(`document.getElementById('v').currentTime`);
  await win.waitForTimeout(1200);
  expect(await inTab(`document.getElementById('v').currentTime`), 'видео под плеером встало').not.toBe(t0);
  // пробел — пауза у видео сайта
  await inTab(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }))`);
  await expect.poll(() => inTab(`document.getElementById('v').paused`)).toBe(true);
  await inTab(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }))`);
  await expect.poll(() => inTab(`document.getElementById('v').paused`)).toBe(false);
  // выход из полного экрана оставляет плеер в окне, Esc закрывает
  await inTab(`document.exitFullscreen()`);
  await expect.poll(() => inTab(`!!document.fullscreenElement`)).toBe(false);
  await inTab(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }))`);
  await expect.poll(() => inTab(`!!document.querySelector('lq-player')`)).toBe(false);
  // сайт уходит в полный экран со своим плеером — вместо него открывается Liquid Player
  await win.waitForTimeout(1700); // сразу после закрытия плеер сам не открывается (защита от повторов)
  await inTabGesture(`document.getElementById('v').requestFullscreen()`);
  await expect.poll(() => inTab(`document.fullscreenElement ? document.fullscreenElement.tagName : ''`)).toBe('LQ-PLAYER');
  await inTab(`document.exitFullscreen()`);
  await expect.poll(() => inTab(`!!document.querySelector('lq-player')`)).toBe(false);
  await expect.poll(() => inTab(`!!document.fullscreenElement`)).toBe(false);
  await win.evaluate(() => document.querySelector('#srLevel [data-v="off"]').click());
  await inTab(`document.getElementById('v').pause()`);
});

// ---------------- 1.8: надёжность ----------------
const logText = () => { try { const d = path.join(dataDir, 'logs'); return fs.readdirSync(d).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join('\n'); } catch { return ''; } };

test('представляется сайтам как Chrome или Edge: строка, заголовки и скрипты совпадают', async () => {
  const look = async () => {
    await expect.poll(() => win.evaluate(() => window.spareReady()), { timeout: 15_000 }).toBe(true);
    await win.evaluate((u) => new Promise((done) => { const t = createTab(u); t.wv.addEventListener('did-finish-load', () => done(), { once: true }); }), `${base}/hdrs`);
    const r = await inTab(`(async () => ({ h: JSON.parse(document.body.innerText), ua: navigator.userAgent,
      brands: navigator.userAgentData.brands.map((b) => b.brand), full: (await navigator.userAgentData.getHighEntropyValues(['fullVersionList'])).fullVersionList.map((b) => b.brand),
      chrome: typeof window.chrome, loadTimes: typeof (window.chrome && window.chrome.loadTimes), native: Function.prototype.toString.call(Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'brands').get) }))()`);
    await win.evaluate(() => closeTab(active));
    return r;
  };
  expect(await win.evaluate(() => settings.uaMode)).toBe('chrome');
  let r = await look();
  expect(r.ua).toMatch(/Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
  expect(r.h['user-agent']).toBe(r.ua);
  expect(r.brands).toContain('Google Chrome');
  expect(r.full).toContain('Google Chrome');
  if (r.h['sec-ch-ua']) expect(r.h['sec-ch-ua']).toContain('"Google Chrome"');
  expect(r.chrome).toBe('object'); expect(r.loadTimes).toBe('function');
  expect(r.native).toContain('[native code]');
  await win.evaluate(() => document.querySelector('#uaMode [data-v="edge"]').click());
  await expect.poll(() => win.evaluate(() => settings.uaMode)).toBe('edge');
  r = await look();
  expect(r.ua).toMatch(/Edg\/\d+/);
  expect(r.h['user-agent']).toBe(r.ua);
  expect(r.brands).toContain('Microsoft Edge');
  if (r.h['sec-ch-ua']) expect(r.h['sec-ch-ua']).toContain('"Microsoft Edge"');
  await win.evaluate(() => document.querySelector('#uaMode [data-v="chrome"]').click());
  await expect.poll(() => win.evaluate(() => settings.uaMode)).toBe('chrome');
});

test('безопасный DNS включается и выключается в настройках', async () => {
  expect(await win.evaluate(() => settings.dns)).toBe('auto');
  await win.evaluate(() => { const s = document.getElementById('dns'); s.value = 'off'; s.dispatchEvent(new Event('change')); });
  await expect.poll(() => win.evaluate(() => settings.dns)).toBe('off');
  await win.evaluate(() => { const s = document.getElementById('dns'); s.value = 'auto'; s.dispatchEvent(new Event('change')); });
  await expect.poll(() => win.evaluate(() => settings.dns)).toBe('auto');
});

test('режим обучения Liquid RTX: включается, берёт ссылки YouTube в очередь, выключается', async () => {
  expect((await win.evaluate(() => window.liquid.rtxLearn.status())).on).toBe(false);
  const flip = (on) => win.evaluate((v) => { const s = document.getElementById('rtxLearn'); s.checked = v; s.dispatchEvent(new Event('change')); }, on);
  await flip(true);
  await expect.poll(() => win.evaluate(() => window.liquid.rtxLearn.status().then((s) => s.on))).toBe(true);
  // ссылка, она же короткой ссылкой (повтор), и мусор — в очереди одна
  const n = await win.evaluate(() => window.liquid.rtxLearn.add('https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=5 https://youtu.be/aqz-KE-bpKQ не-ссылка'));
  await flip(false); // сразу выключаем: тест не должен ходить на YouTube
  expect(n).toBe(1);
  const st = await win.evaluate(() => window.liquid.rtxLearn.status());
  expect(st.queued).toBe(1);
  await expect.poll(() => win.evaluate(() => window.liquid.rtxLearn.status().then((s) => s.on))).toBe(false);
  expect(await win.evaluate(() => document.getElementById('rtxLearnBox').hidden)).toBe(true);
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
  // собирает служебный процесс (списки и движок — через диск), а не основной процесс браузера
  expect(logText(), 'движок собирался в основном процессе').toMatch(/сборка за \d+ мс в отдельном процессе/);
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
  await expect.poll(() => claudeReqs.filter((r) => r.stream).length, { timeout: 30_000 }).toBe(1).catch(async (e) => {
    // диагностика: почему запрос не ушёл (Claude занят, сообщение, режим)
    const d = await win.evaluate(() => ({ busy: chat.busyId, toast: document.getElementById('toast')?.textContent, mode: settings.claudeMode, web: window.claudeIsWeb(), msgs: document.querySelectorAll('#msgs .msg').length, reqs: 0 })).catch((x) => String(x));
    throw new Error(e.message + '\nсостояние: ' + JSON.stringify(d) + ' запросов: ' + JSON.stringify(claudeReqs.map((r) => !!r.stream)));
  });
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

// ---------- 1.13: окна и меню ----------
test('вкладки перетаскиваются: меняются местами и вытягиваются в отдельное окно', async () => {
  test.setTimeout(60_000);
  await win.evaluate(() => closePops());
  await win.evaluate((u) => navigate(u), `${base}/article.html`);
  await expect.poll(activeUrl, { timeout: 15_000 }).toContain('/article.html');
  await win.evaluate((u) => createTab(u), `${base}/form.html`);
  await expect.poll(activeUrl, { timeout: 15_000 }).toContain('/form.html');
  const order = () => win.evaluate(() => tabs.filter((t) => t.el.offsetParent).map((t) => t.url));
  // перетаскиваем последнюю вкладку (form) влево на место предыдущей
  const box = async (i) => (await win.locator('#tabs .tab:not(.closing)').nth(i).boundingBox());
  const n = await win.locator('#tabs .tab:not(.closing)').count();
  const last = await box(n - 1), prev = await box(n - 2);
  // берём вкладку за значок слева: в середине узкой вкладки может оказаться крестик
  await win.mouse.move(last.x + 14, last.y + last.height / 2);
  await win.mouse.down();
  await win.mouse.move(prev.x + 8, prev.y + prev.height / 2, { steps: 12 });
  await win.mouse.up();
  const o = await order();
  expect(o[o.length - 2]).toContain('/form.html');
  expect(o[o.length - 1]).toContain('/article.html');
  // теперь тянем вкладку с формой вниз на страницу и отпускаем — появляется второе окно с ней
  const before = await win.evaluate(() => tabs.length);
  await win.waitForTimeout(600); // вкладки доехали на новые места
  const t = await win.locator('#tabs .tab:not(.closing)').filter({ has: win.locator('.title', { hasText: 'Магазин' }) }).first().boundingBox()
    || await box(n - 2);
  // для разбора при неудаче: какие события мыши дошли до окна
  await win.evaluate(() => { window.__pe = []; for (const k of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'gotpointercapture']) document.addEventListener(k, (e) => { if (window.__pe.length < 80) window.__pe.push(k[7] + Math.round(e.clientY) + (e.target.className ? ':' + String(e.target.className).slice(0, 12) : '')); }, true); });
  await win.mouse.move(t.x + 14, t.y + t.height / 2);
  await win.mouse.down();
  await win.mouse.move(t.x + 54, t.y + 320, { steps: 15 });
  await win.mouse.up();
  // новое окно — то, у которого в адресе extra=1 (событие window могло прийти и от другого окна)
  let w2 = null;
  await expect.poll(() => { w2 = app.windows().find((p) => /[?&]extra=1/.test(p.url())) || null; return !!w2; }, { timeout: 15_000 }).toBe(true).catch(async (e) => {
    // для разбора: какие окна видит браузер и Playwright, сколько вкладок осталось
    console.log('TEAR', JSON.stringify({ main: await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.webContents.getURL().slice(-60))).catch(String),
      pw: app.windows().map((p) => p.url().slice(-60)), tabs: await win.evaluate(() => tabs.length).catch(String), before, pe: await win.evaluate(() => window.__pe.join(' ')).catch(String) }));
    throw e;
  });
  await w2.waitForLoadState('domcontentloaded');
  await expect.poll(() => w2.evaluate(() => typeof active !== 'undefined' && !!active).catch(() => false), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => w2.evaluate(() => (active && active.wv ? active.wv.getURL() : '')).catch(() => ''), { timeout: 20_000 }).toContain('/form.html');
  await expect.poll(() => win.evaluate(() => tabs.length)).toBe(before - 1);
  expect(await w2.evaluate(() => window.isExtraWin())).toBe(true);
  // дополнительное окно не трогает сохранённые вкладки главного
  const saved = await win.evaluate(() => localStorage.getItem('liquid.session'));
  await w2.evaluate((u) => createTab(u), `${base}/article.html#w2`);
  await w2.waitForTimeout(800);
  expect(await win.evaluate(() => localStorage.getItem('liquid.session'))).toBe(saved);
  // последнюю вкладку дополнительного окна закрыли — окно закрывается
  const closed = w2.waitForEvent('close');
  await w2.evaluate(() => { [...tabs].forEach((t) => closeTab(t)); });
  await closed;
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible()).length)).toBeGreaterThanOrEqual(1);
});

test('меню: плитки и прокрутка в маленьком окне', async () => {
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.__liquid && !x.__extra); w.unmaximize(); w.setSize(900, 520); });
  await expect.poll(() => win.evaluate(() => innerHeight)).toBeLessThan(560);
  await win.locator('#menuBtn').click();
  await expect(win.locator('#menuPop')).toHaveClass(/open/);
  const m = await win.evaluate(() => { const p = document.getElementById('menuPop'); const r = p.getBoundingClientRect(); return { sh: p.scrollHeight, ch: p.clientHeight, bottom: r.bottom, ih: innerHeight, tiles: p.querySelectorAll('button.tile').length, oy: getComputedStyle(p).overflowY }; });
  expect(m.tiles).toBeGreaterThanOrEqual(13);
  expect(m.bottom).toBeLessThanOrEqual(m.ih);           // меню не уходит за низ окна
  expect(m.oy).toBe('auto');
  expect(m.sh).toBeGreaterThan(m.ch);                   // не влезло — значит листается
  await win.evaluate(() => { const p = document.getElementById('menuPop'); p.scrollTop = p.scrollHeight; });
  await expect(win.locator('#menuPop [data-m="settings"]')).toBeInViewport();
  await win.evaluate(() => closePops());
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.__liquid && !x.__extra); w.setSize(1400, 900); });
});

test('размер интерфейса: всё крупнее, меню и настройки помещаются в окно', async () => {
  await win.evaluate(() => closePops());
  const barH0 = await win.evaluate(() => document.getElementById('bar').getBoundingClientRect().height);
  await win.evaluate(() => window.openSettings());
  await win.locator('#setNav [data-t="look"]').click();
  await win.locator('#uiScale [data-v="1.5"]').click();
  await expect.poll(() => win.evaluate(() => window.uiScale())).toBe(1.5);
  const g = await win.evaluate(() => {
    const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, h: b.height }; };
    return { bar: r('#bar'), set: r('#setPop'), ih: innerHeight, iw: innerWidth, saved: localStorage.getItem('liquid.ui') };
  });
  expect(g.saved).toBe('1.5');
  expect(g.bar.h).toBeGreaterThan(barH0 * 1.3);              // панель стала крупнее
  expect(g.set.l).toBeGreaterThanOrEqual(0); expect(g.set.t).toBeGreaterThanOrEqual(0);
  expect(g.set.r).toBeLessThanOrEqual(g.iw + 1); expect(g.set.b).toBeLessThanOrEqual(g.ih + 1); // настройки не вылезают за окно
  await win.evaluate(() => closePops());
  // меню под панелью и не уходит за низ окна
  await win.locator('#menuBtn').click();
  await expect(win.locator('#menuPop')).toHaveClass(/open/);
  const geo = () => win.evaluate(() => { const b = document.getElementById('menuPop').getBoundingClientRect(); return { t: b.top, b: b.bottom, bar: document.getElementById('bar').getBoundingClientRect().bottom, ih: innerHeight }; });
  await expect.poll(async () => { const g2 = await geo(); return g2.t >= g2.bar - 4; }, { timeout: 3000 }).toBe(true); // меню выезжает с анимацией
  const m = await geo();
  expect(m.b).toBeLessThanOrEqual(m.ih);
  await win.evaluate(() => closePops());
  // меню вкладки — у курсора, а не со сдвигом в полтора раза
  const tb = await win.locator('#tabs .tab.active').boundingBox();
  await win.mouse.click(tb.x + 20, tb.y + tb.height / 2, { button: 'right' });
  await expect(win.locator('#tabMenu')).toHaveClass(/open/);
  const cm = await win.evaluate(() => { const b = document.getElementById('tabMenu').getBoundingClientRect(); return { l: b.left, t: b.top }; });
  expect(Math.abs(cm.l - (tb.x + 20))).toBeLessThan(30);
  expect(Math.abs(cm.t - (tb.y + tb.height / 2 + 6))).toBeLessThan(30);
  await win.keyboard.press('Escape'); await win.mouse.click(5, 300);
  // обратно 100%
  await win.evaluate(() => window.setUiScale(1));
  expect(await win.evaluate(() => window.uiScale())).toBe(1);
});

// ---------------- 1.16: VPN ----------------
test('VPN: несколько серверов, самый быстрый, маршруты, автопереключение', async () => {
  test.setTimeout(120_000);
  await win.evaluate(() => closePops());
  const A = await startProxy(), B = await startProxy(), dead = await freePort();
  const resolve = (u) => app.evaluate(({ session }, x) => session.fromPartition('persist:liquid').resolveProxy(x), u);
  try {
    // два ключа сразу (один сервер не отвечает) — оба в списке
    let r = await win.evaluate((t) => L.vpn.add(t), `http://127.0.0.1:${dead}#Мёртвый\nhttp://127.0.0.1:${A.port}#Сервер А`);
    expect(r.ok, r.error).toBe(true);
    expect(r.list.map((x) => x.name)).toEqual(expect.arrayContaining(['Мёртвый', 'Сервер А']));
    // подключение само выбирает отвечающий сервер, и трафик правда идёт через него
    const st = await win.evaluate(() => L.vpn.connect());
    expect(st.ok, st.error).toBe(true);
    expect(st.state.name).toBe('Сервер А');
    expect(st.state.country).toMatch(/^[A-Z]{2}$/);
    expect(A.hits.some((h) => h.startsWith('1.1.1.1:'))).toBe(true);
    // окно VPN: список серверов и строка про открытый сайт
    await win.evaluate((u) => navigate(u), `${base}/article.html`);
    await win.locator('#vpnBtn').click();
    await expect(win.locator('#vpnList .vs-row')).toHaveCount(2);
    await expect(win.locator('#vpnList .vs-row.on')).toContainText('Сервер А');
    await win.evaluate(() => closePops());
    // умный режим: заблокированные — через VPN, остальное и российское — напрямую; общий список тоже работает
    await expect.poll(() => resolve('https://www.youtube.com/'), { timeout: 10_000 }).toBe(`PROXY 127.0.0.1:${A.port}`);
    await expect.poll(() => resolve('https://example.com/'), { timeout: 10_000 }).toBe('DIRECT');
    await expect.poll(() => resolve('https://www.blocked-e2e.test/'), { timeout: 15_000 }).toBe(`PROXY 127.0.0.1:${A.port}`);
    await expect.poll(() => resolve('https://shop.zz-e2e/'), { timeout: 10_000 }).toBe(`PROXY 127.0.0.1:${A.port}`); // «.zz-e2e» в списке — вся зона
    expect((await win.evaluate(() => L.vpn.route('www.blocked-e2e.test'))).why).toBe('community');
    // весь трафик: российские сайты напрямую (можно выключить)
    await win.evaluate(() => L.settings.set({ vpnMode: 'all' }));
    await expect.poll(() => resolve('https://example.com/')).toBe(`PROXY 127.0.0.1:${A.port}`);
    await expect.poll(() => resolve('https://ya.ru/'), { timeout: 10_000 }).toBe('DIRECT');
    await expect.poll(() => resolve('https://online.sberbank.ru/'), { timeout: 10_000 }).toBe('DIRECT');
    await win.evaluate(() => L.settings.set({ vpnRuDirect: false }));
    await expect.poll(() => resolve('https://ya.ru/')).toBe(`PROXY 127.0.0.1:${A.port}`);
    await win.evaluate(() => L.settings.set({ vpnRuDirect: true, vpnMode: 'smart' }));
    // сайт «напрямую» по кнопке и обратно
    await win.evaluate(() => L.vpn.site('www.youtube.com', 'direct'));
    await expect.poll(() => resolve('https://www.youtube.com/'), { timeout: 10_000 }).toBe('DIRECT');
    expect((await win.evaluate(() => L.vpn.route('m.youtube.com'))).why).toBe('exclude');
    await win.evaluate(() => L.vpn.site('youtube.com', 'vpn'));
    await expect.poll(() => resolve('https://www.youtube.com/'), { timeout: 10_000 }).toBe(`PROXY 127.0.0.1:${A.port}`);
    // сервер «умер» — браузер сам переходит на другой
    r = await win.evaluate((t) => L.vpn.add(t), `http://127.0.0.1:${B.port}#Сервер Б`);
    expect(r.ok, r.error).toBe(true);
    A.stop();
    await app.evaluate(() => global.__lqVpnHealth());
    await expect.poll(() => win.evaluate(() => L.vpn.state().then((s) => s.on && s.name)), { timeout: 30_000 }).toBe('Сервер Б');
    await expect.poll(() => resolve('https://www.youtube.com/'), { timeout: 10_000 }).toBe(`PROXY 127.0.0.1:${B.port}`);
    await expect(win.locator('#toast')).toContainText('переключил', { timeout: 5000 });
    // проверка скорости не падает (до интернета — через прокси Б)
    const sp = await win.evaluate(() => L.vpn.speed());
    expect(sp.ok ? sp.ping > 0 : typeof sp.error === 'string').toBe(true);
  } finally {
    await win.evaluate(() => L.vpn.disconnect()).catch(() => {});
    await win.evaluate(() => L.settings.set({ forgetVpn: true, vpnMode: 'smart' })).catch(() => {});
    A.stop(); B.stop();
  }
  await expect.poll(() => resolve('https://www.youtube.com/'), { timeout: 10_000 }).toBe('DIRECT');
});

test('VPN: подписка — серверы из ссылки', async () => {
  const r = await win.evaluate((u) => L.vpn.add(u), `${base}/sub?token=abc`);
  expect(r.ok, r.error).toBe(true);
  expect(r.list.map((x) => x.name)).toEqual(['Из подписки 1', 'Из подписки 2']);
  expect(r.list[1].proto).toBe('vless');
  expect(r.list.every((x) => x.sub === '127.0.0.1')).toBe(true);
  expect(r.subs[0].n).toBe(2);
  // кривой ключ — понятная ошибка
  const bad = await win.evaluate(() => L.vpn.add('привет'));
  expect(bad.ok).toBe(false);
  expect(bad.error).toMatch(/ключ|подписк/i);
  await win.evaluate(() => L.settings.set({ forgetVpn: true }));
  expect((await win.evaluate(() => L.vpn.servers())).list).toHaveLength(0);
});

// ---------------- сон вкладок ----------------
const tabState = (i) => win.evaluate((k) => { const t = tabs[k]; return { sleeping: !!t.sleeping, cls: t.el.classList.contains('sleeping'), url: t.url, wv: !!t.wv, typed: !!t.typed }; }, i);

test('сон вкладки: засыпает и просыпается на том же адресе и месте страницы', async () => {
  const i = await win.evaluate((u) => { createTab(u); return tabs.indexOf(active); }, `${base}/long.html`);
  await expect.poll(async () => (await activeUrl()).includes('/long.html') && (await inTab('document.readyState')) === 'complete', { timeout: 15_000 }).toBe(true);
  await inTab('scrollTo(0, 1500)');
  await win.evaluate((u) => createTab(u), `${base}/article.html`); // долгая статья уходит в фон
  expect(await win.evaluate((k) => sleepTab(tabs[k]), i)).toBe(true);
  const s = await tabState(i);
  expect(s).toMatchObject({ sleeping: true, cls: true, wv: false });
  expect(s.url).toContain('/long.html');
  await win.evaluate((k) => activate(tabs[k]), i); // клик по вкладке — просыпается
  await expect.poll(activeUrl, { timeout: 15_000 }).toContain('/long.html');
  expect((await tabState(i)).cls).toBe(false);
  await expect.poll(() => inTab('scrollY'), { timeout: 10_000 }).toBeGreaterThan(1000);
  await win.evaluate(() => { for (const t of tabs.slice(-2)) closeTab(t); });
});

test('не хватает памяти: усыпляет давние фоновые вкладки, не трогая ту, где печатают, — и говорит об этом', async () => {
  await win.evaluate((b) => { createTab(b + '/article.html?mem=1'); createTab(b + '/form.html'); }, base);
  await expect.poll(async () => (await activeUrl()).includes('/form.html') && (await inTab('document.readyState')) === 'complete', { timeout: 15_000 }).toBe(true);
  // печатаем в поле настоящими нажатиями (как человек) — вкладка помечается «тут вводят текст»
  await inTab(`document.getElementById('q').focus()`);
  const id = await win.evaluate(() => active.wv.getWebContentsId());
  await app.evaluate(({ webContents }, wcId) => { const w = webContents.fromId(wcId); for (const type of ['keyDown', 'char', 'keyUp']) w.sendInputEvent({ type, keyCode: 'a' }); }, id);
  await expect.poll(() => inTab(`document.getElementById('q').value`)).toMatch(/a/);
  const fi = await win.evaluate(() => tabs.indexOf(active));
  await expect.poll(() => tabState(fi).then((s) => s.typed)).toBe(true);
  await win.evaluate((u) => createTab(u), `${base}/article.html?mem=2`); // обе вкладки — в фоне
  const ai = fi - 1;
  await win.evaluate(() => { settings.sleepMem = 1; }); // порог в 1 МБ — памяти «не хватает» сразу
  const n = await win.evaluate(() => window.memPressureCheck());
  await win.evaluate(() => { settings.sleepMem = 1536; });
  expect(n).toBeGreaterThanOrEqual(1);
  expect(await tabState(ai)).toMatchObject({ sleeping: true, cls: true }); // давняя фоновая — спит
  expect(await tabState(fi)).toMatchObject({ sleeping: false, typed: true }); // с введённым текстом — нет
  expect(await win.evaluate(() => document.querySelector('#toast').textContent)).toMatch(/Усыпил \d+ фонов.* — не хватало памяти/);
  expect(await win.evaluate((k) => tabs[k].el.title, ai)).toContain('не хватало памяти');
  await expect.poll(() => logText(), { timeout: 5000 }).toMatch(/\[память\] Усыпил фоновых вкладок/);
  await win.evaluate(() => { for (const t of tabs.slice(-3)) closeTab(t); });
});

test('заминки основного процесса (для сведения)', async () => {
  const lines = logText().split('\n').filter((l) => /заминка|списки обновлены|блокировщик\]/.test(l));
  // итог одной строкой — для сравнения «до/после»: сколько заминок и сколько из них — своя работа основного процесса
  const ms = (re) => lines.map((l) => re.exec(l)).filter(Boolean).map((m) => +m[1]);
  const busy = ms(/Основной процесс был занят (\d+)/), wait = ms(/Основной процесс ждал (\d+)/), ui = ms(/Окно браузера было занято (\d+)/);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  lines.push(`ИТОГ заминок > 300 мс: основной процесс занят ${busy.length} (${sum(busy)} мс), ждал ${wait.length} (${sum(wait)} мс); окно ${ui.length} (${sum(ui)} мс)`);
  fs.writeFileSync(path.join(ROOT, 'test-results', 'stalls.txt'), lines.join('\n') + '\n'); // с концом строки — иначе последнюю не прочтёт шаг в GitHub
});

test('в журнале нет ошибок браузера', async () => {
  await win.waitForTimeout(1500); // журнал пишет пачками раз в секунду
  expect(logErrors()).toEqual([]);
});
