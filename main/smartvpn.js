// Умный VPN: через прокси идут только заблокированные/замедленные сайты, остальное — напрямую.
// Chromium берёт правила из PAC-файла, который мы раздаём с локального http-сервера.
const http = require('http');

// Сайты, которые в РФ заблокированы или замедлены (вместе с их CDN)
const BUILTIN = [
  // видео и стримы
  'youtube.com', 'youtu.be', 'googlevideo.com', 'ytimg.com', 'ggpht.com', 'youtube-nocookie.com', 'youtubei.googleapis.com',
  'twitch.tv', 'ttvnw.net', 'jtvnw.net', 'twitchcdn.net', 'twitchsvc.net', 'ext-twitch.tv', 'live-video.net',
  // соцсети и мессенджеры
  'instagram.com', 'cdninstagram.com', 'facebook.com', 'fbcdn.net', 'fb.com', 'messenger.com', 'threads.net',
  'x.com', 'twitter.com', 'twimg.com', 't.co', 'linkedin.com', 'licdn.com',
  'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'discordcdn.com',
  'signal.org', 'viber.com', 'whatsapp.com', 'whatsapp.net',
  // ИИ
  'claude.ai', 'anthropic.com', 'claudeusercontent.com', 'openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com',
  'gemini.google.com', 'aistudio.google.com', 'bard.google.com', 'grok.com', 'x.ai', 'perplexity.ai', 'copilot.microsoft.com',
  // прочее
  'medium.com', 'patreon.com', 'soundcloud.com', 'spotify.com', 'scdn.co', 'notion.so', 'notion.site', 'figma.com',
  'proton.me', 'protonvpn.com', 'rutracker.org', 'nnmclub.to', 'kinozal.tv', 'archive.org', 'wikimedia.org',
  'intel.com', 'nvidia.com', 'docker.com', 'docker.io', 'hub.docker.com', 'canva.com', 'udemy.com', 'coursera.org',
  'pornhub.com', 'quora.com', 'deviantart.com', 'tiktok.com', 'tiktokcdn.com', 'tiktokv.com',
];

const BUILTIN_SET = new Set(BUILTIN);

// Сайты, которые провайдеры замедляют по имени в TLS: без VPN их открывает обход замедления
const DPI_SITES = [
  'twitch.tv', 'ttvnw.net', 'jtvnw.net', 'live-video.net', 'twitchcdn.net', 'twitchsvc.net', 'ext-twitch.tv',
  'youtube.com', 'youtu.be', 'googlevideo.com', 'ytimg.com', 'ggpht.com', 'youtubei.googleapis.com', 'youtube-nocookie.com',
  'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media',
];

// JSON-массив доменов -> текст объекта {"youtube.com":1,...} для PAC
const toMap = (json) => JSON.stringify(Object.fromEntries(JSON.parse(json).map((d) => [String(d).toLowerCase(), 1])));

class SmartVpn {
  constructor() {
    this.proxy = '';           // "SOCKS5 127.0.0.1:1234; SOCKS 127.0.0.1:1234" или "PROXY host:port"
    this.learned = new Set();  // домены, которые не открылись напрямую
    this.custom = new Set();   // домены, добавленные вручную
    this.dpi = '';
    this.vpnOn = false;             // локальный xray обхода замедления: "SOCKS5 127.0.0.1:N; SOCKS 127.0.0.1:N"
    this.server = null;
    this.port = 0;
    this.version = 0;
  }

  domains() { return [...new Set([...BUILTIN, ...this.learned, ...this.custom])]; }

  static baseDomain(host) {
    host = String(host || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    const p = host.split('.');
    if (p.length <= 2) return host;
    const sld = p[p.length - 2];
    // co.uk, com.ru и подобные
    if (['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'].includes(sld) && p[p.length - 1].length === 2) return p.slice(-3).join('.');
    return p.slice(-2).join('.');
  }

  // Совпадает ли сайт (или его поддомен) со списком. Раньше на каждый переход склеивался массив из всех
  // списков и перебирался целиком; теперь проверяются только «хвосты» имени: a.b.youtube.com → b.youtube.com → youtube.com
  matches(host) {
    host = String(host || '').toLowerCase();
    for (let h = host; h; ) {
      if (BUILTIN_SET.has(h) || this.learned.has(h) || this.custom.has(h)) return true;
      const i = h.indexOf('.');
      if (i < 0) break;
      h = h.slice(i + 1);
    }
    return false;
  }

  // vpnOn — включён ли VPN (тогда список D идёт через него); без VPN сайты из DPI идут через обход замедления,
  // а если обход упал, Chromium сам откроет их напрямую (DIRECT в конце)
  pac(vpnOn) {
    const list = JSON.stringify(vpnOn ? this.domains() : []);
    const dpi = JSON.stringify(this.dpi ? DPI_SITES : []);
    // списки — таблицами, а не массивами: Chromium вызывает FindProxyForURL на КАЖДЫЙ запрос, и раньше она
    // перебирала больше сотни сайтов; теперь проверяет только «хвосты» имени (a.b.youtube.com → b.youtube.com → youtube.com)
    return `var D=${toMap(list)};var P=${JSON.stringify(this.proxy)};var F=${toMap(dpi)};var Q=${JSON.stringify(this.dpi ? this.dpi + '; DIRECT' : 'DIRECT')};
function m(h,L){for(;;){if(L.hasOwnProperty(h))return true;var i=h.indexOf(".");if(i<0)return false;h=h.substring(i+1);}}
function FindProxyForURL(url,host){host=host.toLowerCase();
if(isPlainHostName(host)||host==="localhost"||shExpMatch(host,"127.*")||shExpMatch(host,"10.*")||shExpMatch(host,"192.168.*"))return "DIRECT";
if(m(host,D))return P;
if(m(host,F))return Q;
return "DIRECT";}`;
  }

  async start() {
    if (this.server) return;
    this.server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig', 'cache-control': 'no-store' });
      res.end(this.pac(!!this.vpnOn));
    });
    await new Promise((ok, fail) => { this.server.once('error', fail); this.server.listen(0, '127.0.0.1', ok); });
    this.port = this.server.address().port;
  }

  // URL меняется при каждом изменении списка, чтобы Chromium перечитал PAC
  url() { return `http://127.0.0.1:${this.port}/proxy.pac?v=${++this.version}`; }
}

module.exports = { SmartVpn, DPI_SITES };
