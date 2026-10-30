/* Liquid 1.10 — видео и игры: окно поверх игры, клип последних 30 секунд, «Смотреть вместе» */
(() => {
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`; };
  const safeName = (s) => String(s || 'video').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'video';
  const tabByWc = (id) => tabs.find((t) => t.wcId === id);
  const videoCmd = (tab, op, extra = {}) => { try { tab?.wv?.send('liquid', { type: 'video', op, ...extra }); } catch {} };

  // ================= Окно поверх игры =================
  window.openMini = (tab = active) => videoCmd(tab, 'mini');
  L.mini.onBack(({ wcId, t }) => {
    const tab = tabByWc(wcId);
    if (!tab) return;
    activate(tab);
    videoCmd(tab, 'seekPlay', { t });
  });

  // ================= Клип =================
  window.saveClip = (tab = active) => videoCmd(tab, 'clip');
  window.toggleClipBuffer = (tab = active) => videoCmd(tab, 'clipbuf');

  // ================= Смотреть вместе =================
  // Комната привязана к одной вкладке: её видео синхронизируется у всех участников.
  const W = { code: '', state: 'off', tab: null, people: new Map(), chat: [], unread: 0, pending: null, beat: 0, broker: '' };
  let myName = lsGet('liquid.watchName', '');

  // одно и то же видео? У YouTube — по номеру ролика, у остальных — по адресу без параметров
  function sameVideo(a, b) {
    try {
      const x = new URL(a), y = new URL(b);
      const yt = (u) => (/youtube\.com$/.test(u.hostname.replace(/^www\.|^m\./, '')) ? u.searchParams.get('v') || u.pathname : null) || (u.hostname === 'youtu.be' ? u.pathname.slice(1) : null);
      if (yt(x) || yt(y)) return yt(x) === yt(y);
      return x.hostname.replace(/^www\./, '') === y.hostname.replace(/^www\./, '') && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '');
    } catch { return a === b; }
  }
  const tabUrl = (t) => { try { return t.wv.getURL() || t.url; } catch { return t?.url || ''; } };
  const send = (m) => L.watch.send({ ...m, name: myName || 'Гость' });

  function bindTab(tab) {
    if (W.tab && W.tab !== tab) { try { W.tab.wv?.send('liquid', { type: 'wt', on: false }); } catch {} W.tab.el.classList.remove('watching'); }
    W.tab = tab;
    if (tab) { tab.el.classList.add('watching'); try { tab.wv?.send('liquid', { type: 'wt', on: true }); } catch {} }
  }
  async function join(code) {
    if (!myName) { myName = ($('#wtName').value || '').trim().slice(0, 24) || 'Гость'; lsSet('liquid.watchName', myName); }
    const tab = W.tab || active;
    $('#wtErr').textContent = '';
    const r = await L.watch.join(code || '');
    if (!r.ok) { $('#wtErr').textContent = r.error; return; }
    W.code = r.code; W.people.clear(); W.chat = []; W.unread = 0;
    bindTab(tab);
    send({ type: 'hello' });
    clearInterval(W.beat);
    // раз в 5 секунд — где сейчас видео (у остальных расхождение больше 2,5 с поправится само)
    W.beat = setInterval(() => { if (W.tab?.wv) try { W.tab.wv.send('liquid', { type: 'wtPoll' }); } catch {} pruneP(); }, 5000);
    render();
  }
  function leave() {
    L.watch.leave();
    clearInterval(W.beat);
    bindTab(null);
    W.code = ''; W.state = 'off'; W.people.clear();
    render();
  }
  function pruneP() { const now = Date.now(); for (const [id, p] of W.people) if (now - p.seen > 45e3) W.people.delete(id); render(); }

  // мои действия с видео — остальным
  const prevPage = window.onPageMsg;
  window.onPageMsg = (tab, m) => {
    if (m.type === 'watchOpen') { window.openWatch(tab); return; }
    if (m.type === 'wtState') {
      if (!W.code || tab !== W.tab) return;
      const st = m.state || {};
      if (st.reason === 'beat' && st.paused) return; // на паузе сердцебиение не нужно
      send({ type: 'state', ...st });
      return;
    }
    if (m.type === 'mini') { L.mini.open({ url: m.url, t: m.t, wcId: tab.wcId }); toast('Видео — в окне поверх. Ctrl+Alt+M — пропускать клики в игру, Esc — закрыть'); return; }
    if (m.type === 'clip') {
      const ext = /mp4/.test(m.mime || '') ? 'mp4' : 'webm';
      L.saveFile(`Клип ${safeName(tab.title)} ${stamp()}.${ext}`, m.data, 'clip').then((f) => {
        toast(`Клип ${m.secs ? m.secs + ' с ' : ''}сохранён — Видео/Liquid`, false, { label: 'Показать', run: () => L.dl.showPath(f) });
      }).catch((e) => toast('Клип не сохранился: ' + e.message, true));
      return;
    }
    if (m.type === 'clipState') { toast(m.on ? 'Буфер клипа включён: «Сохранить клип» сохранит последние 30–60 секунд' : 'Буфер клипа выключен'); return; }
    // вкладка комнаты загрузила нужное видео — применяем то, что пришло, пока она грузилась
    if (m.type === 'page' && tab === W.tab && m.video) {
      try { tab.wv.send('liquid', { type: 'wt', on: true }); } catch {}
      if (W.pending) { const s = W.pending; W.pending = null; setTimeout(() => { try { tab.wv.send('liquid', { type: 'wtApply', state: s }); } catch {} }, 600); }
    }
    prevPage && prevPage(tab, m);
  };

  // чужие сообщения
  L.watch.onMsg((m) => {
    if (!W.code) return;
    const who = m.name || 'Гость';
    if (m.from) W.people.set(m.from, { name: who, seen: Date.now() });
    if (m.type === 'hello') {
      chatLine('', `${who} зашёл в комнату`);
      send({ type: 'here' }); // отвечаем, чтобы новичок увидел нас в списке
      if (W.tab?.wv) try { W.tab.wv.send('liquid', { type: 'wtPoll' }); } catch {} // и сразу — где у нас видео
    } else if (m.type === 'bye') { W.people.delete(m.from); chatLine('', `${who} вышел`); }
    else if (m.type === 'chat') chatLine(who, String(m.text || '').slice(0, 500));
    else if (m.type === 'state' && W.tab) {
      if (m.url && !sameVideo(m.url, tabUrl(W.tab))) {
        // у собеседника другое видео — открываем его в вкладке комнаты, состояние применим после загрузки
        W.pending = m;
        if (/^https?:/.test(m.url)) { if (W.tab !== active) activate(W.tab); navigate(m.url); }
        if (m.reason !== 'beat') toast(`${who} открыл: ${hostOf(m.url)}`);
      } else {
        try { W.tab.wv.send('liquid', { type: 'wtApply', state: m }); } catch {}
        if (m.reason === 'play' || m.reason === 'pause') toast(`${who}: ${m.reason === 'pause' ? 'пауза' : 'играть'}`);
      }
    }
    render();
  });
  L.watch.onStatus((s) => { W.state = s.state; if (s.broker) W.broker = s.broker; render(); if (s.state === 'online' && W.code) send({ type: 'hello' }); });

  function chatLine(name, text) {
    W.chat.push({ name, text, at: Date.now() });
    if (W.chat.length > 200) W.chat.shift();
    if (!$('#watchPop').classList.contains('open') && name) { W.unread++; toast(`${name}: ${text}`); }
    render();
  }
  function render() {
    const inRoom = !!W.code;
    $('#wtJoin').hidden = inRoom; $('#wtRoom').hidden = !inRoom;
    $('#wtName').value = myName;
    if (inRoom) {
      $('#wtCode').textContent = W.code;
      $('#wtStatus').textContent = W.state === 'online' ? `на связи${W.broker ? ' · ' + W.broker : ''}` : W.state === 'connecting' ? 'подключаюсь…' : 'нет связи, пробую снова';
      $('#wtStatus').className = 'wt-status ' + W.state;
      const ppl = [...W.people.values()].map((p) => p.name);
      $('#wtPeople').textContent = ppl.length ? 'В комнате: вы, ' + ppl.join(', ') : 'Пока только вы — отправьте код другу';
      $('#wtTab').textContent = W.tab ? `Вкладка: ${W.tab.title || hostOf(tabUrl(W.tab))}` : '';
      const box = $('#wtChat');
      box.innerHTML = W.chat.map((c) => (c.name ? `<div class="wt-msg"><b>${esc(c.name)}</b> ${esc(c.text)}</div>` : `<div class="wt-sys">${esc(c.text)}</div>`)).join('');
      box.scrollTop = box.scrollHeight;
    }
    document.body.classList.toggle('watching', inRoom);
  }
  window.openWatch = (tab = active) => {
    if (!W.code) W.tab = tab;
    W.unread = 0;
    openPop('#watchPop');
    render();
    setTimeout(() => (W.code ? $('#wtInput') : myName ? $('#wtCodeIn') : $('#wtName')).focus(), 80);
  };
  $('#wtCreate').onclick = () => join('');
  $('#wtGo').onclick = () => { const c = $('#wtCodeIn').value.trim(); if (c) join(c); else $('#wtErr').textContent = 'Введи код комнаты от друга'; };
  $('#wtCodeIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#wtGo').click(); });
  $('#wtName').addEventListener('change', () => { myName = $('#wtName').value.trim().slice(0, 24); lsSet('liquid.watchName', myName); });
  $('#wtLeave').onclick = leave;
  $('#wtCopy').onclick = () => { L.copy(W.code); toast('Код комнаты скопирован — отправь его другу'); };
  $('#wtSend').onclick = () => {
    const t = $('#wtInput').value.trim(); if (!t) return;
    send({ type: 'chat', text: t.slice(0, 500) });
    W.chat.push({ name: myName || 'Вы', text: t, at: Date.now() });
    $('#wtInput').value = ''; render();
  };
  $('#wtInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#wtSend').click(); });
  // вкладку комнаты закрыли — выходим из комнаты
  setInterval(() => { if (W.code && W.tab && !tabs.includes(W.tab)) { leave(); toast('Вкладка «Смотреть вместе» закрыта — вышел из комнаты'); } }, 2000);
  window.watchState = () => ({ code: W.code, state: W.state, people: W.people.size, tab: W.tab && W.tab.id });

  // ================= Ctrl+K и меню =================
  window.paletteExtra = () => [
    ['Окно поверх игры', 'видео', () => window.openMini()],
    ['Сохранить клип (последние 30 с)', 'видео', () => window.saveClip()],
    ['Буфер клипа: включить / выключить', 'видео', () => window.toggleClipBuffer()],
    [W.code ? `Смотреть вместе — комната ${W.code}` : 'Смотреть вместе', 'видео', () => window.openWatch()],
  ];
  $('#menuPop').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]'); if (!b) return;
    const fn = { watch: () => window.openWatch(), mini: () => window.openMini() }[b.dataset.m];
    if (fn) { closePops(); setTimeout(fn, 60); }
  });
  L.onShortcut(({ key }) => { if (key === 'mini') window.openMini(); else if (key === 'clip') window.saveClip(); });
})();
