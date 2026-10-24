// VPN: разбор ключей (vless / vmess / trojan / ss / ssconf / socks / http) и запуск xray-core
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

function b64d(s) {
  s = s.trim().replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}
const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

function splitHostPort(hp) {
  hp = hp.replace(/\/+$/, '');
  const i = hp.lastIndexOf(':');
  if (i < 0) throw new Error('В ключе нет порта');
  return { address: hp.slice(0, i).replace(/^\[|\]$/g, ''), port: Number(hp.slice(i + 1)) };
}

function streamSettings(o) {
  let network = (o.network || 'tcp').toLowerCase();
  if (network === 'raw') network = 'tcp';
  if (network === 'splithttp') network = 'xhttp';
  const security = (o.security || 'none').toLowerCase();
  const s = { network, security };
  const alpn = o.alpn ? String(o.alpn).split(',').filter(Boolean) : undefined;

  if (security === 'tls') {
    s.tlsSettings = {
      serverName: o.sni || o.host || undefined,
      fingerprint: o.fp || 'chrome',
      alpn,
      allowInsecure: o.allowInsecure === '1' || o.allowInsecure === 'true',
    };
  } else if (security === 'reality') {
    s.realitySettings = {
      serverName: o.sni || '',
      fingerprint: o.fp || 'chrome',
      publicKey: o.pbk || '',
      shortId: o.sid || '',
      spiderX: o.spx || '',
    };
  }

  if (network === 'ws') s.wsSettings = { path: o.path || '/', host: o.host || undefined };
  else if (network === 'grpc') s.grpcSettings = { serviceName: o.serviceName || o.path || '', multiMode: o.mode === 'multi' };
  else if (network === 'httpupgrade') s.httpupgradeSettings = { path: o.path || '/', host: o.host || undefined };
  else if (network === 'xhttp') s.xhttpSettings = { path: o.path || '/', host: o.host || undefined, mode: o.mode || 'auto' };
  else if (network === 'tcp' && o.headerType === 'http') {
    s.tcpSettings = { header: { type: 'http', request: { path: [o.path || '/'], headers: o.host ? { Host: [o.host] } : {} } } };
  }
  return s;
}

function fromQuery(q) {
  return {
    network: q.get('type'), security: q.get('security'), sni: q.get('sni') || q.get('peer'),
    fp: q.get('fp'), alpn: q.get('alpn'), pbk: q.get('pbk'), sid: q.get('sid'), spx: q.get('spx'),
    path: q.get('path') ? dec(q.get('path')) : '', host: q.get('host'), serviceName: q.get('serviceName'),
    headerType: q.get('headerType'), mode: q.get('mode'), allowInsecure: q.get('allowInsecure') || q.get('insecure'),
  };
}

// Возвращает { kind: 'xray', name, outbound } или { kind: 'proxy', name, rules, auth }
async function parseKey(raw, fetcher) {
  const key = String(raw || '').trim();
  if (!key) throw new Error('Пустой ключ');
  const scheme = key.split('://')[0].toLowerCase();

  if (scheme === 'vless' || scheme === 'trojan') {
    const u = new URL(key);
    const q = u.searchParams;
    const address = u.hostname.replace(/^\[|\]$/g, '');
    const port = Number(u.port || 443);
    const name = dec(u.hash.slice(1)) || address;
    const secret = dec(u.username);
    const o = fromQuery(q);
    if (scheme === 'trojan' && !o.security) o.security = 'tls';
    const outbound = scheme === 'vless'
      ? { protocol: 'vless', settings: { vnext: [{ address, port, users: [{ id: secret, encryption: q.get('encryption') || 'none', flow: q.get('flow') || '' }] }] } }
      : { protocol: 'trojan', settings: { servers: [{ address, port, password: secret }] } };
    outbound.streamSettings = streamSettings(o);
    return { kind: 'xray', name, outbound };
  }

  if (scheme === 'vmess') {
    const j = JSON.parse(b64d(key.slice(8).split('#')[0]));
    const outbound = {
      protocol: 'vmess',
      settings: { vnext: [{ address: j.add, port: Number(j.port), users: [{ id: j.id, alterId: Number(j.aid) || 0, security: j.scy || 'auto' }] }] },
      streamSettings: streamSettings({
        network: j.net, security: j.tls === 'tls' ? 'tls' : j.tls === 'reality' ? 'reality' : 'none',
        sni: j.sni, host: j.host, path: j.path, fp: j.fp, alpn: j.alpn, headerType: j.type, pbk: j.pbk, sid: j.sid,
      }),
    };
    return { kind: 'xray', name: j.ps || j.add, outbound };
  }

  if (scheme === 'ss') {
    let body = key.slice(5);
    let name = '';
    const h = body.indexOf('#');
    if (h >= 0) { name = dec(body.slice(h + 1)); body = body.slice(0, h); }
    body = body.split('?')[0]; // параметры плагина (…/?plugin=) не нужны, хвостовой «/» уберёт splitHostPort
    let userinfo, hostport;
    if (body.includes('@')) {
      const at = body.lastIndexOf('@');
      userinfo = dec(body.slice(0, at));
      hostport = body.slice(at + 1);
      if (!userinfo.includes(':')) userinfo = b64d(userinfo);
    } else {
      const d = b64d(body);
      const at = d.lastIndexOf('@');
      userinfo = d.slice(0, at);
      hostport = d.slice(at + 1);
    }
    const ci = userinfo.indexOf(':');
    const method = userinfo.slice(0, ci);
    const password = userinfo.slice(ci + 1);
    const { address, port } = splitHostPort(hostport);
    return {
      kind: 'xray', name: name || address,
      outbound: { protocol: 'shadowsocks', settings: { servers: [{ address, port, method, password }] } },
    };
  }

  // Outline: динамический ключ ssconf:// → JSON с параметрами сервера
  if (scheme === 'ssconf') {
    if (!fetcher) throw new Error('Не могу загрузить ssconf');
    const url = 'https://' + key.slice(9).split('#')[0];
    const text = await fetcher(url);
    if (text.trim().startsWith('ss://')) return parseKey(text.trim(), fetcher);
    const j = JSON.parse(text);
    return {
      kind: 'xray', name: dec(key.split('#')[1] || '') || j.server,
      outbound: { protocol: 'shadowsocks', settings: { servers: [{ address: j.server, port: Number(j.server_port), method: j.method, password: j.password }] } },
    };
  }

  if (['socks', 'socks5', 'http', 'https'].includes(scheme)) {
    const u = new URL(key.replace(/^socks:\/\//i, 'socks5://'));
    const proto = u.protocol.replace(':', '');
    const auth = u.username ? { user: dec(u.username), pass: dec(u.password) } : null;
    // Chromium не умеет авторизацию в SOCKS — гоним такие через xray
    if (proto === 'socks5' && auth) {
      return {
        kind: 'xray', name: u.hostname,
        outbound: { protocol: 'socks', settings: { servers: [{ address: u.hostname, port: Number(u.port || 1080), users: [auth] }] } },
      };
    }
    return { kind: 'proxy', name: u.hostname, rules: `${proto}://${u.hostname}:${u.port || (proto === 'socks5' ? 1080 : 8080)}`, auth };
  }

  if (scheme === 'hysteria2' || scheme === 'hy2' || scheme === 'tuic' || scheme === 'wireguard') {
    throw new Error(`Протокол ${scheme} пока не поддерживается — нужен vless, vmess, trojan или ss`);
  }
  throw new Error('Не понимаю этот ключ. Поддерживаются vless://, vmess://, trojan://, ss://, ssconf://, socks5://, http://');
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

function waitPort(port, ms = 6000) {
  const end = Date.now() + ms;
  return new Promise((res, rej) => {
    const tryOnce = () => {
      const c = net.connect(port, '127.0.0.1');
      c.once('connect', () => { c.destroy(); res(); });
      c.once('error', () => { c.destroy(); Date.now() > end ? rej(new Error('xray не запустился')) : setTimeout(tryOnce, 150); });
    };
    tryOnce();
  });
}

class Xray {
  constructor(binDir, workDir) { this.binDir = binDir; this.workDir = workDir; this.proc = null; this.port = 0; this.log = ''; }

  binPath() {
    const exe = process.platform === 'win32' ? 'xray.exe' : 'xray';
    return path.join(this.binDir, exe);
  }

  async start(outbound) {
    this.stop();
    const bin = this.binPath();
    if (!fs.existsSync(bin)) throw new Error('Не найден xray (папка bin). Запусти Liquid-Setup.exe ещё раз — он скачает xray заново');
    this.port = await freePort();
    const config = {
      log: { loglevel: 'warning' },
      dns: { servers: ['1.1.1.1', '8.8.8.8'] },
      inbounds: [{
        tag: 'socks-in', listen: '127.0.0.1', port: this.port, protocol: 'socks',
        settings: { udp: true }, sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
      }],
      outbounds: [{ ...outbound, tag: 'proxy' }, { protocol: 'freedom', tag: 'direct' }],
    };
    const cfgPath = path.join(this.workDir, 'xray-config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));
    this.log = '';
    this.proc = spawn(bin, ['run', '-c', cfgPath], { windowsHide: true });
    const grab = (d) => { this.log = (this.log + d.toString()).slice(-4000); };
    this.proc.stdout.on('data', grab);
    this.proc.stderr.on('data', grab);
    const p = this.proc;
    p.on('error', (e) => grab('\n' + e.message)); // без обработчика ошибка запуска xray уронила бы браузер
    p.on('exit', (code) => { if (this.proc === p) { this.proc = null; try { this.onExit && this.onExit(code); } catch {} } });
    try { await waitPort(this.port); }
    catch (e) { const l = this.log; this.stop(); throw new Error('xray не стартовал: ' + (l.trim().split('\n').pop() || e.message)); }
    return this.port;
  }

  stop() { const p = this.proc; this.proc = null; if (p) { try { p.kill(); } catch {} } }
  alive() { return !!this.proc && this.proc.exitCode === null; }
}

module.exports = { parseKey, Xray };
