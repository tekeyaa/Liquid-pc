/* Liquid 1.10 — окно поверх игры (видео из вкладки в отдельном маленьком окне) */
(() => {
  const tabByWc = (id) => tabs.find((t) => t.wcId === id);
  const videoCmd = (tab, op, extra = {}) => { try { tab?.wv?.send('liquid', { type: 'video', op, ...extra }); } catch {} };

  window.openMini = (tab = active) => videoCmd(tab, 'mini');
  L.mini.onBack(({ wcId, t }) => {
    const tab = tabByWc(wcId);
    if (!tab) return;
    activate(tab);
    videoCmd(tab, 'seekPlay', { t });
  });

  const prevPage = window.onPageMsg;
  window.onPageMsg = (tab, m) => {
    if (m.type === 'mini') { L.mini.open({ url: m.url, t: m.t, wcId: tab.wcId }); toast('Видео — в окне поверх. Ctrl+Alt+M — пропускать клики в игру, Esc — закрыть'); return; }
    prevPage && prevPage(tab, m);
  };

  // Ctrl+K и меню
  window.paletteExtra = () => [['Окно поверх игры', 'видео', () => window.openMini()]];
  $('#menuPop').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]'); if (!b) return;
    const fn = { mini: () => window.openMini() }[b.dataset.m];
    if (fn) { closePops(); setTimeout(fn, 60); }
  });
  L.onShortcut(({ key }) => { if (key === 'mini') window.openMini(); });
})();
