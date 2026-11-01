// VPN: список серверов, подписки, пинг и понятные причины ошибок.
// Один ключ — один сервер. Подписка (ссылка https://…, которую дают VPN-сервисы и панели 3x-ui / Marzban) — сразу
// много серверов; её содержимое — ключи по строке, обычно ещё и в base64.
const net = require('net');
const crypto = require('crypto');

const KEY_RE = /^(vless|vmess|trojan|ss|ssconf|socks5?|socks|https?):\/\/\S+/i;
const SERVER_KEY_RE = /^(vless|vmess|trojan|ss|ssconf|socks5?|socks):\/\/\S+/i; // ключи внутри подписки (без http-прокси)

// https://host/путь — подписка; http(s)://host:порт без пути — обычный прокси
function isSubUrl(s) {
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return false;
    return (u.pathname && u.pathname !== '/') || !!u.search;
  } catch { return false; }
}

function b64(s) {
  try { return Buffer.from(String(s).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { return ''; }
}

// текст подписки → ключи (base64 или обычный список; лишние строки и комментарии отбрасываем)
function decodeSub(text) {
  let t = String(text || '').trim();
  if (!/:\/\//.test(t)) t = b64(t);
  return t.split(/\r?\n/).map((l) => l.trim()).filter((l) => SERVER_KEY_RE.test(l));
}

// что вставили в поле: один ключ, несколько ключей (по строке или через пробел), ссылки подписок, base64-подписка целиком
function splitInput(text) {
  const keys = [], subs = [];
  const raw = String(text || '').trim();
  if (!raw) return { keys, subs };
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 1 && !/:\/\//.test(parts[0])) { keys.push(...decodeSub(parts[0])); return { keys, subs }; }
  for (const p of parts) {
    if (isSubUrl(p)) subs.push(p);
    else if (KEY_RE.test(p)) keys.push(p);
  }
  return { keys, subs };
}

const keyId = (key) => crypto.createHash('sha1').update(String(key).trim()).digest('hex').slice(0, 12);

// время TCP-соединения с сервером — быстрый «пинг» без запуска VPN (-1 — не отвечает)
function tcpPing(host, port, ms = 3000) {
  return new Promise((res) => {
    if (!host || !port) { res(-1); return; }
    const t0 = Date.now();
    const s = net.connect({ host, port: Number(port) });
    const done = (v) => { clearTimeout(t); s.destroy(); res(v); };
    const t = setTimeout(() => done(-1), ms);
    s.once('connect', () => done(Date.now() - t0));
    s.once('error', () => done(-1));
  });
}

// адрес и порт сервера из разобранного ключа (для пинга)
function endpoint(cfg) {
  try {
    if (cfg.kind === 'proxy') { const u = new URL(cfg.rules); return { host: u.hostname, port: Number(u.port) }; }
    const s = cfg.outbound.settings || {};
    const v = (s.vnext || s.servers || [])[0] || {};
    return { host: v.address || '', port: Number(v.port) || 0 };
  } catch { return { host: '', port: 0 }; }
}

// флаг страны по коду: RU → 🇷🇺
const flag = (cc) => (/^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '');

// почему не подключилось — человеческими словами (по журналу xray и тексту ошибки)
function explain(err, log) {
  const t = `${err || ''}\n${log || ''}`;
  if (/Не найден xray/i.test(t)) return String(err);
  if (/REALITY|reality/.test(t) && /invalid|failed|mismatch/i.test(t)) return 'Сервер не принял ключ (REALITY). Ключ устарел или в нём ошибка — возьми новый у своего VPN-сервиса.';
  if (/invalid user|user not found|unauthorized|authentication failed|invalid request user id/i.test(t)) return 'Сервер не принял ключ: он устарел, отключён или закончилась подписка.';
  if (/certificate|x509|tls: |handshake/i.test(t)) return 'Не получилось установить защищённое соединение с сервером (TLS). Возможно, адрес сервера блокируют или ключ с ошибкой.';
  if (/connection refused|actively refused/i.test(t)) return 'Сервер отказал в соединении: VPN на нём не запущен или порт закрыт.';
  if (/i\/o timeout|timed out|deadline exceeded|нет ответа|ETIMEDOUT/i.test(t)) return 'Сервер не отвечает: он выключен или его адрес блокирует провайдер. Попробуй другой сервер.';
  if (/no such host|ENOTFOUND|lookup/i.test(t)) return 'Не нашёл адрес сервера (DNS). Проверь интернет или ключ.';
  if (/не стартовал|xray/i.test(t)) return 'Не запустился xray: ' + String(err).replace(/^xray не стартовал:\s*/, '');
  return String(err || 'Не получилось подключиться');
}

module.exports = { splitInput, decodeSub, isSubUrl, keyId, tcpPing, endpoint, flag, explain, KEY_RE };
