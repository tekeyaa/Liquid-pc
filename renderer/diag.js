/* Liquid — вкладка «Отладка»: журнал ошибок и отчёт для Claude */
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  let min = 'error';
  const NAMES = { crash: 'Падение', error: 'Ошибка', warn: 'Внимание', info: 'Инфо', debug: 'Отладка' };

  async function render() {
    const { items } = await L.diag.list(min);
    const box = $('#diagList');
    box.innerHTML = items.slice().reverse().map((e) => `
      <div class="dg ${e.level}">
        <div class="dg-top"><b>${NAMES[e.level] || e.level}${e.count > 1 ? ` ×${e.count}` : ''}</b><span>${esc(e.source)}</span><time>${new Date(e.t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div>
        <div class="dg-msg">${esc(e.msg)}</div>${e.extra ? `<div class="dg-x">${esc(e.extra)}</div>` : ''}
      </div>`).join('') || `<div class="lib-empty">${min === 'error' ? 'Ошибок нет — всё работает 👌' : 'Записей нет'}</div>`;
  }
  function setBadge(n) {
    $('#menuDot').classList.toggle('on', n > 0);
    $('#debugDot').classList.toggle('on', n > 0);
    $('#menuErrCount').textContent = n ? String(n) : '';
    // кнопка журнала на панели: число новых ошибок
    $('#logCount').textContent = n ? (n > 99 ? '99+' : String(n)) : '';
    $('#logBtn').classList.toggle('has', n > 0);
    $('#logBtn').title = n ? `Журнал ошибок — новых: ${n}` : 'Журнал ошибок';
  }
  $('#logBtn').onclick = () => window.openDebug();
  // агента идей больше нет — убираем его записи
  try { localStorage.removeItem('liquid.ideas.stats'); localStorage.removeItem('liquid.ideas.state'); } catch {}
  window.openDebug = () => { window.openSettings('debug'); };
  const origSetTab = window.setTab;
  window.setTab = (name) => { origSetTab(name); if (name === 'debug') { render(); L.diag.seen(); setBadge(0); } };

  $('#diagFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    min = b.dataset.v;
    $('#diagFilter').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    render();
  });
  $('#diagCopy').onclick = async () => { L.copy(await L.diag.report()); toast('Отчёт скопирован — вставь его в чат с Claude'); };
  $('#diagSave').onclick = async () => { const f = await L.diag.save(); toast('Отчёт сохранён в «Загрузки»: ' + f.split(/[\\/]/).pop()); };
  $('#diagFolder').onclick = () => L.diag.folder();
  $('#diagClear').onclick = () => { L.diag.clear(); render(); setBadge(0); };
  $('#menuPop').addEventListener('click', (e) => { const b = e.target.closest('button[data-m="debug"]'); if (b) { closePops(); setTimeout(window.openDebug, 80); } });

  L.diag.onNew(({ unseen, last }) => {
    setBadge(unseen);
    if ($('#setPop').classList.contains('open') && $('.set-sec.debug').classList.contains('on')) { render(); L.diag.seen(); setBadge(0); }
    void last;
  });
  L.diag.list('error').then(({ unseen }) => setBadge(unseen));
})();
