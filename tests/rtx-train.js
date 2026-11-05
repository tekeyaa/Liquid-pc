// Проверка кнопки «Обучить» (main/rtx-train.js) на чистой Windows: ставит свой Python и PyTorch (здесь — версию
// для процессора: у машины тестов нет видеокарты), учит на пробных данных в формате режима обучения и проверяет веса.
const fs = require('fs'), os = require('os'), path = require('path');
const { RtxTrain } = require('../main/rtx-train');
const { npy } = require('../main/rtx-learn');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lq-train-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
// пробные пары: узоры 512² и они же, уменьшенные вдвое (uint16, как пишет браузер). У двух роликов из трёх есть ещё
// прошлый кадр (_lp: тот же узор, сдвинутый на точку) — как собирает сбор с 1.35; третий — старых данных, без него
for (let v = 0; v < 3; v++) {
  const N = 6, hr = Buffer.alloc(N * 512 * 512 * 2), lr = Buffer.alloc(N * 256 * 256 * 2), lp = Buffer.alloc(N * 256 * 256 * 2), cid = Buffer.alloc(N * 4);
  for (let n = 0; n < N; n++) {
    const fx = 0.02 + 0.05 * Math.random(), fy = 0.02 + 0.05 * Math.random(), ph = Math.random() * 6;
    const H = (x, y) => 0.5 + 0.35 * Math.sin(x * fx + ph) * Math.cos(y * fy) + (((x >> 5) + (y >> 5)) % 2 ? 0.1 : -0.1);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) hr.writeUInt16LE(Math.round(Math.min(1, Math.max(0, H(x, y))) * 65535), 2 * (n * 512 * 512 + y * 512 + x));
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      let s = 0; for (let k = 0; k < 4; k++) s += hr.readUInt16LE(2 * (n * 512 * 512 + (2 * y + (k >> 1)) * 512 + 2 * x + (k & 1)));
      lr.writeUInt16LE(Math.round(s / 4), 2 * (n * 256 * 256 + y * 256 + x));
    }
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) lp.writeUInt16LE(lr.readUInt16LE(2 * (n * 256 * 256 + y * 256 + Math.max(0, x - 1))), 2 * (n * 256 * 256 + y * 256 + x));
    cid.writeInt32LE(n, 4 * n);
  }
  fs.writeFileSync(path.join(data, `v${v}_hr.npy`), npy('<u2', [6, 512, 512], hr));
  fs.writeFileSync(path.join(data, `v${v}_lr.npy`), npy('<u2', [6, 256, 256], lr));
  fs.writeFileSync(path.join(data, `v${v}_cid.npy`), npy('<i4', [6], cid));
  if (v < 2) fs.writeFileSync(path.join(data, `v${v}_lp.npy`), npy('<u2', [6, 256, 256], lp));
}
// аниме — в свою папку, как раскладывает режим обучения: для проверки «одной кнопки»
fs.mkdirSync(path.join(data, 'anime'));
for (const f of fs.readdirSync(data)) if (f.endsWith('.npy')) fs.copyFileSync(path.join(data, f), path.join(data, 'anime', f));
const out = path.join(root, 'out');
const T = new RtxTrain({ dir: path.join(root, 'train'), scripts: path.join(__dirname, '..', 'tools', 'rtx', 'gpu'), weights: path.join(__dirname, '..', 'main', 'rtx'),
  data, out, torchIndex: 'https://download.pytorch.org/whl/cpu', log: (...a) => console.log(...a), minLp: 10 });
const sane = (j) => j && Array.isArray(j.dims) && Array.isArray(j.layers) && j.layers.length === j.dims.length - 1 && j.dims[0] === 1 && j.dims[j.dims.length - 1] === 4
  && j.layers.every((l, i) => l.w.length === 9 * j.dims[i] && l.w.every((r) => r.length === j.dims[i + 1]) && l.b.length === j.dims[i + 1]);
async function go(extra, hours, net = 'pro') {
  const t0 = Date.now(); let last = '';
  T.start(net, extra, hours);
  while (T.busy) { await new Promise((r) => setTimeout(r, 1000)); const m = T.state().msg; if (m !== last) { console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}с] ${m}`); last = m; } }
  const st = T.state(); console.log('итог:', st.phase, st.msg, '| последняя строка:', T.lastLine);
  if (st.phase !== 'done') { console.log(T.lastTail || ''); console.error('::error::обучение не дошло до конца:', st.msg); process.exit(1); }
}
(async () => {
  await go(['--allow-cpu', '--steps', '20', '--batch', '4']);                  // дообучение встроенной сети (ставит Python и PyTorch)
  if (!T.ready()) { console.error('::error::Python/PyTorch не отмечены как готовые'); process.exit(1); }
  await go(['--allow-cpu', '--steps', '30', '--batch', '4', '--scratch']);     // с нуля — файл весов пишется всегда
  // срок (кнопки 3/6/12 ч): один заход на весь срок, здесь 40 с — должен уложиться и закончиться сам
  const t1 = Date.now();
  await go(['--allow-cpu', '--batch', '4'], 40 / 3600);
  const dt = (Date.now() - t1) / 1000;
  if (dt > 150 || T.result.best == null) { console.error(`::error::обучение по сроку: ${dt.toFixed(0)} с, проверка ${T.result.best}`); process.exit(1); }
  console.log(`по сроку: ${dt.toFixed(0)} с`);
  // «Обучить» (auto): одна сеть для всего — Liquid RTX 2 с нуля на всех данных, включая вложенную папку,
  // и следом она же на два кадра (данных с прошлым кадром здесь 24 пары из 4 роликов — с папкой anime — при пороге 10)
  await go(['--allow-cpu', '--steps', '20', '--batch', '4', '--scratch', '--no-baseline', '--always-save'], 0, 'auto');
  const nets = (T.result.nets || []).map((r) => r.name + (r.two ? '·2' : '')).join(',');
  if (nets !== 'rtx2,rtx2·2' || !fs.existsSync(path.join(out, 'liquid-rtx2.json')) || !T.mine()) { console.error('::error::«Обучить» выучило не Liquid RTX 2 на один и два кадра: ' + nets + ' — ' + T.state().msg); process.exit(1); }
  const two = T.result.nets[1];
  if (two.skip || two.first == null || !fs.existsSync(path.join(out, 'liquid-rtx2-2f.json')) || !T.state().two) { console.error('::error::сеть на два кадра не обучилась: ' + (two.skip || T.state().msg)); process.exit(1); }
  const j2 = JSON.parse(fs.readFileSync(path.join(out, 'liquid-rtx2-2f.json'), 'utf8'));
  if (j2.frames !== 2 || j2.layers[0].cin !== 2 || j2.layers[0].w.length !== 18 || j2.layers.slice(1).some((L, i) => L.cin !== JSON.parse(fs.readFileSync(path.join(out, 'liquid-rtx2.json'), 'utf8')).layers[i + 1].cin)) { console.error('::error::веса на два кадра не того формата'); process.exit(1); }
  // начинала ровно с сети на один кадр: проверка в начале совпала с её итогом (вход прошлого кадра был нулевым)
  console.log(`одна кнопка: ${nets} — ${T.state().msg} (на два кадра: в начале ${two.first} дБ, лучшая ${two.last} дБ; на один кадр — лучшая ${T.result.nets[0].last} дБ)`);
  // цепочка: сеть на PyTorch (как учится) == эталон на numpy по файлу (а эталон == шейдеры браузера — проверено отдельно)
  for (const g of ['liquid-rtx2.json', 'liquid-rtx2-2f.json']) await T.run(T.py, [path.join(__dirname, '..', 'tools', 'rtx', 'gpu', 'check_rtx2.py'), path.join(out, g)], (l) => console.log(l)).catch((e) => { console.error(`::error::PyTorch и эталон RTX 2 (${g}) расходятся: ` + e.message); process.exit(1); });
  // мало данных с прошлым кадром — сеть на два кадра не учится, и в строке обучения так и написано
  T.minLp = 1000;
  await go(['--allow-cpu', '--steps', '5', '--batch', '4', '--no-baseline'], 0, 'auto');
  if (!/мало данных с прошлым кадром \(собрано пар: 24, роликов: 4, нужно пар: 1000\)/.test(T.state().msg)) { console.error('::error::нет честного сообщения про мало данных: ' + T.state().msg); process.exit(1); }
  console.log('мало данных: ' + T.state().msg);
  T.minLp = 10;
  // дорисовка: дообучение RTX 2 с сетью-судьёй — свой файл и «с чего начинала», оба того же формата
  await go(['--allow-cpu', '--steps', '20', '--batch', '4'], 0, 'gan');
  for (const g of ['liquid-rtx2-gan.json', 'liquid-rtx2-gan-base.json']) {
    if (!fs.existsSync(path.join(out, g))) { console.error('::error::дорисовка не записала ' + g); process.exit(1); }
    await T.run(T.py, [path.join(__dirname, '..', 'tools', 'rtx', 'gpu', 'check_rtx2.py'), path.join(out, g)], (l) => console.log(l)).catch((e) => { console.error('::error::' + g + ': ' + e.message); process.exit(1); });
  }
  if (!T.state().gan) { console.error('::error::дорисовка не видна в состоянии'); process.exit(1); }
  console.log('дорисовка: ' + T.state().msg);
  const f = path.join(out, 'liquid-rtx-pro.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!sane(j) || j.F !== 24 || j.H !== 5) { console.error('::error::веса не того формата'); process.exit(1); }
  console.log('веса в порядке:', f, fs.statSync(f).size, 'байт, версия', j.version);
})().catch((e) => { console.error('::error::', e); process.exit(1); });
