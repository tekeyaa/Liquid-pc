// Разбор профилей (.cpuprofile) из автотестов: где основной процесс и окно браузера тратят время.
// node tests/prof.js файл... → строки для пометок GitHub: самые затратные функции и что делалось во время заминок
const fs = require('fs'); const path = require('path');
const OURS = /liquid-pc|Liquid-pc|[\\/](main|renderer)[\\/]|main\.js|webview-preload|preload\.js|@ghostery/;
const short = (u) => String(u || '').replace(/^.*?(node_modules[\\/]|[\\/](?=main[\\/]|renderer[\\/]|main\.js|preload|webview-preload))/, '').replace(/\\/g, '/') || '';
for (const f of process.argv.slice(2)) {
  const p = JSON.parse(fs.readFileSync(f, 'utf8'));
  const nodes = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const name = (n) => { const c = n.callFrame; return `${c.functionName || '(анон.)'}${c.url ? ' ' + short(c.url) + ':' + (c.lineNumber + 1) : ''}`; };
  const IDLE = new Set(['(idle)', '(root)', '(program)']); // (program) — ожидание событий или работа движка вне JS: в заминки его не считаем
  // кому приписать сэмпл: ближайшая по стеку функция нашего кода (или блокировщика), иначе сам лист
  const owner = (id) => { for (let x = id; x != null; x = parent.get(x)) { const n = nodes.get(x); if (OURS.test(n.callFrame.url)) return name(n); } return name(nodes.get(id)); };
  const self = new Map(), own = new Map(); let program = 0;
  const busy = []; let cur = null; let total = 0;
  for (let i = 0; i < p.samples.length; i++) {
    const n = nodes.get(p.samples[i]); const dt = (p.timeDeltas[i + 1] ?? 1000) / 1000; total += dt;
    const idle = IDLE.has(n.callFrame.functionName);
    if (n.callFrame.functionName === '(program)') program += dt;
    if (!idle) {
      self.set(name(n), (self.get(name(n)) || 0) + dt);
      const o = owner(n.id); own.set(o, (own.get(o) || 0) + dt);
      if (!cur) cur = { ms: 0, by: new Map(), at: total }; cur.ms += dt; cur.by.set(o, (cur.by.get(o) || 0) + dt);
    } else if (cur && dt + 0 > 0) { if (cur.ms > 150) busy.push(cur); cur = null; }
  }
  if (cur && cur.ms > 150) busy.push(cur);
  const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([n, ms]) => `${Math.round(ms)} мс ${n}`);
  const label = path.basename(f).split('-')[0];
  const work = [...self.values()].reduce((a, b) => a + b, 0);
  console.log(`[${label}] записано ${Math.round(total / 1000)} с, JS занят ${Math.round(work)} мс, вне JS ${Math.round(program)} мс; заминок дольше 150 мс: ${busy.length}`);
  console.log(`[${label}] больше всего времени (с вызванными функциями, по нашему коду): ` + top(own, 12).join(' | '));
  console.log(`[${label}] самые затратные функции сами по себе: ` + top(self, 10).join(' | '));
  busy.sort((a, b) => b.ms - a.ms).slice(0, 8).forEach((b) => console.log(`[${label}] заминка ${Math.round(b.ms)} мс на ${Math.round(b.at / 1000)} с: ` + top(b.by, 4).join(' | ')));
}
