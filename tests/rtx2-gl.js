// Проверка шейдеров Liquid RTX 2: движок браузера (раздел 7 webview-preload.js) в Chromium без видеокарты
// (SwiftShader) считает сеть со случайными весами на кадре нечётного размера, а итог (текстура res) сравнивается
// с эталоном на numpy (tools/rtx/gpu/rtx2.py → forward_np). Проверяются оба вида сети — на один кадр и на два,
// разные способы делить слой на проходы (SR_MAXG), и что память не растёт при смене сетей и размеров.
// Запуск: node tests/rtx2-gl.js  (нужны python3 с numpy и playwright с chromium)
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const src = fs.readFileSync(path.join(ROOT, 'webview-preload.js'), 'utf8');
const a = src.indexOf('const SR_VS = `'), b = src.indexOf('// ---------- 7в.');
if (a < 0 || b < a) { console.error('::error::не нашёл раздел 7 в webview-preload.js'); process.exit(1); }
// раздел 7: шейдеры, RtxEngine, замер; из браузера ему нужны только веса (ipcRenderer) и настройки видео (vt)
const SECTION = src.slice(a, b);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lq-rtx2-gl-'));
const ref = (w, h, frames, seed) => {
  const f = path.join(tmp, `ref-${w}x${h}-${frames}-${seed}.json`);
  execFileSync(PY, [path.join(__dirname, 'rtx2_ref.py'), f, String(w), String(h), String(frames), String(seed)], { stdio: 'inherit' });
  return JSON.parse(fs.readFileSync(f, 'utf8'));
};

// в странице: движок, сеть, два кадра (прошлый и текущий) → текстура res
async function runCase(page, R, maxG, preG) {
  return page.evaluate(async ({ R, maxG, preG }) => {
    SR_MAXG = maxG; SR_PREG = preG;
    const cv = document.createElement('canvas'), E = new RtxEngine(cv), gl = E.gl;
    try {
      E.size(R.w * 2, R.h * 2);
      const N = E.loadNet2('rtx2', R.net);
      for (let i = 0; i < 600 && !E.netReady(N); i++) await new Promise((r) => setTimeout(r, 50)); // шейдеры собираются в фоне
      if (!E.netReady(N)) return { err: 'шейдер не собрался' };
      const img = (vals) => { const d = new ImageData(R.w, R.h); vals.forEach((v, i) => { d.data[4 * i] = d.data[4 * i + 1] = d.data[4 * i + 2] = v; d.data[4 * i + 3] = 255; }); return d; };
      E.upload(img(R.prev), R.w, R.h); E.upload(img(R.cur), R.w, R.h);
      E.drawNet2(N, R.w, R.h, [0, 0, 1, 1]);
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, E.nb2.tRes, 0);
      const px = new Float32Array(R.w * R.h * 4); gl.readPixels(0, 0, R.w, R.h, gl.RGBA, gl.FLOAT, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb);
      let worst = 0, scale = 0;
      for (let y = 0; y < R.h; y++) for (let x = 0; x < R.w; x++) for (let k = 0; k < 4; k++) {
        const e = R.res[(k * R.h + y) * R.w + x], g = px[(y * R.w + x) * 4 + k];
        worst = Math.max(worst, Math.abs(e - g)); scale = Math.max(scale, Math.abs(e));
      }
      return { worst, scale, passes: N.layers.length, two: !!N.two, err: gl.getError() || null };
    } finally { E.destroy(); }
  }, { R, maxG, preG });
}

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[страница]', m.text()); });
  await page.setContent('<!doctype html><title>rtx2</title>');
  await page.addScriptTag({ content: 'const ipcRenderer = { invoke: async () => null, send() {} }; const vt = {};\n' + SECTION + '\nwindow.__ok = 1;' });
  if (!(await page.evaluate(() => window.__ok))) throw new Error('раздел 7 не загрузился');
  let fail = 0;
  const LIM = 3e-4; // fp16 в признаках: ~1e-4
  // способы деления на проходы: по 8 / 4 / 3 выхода, «#pre» отдельно по 4 и по 2 (их выбирает замер на видеокарте)
  const ways = { 1: [[8, 0], [3, 0], [8, 2]], 2: [[8, 0], [4, 0], [6, 2]] };
  for (const [w, h, frames, seed] of [[61, 45, 1, 1], [61, 45, 2, 2], [37, 29, 2, 5]]) {
    const R = ref(w, h, frames, seed);
    for (const [g, pg] of w === 37 ? [[8, 4]] : ways[frames]) {
      const r = await runCase(page, R, g, pg);
      const ok = !r.err && r.worst < LIM && r.two === (frames === 2);
      if (!ok) fail++;
      console.log(`${ok ? 'ok ' : 'ПЛОХО'} ${w}×${h}, кадров ${frames}, по ${g}${pg ? `, #pre по ${pg}` : ''}: проходов ${r.passes}, расхождение ${r.worst != null ? r.worst.toExponential(2) : '—'} (величина ${r.scale != null ? r.scale.toFixed(3) : '—'})${r.err ? ' ошибка ' + r.err : ''}`);
    }
  }
  // память: смена сетей, размеров и пересоздание движка — счётчики объектов WebGL не растут
  const leak = await page.evaluate(async ({ R1, R2 }) => {
    const cnt = { tex: 0, fb: 0, buf: 0, q: 0, prog: 0, sync: 0 };
    const P = WebGL2RenderingContext.prototype, wrap = (mk, del, k) => { const m = P[mk], d = P[del]; P[mk] = function (...x) { cnt[k]++; return m.apply(this, x); }; P[del] = function (o) { if (o) cnt[k]--; return d.call(this, o); }; };
    wrap('createTexture', 'deleteTexture', 'tex'); wrap('createFramebuffer', 'deleteFramebuffer', 'fb'); wrap('createBuffer', 'deleteBuffer', 'buf');
    wrap('createQuery', 'deleteQuery', 'q'); wrap('createProgram', 'deleteProgram', 'prog'); wrap('fenceSync', 'deleteSync', 'sync');
    SR_MAXG = 8; SR_PREG = 0;
    const E = new RtxEngine(document.createElement('canvas'));
    const wait = async (N) => { for (let i = 0; i < 600 && !E.netReady(N); i++) await new Promise((r) => setTimeout(r, 50)); };
    const N1 = E.loadNet2('rtx2', R1.net); let N2 = E.loadNet2('gan', R2.net); await wait(N1); await wait(N2);
    E.nets.rtx2 = N1; E.nets.gan = N2;
    const img = (w, h) => { const d = new ImageData(w, h); for (let i = 0; i < d.data.length; i++) d.data[i] = (i * 37) & 255; return d; };
    const snap = [];
    for (let round = 0; round < 6; round++) {
      for (const [w, h] of [[61, 45], [40, 30], [61, 45]]) {
        E.size(w * 2, h * 2); E.upload(img(w, h), w, h); E.drawNet2(N1, w, h, [0, 0, 1, 1]); E.drawNet2(N2, w, h, [0, 0, 1, 1]);
        E.slower(); E.faster();
      }
      E.dropNet('gan'); N2 = E.loadNet2('gan', R2.net); await wait(N2); E.nets.gan = N2;
      E.drawNet2(N2, 61, 45, [0, 0, 1, 1]);
      if (round >= 1) snap.push(JSON.stringify(cnt));
    }
    E.freeAll(); const after = { ...cnt };
    // сколько видеопамяти на плеер 1080p → 4K (только выделение, без счёта: SwiftShader считал бы минуты)
    E.size(3840, 2160); E.lastSrcBytes = 1920 * 1080 * 4; E.debMem = 1920 * 1080 * 8;
    const B2 = E.netAlloc2(N1, 1920, 1080);
    const MB = (x) => Math.round(x / 1048576);
    const vram = { out: MB(E.mem.out), common: MB(E.cb.mem), rtx2: MB(B2.mem), total: E.vram() };
    E.freeAll();
    E.destroy();
    return { snap, after, vram };
  }, { R1: ref(61, 45, 1, 7), R2: ref(61, 45, 2, 8) });
  const steady = new Set(leak.snap).size === 1;
  console.log(`${steady ? 'ok ' : 'ПЛОХО'} память при смене сетей и размеров: ${leak.snap[0]} → ${leak.snap[leak.snap.length - 1]}; после освобождения ${JSON.stringify(leak.after)}`);
  if (!steady) fail++;
  const V = leak.vram;
  console.log(`видеопамять движка, 1080p → 4K с Liquid RTX 2: всего ~${V.total} МБ (сеть ${V.rtx2}, яркость 2× и цвет ${V.common}, кадр экрана ${V.out}, исходный кадр и без полос — остальное)`);
  if (V.rtx2 > 160) { console.error(`::error::буферы RTX 2 на 1080p: ${V.rtx2} МБ — больше 160`); fail++; }
  // очередь видеокарты (зависание 1.34–1.35): не больше двух недосчитанных кадров, отметки не копятся, после — свободно
  const q = await page.evaluate(async () => {
    const E = new RtxEngine(document.createElement('canvas')), gl = E.gl, r = {};
    E.gpuMark(); r.one = E.gpuBusy();
    for (let i = 0; i < 5; i++) { E.gpuMark(); E.gpuBusy(); }
    r.many = E.gpuBusy(); r.len = E.gq.length;
    gl.finish(); await new Promise((ok) => setTimeout(ok, 100));
    r.after = E.gpuBusy(); r.lenAfter = E.gq.length;
    E.gpuSkip(1); E.gpuSkip(1); E.gpuSkip(2); r.skip = E.skipN;
    E.destroy(); return r;
  });
  const qOk = q.after === false && q.lenAfter === 0 && q.len <= 7 && q.skip === 2;
  console.log(`${qOk ? 'ok ' : 'ПЛОХО'} очередь видеокарты: ${JSON.stringify(q)}`);
  if (!qOk) fail++;
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (fail) { console.error(`::error::шейдеры Liquid RTX 2 расходятся с эталоном или течёт память: ${fail}`); process.exit(1); }
  console.log('Liquid RTX 2: шейдеры == эталон numpy');
})().catch((e) => { console.error('::error::', e); process.exit(1); });
