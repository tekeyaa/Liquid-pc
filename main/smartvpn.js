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

class SmartVpn {
  constructor() {
    this.proxy = '';           // "SOCKS5 127.0.0.1:1234; SOCKS 127.0.0.1:1234" или "PROXY host:port"
    this.learned = new Set();  // домены, которые не открылись напрямую
    this.custom = new Set();   // домены, добавленные вручную
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

  matches(host) {
    host = String(host || '').toLowerCase();
    return this.domains().some((d) => host === d || host.endsWith('.' + d));
  }

  pac() {
    const list = JSON.stringify(this.domains());
    return `var D=${list};var P=${JSON.stringify(this.proxy)};
function FindProxyForURL(url,host){host=host.toLowerCase();
if(isPlainHostName(host)||host==="localhost"||shExpMatch(host,"127.*")||shExpMatch(host,"10.*")||shExpMatch(host,"192.168.*"))return "DIRECT";
for(var i=0;i<D.length;i++){var d=D[i];if(host===d||dnsDomainIs(host,"."+d))return P;}
return "DIRECT";}`;
  }

  async start() {
    if (this.server) return;
    this.server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig', 'cache-control': 'no-store' });
      res.end(this.pac());
    });
    await new Promise((ok, fail) => { this.server.once('error', fail); this.server.listen(0, '127.0.0.1', ok); });
    this.port = this.server.address().port;
  }

  // URL меняется при каждом изменении списка, чтобы Chromium перечитал PAC
  url() { return `http://127.0.0.1:${this.port}/proxy.pac?v=${++this.version}`; }
}

module.exports = { SmartVpn, BUILTIN };
