// «Смотреть вместе»: синхронная пауза, перемотка и чат для двух и больше браузеров Liquid.
// Своего сервера нет: сообщения ходят через бесплатный публичный MQTT-брокер (как почтовый ящик для коротких
// записок). Видео каждый смотрит сам со своего сайта — через брокер идут только «пауза на 12:30» и чат.
// Всё зашифровано ключом из кода комнаты (AES-256-GCM), а тема в брокере — хэш кода: посторонние не прочтут.
const crypto = require('crypto');

const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];

// ---------- минимальный MQTT 3.1.1 поверх WebSocket (только то, что нужно: QoS 0) ----------
const str = (s) => { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
function varLen(n) { const out = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 0x80; out.push(d); } while (n > 0); return Buffer.from(out); }
const packet = (type, body) => Buffer.concat([Buffer.from([type]), varLen(body.length), body]);

class Mqtt {
  constructor(url, clientId, { onMessage, onClose }) {
    this.url = url; this.clientId = clientId; this.onMessage = onMessage; this.onClose = onClose;
    this.buf = Buffer.alloc(0); this.ws = null; this.ping = 0; this.pid = 1;
  }
  connect(timeoutMs = 8000) {
    return new Promise((ok, fail) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; try { this.ws.close(); } catch {} fail(new Error('нет ответа')); } }, timeoutMs);
      try { this.ws = new WebSocket(this.url, ['mqtt']); } catch (e) { clearTimeout(t); fail(e); return; }
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = () => {
        const vh = Buffer.concat([str('MQTT'), Buffer.from([4, 0x02, 0, 60])]); // уровень 4, чистая сессия, keepalive 60 с
        this.ws.send(packet(0x10, Buffer.concat([vh, str(this.clientId)])));
      };
      this.ws.onmessage = (ev) => {
        this.buf = Buffer.concat([this.buf, Buffer.from(ev.data)]);
        for (;;) {
          if (this.buf.length < 2) break;
          let len = 0, mul = 1, i = 1, b;
          do { if (i >= this.buf.length) return; b = this.buf[i++]; len += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
          if (this.buf.length < i + len) break;
          const hdr = this.buf[0], type = hdr >> 4, body = this.buf.subarray(i, i + len);
          this.buf = this.buf.subarray(i + len);
          if (type === 2 && !done) { // CONNACK
            done = true; clearTimeout(t);
            if (body[1] !== 0) { fail(new Error('брокер отказал (' + body[1] + ')')); return; }
            this.ping = setInterval(() => { try { this.ws.send(Buffer.from([0xc0, 0])); } catch {} }, 30e3);
            ok();
          } else if (type === 3) { // PUBLISH (QoS 0)
            const tl = body.readUInt16BE(0);
            const topic = body.subarray(2, 2 + tl).toString('utf8');
            const qos = (hdr >> 1) & 3; // подписываемся с QoS 0, но на всякий случай пропускаем номер пакета
            this.onMessage(topic, body.subarray(2 + tl + (qos ? 2 : 0)));
          }
        }
      };
      this.ws.onclose = () => { clearInterval(this.ping); if (!done) { done = true; clearTimeout(t); fail(new Error('соединение закрыто')); } else this.onClose && this.onClose(); };
      this.ws.onerror = () => {};
    });
  }
  subscribe(topic) { const id = Buffer.alloc(2); id.writeUInt16BE(this.pid++ & 0xffff || 1); this.ws.send(packet(0x82, Buffer.concat([id, str(topic), Buffer.from([0])]))); }
  publish(topic, payload) { if (this.ws && this.ws.readyState === 1) this.ws.send(packet(0x30, Buffer.concat([str(topic), payload]))); }
  close() { clearInterval(this.ping); this.onClose = null; try { this.ws.send(Buffer.from([0xe0, 0])); this.ws.close(); } catch {} }
}

// ---------- комната ----------
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих 0/O, 1/I
function newCode() { const b = crypto.randomBytes(8); let s = ''; for (let i = 0; i < 8; i++) s += ALPHA[b[i] % ALPHA.length]; return s.slice(0, 4) + '-' + s.slice(4); }
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{4})(.{4}).*/, '$1-$2');

class WatchRoom {
  // Подключаемся сразу ко всем брокерам и пишем во все: если у одного участника какой-то брокер недоступен,
  // а у другого — другой, они всё равно встретятся на общем. Повторы одного сообщения отсеиваем по номеру.
  constructor({ onMessage, onStatus, log }) {
    this.onMessage = onMessage; this.onStatus = onStatus; this.log = log || (() => {});
    this.code = ''; this.me = 'lq-' + crypto.randomBytes(6).toString('hex'); this.state = 'off';
    this.links = new Map(); // url брокера -> { mq, retry, timer }
    this.seen = new Map();  // номер сообщения -> время (защита от дублей)
  }
  get topic() { return 'liquid-watch/v1/' + crypto.createHash('sha256').update('topic:' + this.code).digest('hex').slice(0, 32); }
  get key() { return crypto.createHash('sha256').update('liquid-watch:' + this.code).digest(); }
  seal(obj) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }
  open(buf) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
    } catch { return null; } // чужое или повреждённое — молча пропускаем
  }
  online() { return [...this.links.values()].filter((l) => l.mq).map((l) => l.host); }
  status() {
    const up = this.online();
    const state = !this.code ? 'off' : up.length ? 'online' : [...this.links.values()].some((l) => l.trying) ? 'connecting' : 'offline';
    this.state = state;
    this.onStatus({ state, code: this.code, broker: up.join(', ') });
  }
  async join(code) {
    this.leave(true);
    this.code = code ? normCode(code) : newCode();
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(this.code)) { const bad = this.code; this.code = ''; throw new Error(`Код комнаты — 8 букв и цифр, например ABCD-1234 (введено «${bad}»)`); }
    const firsts = BROKERS.map((url) => this.link(url));
    // ждём первого успешного подключения (или пока все откажут), остальные доподключатся сами
    await new Promise((ok) => { let left = firsts.length; firsts.forEach((p) => p.then((good) => { if (good || --left === 0) ok(); })); });
    this.status();
    return this.code;
  }
  async link(url) {
    const code = this.code;
    const l = this.links.get(url) || { url, host: new URL(url).hostname, mq: null, retry: 0, timer: 0, trying: false };
    this.links.set(url, l);
    l.trying = true; this.status();
    const mq = new Mqtt(url, this.me + '-' + crypto.randomBytes(2).toString('hex'), {
      onMessage: (_t, payload) => this.receive(payload),
      onClose: () => { if (l.mq === mq) { l.mq = null; this.status(); this.relink(l); } },
    });
    try {
      await mq.connect();
      if (this.code !== code) { mq.close(); return false; }
      mq.subscribe(this.topic);
      l.mq = mq; l.retry = 0; l.trying = false;
      this.log('info', `Смотреть вместе: подключился к ${l.host}`);
      this.status();
      return true;
    } catch (e) {
      l.trying = false;
      this.log('info', `Смотреть вместе: ${l.host} — ${e.message}`);
      if (this.code === code) { this.status(); this.relink(l); }
      return false;
    }
  }
  relink(l) {
    if (!this.code) return;
    clearTimeout(l.timer);
    l.timer = setTimeout(() => { if (this.code) this.link(l.url); }, Math.min(60e3, 3000 * 2 ** l.retry++));
  }
  receive(payload) {
    const m = this.open(payload);
    if (!m || m.from === this.me) return;
    if (m.id) {
      if (this.seen.has(m.id)) return;
      this.seen.set(m.id, Date.now());
      if (this.seen.size > 500) for (const k of [...this.seen.keys()].slice(0, 250)) this.seen.delete(k);
    }
    this.onMessage(m);
  }
  send(obj) {
    if (!this.code) return false;
    const up = [...this.links.values()].filter((l) => l.mq);
    if (!up.length) return false;
    const data = this.seal({ ...obj, from: this.me, id: crypto.randomBytes(6).toString('hex'), at: Date.now() });
    for (const l of up) l.mq.publish(this.topic, data);
    return true;
  }
  leave(silent) {
    if (this.code) { try { this.send({ type: 'bye' }); } catch {} }
    for (const l of this.links.values()) { clearTimeout(l.timer); if (l.mq) l.mq.close(); }
    this.links.clear(); this.code = '';
    if (!silent) this.status();
  }
}

module.exports = { WatchRoom, normCode, newCode, Mqtt, BROKERS };
