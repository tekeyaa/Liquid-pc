/* Liquid — скриншоты, режим чтения, заметки, видео */
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
  // Панель видео рисует скрипт страницы (кружок на видео); тут — запоминание скорости и сохранение кадров
  const vidPrefs = lsGet('liquid.videoSpeed', {}); // host -> скорость

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
    if (m.type === 'videoRemember') { const h = hostOf(tab.url); if (m.on) vidPrefs[h] = m.speed || 1; else delete vidPrefs[h]; lsSet('liquid.videoSpeed', vidPrefs); return; }
    if (m.type === 'pipFail') { toast('Этот сайт не разрешает картинку в картинке', true); return; }
    if (m.type === 'srFail') {
      const why = { gpu: 'видеокарта не отдала кадр', stall: 'кадры перестали обновляться', nogl: 'нет WebGL' }[m.reason] || 'не получилось обработать видео';
      toast(`Супер-чёткость выключена: ${why}. Показываю обычное видео.`, true);
      return;
    }
    if (m.type === 'srPref') { window.saveSrPref({ superRes: m.level, srHdr: !!m.hdr, ...(m.content ? { srContent: m.content } : {}) }); return; }
    if (m.type === 'lpPref') { window.saveSrPref(m.smooth != null ? { lpSmooth: !!m.smooth } : { lpAuto: !!m.auto }); return; }
    if (m.type === 'lpOpen') return;
    if (m.type === 'videoPrefs') { const h = hostOf(tab.url); if (vidPrefs[h]) { vidPrefs[h] = m.speed; lsSet('liquid.videoSpeed', vidPrefs); } return; }
    if (m.type === 'videoErr') { toast('Видео: ' + m.error, true); return; }
    if (m.type === 'rtxMsg') { toast(m.text, !!m.error); return; }
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


  // ================= Меню и хоткеи =================
  $('#menuPop').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]');
    if (!b) return;
    const fn = { shot: window.openShot, reader: window.toggleReader, notes: window.openNotes }[b.dataset.m];
    if (fn) { closePops(); setTimeout(fn, 60); }
  });
  L.onShortcut(({ key }) => {
    if (key === 'shot') window.openShot();
    else if (key === 'reader') window.toggleReader();
    else if (key === 'video') active?.wv?.send('liquid', { type: 'video', op: 'overlay' });
    else if (key === 'navBack' || key === 'navForward') window.mouseNav && window.mouseNav(active, key === 'navBack' ? 'back' : 'forward');
  });

  // настройки
  window.features2Init = () => {
    bumpNotes();
    renderSr();
    $('#aboutLine').textContent = `Liquid ${settings.version || ''} · движок Electron ${settings.electron || ''}`;
  };

  // ---- видео: Супер-чёткость и панель на видео ----
  function videoPrefsMsg() { return { type: 'video', op: 'prefs', sr: settings.superRes || 'off', srHdr: !!settings.srHdr, bar: settings.vidBar !== false, lpAuto: settings.lpAuto !== false, lpSmooth: settings.lpSmooth !== false, learn: !!settings.rtxLearn, deband: settings.srDeband !== false }; }
  function pushVideoPrefs() { for (const t of tabs) if (t.wv && /^https?:/.test(t.url)) { try { t.wv.send('liquid', videoPrefsMsg()); } catch {} } }
  function renderSr() {
    $('#srLevel').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === (settings.superRes || 'off')));
    $('#srHdr').checked = !!settings.srHdr;
    $('#vidBar').checked = settings.vidBar !== false;
    $('#lpAuto').checked = settings.lpAuto !== false;
    $('#lpSmooth').checked = settings.lpSmooth !== false;
    $('#srDeband').checked = settings.srDeband !== false;
    $('#rtxLearn').checked = !!settings.rtxLearn; $('#rtxLearnBox').hidden = !settings.rtxLearn;
    $('#rtxLearnGb').value = String(settings.rtxLearnGb || 1);
    $('#rtxLearnWatch').checked = settings.rtxLearnWatch !== false;
    $('#rtxTrainHours').value = String(settings.rtxTrainHours || 0);
    $('#rtxAutoTrain').checked = !!settings.rtxAutoTrain;
    learnStat();
  }
  // режим обучения Liquid RTX: очередь роликов и сколько уже собрано
  const mb = (b) => (b >= 2 ** 30 ? (b / 2 ** 30).toFixed(1).replace('.', ',') + ' ГБ' : Math.round(b / 2 ** 20) + ' МБ');
  async function learnStat() {
    if (!L.rtxLearn) return;
    if (settings.rtxLearn) {
      const s = await L.rtxLearn.status().catch(() => null);
      if (s) {
        const full = s.bytes >= s.budget;
        $('#rtxLearnStat').textContent = `Собрано ${mb(s.bytes)} из ${mb(s.budget)} · роликов ${s.done}, в очереди ${s.queued}` + (s.skipped ? `, пропущено ${s.skipped}` : '') +
          (s.busy ? ` · сейчас: ${s.cur}` : s.wait ? ` · ${s.wait}` : '') + (s.last ? ` · прошлый ролик за ${Math.max(1, Math.round(s.last / 1000))} с` : '');
        $('#rtxMeter i').style.width = Math.min(100, (s.bytes / s.budget) * 100).toFixed(1) + '%';
        $('#rtxMeter').classList.toggle('full', full);
      }
    }
    const t = await L.rtxLearn.trainState().catch(() => null); if (!t) return;
    $('#rtxTrainGo').hidden = t.running; $('#rtxTrainStop').hidden = !t.running; $('#rtxTrainHours').disabled = t.running;
    const day = (x) => new Date(x).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    $('#rtxMine').textContent = t.mine ? `Твоя сеть обучена${t.mine.at ? ' ' + day(t.mine.at) : ''}${t.mine.gain ? ` · точнее на ${t.mine.gain.toFixed(2).replace('.', ',')} дБ` : ''}` : 'Своя сеть ещё не обучена';
    $('#rtxTrainStat').textContent = t.msg || (t.mine ? 'Можно доучить — станет ещё точнее.' : t.ready ? 'Пока работает встроенная. Учится на собранных роликах; лучше ставить на 6–12 часов.'
      : 'Пока работает встроенная. Нужна видеокарта NVIDIA; в первый раз браузер сам скачает Python и PyTorch (~3 ГБ).');
  }
  // по видимой строке «Своя сеть», а не по кнопке «Обучить»: во время обучения кнопка скрыта, и статус замирал
  setInterval(() => { if ($('#rtxMine') && $('#rtxMine').offsetParent) learnStat(); }, 2000);
  $('#rtxLearn').onchange = async (e) => { settings = await L.settings.set({ rtxLearn: e.target.checked }); renderSr(); pushVideoPrefs(); };
  $('#rtxLearnWatch').onchange = async (e) => { settings = await L.settings.set({ rtxLearnWatch: e.target.checked }); renderSr(); };
  $('#rtxLearnGb').onchange = async (e) => { settings = await L.settings.set({ rtxLearnGb: Number(e.target.value) }); renderSr(); };
  $('#rtxLinksAdd').onclick = async () => { const txt = $('#rtxLinks').value; if (/[?&]list=/.test(txt) && window.toast) window.toast('Разворачиваю плейлист…');
    const n = await L.rtxLearn.add(txt); $('#rtxLinks').value = ''; learnStat(); if (window.toast) window.toast(n ? `В очередь: ${n}` : 'Новых ссылок YouTube не нашлось'); };
  $('#rtxLearnOpen').onclick = () => L.rtxLearn.open();
  $('#rtxTrainGo').onclick = async () => { await L.rtxLearn.train('auto', Number($('#rtxTrainHours').value)); learnStat(); };
  $('#rtxTrainHours').onchange = async (e) => { settings = await L.settings.set({ rtxTrainHours: Number(e.target.value) }); };
  $('#rtxAutoTrain').onchange = async (e) => { settings = await L.settings.set({ rtxAutoTrain: e.target.checked }); };
  $('#rtxTrainStop').onclick = async () => { await L.rtxLearn.trainStop(); setTimeout(learnStat, 800); };
  $('#srLevel').addEventListener('click', async (e) => { const b = e.target.closest('button'); if (!b) return; settings = await L.settings.set({ superRes: b.dataset.v }); renderSr(); pushVideoPrefs(); });
  $('#srHdr').onchange = async (e) => { settings = await L.settings.set({ srHdr: e.target.checked }); pushVideoPrefs(); };
  $('#vidBar').onchange = async (e) => { settings = await L.settings.set({ vidBar: e.target.checked }); pushVideoPrefs(); };
  $('#srDeband').onchange = async (e) => { settings = await L.settings.set({ srDeband: e.target.checked }); pushVideoPrefs(); };
  $('#lpAuto').onchange = async (e) => { settings = await L.settings.set({ lpAuto: e.target.checked }); pushVideoPrefs(); };
  $('#lpSmooth').onchange = async (e) => { settings = await L.settings.set({ lpSmooth: e.target.checked }); pushVideoPrefs(); };
  window.saveSrPref = async (p) => { settings = await L.settings.set(p); renderSr(); pushVideoPrefs(); };
  $('#setClose').onclick = () => closePops();
  $('#setExt').onclick = () => { closePops(); setTimeout(() => window.openExtensions(), 120); };
})();
