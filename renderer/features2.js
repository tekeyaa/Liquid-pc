/* Liquid 1.3 — скриншоты, режим чтения, заметки, видео-панель, игровой режим */
(function () {
  const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const isWeb = (u) => /^https?:/.test(u || '');
  const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`; };
  const safeName = (s) => String(s || 'page').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'page';

  function savedToast(file, what) {
    toast(`${what} сохранён и скопирован — ${file.split(/[\\/]/).slice(-2).join('/')}`);
  }

  // ================= Скриншоты =================
  window.openShot = () => { if (!active?.wv) return; openPop('#shotPop'); };
  async function shotVisible() {
    const t = active; if (!t?.wv || !t.wcId) return;
    const data = await L.shot.visible(t.wcId);
    const file = await L.saveFile(`${safeName(t.title)} ${stamp()}.png`, data, 'shot', true);
    flash(); savedToast(file, 'Скриншот');
  }
  async function shotFull() {
    const t = active; if (!t?.wv || !t.wcId) return;
    toast('Снимаю всю страницу…');
    const r = await L.shot.full(t.wcId);
    if (!r.ok) { toast('Не получилось: ' + r.error, true); return; }
    // склеиваем куски на холсте
    const c = document.createElement('canvas');
    c.width = r.width; c.height = r.height;
    const g = c.getContext('2d');
    for (const tile of r.tiles) {
      const img = new Image();
      img.src = 'data:image/png;base64,' + tile.data;
      await img.decode();
      g.drawImage(img, 0, tile.y);
    }
    const data = c.toDataURL('image/png');
    const file = await L.saveFile(`${safeName(t.title)} ${stamp()} (вся).png`, data, 'shot', true);
    flash(); savedToast(file, r.cut ? 'Скриншот (первые 30 000 px)' : 'Скриншот всей страницы');
  }
  function shotArea() {
    const t = active; if (!t?.wv) return;
    const ov = $('#areaShot');
    const views = $('#views').getBoundingClientRect();
    const wvr = t.wv.getBoundingClientRect();
    ov.classList.add('open');
    const sel = ov.querySelector('.sel');
    sel.style.cssText = 'display:none';
    let x0 = 0, y0 = 0, drag = false;
    const down = (e) => { drag = true; x0 = e.clientX; y0 = e.clientY; sel.style.cssText = `display:block;left:${x0}px;top:${y0}px;width:0;height:0`; };
    const move = (e) => {
      if (!drag) return;
      const x = Math.min(x0, e.clientX), y = Math.min(y0, e.clientY);
      sel.style.cssText = `display:block;left:${x}px;top:${y}px;width:${Math.abs(e.clientX - x0)}px;height:${Math.abs(e.clientY - y0)}px`;
    };
    const up = async (e) => {
      if (!drag) return;
      drag = false;
      cleanup();
      const x = Math.max(Math.min(x0, e.clientX), wvr.left), y = Math.max(Math.min(y0, e.clientY), wvr.top);
      const x1 = Math.min(Math.max(x0, e.clientX), wvr.right), y1 = Math.min(Math.max(y0, e.clientY), wvr.bottom);
      const w = Math.round(x1 - x), h = Math.round(y1 - y);
      if (w < 8 || h < 8) return;
      const data = await L.shot.visible(t.wcId, { x: Math.round(x - wvr.left), y: Math.round(y - wvr.top), width: w, height: h });
      const file = await L.saveFile(`${safeName(t.title)} ${stamp()} (область).png`, data, 'shot', true);
      flash(); savedToast(file, 'Скриншот области');
    };
    const key = (e) => { if (e.key === 'Escape') cleanup(); };
    function cleanup() {
      ov.classList.remove('open');
      ov.removeEventListener('pointerdown', down); ov.removeEventListener('pointermove', move); ov.removeEventListener('pointerup', up);
      document.removeEventListener('keydown', key);
    }
    ov.addEventListener('pointerdown', down); ov.addEventListener('pointermove', move); ov.addEventListener('pointerup', up);
    document.addEventListener('keydown', key);
    void views;
  }
  function flash() { const f = $('#shotFlash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
  $('#shotPop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-shot]');
    if (!b) return;
    closePops();
    setTimeout(() => ({ visible: shotVisible, full: shotFull, area: shotArea })[b.dataset.shot](), 180);
  });

  // ================= Режим чтения =================
  let readerPrefs = lsGet('liquid.reader', { size: 20, font: 'serif', theme: 'dark', width: 720 });
  window.toggleReader = () => {
    const t = active;
    if (!t?.wv || !isWeb(t.url)) return;
    t.wv.send('liquid', { type: 'reader', prefs: readerPrefs, on: t.reading ? false : undefined });
  };
  $('#readerBtn').onclick = () => window.toggleReader();

  // ================= Видео =================
  // Панель видео теперь всплывает прямо над видео (её рисует скрипт страницы); тут — запоминание скорости и сохранение кадров
  const vidPrefs = lsGet('liquid.videoSpeed', {}); // host -> скорость
  window.openVideo = () => active?.wv?.send('liquid', { type: 'video', op: 'overlay' });

  // ================= Заметки =================
  let notes = lsGet('liquid.notes', []);
  const saveNotes = () => lsSet('liquid.notes', notes);
  L.onNote(({ text, url, title }) => {
    notes.unshift({ id: Date.now(), text: text.trim(), url, title, at: Date.now() });
    saveNotes();
    toast('Сохранено в заметки ✎');
    bumpNotes();
  });
  function bumpNotes() { const b = $('#notesCount'); if (b) b.textContent = notes.length || ''; }
  window.openNotes = () => { openPop('#notesPop'); $('#notesSearch').value = ''; renderNotes(); };
  function notesMarkdown(list) {
    return list.map((n) => `> ${n.text.replace(/\n/g, '\n> ')}\n\n— [${n.title || hostOf(n.url)}](${n.url}), ${new Date(n.at).toLocaleDateString('ru-RU')}`).join('\n\n---\n\n');
  }
  function renderNotes() {
    const q = $('#notesSearch').value.trim().toLowerCase();
    const list = notes.filter((n) => !q || n.text.toLowerCase().includes(q) || (n.title || '').toLowerCase().includes(q));
    $('#notesList').innerHTML = list.map((n) => `
      <div class="note" data-id="${n.id}">
        <div class="note-t">${esc(n.text.length > 600 ? n.text.slice(0, 600) + '…' : n.text)}</div>
        <div class="note-src"><a data-url="${esc(n.url)}">${esc(n.title || hostOf(n.url))}</a> · ${new Date(n.at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
          <span class="note-act"><button data-copy="${n.id}">копировать</button><button data-del="${n.id}">удалить</button></span></div>
      </div>`).join('') || `<div class="lib-empty">${q ? 'Ничего не нашлось' : 'Заметок пока нет.<br>Выдели текст на сайте → правый клик → «Сохранить в заметки»'}</div>`;
  }
  $('#notesSearch').addEventListener('input', renderNotes);
  $('#notesList').addEventListener('click', (e) => {
    const a = e.target.closest('[data-url]');
    if (a) { closePops(); createTab(a.dataset.url, { after: active }); return; }
    const c = e.target.closest('[data-copy]');
    if (c) { const n = notes.find((x) => x.id === +c.dataset.copy); if (n) { L.copy(`${n.text}\n\n— ${n.url}`); toast('Скопировано'); } return; }
    const d = e.target.closest('[data-del]');
    if (d) { notes = notes.filter((x) => x.id !== +d.dataset.del); saveNotes(); renderNotes(); bumpNotes(); }
  });
  $('#notesExport').onclick = async () => {
    if (!notes.length) return;
    const md = `# Заметки Liquid\n\n${notesMarkdown(notes)}\n`;
    const file = await L.saveFile(`Заметки ${stamp()}.md`, new TextEncoder().encode(md), 'note');
    toast('Заметки сохранены — ' + file.split(/[\\/]/).pop());
  };
  $('#notesClaude').onclick = () => {
    if (!notes.length) return;
    const text = `Вот мои заметки с сайтов. Сделай по ним краткий структурированный конспект с главными мыслями и ссылками на источники.\n\n${notesMarkdown(notes.slice(0, 60))}`;
    closePops();
    window.pasteToClaude(text);
  };
  window.pasteToClaude = (text) => {
    toggleSide(true);
    if (settings.claudeMode !== 'api') {
      L.copy(text);
      const wv = ensureClaudeWeb();
      setTimeout(() => { try { wv.focus(); wv.paste(); toast('Вставлено в чат Claude — нажми Enter'); } catch { toast('Скопировано — вставь в чат Claude (Ctrl+V)'); } }, 400);
    } else {
      $('#prompt').value = text;
      $('#prompt').dispatchEvent(new Event('input'));
      $('#prompt').focus();
    }
  };

  // ================= Сообщения со страниц =================
  const prevOnPage = window.onPageMsg;
  window.onPageMsg = (tab, m) => {
    if (m.type === 'reader') {
      tab.reading = m.state === 'on';
      if (m.state === 'none') toast('Не нашёл на странице статью для режима чтения');
      if (tab === active) $('#readerBtn').classList.toggle('on', !!tab.reading);
      return;
    }
    if (m.type === 'readerPrefs') { readerPrefs = m.prefs; lsSet('liquid.reader', readerPrefs); return; }
    if (m.type === 'videoState') return;
    if (m.type === 'videoRemember') { const h = hostOf(tab.url); if (m.on) vidPrefs[h] = m.speed || 1; else delete vidPrefs[h]; lsSet('liquid.videoSpeed', vidPrefs); return; }
    if (m.type === 'pipFail') { toast('Этот сайт не разрешает картинку в картинке', true); return; }
    if (m.type === 'srFail') {
      const why = { cors: 'этот сайт не даёт обработать своё видео', gpu: 'видеокарта не отдала кадр', stall: 'кадры перестали обновляться', nogl: 'нет WebGL' }[m.reason] || 'не получилось обработать видео';
      toast(`Супер-чёткость выключена: ${why}. Показываю обычное видео.`, true);
      return;
    }
    if (m.type === 'srPref') { window.saveSrPref({ superRes: m.level, srHdr: !!m.hdr }); return; }
    if (m.type === 'videoPrefs') { const h = hostOf(tab.url); if (vidPrefs[h]) { vidPrefs[h] = m.speed; lsSet('liquid.videoSpeed', vidPrefs); } return; }
    if (m.type === 'videoErr') { toast('Видео: ' + m.error, true); return; }
    if (m.type === 'frame') {
      L.saveFile(`Кадр ${safeName(tab.title)} ${stamp()}.png`, m.data, 'shot', true).then((f) => { flash(); savedToast(f, 'Кадр'); });
      return;
    }
    if (m.type === 'page') {
      tab.page = { ...tab.page, readable: m.readable };
      // запомненная скорость видео для сайта
      const sp = vidPrefs[hostOf(tab.url)];
      if (m.video) tab.wv?.send('liquid', { ...videoPrefsMsg(), speed: sp || 0, remember: !!sp });
    }
    prevOnPage && prevOnPage(tab, m);
  };
  const prevSync = window.syncOmniExtras;
  window.syncOmniExtras = (tab) => {
    prevSync && prevSync(tab);
    if (!tab || tab !== active) return;
    const web = isWeb(tab.url);
    $('#readerBtn').classList.toggle('show', web && !!(tab.page?.readable || tab.reading));
    $('#readerBtn').classList.toggle('on', !!tab.reading);
  };

  // ================= Игровой режим =================
  let gameOn = false;
  function gameApply({ on, game, keepAudio }) {
    if (on === gameOn) return;
    gameOn = on;
    document.body.classList.toggle('game', on);
    $('#gameBadge').title = on ? `Игровой режим: ${game || 'игра'} — браузер отдал ресурсы игре` : '';
    if (on) {
      let n = 0;
      for (const t of tabs) {
        if (keepAudio !== false && t.playing) continue;
        if (t === active) { if (t.wv && !t.playing) { try { t.url = t.wv.getURL() || t.url; } catch {} t.wv.remove(); t.wv = null; t.wcId = null; t.sleeping = true; t.el.classList.add('sleeping'); n++; } continue; }
        if (sleepTab(t)) n++;
      }
      if (claudeWv && !document.body.classList.contains('side')) { claudeWv.remove(); claudeWv = null; }
      toast(`🎮 Игровой режим${game && game !== 'вручную' ? ': ' + game : ''} — усыпил вкладок: ${n}`);
    } else {
      toast('Игровой режим выключен');
      if (document.hasFocus()) wakeActive();
    }
    syncGameUi();
  }
  function wakeActive() { if (active && !active.wv) { attachWebview(active, active.url); active.el.classList.remove('sleeping'); layoutViews(); syncChrome(); } }
  window.addEventListener('focus', wakeActive);
  L.game.onState(gameApply);
  function syncGameUi() {
    $('#gameMenuLbl').textContent = gameOn ? 'Выключить игровой режим' : 'Игровой режим';
    $('#gameBtn').classList.toggle('on', gameOn);
    $('#gameBtn').title = gameOn ? `Игровой режим включён${$('#gameBadge').title ? '' : ''} — нажми, чтобы выключить` : 'Игровой режим: усыпить вкладки и отдать ресурсы игре';
  }
  window.toggleGame = () => L.game.force(gameOn ? null : true);
  $('#gameBadge').onclick = () => L.game.force(null);
  $('#gameBtn').onclick = () => window.toggleGame();

  // ================= Меню и хоткеи =================
  $('#menuPop').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]');
    if (!b) return;
    const fn = { shot: window.openShot, reader: window.toggleReader, notes: window.openNotes, game: window.toggleGame }[b.dataset.m];
    if (fn) { closePops(); setTimeout(fn, 60); }
  });
  L.onShortcut(({ key }) => {
    if (key === 'shot') window.openShot();
    else if (key === 'reader') window.toggleReader();
    else if (key === 'video') active?.wv?.send('liquid', { type: 'video', op: 'overlay' });
  });

  // настройки
  window.features2Init = () => {
    $('#gameMode').checked = settings.gameMode !== false;
    $('#gameKeepAudio').checked = settings.gameKeepAudio !== false;
    bumpNotes();
    renderSr();
    $('#aboutLine').textContent = `Liquid ${settings.version || ''} · движок Electron ${settings.electron || ''}`;
    L.game.state().then((s) => { if (!s.supported) { $('#gameRow').style.display = 'none'; } gameApply(s); syncGameUi(); });
  };
  $('#gameMode').onchange = async (e) => { settings = await L.settings.set({ gameMode: e.target.checked }); };

  // ---- видео: Супер-чёткость и панель на видео ----
  function videoPrefsMsg() { return { type: 'video', op: 'prefs', sr: settings.superRes || 'off', srHdr: !!settings.srHdr, bar: settings.vidBar !== false }; }
  function pushVideoPrefs() { for (const t of tabs) if (t.wv && /^https?:/.test(t.url)) { try { t.wv.send('liquid', videoPrefsMsg()); } catch {} } }
  function renderSr() {
    $('#srLevel').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === (settings.superRes || 'off')));
    $('#srHdr').checked = !!settings.srHdr;
    $('#vidBar').checked = settings.vidBar !== false;
  }
  window.renderSr = renderSr;
  $('#srLevel').addEventListener('click', async (e) => { const b = e.target.closest('button'); if (!b) return; settings = await L.settings.set({ superRes: b.dataset.v }); renderSr(); pushVideoPrefs(); });
  $('#srHdr').onchange = async (e) => { settings = await L.settings.set({ srHdr: e.target.checked }); pushVideoPrefs(); };
  $('#vidBar').onchange = async (e) => { settings = await L.settings.set({ vidBar: e.target.checked }); pushVideoPrefs(); };
  window.saveSrPref = async (p) => { settings = await L.settings.set(p); renderSr(); pushVideoPrefs(); };
  $('#setClose').onclick = () => closePops();
  $('#setExt').onclick = () => { closePops(); setTimeout(() => window.openExtensions(), 120); };
  $('#gameKeepAudio').onchange = async (e) => { settings = await L.settings.set({ gameKeepAudio: e.target.checked }); };
})();
