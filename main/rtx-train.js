// Обучение Liquid RTX прямо из браузера: без установки руками. По кнопке «Обучить» Liquid сам ставит
// в %APPDATA%\Liquid\rtx-train\ отдельный Python (официальный embeddable с python.org) и PyTorch с CUDA,
// запускает tools/rtx/gpu/train_gpu.py на данных режима обучения и кладёт веса в %APPDATA%\Liquid\rtx\.
// Не зависит от Electron (проверяется отдельным тестом на Windows: tests/rtx-train.js).
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const PY_VER = '3.12.10';
const PY_URL = `https://www.python.org/ftp/python/${PY_VER}/python-${PY_VER}-embed-amd64.zip`;
const PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';
const SETUP_V = '1'; // поменять — поставится заново
const NETS = { pro: 'liquid-rtx-pro.json', lite: 'liquid-rtx.json', anime: 'liquid-rtx-anime.json' };

class RtxTrain {
  constructor({ dir, scripts, weights, data, out, log, torchIndex, onDone }) {
    Object.assign(this, { dir, scripts, weights, data, out, onDone });
    this.log = log || (() => {});
    this.torchIndex = torchIndex || 'https://download.pytorch.org/whl/cu126';
    this.py = path.join(dir, 'py', 'python.exe');
    this.st = { phase: 'idle', msg: '', pct: 0 };
    this.proc = null; this.stopping = false;
  }
  state() { return { ...this.st, running: !!this.busy, ready: this.ready() }; }
  ready() { try { return fs.readFileSync(path.join(this.dir, 'py', '.ready'), 'utf8') === SETUP_V; } catch { return false; } }
  set(phase, msg, pct) { this.st = { ...this.st, phase, msg, pct: pct ?? this.st.pct }; }

  async download(url, file, what) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${what}: ответ ${r.status}`);
    const total = Number(r.headers.get('content-length')) || 0;
    const fd = fs.openSync(file + '.part', 'w'); let got = 0;
    try { for await (const ch of r.body) { if (this.stopping) throw new Error('остановлено'); fs.writeSync(fd, ch); got += ch.length; if (total) this.set('setup', `${what}: ${Math.round(got / total * 100)}%`); } }
    finally { fs.closeSync(fd); }
    fs.renameSync(file + '.part', file);
  }
  // запуск с выводом построчно; onLine — разбор прогресса
  run(cmd, args, onLine, env) {
    return new Promise((ok, no) => {
      const p = this.proc = spawn(cmd, args, { cwd: this.dir, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONNOUSERSITE: '1', ...env } });
      let tail = '';
      const feed = (b) => { tail = (tail + b.toString('utf8')).slice(-4000); for (const l of b.toString('utf8').split(/\r?\n|\r/)) if (l.trim()) { this.lastLine = l.trim(); onLine && onLine(l.trim()); } };
      p.stdout.on('data', feed); p.stderr.on('data', feed);
      p.on('error', no);
      p.on('close', (code) => { this.proc = null; if (code === 0) ok(tail); else no(new Error(this.stopping ? 'остановлено' : (tail.trim().split(/\r?\n/).pop() || `код ${code}`).slice(0, 300))); });
    });
  }
  hasNvidia() {
    if (process.platform !== 'win32') return Promise.resolve(true);
    return new Promise((ok) => execFile('nvidia-smi', ['-L'], { windowsHide: true, timeout: 15000 }, (e, out) => ok(!e && /GPU/i.test(String(out)))));
  }
  async setup() {
    if (this.ready()) return;
    const pyDir = path.join(this.dir, 'py');
    fs.rmSync(pyDir, { recursive: true, force: true }); fs.mkdirSync(pyDir, { recursive: true });
    const zip = path.join(this.dir, 'python.zip');
    this.set('setup', 'Скачиваю Python…', 2);
    await this.download(PY_URL, zip, 'Python');
    await this.run('tar', ['-xf', zip, '-C', pyDir]);  // tar есть в Windows 10/11 и умеет zip
    fs.rmSync(zip, { force: true });
    // embeddable-Python по умолчанию не видит site-packages — включаем
    const pth = fs.readdirSync(pyDir).find((f) => /^python\d+\._pth$/.test(f));
    if (!pth) throw new Error('не тот архив Python');
    fs.writeFileSync(path.join(pyDir, pth), fs.readFileSync(path.join(pyDir, pth), 'utf8').replace(/^#\s*import site/m, 'import site') + '\nLib\\site-packages\n');
    this.set('setup', 'Ставлю pip…', 5);
    const gp = path.join(this.dir, 'get-pip.py');
    await this.download(PIP_URL, gp, 'pip');
    await this.run(this.py, [gp, '--no-warn-script-location']);
    this.set('setup', 'Скачиваю PyTorch (~2,5 ГБ, один раз)…', 10);
    await this.run(this.py, ['-m', 'pip', 'install', '--no-warn-script-location', '--progress-bar', 'off', 'torch', '--index-url', this.torchIndex], (l) => {
      const m = l.match(/Downloading (\S+?)-[\d.]+.*\(([\d.]+ [kMG]B)\)/); if (m) this.set('setup', `Скачиваю ${m[1]} (${m[2]})…`);
      if (/^Installing collected/.test(l)) this.set('setup', 'Устанавливаю PyTorch…', 80);
    });
    await this.run(this.py, ['-m', 'pip', 'install', '--no-warn-script-location', '--progress-bar', 'off', 'numpy']);
    fs.writeFileSync(path.join(pyDir, '.ready'), SETUP_V);
    this.log('info', 'Liquid RTX обучение', 'Python и PyTorch установлены');
  }
  // скрипты — из приложения (они в app.asar, Python его не читает) — копируем рядом
  prepScripts() {
    const d = path.join(this.dir, 'scripts'); fs.mkdirSync(d, { recursive: true });
    for (const f of ['train_gpu.py', 'rtxfmt.py']) fs.writeFileSync(path.join(d, f), fs.readFileSync(path.join(this.scripts, f)));
    for (const f of Object.values(NETS)) { const src = path.join(this.weights, f); if (fs.existsSync(src)) fs.writeFileSync(path.join(d, f), fs.readFileSync(src)); }
    return d;
  }
  start(net = 'pro', extra = []) {
    if (this.busy) return false;
    if (!NETS[net]) net = 'pro';
    this.stopping = false; this.result = null;
    this.set('setup', 'Проверяю видеокарту…', 0);
    this.busy = (async () => {
      if (!extra.includes('--allow-cpu') && !(await this.hasNvidia())) throw new Error('нужна видеокарта NVIDIA (не нашёл nvidia-smi — обнови драйвер)');
      await this.setup();
      const d = this.prepScripts();
      fs.mkdirSync(this.out, { recursive: true });
      this.set('train', 'Обучение: запуск…', 0);
      let v0 = null, best = null;
      await this.run(this.py, ['-u', path.join(d, 'train_gpu.py'), '--net', net, '--data', this.data, '--out', path.join(this.out, NETS[net]), ...extra], (l) => {
        let m;
        if ((m = l.match(/сеть в начале ([\d.]+)/))) v0 = +m[1];
        if ((m = l.match(/^(\d+)\/(\d+) потери.*?осталось ~(\d+) мин/))) this.set('train', `Обучение: ${Math.round(m[1] / m[2] * 100)}%, осталось ~${m[3]} мин` + (best ? ` · лучше на ${(best - v0).toFixed(2).replace('.', ',')} дБ` : ''), m[1] / m[2] * 100);
        if ((m = l.match(/проверка ([\d.]+) дБ/)) && v0 != null) best = Math.max(best || v0, +m[1]);
        if (/^В .* пока нет данных/.test(l)) this.set('train', l);
      });
      this.result = { v0, best, better: best != null && v0 != null && best > v0 };
      this.set('done', this.result.better ? `Готово: сеть стала точнее на ${(best - v0).toFixed(2).replace('.', ',')} дБ — уже работает в новых вкладках` : 'Готово: на этих данных сеть лучше не стала — оставил прежнюю. Соберите больше разных роликов', 100);
      this.log('info', 'Liquid RTX обучение', this.st.msg);
      if (this.onDone) this.onDone(this.result);
    })().catch((e) => {
      if (this.stopping) { this.set('idle', this.st.phase === 'train' ? 'Остановлено. Лучший результат уже сохранён' : 'Остановлено', 0); return; }
      this.set('error', `Не вышло: ${e.message}`); this.log('warn', 'Liquid RTX обучение', e.message);
    })
      .finally(() => { this.busy = null; });
    return true;
  }
  stop() {
    this.stopping = true;
    if (this.proc) { try { if (process.platform === 'win32') execFile('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true }); else this.proc.kill(); } catch {} }
  }
}

module.exports = { RtxTrain, NETS };
