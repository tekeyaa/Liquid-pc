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

// российские сайты, банки и госуслуги никогда не уводим за границу — с иностранным IP они могут перестать пускать.
// В режиме «Весь трафик» они (и все .ru / .su / .рф) идут напрямую, если не выключить это
const NEVER_VPN = ['gosuslugi.ru', 'nalog.gov.ru', 'mos.ru', 'sberbank.ru', 'sber.ru', 'tbank.ru', 'tinkoff.ru', 'vtb.ru', 'alfabank.ru', 'gazprombank.ru',
  'raiffeisen.ru', 'pochtabank.ru', 'sovcombank.ru', 'otpbank.ru', 'rshb.ru', 'mts.ru', 'megafon.ru', 'beeline.ru', 'tele2.ru', 'rostelecom.ru', 'yandex.ru',
  'ya.ru', 'vk.com', 'vk.ru', 'mail.ru', 'ok.ru', 'ozon.ru', 'wildberries.ru', 'avito.ru', 'kinopoisk.ru', 'rzd.ru', 'pochta.ru', 'nspk.ru', 'gov.ru', 'max.ru',
  'yandex.net', 'yastatic.net', 'vkuser.net', 'userapi.com', 'mycdn.me', 'wb.ru', 'ozone.ru', 'dzen.ru', 'rutube.ru', 'kaspersky.ru'];
const RU_TLD = /\.(ru|su|xn--p1ai|рф)$/;

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
    this.community = new Set(); // общий список заблокированных в России сайтов (itdoginfo/allow-domains), обновляется раз в сутки
    this.exclude = new Set();  // сайты, которые всегда идут напрямую (выбрал человек)
    this.mode = 'smart';       // smart — через VPN только заблокированные; all — весь трафик
    this.ruDirect = true;      // в режиме «весь трафик» российские сайты — напрямую
    this.dpi = '';
    this.vpnOn = false;             // локальный xray обхода замедления: "SOCKS5 127.0.0.1:N; SOCKS 127.0.0.1:N"
    this.server = null;
    this.port = 0;
    this.version = 0;
  }

  domains() { return [...new Set([...BUILTIN, ...this.community, ...this.learned, ...this.custom])]; }

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
  matches(host) { return !!this.why(host); }
  // почему сайт в списке «через VPN»: custom / learned / community / builtin (или '' — не в списке)
  why(host) {
    host = String(host || '').toLowerCase();
    if (SmartVpn.inSet(host, this.exclude)) return '';
    for (let h = host; h; ) {
      if (this.custom.has(h)) return 'custom';
      if (this.learned.has(h)) return 'learned';
      if (BUILTIN_SET.has(h)) return 'builtin';
      if (this.community.has(h)) return 'community';
      const i = h.indexOf('.');
      if (i < 0) break;
      h = h.slice(i + 1);
    }
    return '';
  }
  static inSet(host, set) {
    if (!set.size) return false;
    for (let h = String(host || '').toLowerCase(); h; ) { if (set.has(h)) return true; const i = h.indexOf('.'); if (i < 0) break; h = h.slice(i + 1); }
    return false;
  }
  static russian(host) { host = String(host || '').toLowerCase(); return RU_TLD.test(host) || NEVER_VPN.some((d) => host === d || host.endsWith('.' + d)); }
  // Куда пойдёт сайт и почему (для окна VPN и диагностики): { via: 'vpn' | 'dpi' | 'direct', why }
  route(host, vpnOn) {
    host = String(host || '').toLowerCase();
    if (!host) return { via: 'direct', why: '' };
    if (SmartVpn.inSet(host, this.exclude)) return { via: 'direct', why: 'exclude' };
    if (vpnOn && this.mode === 'all') {
      if (SmartVpn.inSet(host, this.custom)) return { via: 'vpn', why: 'custom' };
      if (this.ruDirect && SmartVpn.russian(host)) return { via: 'direct', why: 'russian' };
      return { via: 'vpn', why: 'all' };
    }
    const w = this.why(host);
    if (vpnOn && w) return { via: 'vpn', why: w };
    if (this.dpi && DPI_SITES.some((d) => host === d || host.endsWith('.' + d))) return { via: 'dpi', why: 'dpi' };
    return { via: 'direct', why: w ? 'vpn-off' : '' };
  }

  // vpnOn — включён ли VPN (тогда список D идёт через него); без VPN сайты из DPI идут через обход замедления,
  // а если обход упал, Chromium сам откроет их напрямую (DIRECT в конце)
  pac(vpnOn) {
    const all = vpnOn && this.mode === 'all';
    const list = JSON.stringify(vpnOn ? (all ? [...this.custom] : this.domains()) : []);
    const dpi = JSON.stringify(this.dpi ? DPI_SITES : []);
    const ex = JSON.stringify([...this.exclude]);
    const ru = JSON.stringify(all && this.ruDirect ? NEVER_VPN : []);
    // списки — таблицами, а не массивами: Chromium вызывает FindProxyForURL на КАЖДЫЙ запрос, поэтому проверяем
    // только «хвосты» имени (a.b.youtube.com → b.youtube.com → youtube.com), а не перебираем тысячу сайтов
    return `var D=${toMap(list)};var P=${JSON.stringify(this.proxy)};var F=${toMap(dpi)};var Q=${JSON.stringify(this.dpi ? this.dpi + '; DIRECT' : 'DIRECT')};
var X=${toMap(ex)};var R=${toMap(ru)};var A=${all ? 'true' : 'false'};var RT=${all && this.ruDirect ? 'true' : 'false'};
function m(h,L){for(;;){if(L.hasOwnProperty(h))return true;var i=h.indexOf(".");if(i<0)return false;h=h.substring(i+1);}}
function FindProxyForURL(url,host){host=host.toLowerCase();
if(isPlainHostName(host)||host==="localhost"||shExpMatch(host,"127.*")||shExpMatch(host,"10.*")||shExpMatch(host,"192.168.*"))return "DIRECT";
if(m(host,X))return "DIRECT";
if(m(host,D))return P;
if(A){if(RT&&(/\\.(ru|su|xn--p1ai)$/.test(host)||m(host,R)))return "DIRECT";return P;}
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

// Общий список заблокированных в России сайтов: строка — домен, «.ua» — вся зона
function parseBlockList(text) {
  const out = new Set();
  for (let l of String(text || '').split(/\r?\n/)) {
    l = l.trim().toLowerCase().replace(/^\*?\./, '');
    if (!l || l.startsWith('#') || !/^[a-z0-9.-]+$/.test(l) || l.length > 253) continue;
    if (NEVER_VPN.some((d) => l === d || l.endsWith('.' + d))) continue; // банки и госуслуги туда не попадут, но на всякий случай
    out.add(l);
  }
  return out;
}

module.exports = { SmartVpn, DPI_SITES, NEVER_VPN, parseBlockList };
