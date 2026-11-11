// Сборка движка блокировщика рекламы — в отдельном служебном процессе.
// Разбор нескольких мегабайт правил занимает 1–3 секунды. Раньше это делал основной процесс браузера,
// и всё это время окно не отвечало на клики, а сайты ждали (замер в автотестах: 2,5 с заминки).
// Сюда приходят пути к спискам на диске, обратно — путь к готовому движку (большие данные через postMessage
// стоили основному процессу секунды заминки).
process.parentPort.once('message', (e) => {
  try {
    const { parts, exceptions, oldHash, out, resources } = e.data;
    const fs = require('fs');
    const read = (p) => (typeof p === 'string' ? p : p.file ? fs.readFileSync(p.file, 'utf8') : p.text || '');
    // чтение, склейка и отпечаток списков — тоже здесь: на основном процессе это стоило ещё ~60 мс
    const text = parts.map(read).join('\n');
    // ресурсы uBlock (тела скриптлетов) — в отпечатке: появились или изменились — движок пересобирается
    const res = resources ? read(resources) : '';
    const h = require('crypto').createHash('sha256').update(text).update((exceptions || []).join('\n'));
    if (res) h.update('\n#resources\n').update(res);
    const hash = h.digest('hex');
    if (oldHash && oldHash === hash) { process.parentPort.postMessage({ ok: true, same: true, hash }); setTimeout(() => process.exit(0), 100); return; }
    const { FiltersEngine, CosmeticFilter } = require('@ghostery/adblocker');
    const engine = FiltersEngine.parse(text, { enableCompression: true, loadCosmeticFilters: true, loadNetworkFilters: true, integrityCheck: false });
    const extra = (exceptions || []).map((l) => CosmeticFilter.parse(l)).filter(Boolean);
    if (extra.length) engine.update({ newCosmeticFilters: extra });
    // ресурсы не разобрались (сменился формат) — движок всё равно нужен: без скриптлетов, как раньше
    let resErr = '';
    if (res) { try { engine.updateResources(res, hash.slice(0, 16)); } catch (err) { resErr = String((err && err.message) || err).slice(0, 300); } }
    const buf = engine.serialize();
    if (out) { fs.writeFileSync(out, buf); process.parentPort.postMessage({ ok: true, file: out, hash, resErr }); }
    else process.parentPort.postMessage({ ok: true, buf, hash, resErr });
  } catch (err) {
    process.parentPort.postMessage({ ok: false, error: String((err && err.stack) || err) });
  }
  setTimeout(() => process.exit(0), 100);
});
