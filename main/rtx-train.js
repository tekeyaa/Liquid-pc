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
const GAN = 'liquid-rtx2-gan.json'; // дорисовка: RTX 2, дообученная с сетью-судьёй (рядом -base.json — с чего начинала)
const NETS = { rtx2: 'liquid-rtx2.json', pro: 'liquid-rtx-pro.json', lite: 'liquid-rtx.json', anime: 'liquid-rtx-anime.json' };
const TWO = 'liquid-rtx2-2f.json'; // Liquid RTX 2 на два кадра (второй вход — прошлый кадр), учится поверх сети на один кадр

// сколько пар с прошлым кадром собрано (<ролик>_lp.npy, с 1.35): число — из заголовка .npy, сам файл не читаем
function lpPairs(dir) {
  let n = 0, files = 0;
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (!e.name.endsWith('_lp.npy') || !fs.existsSync(f.replace(/_lp\.npy$/, '_lr.npy'))) continue;
      try { const fd = fs.openSync(f, 'r'), b = Buffer.alloc(256); fs.readSync(fd, b, 0, 256, 0); fs.closeSync(fd);
        const m = b.toString('latin1').match(/'shape': \((\d+),/); if (m) { n += +m[1]; files++; } } catch {}
    } };
  walk(dir);
  return { n, files };
}

class RtxTrain {
  constructor({ dir, scripts, weights, data, out, log, torchIndex, onDone, minLp }) {
    Object.assign(this, { dir, scripts, weights, data, out, onDone });
    this.log = log || (() => {});
    this.torchIndex = torchIndex || 'https://download.pytorch.org/whl/cu126';
    this.py = path.join(dir, 'py', 'python.exe');
    this.st = { phase: 'idle', msg: '', pct: 0 };
    this.proc = null; this.stopping = false; this.minGain = 0.1; this.minLeft = 5 * 60e3;
    this.minLp = minLp || 300; // столько пар с прошлым кадром нужно, чтобы учить сеть на два кадра
  }
  state() { return { ...this.st, running: !!this.busy, ready: this.ready(), mine: this.mine(), gan: this.gan(), two: this.two() }; }
  // своя сеть на два кадра: когда записана (null — нет)
  two() { try { return { at: fs.statSync(path.join(this.out, TWO)).mtimeMs }; } catch { return null; } }
  // своя обученная сеть (Liquid RTX 2): есть ли, когда обучалась, сколько прибавила
  gan() { return fs.existsSync(path.join(this.out, GAN)) && fs.existsSync(path.join(this.out, GAN.replace('.json', '-base.json'))); }
  mine() {
    if (!fs.existsSync(path.join(this.out, NETS.rtx2))) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.out, 'liquid-rtx2.meta.json'), 'utf8')); } catch { return {}; }
  }
  // «твоя сеть»: когда обучалась и насколько точнее Pro на проверочных кадрах (и после «Остановить» — лучшее уже записано)
  writeMeta() {
    const r = this.run0, mf = path.join(this.out, 'liquid-rtx2.meta.json'); this.run0 = null;
    if (!fs.existsSync(path.join(this.out, NETS.rtx2))) { try { fs.unlinkSync(mf); } catch {} return; }
    if (!r || r.gan) return;
    let saved = false; try { saved = fs.statSync(r.out).mtimeMs >= r.t0; } catch {}
    if (!saved || r.best == null) return;
    let m = {}; try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch {}
    try { fs.writeFileSync(mf, JSON.stringify({ at: Date.now(), vsPro: r.bar != null ? r.best - r.bar : null, times: (m.times || 0) + 1 })); } catch {}
  }
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
    for (const f of ['train_gpu.py', 'rtxfmt.py', 'rtx2.py', 'rtx2_torch.py', 'check_rtx2.py']) fs.writeFileSync(path.join(d, f), fs.readFileSync(path.join(this.scripts, f)));
    for (const f of Object.values(NETS)) { const src = path.join(this.weights, f); if (fs.existsSync(src)) fs.writeFileSync(path.join(d, f), fs.readFileSync(src)); }
    return d;
  }
  // Обучение. Без срока — один заход (~100 тыс. шагов). Со сроком (3/6/12 ч) — один заход на весь срок, шаг обучения
  // плавно спадает к концу. Лучшие веса train_gpu сам записывает по ходу (только если стало лучше), .pt — для продолжения.
  start(net = 'auto', extra = [], hours = 0) {
    hours = Math.max(0, Number(hours) || 0);
    if (this.busy) return false;
    // одна сеть для всего: Liquid RTX 2 на всех собранных роликах (train_gpu берёт и вложенные папки — старая data/anime тоже)
    const gan = net === 'gan';
    if (gan && !fs.existsSync(path.join(this.out, NETS.rtx2)) && !fs.existsSync(path.join(this.out, NETS.rtx2 + '.pt'))) {
      this.set('error', 'Сначала обычное обучение: дорисовка учится поверх твоей Liquid RTX 2'); return false;
    }
    const plan = gan || net === 'auto' || !NETS[net] ? [['rtx2', this.data, gan ? 'дорисовка' : 'видео', 1]] : [[net, this.data, 'видео', 1]];
    // «Обучить»: следом — сеть на два кадра (треть срока), если собрано достаточно пар с прошлым кадром. Мало — честно
    // пишем об этом в итоговой строке, а не молча пропускаем
    const lp = lpPairs(this.data);
    let twoNote = '';
    if (net === 'auto' && !gan) {
      if (lp.n >= this.minLp) { plan[0][3] = 2; plan.push(['rtx2', this.data, 'два кадра', 1, true]); }
      else twoNote = `сеть на два кадра не учил: мало данных с прошлым кадром (собрано пар: ${lp.n}, роликов: ${lp.files}, нужно пар: ${this.minLp}). Сбор сохраняет прошлый кадр с версии 1.35 — посмотри ещё ролики с 4K`;
    }
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
        const [name, data, label, share, two] = plan[pi];
        const base = path.join(this.out, NETS[name]), out = gan ? path.join(this.out, GAN) : two ? path.join(this.out, TWO) : base;
        const restShare = plan.slice(pi).reduce((a, p) => a + p[3], 0);
        const deadline = hours ? Date.now() + Math.max(0, deadlineAll - Date.now()) * (share / restShare) : 0;
        const tag = two ? 'Сеть на два кадра' : plan.length > 1 ? 'Сеть на один кадр' : 'Обучение';
        // Одним заходом на весь срок: шаг обучения плавно спадает к концу срока. Раньше срок резался на «круги» по
        // ~12 минут, и каждый начинался с большого шага заново — сеть каждый раз частично «разучивалась»
        const args = two ? extra.filter((x) => x !== '--scratch') : [...extra];
        if (hours) args.push('--hours', String(Math.max(deadline - Date.now(), 60e3) / 3600e3));
        else if (two && !args.includes('--steps')) args.push('--steps', '25000'); // без срока — короткое дообучение (~10 мин)
        // продолжение: лучшие веса (json), а если RTX 2 ещё не обогнала Pro и json нет — последние веса (.pt)
        if (two) {
          // поверх своей сети на два кадра, а если её ещё нет — поверх сети на один кадр (вход прошлого кадра = 0)
          args.push('--frames', '2', '--min-pairs', String(this.minLp));
          if (fs.existsSync(out)) args.push('--init', out); else if (fs.existsSync(out + '.pt')) args.push('--warm', out + '.pt');
          else if (fs.existsSync(base)) args.push('--init', base);
          else { results.push({ name, label, two, skip: 'сеть на два кадра учится поверх твоей Liquid RTX 2 — она ещё не обогнала Pro, пока не учу' }); continue; }
        } else if (gan) { args.push('--gan', '0.01'); if (fs.existsSync(base)) args.push('--init', base); else args.push('--warm', base + '.pt'); }
        else if (fs.existsSync(out)) args.push('--init', out); else if (fs.existsSync(out + '.pt') && !args.includes('--scratch')) args.push('--warm', out + '.pt');
        this.set('train', `${tag}: запуск…`, 0);
        const t0 = Date.now();
        // v0 — сеть в начале, best — лучшая проверка САМОЙ сети за этот заход, bar — планка (Pro) на тех же кадрах
        let v0 = null, best = null, bar = null;
        const r0 = { t0, out, gan, v0: null, best: null, bar: null };
        if (!two) this.run0 = r0; // «твоя сеть обучена …» — про сеть на один кадр
        let few = '';
        const go = this.run(this.py, ['-u', path.join(d, 'train_gpu.py'), '--net', name, '--data', data, '--out', out, ...args], (l) => {
          if (/^мало данных/.test(l)) few = l;
          let m;
          if ((m = l.match(/сеть в начале ([\d.]+)/))) r0.v0 = v0 = +m[1];
          if ((m = l.match(/^планка: Pro ([\d.]+)/))) r0.bar = bar = +m[1];
          if ((m = l.match(/^(?:\d+\/\d+ потери|конец:).*?проверка ([\d.]+) дБ/)) && v0 != null) r0.best = best = Math.max(best ?? v0, +m[1]);
          if ((m = l.match(/^(\d+)\/(\d+) потери.*?осталось ~(\d+) мин/))) {
            const pct = Math.round(m[1] / m[2] * 100);
            const gain = best != null && best > v0 ? ` · лучше на ${db(best - v0)} дБ` : '';
            const gap = bar != null && best != null && best < bar ? ` · до Pro ${db(bar - best)} дБ` : '';
            const sp = l.match(/(\d+) шаг\/с/);
            this.set('train', `${tag}: ${pct}%, осталось ~${fmt(+m[3])}${gain}${gap}${sp ? ` · ${sp[1]} шагов/с` : ''}`, pct);
          }
          if (/^В .* пока нет данных/.test(l)) this.set('train', l);
        });
        // сеть на два кадра — дополнительная: не вышла (мало данных, ошибка) — обучение на один кадр всё равно засчитано
        if (two) { try { await go; } catch (e) { if (this.stopping) throw e; results.push({ name, label, two, skip: few || `сеть на два кадра не обучилась: ${e.message}` }); continue; } }
        else await go;
        // браузеру отдано, только если файл весов записан в этот заход (train_gpu пишет его, лишь когда стало лучше)
        let saved = false; try { saved = fs.statSync(out).mtimeMs >= t0; } catch {}
        results.push({ name, label, two, first: v0, last: best, round: 1, why: '', bar, saved, total: best != null && v0 != null ? best - v0 : 0 });
      }
      const r0 = results[0];
      this.result = { v0: r0.first, best: r0.last, better: results.some((r) => r.saved), rounds: 1, nets: results };
      const part = (r) => {
        if (r.skip) return r.skip;
        if (r.two) return r.saved ? `сеть на два кадра стала точнее на ${db(r.total)} дБ — уже работает в новых вкладках` : 'сеть на два кадра не прибавила — оставил прежнюю';
        if (gan) return r.saved ? 'дорисовка обучена. Силу настрой ползунком «Дорисовка деталей» — в новых вкладках и плеере' : 'дорисовка не сохранилась — запусти ещё раз';
        const up = r.total > 0.005 ? `стала точнее на ${db(r.total)} дБ` : 'на этих данных не прибавила';
        if (r.saved) return `${up}. Уже работает в новых вкладках`;
        if (r.bar != null && r.last != null && r.last < r.bar) return `${up}, но ещё не догнала твою Pro (осталось ${db(r.bar - r.last)} дБ) — пока работает Pro, прогресс сохранён, следующее обучение продолжит`;
        return `${up} — оставил прежнюю. Соберите больше разных роликов`;
      };
      this.set('done', `Готово — ${[...results.map(part), ...(twoNote ? [twoNote] : [])].join(' · ')}`, 100);
      this.log('info', 'Liquid RTX обучение', this.st.msg);
      if (this.onDone) this.onDone(this.result);
    })().catch((e) => {
      if (this.stopping) { this.set('idle', this.st.phase === 'train' ? 'Остановлено. Лучший результат уже сохранён' : 'Остановлено', 0); return; }
      this.set('error', `Не вышло: ${e.message}`); this.log('warn', 'Liquid RTX обучение', e.message);
    })
      .finally(() => { this.writeMeta(); this.busy = null; });
    return true;
  }
  stop() {
    this.stopping = true;
    if (this.proc) { try { if (process.platform === 'win32') execFile('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true }); else this.proc.kill(); } catch {} }
  }
}

module.exports = { RtxTrain, NETS, TWO, lpPairs };
