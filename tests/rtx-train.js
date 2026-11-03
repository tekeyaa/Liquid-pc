// Проверка кнопки «Обучить» (main/rtx-train.js) на чистой Windows: ставит свой Python и PyTorch (здесь — версию
// для процессора: у машины тестов нет видеокарты), учит на пробных данных в формате режима обучения и проверяет веса.
const fs = require('fs'), os = require('os'), path = require('path');
const { RtxTrain } = require('../main/rtx-train');
const { npy } = require('../main/rtx-learn');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lq-train-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
// пробные пары: узоры 512² и они же, уменьшенные вдвое (uint16, как пишет браузер)
for (let v = 0; v < 3; v++) {
  const N = 6, hr = Buffer.alloc(N * 512 * 512 * 2), lr = Buffer.alloc(N * 256 * 256 * 2), cid = Buffer.alloc(N * 4);
  for (let n = 0; n < N; n++) {
    const fx = 0.02 + 0.05 * Math.random(), fy = 0.02 + 0.05 * Math.random(), ph = Math.random() * 6;
    const H = (x, y) => 0.5 + 0.35 * Math.sin(x * fx + ph) * Math.cos(y * fy) + (((x >> 5) + (y >> 5)) % 2 ? 0.1 : -0.1);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) hr.writeUInt16LE(Math.round(Math.min(1, Math.max(0, H(x, y))) * 65535), 2 * (n * 512 * 512 + y * 512 + x));
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      let s = 0; for (let k = 0; k < 4; k++) s += hr.readUInt16LE(2 * (n * 512 * 512 + (2 * y + (k >> 1)) * 512 + 2 * x + (k & 1)));
      lr.writeUInt16LE(Math.round(s / 4), 2 * (n * 256 * 256 + y * 256 + x));
    }
    cid.writeInt32LE(n, 4 * n);
  }
  fs.writeFileSync(path.join(data, `v${v}_hr.npy`), npy('<u2', [6, 512, 512], hr));
  fs.writeFileSync(path.join(data, `v${v}_lr.npy`), npy('<u2', [6, 256, 256], lr));
  fs.writeFileSync(path.join(data, `v${v}_cid.npy`), npy('<i4', [6], cid));
}
// аниме — в свою папку, как раскладывает режим обучения: для проверки «одной кнопки»
fs.mkdirSync(path.join(data, 'anime'));
for (const f of fs.readdirSync(data)) if (f.endsWith('.npy')) fs.copyFileSync(path.join(data, f), path.join(data, 'anime', f));
const out = path.join(root, 'out');
const T = new RtxTrain({ dir: path.join(root, 'train'), scripts: path.join(__dirname, '..', 'tools', 'rtx', 'gpu'), weights: path.join(__dirname, '..', 'main', 'rtx'),
  data, out, torchIndex: 'https://download.pytorch.org/whl/cpu', log: (...a) => console.log(...a) });
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
  // круги по времени (кнопки 3/6/12 ч): здесь срок 40 с и круги по 20 шагов — кругов должно быть несколько,
  // каждый следующий — от лучшей версии прошлого; порог «меньше +0,1 дБ — стоп» здесь выключен
  T.minGain = -1; T.minLeft = 0;
  const t1 = Date.now();
  await go(['--allow-cpu', '--steps', '20', '--batch', '4'], 40 / 3600);
  const dt = (Date.now() - t1) / 1000;
  if (!(T.result.rounds >= 2) || dt > 150) { console.error(`::error::круги: ${T.result.rounds}, ${dt.toFixed(0)} с`); process.exit(1); }
  console.log(`круги: ${T.result.rounds} за ${dt.toFixed(0)} с`);
  // «Обучить» (auto): одна сеть для всего — Ultra на всех данных, включая вложенную папку (старая anime)
  T.minGain = 0.1; T.minLeft = 5 * 60e3;
  await go(['--allow-cpu', '--steps', '20', '--batch', '4', '--scratch'], 0, 'auto');
  const nets = (T.result.nets || []).map((r) => r.name).join(',');
  if (nets !== 'ultra' || !fs.existsSync(path.join(out, 'liquid-rtx-ultra.json')) || !T.mine()) { console.error('::error::«Обучить» выучило не одну Ultra: ' + nets); process.exit(1); }
  console.log('одна кнопка: ' + nets + ' — ' + T.state().msg);
  // Ultra из Pro: своих весов Ultra нет — первый круг стартует с выращенной Pro, «в начале» — та же точность
  fs.rmSync(path.join(out, 'liquid-rtx-ultra.json'), { force: true });
  await go(['--allow-cpu', '--steps', '10', '--batch', '4'], 0, 'ultra');
  if (!/выращена до 32×6/.test(T.lastTail || '')) { console.log(T.lastTail); console.error('::error::Ultra не выросла из Pro'); process.exit(1); }
  console.log('Ultra выросла из Pro');
  const f = path.join(out, 'liquid-rtx-pro.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!sane(j) || j.F !== 24 || j.H !== 5) { console.error('::error::веса не того формата'); process.exit(1); }
  console.log('веса в порядке:', f, fs.statSync(f).size, 'байт, версия', j.version);
})().catch((e) => { console.error('::error::', e); process.exit(1); });
