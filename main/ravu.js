// Liquid RTX: таблицы весов обученного апскейлера RAVU-Zoom-AR.
// Файлы main/ravu/*.hook — оригинальные шейдеры bjin/mpv-prescalers (LGPL-3.0, текст лицензии рядом), без изменений:
// их можно заменить своими версиями того же формата. Отсюда берём тело шейдера и таблицы (float32, записаны в hex),
// а страница собирает из них обычный WebGL2-шейдер.
const fs = require('fs');
const path = require('path');

function parseHook(text) {
  let body = '';
  const luts = [];
  for (const b of String(text).split(/^(?=\/\/!(?:DESC|TEXTURE))/m)) {
    const lines = b.split(/\r?\n/);
    if (/^\/\/!DESC/.test(b)) body = lines.filter((l) => !/^\/\/!/.test(l)).join('\n');
    else if (/^\/\/!TEXTURE/.test(b)) {
      const name = lines[0].split(/\s+/)[1];
      const size = lines.find((l) => /^\/\/!SIZE/.test(l));
      const [w, h] = size ? size.split(/\s+/).slice(1).map(Number) : [0, 0];
      const hex = lines.filter((l) => l && !/^\/\//.test(l)).join('').trim();
      const data = Buffer.from(hex, 'hex');
      if (!name || !w || !h || data.length !== w * h * 16) throw new Error(`RAVU: таблица ${name} не того размера`);
      luts.push({ name, w, h, data });
    }
  }
  if (!/vec4 hook\(\)/.test(body) || !luts.length) throw new Error('RAVU: не похоже на шейдер mpv');
  return { body, luts };
}

const cache = new Map();
// r: 'r2' (быстрее) или 'r3' (точнее)
function load(r) {
  if (!['r2', 'r3'].includes(r)) return null;
  // файл в 3–5 МБ читаем без остановки основного процесса; несколько вкладок сразу ждут одно и то же чтение
  if (!cache.has(r)) cache.set(r, fs.promises.readFile(path.join(__dirname, 'ravu', `ravu-zoom-ar-${r}-rgb.hook`), 'utf8').then(parseHook).catch((e) => { cache.delete(r); throw e; }));
  return cache.get(r);
}

module.exports = { parseHook, load };
