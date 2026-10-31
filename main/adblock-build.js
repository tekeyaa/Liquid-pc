// Сборка движка блокировщика рекламы — в отдельном служебном процессе.
// Разбор нескольких мегабайт правил занимает 1–3 секунды. Раньше это делал основной процесс браузера,
// и всё это время окно не отвечало на клики, а сайты ждали (замер в автотестах: 2,5 с заминки).
// Сюда приходит текст списков, обратно уходит готовый движок в двоичном виде.
process.parentPort.once('message', (e) => {
  try {
    const { text, exceptions } = e.data;
    const { FiltersEngine, CosmeticFilter } = require('@ghostery/adblocker');
    const engine = FiltersEngine.parse(text, { enableCompression: true, loadCosmeticFilters: true, loadNetworkFilters: true });
    const extra = (exceptions || []).map((l) => CosmeticFilter.parse(l)).filter(Boolean);
    if (extra.length) engine.update({ newCosmeticFilters: extra });
    process.parentPort.postMessage({ ok: true, buf: engine.serialize() });
  } catch (err) {
    process.parentPort.postMessage({ ok: false, error: String((err && err.stack) || err) });
  }
  setTimeout(() => process.exit(0), 100);
});
