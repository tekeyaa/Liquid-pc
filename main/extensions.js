// Расширения Chrome: скачивание .crx из Chrome Web Store, распаковка и загрузка в сессию браузера.
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const POPULAR = [
  { id: 'gebbhagfogifgggkldgodflihgfeippi', name: 'Return YouTube Dislike', desc: 'Возвращает счётчик дизлайков на YouTube' },
  { id: 'mnjggcdmjocbbbhaepdhchncahnbgone', name: 'SponsorBlock', desc: 'Пропускает рекламные вставки блогеров в роликах' },
  { id: 'ammjkodgmmoknidbanneddgankgfejfh', name: '7TV', desc: 'Смайлы 7TV и улучшенный чат на Twitch' },
  { id: 'ajopnjidmegmdimjlfnijceegpefgped', name: 'BetterTTV', desc: 'Смайлы BTTV и настройки чата Twitch и YouTube' },
  { id: 'eimadpbcbfnmbkopoojfekhnkhdbieeh', name: 'Dark Reader', desc: 'Тёмная тема для любых сайтов' },
];

// --- минимальный распаковщик zip (deflate/store) без зависимостей
function unzip(buf, dest) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('повреждённый архив расширения');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const root = path.resolve(dest);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('повреждённый архив расширения');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commLen;
    const target = path.resolve(root, name);
    if (!target.startsWith(root + path.sep) && target !== root) continue; // защита от ../
    if (name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error('неподдерживаемое сжатие в расширении');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
}

function crxToZip(buf) {
  if (buf.slice(0, 4).toString() !== 'Cr24') {
    if (buf.readUInt32LE(0) === 0x04034b50) return buf; // уже zip
    throw new Error('это не файл расширения Chrome');
  }
  const ver = buf.readUInt32LE(4);
  if (ver === 3) return buf.slice(12 + buf.readUInt32LE(8));
  if (ver === 2) return buf.slice(16 + buf.readUInt32LE(8) + buf.readUInt32LE(12));
  throw new Error('неизвестная версия .crx');
}

function parseId(input) {
  const s = String(input || '').trim();
  const m = s.match(/[a-p]{32}/);
  return m ? m[0] : null;
}

class Extensions {
  constructor(userData) {
    this.dir = path.join(userData, 'extensions');
    this.file = path.join(userData, 'extensions.json');
    fs.mkdirSync(this.dir, { recursive: true });
    this.list = [];
    try { this.list = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    this.loaded = new Map(); // id -> Extension
  }
  save() { fs.writeFileSync(this.file, JSON.stringify(this.list, null, 2)); }
  api(sess) { return sess.extensions || sess; } // новые версии Electron: session.extensions

  async loadAll(sessions) {
    for (const e of this.list) if (e.enabled !== false) await this.loadOne(e, sessions).catch((err) => { e.error = err.message; });
  }

  async loadOne(e, sessions) {
    for (const s of sessions) {
      const ext = await this.api(s).loadExtension(path.join(this.dir, e.id), { allowFileAccess: false });
      if (s === sessions[0]) { this.loaded.set(e.id, ext); e.realId = ext.id; e.error = ''; }
    }
  }

  async install(input, fetchFn, sessions, chromeVersion) {
    const id = parseId(input);
    if (!id) throw new Error('Вставь ссылку на расширение из Chrome Web Store или его ID (32 буквы)');
    const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${chromeVersion}&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`Chrome Web Store не отдал расширение (ошибка ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    const dest = path.join(this.dir, id);
    // старую версию сначала выгружаем из сессий, потом удаляем её файлы
    for (const s of sessions) { try { this.api(s).removeExtension(this.loaded.get(id)?.id || ''); } catch {} }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    unzip(crxToZip(buf), dest);
    try { fs.rmSync(path.join(dest, '_metadata'), { recursive: true, force: true }); } catch {} // подписи CWS Electron не нужны
    const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
    let name = manifest.name || id;
    if (/^__MSG_/.test(name)) name = this.localize(dest, manifest, name) || id;
    const popup = manifest.action?.default_popup || manifest.browser_action?.default_popup || '';
    const options = manifest.options_ui?.page || manifest.options_page || '';
    const icons = manifest.icons || {};
    const icon = icons['48'] || icons['32'] || icons['128'] || icons['16'] || '';
    const entry = { id, name, version: manifest.version, popup, options, icon, enabled: true, mv: manifest.manifest_version };
    this.list = this.list.filter((x) => x.id !== id);
    this.list.push(entry);
    this.save();
    await this.loadOne(entry, sessions);
    this.save();
    return entry;
  }

  localize(dir, manifest, msg) {
    const key = msg.replace(/^__MSG_|__$/g, '');
    for (const loc of ['ru', manifest.default_locale || 'en', 'en']) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, '_locales', loc, 'messages.json'), 'utf8'));
        const hit = Object.entries(m).find(([k]) => k.toLowerCase() === key.toLowerCase());
        if (hit) return hit[1].message;
      } catch {}
    }
    return '';
  }

  async setEnabled(id, on, sessions) {
    const e = this.list.find((x) => x.id === id);
    if (!e) return;
    e.enabled = on;
    if (on) await this.loadOne(e, sessions).catch((err) => { e.error = err.message; });
    else for (const s of sessions) { try { this.api(s).removeExtension(e.realId || this.loaded.get(id)?.id); } catch {} }
    this.save();
  }

  remove(id, sessions) {
    const e = this.list.find((x) => x.id === id);
    if (!e) return;
    for (const s of sessions) { try { this.api(s).removeExtension(e.realId || this.loaded.get(id)?.id); } catch {} }
    this.list = this.list.filter((x) => x.id !== id);
    this.save();
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
  }

  iconData(e) {
    if (!e.icon) return '';
    try { return 'data:image/png;base64,' + fs.readFileSync(path.join(this.dir, e.id, e.icon)).toString('base64'); } catch { return ''; }
  }

  view() {
    return this.list.map((e) => ({ ...e, iconData: this.iconData(e), installed: true }));
  }
}

module.exports = { Extensions, POPULAR };
