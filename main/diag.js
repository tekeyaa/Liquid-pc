// Журнал ошибок Liquid: ловит сбои во всех частях браузера и пишет их в файл.
// Ключи VPN, API-ключи и параметры ссылок вырезаются, чтобы отчётом можно было спокойно делиться.
const fs = require('fs');
const path = require('path');
const os = require('os');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, crash: 4 };

function redact(s) {
  return String(s ?? '')
    .replace(/\b(vless|vmess|trojan|ss|ssconf|socks5?|hysteria2|hy2|tuic):\/\/\S+/gi, '$1://[ключ скрыт]')
    .replace(/sk-ant-[A-Za-z0-9_\-]+/g, 'sk-ant-[скрыт]')
    .replace(/\b(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, '$1?…')
    .replace(/("?(password|token|secret|authorization|cookie)"?\s*[:=]\s*)("[^"]*"|\S+)/gi, '$1[скрыто]');
}

class Diag {
  constructor(dir) {
    this.dir = path.join(dir, 'logs');
    fs.mkdirSync(this.dir, { recursive: true });
    this.ring = [];          // последние записи в памяти
    this.unseen = 0;         // новых ошибок с последнего просмотра
    this.listeners = new Set();
    this.dedupe = new Map(); // одинаковые сообщения не пишем чаще раза в 10 секунд
    this.started = Date.now();
    this.queue = [];         // строки, ещё не записанные в файл
    this.flushT = 0;
    this.cur = '';           // файл сегодняшнего журнала и его размер — без проверки диска на каждую строку
    this.size = 0;
    this.cleanup();
    process.on('exit', () => this.flush());
  }

  file() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return path.join(this.dir, `liquid-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`);
  }

  cleanup() {
    // храним журналы за 7 дней
    try {
      const old = Date.now() - 7 * 864e5;
      for (const f of fs.readdirSync(this.dir)) {
        const full = path.join(this.dir, f);
        if (fs.statSync(full).mtimeMs < old) fs.rmSync(full, { force: true });
      }
    } catch {}
  }

  log(level, source, message, extra) {
    if (!(level in LEVELS)) level = 'info';
    let msg = redact(typeof message === 'string' ? message : (message && message.stack) || JSON.stringify(message));
    let ext = extra ? redact(typeof extra === 'string' ? extra : JSON.stringify(extra)) : '';
    if (msg.length > 4000) msg = msg.slice(0, 4000) + '…';
    if (ext.length > 4000) ext = ext.slice(0, 4000) + '…';
    const key = level + source + msg.slice(0, 300);
    const now = Date.now();
    const prev = this.dedupe.get(key);
    if (prev && now - prev.t < 10_000) { prev.count = (prev.count || 1) + 1; prev.t = now; return; } // повтор — только счётчик
    const e = { t: now, level, source, msg, extra: ext, count: 1 };
    this.dedupe.set(key, e);
    if (this.dedupe.size > 500) this.dedupe.clear();
    this.write(e);
  }

  write(e) {
    this.ring.push(e);
    if (this.ring.length > 2000) this.ring.splice(0, this.ring.length - 2000);
    if (LEVELS[e.level] >= LEVELS.error) this.unseen++;
    const line = `${new Date(e.t).toISOString()} [${e.level.toUpperCase()}] [${e.source}] ${e.msg}${e.extra ? ' | ' + e.extra : ''}\n`;
    // Сайты сыплют предупреждениями в консоль; раньше каждая строка — это три обращения к диску из основного
    // процесса браузера. Теперь строки копятся и пишутся пачкой раз в секунду; ошибки и сбои — сразу.
    this.queue.push(line);
    if (LEVELS[e.level] >= LEVELS.error) this.flush();
    else if (!this.flushT) this.flushT = setTimeout(() => this.flush(), 1000);
    for (const l of this.listeners) { try { l(e, this.unseen); } catch {} }
  }

  flush() {
    clearTimeout(this.flushT); this.flushT = 0;
    if (!this.queue.length) return;
    const data = this.queue.join(''); this.queue = [];
    try {
      const f = this.file();
      if (f !== this.cur) { this.cur = f; try { this.size = fs.statSync(f).size; } catch { this.size = 0; } }
      // не больше 5 МБ в день (значок новых ошибок при этом всё равно обновляется)
      if (this.size > 5 * 1024 * 1024) return;
      fs.appendFileSync(f, data);
      this.size += Buffer.byteLength(data);
    } catch {}
  }

  list(minLevel = 'warn', limit = 300) {
    const m = LEVELS[minLevel] ?? 0;
    return this.ring.filter((e) => LEVELS[e.level] >= m).slice(-limit);
  }

  clear() { this.ring = []; this.unseen = 0; for (const l of this.listeners) { try { l(null, 0); } catch {} } }
  seen() { this.unseen = 0; }

  report(sys, limit = 150) {
    const list = this.list('warn', limit);
    const up = Math.round((Date.now() - this.started) / 60000);
    const lines = list.map((e) => `${new Date(e.t).toLocaleTimeString('ru-RU')} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.msg}${e.extra ? ' | ' + e.extra : ''}${e.count > 1 ? ` ×${e.count}` : ''}`);
    return [
      '## Отчёт Liquid для Claude',
      '',
      '**Система**',
      ...Object.entries(sys).map(([k, v]) => `- ${k}: ${v}`),
      `- работает: ${up} мин`,
      '',
      `**Ошибки и предупреждения (последние ${list.length})**`,
      '```',
      ...(lines.length ? lines : ['ошибок нет']),
      '```',
      '',
      'Что я делал перед ошибкой: (опиши своими словами)',
    ].join('\n');
  }
}

function sysInfo(app, extra = {}) {
  return {
    'Liquid': app.getVersion(),
    'Electron / Chrome': `${process.versions.electron} / ${process.versions.chrome}`,
    'ОС': `${os.type()} ${os.release()} ${os.arch()}`,
    'Процессор': `${os.cpus()[0]?.model || '?'} × ${os.cpus().length}`,
    'Память': `${Math.round(os.freemem() / 1e9 * 10) / 10} из ${Math.round(os.totalmem() / 1e9 * 10) / 10} ГБ свободно`,
    ...extra,
  };
}

module.exports = { Diag, sysInfo };
