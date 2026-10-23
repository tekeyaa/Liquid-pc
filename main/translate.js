// Перевод текста страниц. Три движка по очереди: если один не отвечает (бывает, что Google режут),
// берём следующий. Тот, что сработал, запоминаем и в следующий раз пробуем первым.
const cache = new Map(); // 'ru|текст' -> перевод
let preferred = 0;
let msToken = '', msTokenExp = 0;

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ': нет ответа ' + ms / 1000 + ' с')), ms))]);

// пачки: не больше maxChars символов и maxItems строк
function chunk(texts, maxChars, maxItems, measure = (t) => t.length) {
  const out = []; let cur = [], len = 0;
  texts.forEach((t, i) => {
    const l = measure(t);
    if (cur.length && (len + l > maxChars || cur.length >= maxItems)) { out.push(cur); cur = []; len = 0; }
    cur.push(i); len += l + 3;
  });
  if (cur.length) out.push(cur);
  return out;
}

async function parallel(chunks, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, chunks.length) }, async () => { while (next < chunks.length) await fn(chunks[next++]); }));
}

// 1. Google (translate.googleapis.com, как в расширениях Chrome) — строки склеиваем через перевод строки
async function google(fetchFn, texts, to) {
  const out = new Array(texts.length);
  const one = async (q) => {
    const r = await withTimeout(fetchFn(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${to}&dt=t&q=${encodeURIComponent(q)}`), 12000, 'Google');
    if (!r.ok) throw new Error('Google ' + r.status);
    const j = await r.json();
    return (j[0] || []).map((s) => s[0] || '').join('');
  };
  await parallel(chunk(texts, 1800, 120, (t) => encodeURIComponent(t).length), 4, async (idx) => {
    const parts = (await one(idx.map((i) => texts[i].replace(/\n+/g, ' ')).join('\n'))).split('\n');
    if (parts.length === idx.length) idx.forEach((i, k) => (out[i] = parts[k]));
    else for (const i of idx) out[i] = await one(texts[i]);
  });
  return out;
}

// 2. Google, другой адрес (clients5 — словарь Chrome): несколько q в одном запросе
async function googleDict(fetchFn, texts, to) {
  const out = new Array(texts.length);
  await parallel(chunk(texts, 1800, 60, (t) => encodeURIComponent(t).length + 3), 4, async (idx) => {
    const q = idx.map((i) => 'q=' + encodeURIComponent(texts[i])).join('&');
    const r = await withTimeout(fetchFn(`https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${to}&${q}`), 12000, 'Google-2');
    if (!r.ok) throw new Error('Google-2 ' + r.status);
    let j = await r.json();
    if (idx.length === 1 && !Array.isArray(j[0]) && typeof j[0] === 'string' && j.length === 2 && j[1].length <= 5) j = [j];
    if (!Array.isArray(j) || j.length !== idx.length) throw new Error('Google-2: неожиданный ответ');
    idx.forEach((i, k) => (out[i] = Array.isArray(j[k]) ? j[k][0] : j[k]));
  });
  return out;
}

// 3. Microsoft Translator (движок Edge): токен с edge.microsoft.com, пачки до 100 строк
async function microsoft(fetchFn, texts, to) {
  if (!msToken || Date.now() > msTokenExp) {
    const r = await withTimeout(fetchFn('https://edge.microsoft.com/translate/auth'), 10000, 'Microsoft');
    if (!r.ok) throw new Error('Microsoft auth ' + r.status);
    msToken = (await r.text()).trim(); msTokenExp = Date.now() + 8 * 60_000;
  }
  const out = new Array(texts.length);
  await parallel(chunk(texts, 9000, 100), 3, async (idx) => {
    const r = await withTimeout(fetchFn(`https://api-edge.cognitivemicrosofttranslator.com/translate?from=&to=${to}&api-version=3.0&includeSentenceLength=false`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + msToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(idx.map((i) => ({ Text: texts[i] }))),
    }), 15000, 'Microsoft');
    if (r.status === 401) msToken = '';
    if (!r.ok) throw new Error('Microsoft ' + r.status);
    const j = await r.json();
    idx.forEach((i, k) => (out[i] = j[k]?.translations?.[0]?.text ?? texts[i]));
  });
  return out;
}

const ENGINES = [['Google', google], ['Google-2', googleDict], ['Microsoft', microsoft]];

/** Перевести массив строк. Возвращает массив переводов или null, если не сработал ни один движок (причины — в log). */
async function translateBatch(fetchFn, texts, to = 'ru', log = () => {}) {
  const out = new Array(texts.length);
  const todo = [];
  texts.forEach((t, i) => { const c = cache.get(to + '|' + t); if (c !== undefined) out[i] = c; else todo.push(i); });
  if (!todo.length) return out;
  const src = todo.map((i) => texts[i]);
  const errs = [];
  for (let k = 0; k < ENGINES.length; k++) {
    const e = (preferred + k) % ENGINES.length;
    const [name, fn] = ENGINES[e];
    try {
      const res = await fn(fetchFn, src, to);
      if (!res || res.length !== src.length) throw new Error(name + ': не совпало число строк');
      todo.forEach((i, j) => { const t = res[j] || texts[i]; out[i] = t; cache.set(to + '|' + texts[i], t); });
      if (preferred !== e) log('info', `Перевод: работает ${name}`);
      preferred = e;
      if (cache.size > 20000) cache.clear();
      return out;
    } catch (err) {
      errs.push(String((err && err.message) || err));
    }
  }
  log('warn', 'Перевод не удался ни одним движком: ' + errs.join('; '));
  return null;
}

module.exports = { translateBatch };
