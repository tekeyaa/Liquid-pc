// Обучение Liquid RTX прямо из браузера: без установки руками. По кнопке «Обучить» Liquid сам ставит
// в %APPDATA%\Liquid\rtx-train\ отдельный Python (официальный embeddable с python.org) и PyTorch с CUDA,
// запускает tools/rtx/gpu/train_gpu.py на данных режима обучения и кладёт веса в %APPDATA%\Liquid\rtx\.
// Не зависит от Electron (проверяется отдельным тестом на Windows: tests/rtx-train.js).
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const PY_VER = '3.12.10';
const PY_URL = `https://www.python.org/ftp/python/${PY_VER}/python-${PY_VER}-embed-amd64.zip`;
// pip — готовый wheel (это zip) закреплённой версии: распаковываем прямо в site-packages. get-pip.py не берём:
// его новые версии отказываются ставить pip во встроенный Python на Windows («To modify pip, please run…»)
const PIP_URL = 'https://files.pythonhosted.org/packages/py3/p/pip/pip-24.3.1-py3-none-any.whl';
const SETUP_V = '1'; // поменять — поставится заново
const NETS = { pro: 'liquid-rtx-pro.json', lite: 'liquid-rtx.json', anime: 'liquid-rtx-anime.json' };

class RtxTrain {
  constructor({ dir, scripts, weights, data, out, log, torchIndex, onDone }) {
    Object.assign(this, { dir, scripts, weights, data, out, onDone });
    this.log = log || (() => {});
    this.torchIndex = torchIndex || 'https://download.pytorch.org/whl/cu126';
    this.py = path.join(dir, 'py', 'python.exe');
    this.st = { phase: 'idle', msg: '', pct: 0 };
    this.proc = null; this.stopping = false; this.minGain = 0.1; this.minLeft = 5 * 60e3;
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
      p.on('close', (code) => {
        this.proc = null; this.lastTail = tail;
        if (code === 0) return ok(tail);
        // в сообщение — сама ошибка, а не последняя строка (pip в конце пишет подсказку, а не причину)
        const lines = tail.trim().split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        const why = [...lines].reverse().find((x) => /error|exception|не\s/i.test(x) && !/--force-reinstall/.test(x)) || lines.pop() || `код ${code}`;
        no(new Error(this.stopping ? 'остановлено' : why.slice(0, 300)));
      });
    });
  }
  // сеть бывает капризной: шаги установки повторяем до 3 раз
  async retry(fn) {
    for (let k = 1; ; k++) {
      try { return await fn(); } catch (e) { if (this.stopping || k >= 3) throw e; this.log('warn', 'Liquid RTX обучение', `повтор ${k}: ${e.message}`); await new Promise((r) => setTimeout(r, 5000 * k)); }
    }
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
    const site = path.join(pyDir, 'Lib', 'site-packages'); fs.mkdirSync(site, { recursive: true });
    const whl = path.join(this.dir, 'pip.whl');
    await this.retry(async () => { await this.download(PIP_URL, whl, 'pip'); await this.run('tar', ['-xf', whl, '-C', site]); await this.run(this.py, ['-m', 'pip', '--version']); });
    fs.rmSync(whl, { force: true });
    this.set('setup', 'Скачиваю PyTorch (~2,5 ГБ, один раз)…', 10);
    await this.retry(() => this.run(this.py, ['-m', 'pip', 'install', '--no-warn-script-location', '--progress-bar', 'off', 'torch', '--index-url', this.torchIndex], (l) => {
      const m = l.match(/Downloading (\S+?)-[\d.]+.*\(([\d.]+ [kMG]B)\)/); if (m) this.set('setup', `Скачиваю ${m[1].split('/').pop()} (${m[2]})…`);
      if (/^Installing collected/.test(l)) this.set('setup', 'Устанавливаю PyTorch…', 80);
    }));
    await this.retry(() => this.run(this.py, ['-m', 'pip', 'install', '--no-warn-script-location', '--progress-bar', 'off', 'numpy']));
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
  // Обучение кругами. Круг — полное обучение (~40 минут на RTX 4070) от лучшей версии прошлого круга: улучшилась —
  // записалась, и следующий круг начинается уже с неё. Без срока — один круг. Со сроком (3/6/12 ч) — круги, пока
  // не выйдет время или пока круг не даст меньше +0,1 дБ: дальше сеть на этих данных почти не растёт, нужны новые.
  // net 'auto' (кнопка «Обучить»): сеть для видео на общих данных, а если режим обучения набрал аниме (от 3 роликов,
  // папка data/anime) — следом и сеть для аниме. Со сроком время делится: видео 70 %, аниме 30 %
  start(net = 'auto', extra = [], hours = 0) {
    hours = Math.max(0, Number(hours) || 0);
    if (this.busy) return false;
    const animeDir = path.join(this.data, 'anime');
    const nAnime = (() => { try { return fs.readdirSync(animeDir).filter((f) => f.endsWith('_hr.npy')).length; } catch { return 0; } })();
    const plan = net === 'auto' || !NETS[net]
      ? [['pro', this.data, 'видео', 0.7], ...(nAnime >= 3 ? [['anime', animeDir, 'аниме', 0.3]] : [])]
      : [[net, net === 'anime' ? animeDir : this.data, net === 'anime' ? 'аниме' : 'видео', 1]];
    this.stopping = false; this.result = null;
    this.set('setup', 'Проверяю видеокарту…', 0);
    const fmt = (min) => (min >= 90 ? `${Math.floor(min / 60)} ч ${Math.round(min % 60)} мин` : `${Math.round(min)} мин`);
    const db = (x) => x.toFixed(2).replace('.', ',');
    const deadlineAll = hours ? Date.now() + hours * 3600e3 : 0;
    this.busy = (async () => {
      if (!extra.includes('--allow-cpu') && !(await this.hasNvidia())) throw new Error('нужна видеокарта NVIDIA (не нашёл nvidia-smi — обнови драйвер)');
      await this.setup();
      const d = this.prepScripts();
      fs.mkdirSync(this.out, { recursive: true });
      const results = [];
      for (let pi = 0; pi < plan.length; pi++) {
        const [name, data, label, share] = plan[pi];
        const out = path.join(this.out, NETS[name]);
        const restShare = plan.slice(pi).reduce((a, p) => a + p[3], 0);
        const deadline = hours ? Date.now() + Math.max(0, deadlineAll - Date.now()) * (share / restShare) : 0;
        const tag = plan.length > 1 ? `Сеть для ${label}` : 'Обучение';
        let round = 0, first = null, last = null, lastDur = 0, why = '';
        for (;;) {
          round++;
          const args = [...extra];
          const left = deadline - Date.now();
          if (hours && lastDur && left < lastDur * 1.1) args.push('--hours', String(Math.max(left, 60e3) / 3600e3)); // последний круг — сколько осталось
          if (round > 1 && fs.existsSync(out)) args.push('--init', out);
          this.set('train', `${tag}${hours ? `, круг ${round}` : ''}: запуск…`, 0);
          const t0 = Date.now();
          let v0 = null, best = null;
          await this.run(this.py, ['-u', path.join(d, 'train_gpu.py'), '--net', name, '--data', data, '--out', out, ...args], (l) => {
            let m;
            if ((m = l.match(/сеть в начале ([\d.]+)/))) { v0 = +m[1]; if (first == null) first = v0; }
            if ((m = l.match(/проверка ([\d.]+) дБ/)) && v0 != null) best = Math.max(best ?? v0, +m[1]);
            if ((m = l.match(/^(\d+)\/(\d+) потери.*?осталось ~(\d+) мин/))) {
              const pct = Math.round(m[1] / m[2] * 100);
              const tot = hours ? `, всего осталось ~${fmt(Math.max(0, deadlineAll - Date.now()) / 60e3)}` : `, осталось ~${fmt(+m[3])}`;
              const gain = best != null && first != null && best > first ? ` · лучше на ${db(best - first)} дБ` : '';
              this.set('train', `${tag}${hours ? `, круг ${round}` : ''}: ${pct}%${tot}${gain}`, pct);
            }
            if (/^В .* пока нет данных/.test(l)) this.set('train', l);
          });
          lastDur = Date.now() - t0;
          const gain = best != null && v0 != null ? best - v0 : 0;
          if (best != null && best > (last ?? -1)) last = best;
          if (!hours) break;
          this.log('info', 'Liquid RTX обучение', `${label}, круг ${round}: ${gain > 0 ? '+' + db(gain) : 'без прибавки'} дБ`);
          if (gain < this.minGain) { why = 'gain'; break; }
          if (deadline - Date.now() < this.minLeft) { why = 'time'; break; }
        }
        results.push({ name, label, first, last, round, why, total: last != null && first != null ? last - first : 0 });
      }
      const r0 = results[0];
      this.result = { v0: r0.first, best: r0.last, better: results.some((r) => r.total > 0), rounds: results.reduce((a, r) => a + r.round, 0), nets: results };
      const part = (r) => (results.length > 1 ? `${r.label}: ` : '') + (r.total > 0 ? `точнее на ${db(r.total)} дБ` : 'лучше не стала — оставил прежнюю');
      const anyGain = results.some((r) => r.why === 'gain');
      this.set('done', `Готово${hours ? ` за ${this.result.rounds} ${this.result.rounds === 1 ? 'круг' : this.result.rounds < 5 ? 'круга' : 'кругов'}` : ''} — ${results.map(part).join(' · ')}`
        + (this.result.better ? '. Уже работает в новых вкладках' : '. Соберите больше разных роликов')
        + (anyGain ? '. Круги перестали давать прибавку (меньше +0,1 дБ) — дальше нужны новые ролики' : ''), 100);
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
