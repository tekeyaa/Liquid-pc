/* Liquid 1.9 — вкладки: пространства, группы с цветами, командная строка Ctrl+K, превью при наведении */
(() => {
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const uid = () => Math.random().toString(36).slice(2, 9);
  const COLORS = ['#d97757', '#6366f1', '#22c55e', '#0ea5e9', '#f59e0b', '#ec4899', '#a855f7', '#14b8a6', '#ef4444'];
  const tabUrl = (t) => (t.wv ? (() => { try { return t.wv.getURL() || t.url; } catch { return t.url; } })() : t.url);

  // ================= Пространства и группы =================
  // Пространство — свой набор вкладок («Игры», «Учёба»): переключил — и полоса вкладок целиком другая.
  // Группа — несколько вкладок внутри пространства под цветной меткой; метку можно свернуть.
  const PRIV = !!L.incognito;
  let spaces = PRIV ? null : lsGet('liquid.spaces', null);
  if (!Array.isArray(spaces) || !spaces.length) spaces = [{ id: 'main', name: 'Основное', color: COLORS[0] }];
  let cur = PRIV ? spaces[0].id : lsGet('liquid.space', spaces[0].id);
  if (!spaces.some((s) => s.id === cur)) cur = spaces[0].id;
  let groups = PRIV ? [] : lsGet('liquid.groups', []);
  if (!Array.isArray(groups)) groups = [];
  const lastActive = {}; // пространство -> последняя открытая в нём вкладка
  const save = () => { if (PRIV) return; lsSet('liquid.spaces', spaces); lsSet('liquid.space', cur); lsSet('liquid.groups', groups); };
  const spaceOf = (t) => t.space || spaces[0].id;
  const space = (id) => spaces.find((s) => s.id === id);
  const group = (id) => groups.find((g) => g.id === id);

  window.visibleTabs = () => tabs.filter((t) => spaceOf(t) === cur);
  window.tabsChromeWidth = () => ($('#spaceBtn')?.offsetWidth || 0) + [...document.querySelectorAll('#tabs .tgroup')].reduce((n, c) => n + c.offsetWidth + 6, 0);

  // кнопка пространства — слева от вкладок
  const spaceBtn = document.createElement('button');
  spaceBtn.id = 'spaceBtn';
  spaceBtn.className = 'glass';
  spaceBtn.title = 'Пространства: свои наборы вкладок (правый клик — переименовать)';
  $('#tabs').before(spaceBtn);

  function render() {
    // группы без вкладок больше не нужны
    groups = groups.filter((g) => tabs.some((t) => t.group === g.id));
    for (const t of tabs) {
      const g = t.group && group(t.group);
      t.el.classList.toggle('off-space', spaceOf(t) !== cur);
      t.el.classList.toggle('grouped', !!g);
      t.el.classList.toggle('g-collapsed', !!g && g.collapsed && t !== active);
      if (g) t.el.style.setProperty('--g', g.color); else t.el.style.removeProperty('--g');
    }
    // метки групп — перед первой вкладкой каждой группы
    document.querySelectorAll('#tabs .tgroup').forEach((c) => c.remove());
    for (const g of groups) {
      const members = tabs.filter((t) => t.group === g.id && spaceOf(t) === cur);
      if (!members.length) continue;
      const chip = document.createElement('button');
      chip.className = 'tgroup' + (g.collapsed ? ' collapsed' : '');
      chip.dataset.g = g.id;
      chip.style.setProperty('--g', g.color);
      chip.title = g.collapsed ? 'Развернуть группу' : 'Свернуть группу (правый клик — настройки)';
      chip.innerHTML = `<span>${esc(g.name)}</span>${g.collapsed ? `<b>${members.length}</b>` : ''}`;
      members[0].el.before(chip);
    }
    const s = space(cur);
    spaceBtn.style.setProperty('--s', s.color);
    spaceBtn.innerHTML = `<i></i><span>${esc(s.name)}</span>`;
    save();
    fitTabs();
  }
  window.renderSpaces = render;

  function setSpace(id, { focus = true } = {}) {
    if (!space(id) || id === cur) return;
    if (active) lastActive[cur] = active;
    cur = id;
    render();
    if (!focus) return;
    const want = lastActive[id];
    const t = want && tabs.includes(want) && spaceOf(want) === id ? want : window.visibleTabs().slice(-1)[0];
    if (t) activate(t); else createTab();
    toast(`Пространство «${space(id).name}»`);
  }
  window.setSpace = setSpace;

  // переносим вкладку в DOM и в списке сразу за другой (чтобы вкладки группы шли подряд)
  function moveAfter(tab, ref) {
    if (!ref || ref === tab) return;
    tabs.splice(tabs.indexOf(tab), 1);
    tabs.splice(tabs.indexOf(ref) + 1, 0, tab);
    ref.el.after(tab.el);
  }
  function addToGroup(tab, gid) {
    const members = tabs.filter((t) => t.group === gid && t !== tab);
    tab.group = gid;
    if (members.length) moveAfter(tab, members[members.length - 1]);
    render(); saveSession();
  }
  async function newGroup(tab) {
    const name = await askName('Новая группа', hostOf(tabUrl(tab)).split('.')[0] || 'Группа');
    if (!name) return;
    const used = new Set(groups.map((g) => g.color));
    const g = { id: uid(), name: name.slice(0, 24), color: COLORS.slice(1).find((c) => !used.has(c)) || COLORS[1 + (groups.length % (COLORS.length - 1))], collapsed: false }; // первый цвет — у акцента браузера
    groups.push(g);
    addToGroup(tab, g.id);
  }
  function ungroup(tab) { tab.group = null; render(); saveSession(); }
  function moveToSpace(tab, sid) {
    const was = tab === active;
    tab.group = null; tab.space = sid;
    if (was) { const next = window.visibleTabs().filter((t) => t !== tab).slice(-1)[0]; active = null; tab.el.classList.remove('active'); next ? activate(next) : createTab(); }
    render(); saveSession();
    toast(`Вкладка перенесена в «${space(sid).name}»`);
  }

  // хуки из app.js
  window.onTabCreated = (tab, { after }) => {
    tab.space = cur;
    if (after && after.group && spaceOf(after) === cur) tab.group = after.group; // открыли из вкладки группы — туда же
    hookPreview(tab);
    render();
  };
  window.onTabRestored = (tab, d) => {
    if (d.space && space(d.space)) tab.space = d.space;
    if (d.group && group(d.group)) tab.group = d.group;
    render();
  };
  window.nextTabAfterClose = (i, closed) => {
    const same = tabs.filter((t) => spaceOf(t) === spaceOf(closed));
    if (!same.length) return null;
    return same.find((t) => tabs.indexOf(t) >= i) || same[same.length - 1];
  };
  const prevActivated = window.onTabActivated;
  window.onTabActivated = (tab) => {
    prevActivated && prevActivated(tab);
    if (spaceOf(tab) !== cur) { if (active) lastActive[cur] = active; cur = spaceOf(tab); }
    lastActive[cur] = tab;
    const g = tab.group && group(tab.group);
    if (g && g.collapsed) g.collapsed = false;
    render();
  };
  window.tabMenuExtra = (tab) => {
    const items = [null];
    for (const g of groups.filter((x) => x.id !== tab.group && tabs.some((t) => t.group === x.id && spaceOf(t) === cur)).slice(0, 6)) items.push([`В группу «${g.name}»`, () => addToGroup(tab, g.id)]);
    items.push(['Новая группа…', () => newGroup(tab)]);
    if (tab.group) items.push(['Убрать из группы', () => ungroup(tab)]);
    const others = spaces.filter((s) => s.id !== spaceOf(tab));
    if (others.length) { items.push(null); for (const s of others.slice(0, 6)) items.push([`В пространство «${s.name}»`, () => moveToSpace(tab, s.id)]); }
    return items;
  };

  // меню того же вида, что у вкладок
  function ctxMenu(items, x, y) {
    const m = $('#tabMenu');
    m.innerHTML = items.map((it, i) => (it ? `<button data-i="${i}">${esc(it[0])}</button>` : '<hr>')).join('');
    m.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; hideTabMenu(); items[+b.dataset.i][1](); };
    m.style.left = Math.min(x, innerWidth - 240) + 'px';
    m.style.top = Math.max(8, Math.min(y + 6, innerHeight - m.offsetHeight - 8)) + 'px';
    m.classList.add('open');
    setTimeout(() => document.addEventListener('mousedown', hideTabMenu, { once: true }), 0);
  }
  function spaceMenu(x, y) {
    const count = (id) => tabs.filter((t) => spaceOf(t) === id).length;
    const items = spaces.map((s) => [`${s.id === cur ? '✓ ' : '    '}${s.name} · ${count(s.id)}`, () => setSpace(s.id)]);
    items.push(null, ['Новое пространство…', newSpace], [`Переименовать «${space(cur).name}»…`, renameSpace]);
    if (spaces.length > 1) items.push([`Удалить «${space(cur).name}» (вкладки — в соседнее)`, deleteSpace]);
    ctxMenu(items, x, y);
  }
  async function newSpace() {
    const name = await askName('Новое пространство', ['Игры', 'Учёба', 'Работа', 'Смотреть'][spaces.length - 1] || 'Пространство');
    if (!name) return;
    const s = { id: uid(), name: name.slice(0, 20), color: COLORS[spaces.length % COLORS.length] };
    spaces.push(s);
    setSpace(s.id);
  }
  async function renameSpace() {
    const s = space(cur); const name = await askName('Название пространства', s.name);
    if (name) { s.name = name.slice(0, 20); render(); }
  }
  function deleteSpace() {
    if (spaces.length < 2) return;
    const gone = cur, to = spaces.find((s) => s.id !== gone).id;
    for (const t of tabs) if (spaceOf(t) === gone) { t.space = to; t.group = null; }
    spaces = spaces.filter((s) => s.id !== gone);
    cur = to; render(); saveSession();
    const t = window.visibleTabs().slice(-1)[0]; if (t) activate(t);
  }
  spaceBtn.addEventListener('click', (e) => { const r = spaceBtn.getBoundingClientRect(); spaceMenu(r.left, r.bottom); e.stopPropagation(); });
  spaceBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); renameSpace(); });
  $('#tabs').addEventListener('click', (e) => {
    const c = e.target.closest('.tgroup'); if (!c) return;
    const g = group(c.dataset.g); if (!g) return;
    g.collapsed = !g.collapsed; render();
  });
  $('#tabs').addEventListener('contextmenu', (e) => {
    const c = e.target.closest('.tgroup'); if (!c) return;
    e.preventDefault(); e.stopPropagation();
    const g = group(c.dataset.g); if (!g) return;
    const members = () => tabs.filter((t) => t.group === g.id);
    ctxMenu([
      ['Переименовать…', async () => { const n = await askName('Название группы', g.name); if (n) { g.name = n.slice(0, 24); render(); } }],
      ['Другой цвет', () => { g.color = COLORS[(COLORS.indexOf(g.color) + 1) % COLORS.length]; render(); }],
      [g.collapsed ? 'Развернуть' : 'Свернуть', () => { g.collapsed = !g.collapsed; render(); }],
      null,
      ['Разгруппировать', () => { members().forEach((t) => { t.group = null; }); render(); saveSession(); }],
      [`Закрыть группу (${members().length})`, () => members().forEach(closeTab)],
    ], e.clientX, e.clientY);
  });

  // ввод названия — своё окошко (prompt() в браузере на Electron не работает)
  function askName(title, def = '') {
    return new Promise((done) => {
      $('#askTitle').textContent = title;
      const inp = $('#askInput'); inp.value = def;
      openPop('#askPop');
      setTimeout(() => { inp.focus(); inp.select(); }, 60);
      const finish = (v) => { cleanup(); closePops(); done(v ? v.trim() : null); };
      const onKey = (e) => { if (e.key === 'Enter') finish(inp.value); else if (e.key === 'Escape') finish(null); };
      const onOk = () => finish(inp.value);
      const onScrim = () => { cleanup(); done(null); };
      const cleanup = () => { inp.removeEventListener('keydown', onKey); $('#askOk').removeEventListener('click', onOk); $('#scrim').removeEventListener('click', onScrim); };
      inp.addEventListener('keydown', onKey); $('#askOk').addEventListener('click', onOk); $('#scrim').addEventListener('click', onScrim);
    });
  }
  window.askName = askName;

  // ================= Командная строка (Ctrl+K) =================
  const ACTIONS = () => [
    ['Новая вкладка', 'Ctrl+T', () => createTab()],
    ['Окно инкогнито', 'Ctrl+Shift+N', () => L.newIncognito()],
    ['Вернуть закрытую вкладку', 'Ctrl+Shift+T', () => reopenClosed()],
    ...(settings.hasVpnKey ? [[settings._vpnOn ? 'Выключить VPN' : 'Включить VPN', 'VPN', () => (settings._vpnOn ? L.vpn.disconnect() : L.vpn.connect()).then((r) => { if (r && r.state) renderVpn(r.state); else if (r && r.error) toast('VPN: ' + r.error, true); })]] : []),
    ['Панель Claude', 'Ctrl+J', () => toggleSide()],
    ['Почему не открылось?', 'проверка сайта', () => window.openNetDiag()],
    ['Добавить в закладки', 'Ctrl+D', () => window.toggleBookmark()],
    ['Закладки', 'Ctrl+Shift+B', () => window.openLibrary('bookmarks')],
    ['История', 'Ctrl+H', () => window.openLibrary('history')],
    ['Загрузки', '', () => window.openLibrary('downloads')],
    ['Расширения', '', () => window.openExtensions()],
    ['Скриншот', 'Ctrl+Shift+S', () => window.openShot()],
    ['Режим чтения', 'F9', () => window.toggleReader()],
    ['Перевести страницу', '', () => window.translatePage()],
    ['Картинка в картинке', 'Alt+P', () => window.togglePip()],
    ['Два сайта рядом', 'Ctrl+\\', () => (split ? endSplit(true) : startSplit())],
    ['Заметки', '', () => window.openNotes()],
    ['Игровой режим', '', () => window.toggleGame()],
    ['Настройки', '', () => window.openSettings()],
    ['Новое пространство…', 'пространство', () => newSpace()],
    ...spaces.filter((s) => s.id !== cur).map((s) => [`Пространство «${s.name}»`, 'перейти', () => setSpace(s.id)]),
    ...(active ? [['Новая группа из этой вкладки…', 'группа', () => newGroup(active)]] : []),
    ...(window.paletteExtra ? window.paletteExtra() : []), // видео и игры (features5.js)
  ];
  const pal = { items: [], sel: 0 };
  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
  const score = (text, q) => { const t = norm(text); if (!q) return 1; if (t.startsWith(q)) return 3; if (t.split(/[\s«».\-/]+/).some((w) => w.startsWith(q))) return 2; return t.includes(q) ? 1 : 0; };
  function palItems(raw) {
    const q = norm(raw.trim());
    const out = [];
    // «закрой ютуб», «закрыть все youtube» — закрыть все вкладки, где это есть
    const m = /^закр\S*\s+(?:все\s+)?(.+)$/.exec(q);
    if (m) {
      const w = m[1].trim(), hit = tabs.filter((t) => norm(t.title).includes(w) || norm(hostOf(tabUrl(t))).includes(w));
      if (hit.length) out.push({ kind: 'Закрыть', title: `Закрыть вкладки «${m[1].trim()}» — ${hit.length}`, run: () => hit.forEach(closeTab), s: 9 });
    }
    for (const t of tabs) {
      const sc = Math.max(score(t.title, q), score(hostOf(tabUrl(t)), q));
      if (sc) out.push({ kind: spaceOf(t) === cur ? 'Вкладка' : `Вкладка · ${space(spaceOf(t))?.name || ''}`, title: t.title || hostOf(tabUrl(t)), sub: hostOf(tabUrl(t)), fav: t.favicon, run: () => activate(t), s: sc + (t === active ? -0.5 : 0.5) + (q ? 0 : spaceOf(t) === cur ? 0 : -3) });
    }
    for (const [title, hint, run] of ACTIONS()) { const sc = score(title, q) || score(hint, q); if (sc && (q || out.length < 30)) out.push({ kind: 'Действие', title, sub: hint, run, s: sc + (q ? 0.25 : -1) }); }
    if (q.length >= 2) for (const r of window.libSearch ? window.libSearch(q, 6) : []) out.push({ kind: r.kind === 'bookmark' ? 'Закладка' : 'История', title: r.title, sub: hostOf(r.url), run: () => navigate(r.url), s: 0.6 + (r.kind === 'bookmark' ? 0.2 : 0) });
    if (raw.trim()) out.push({ kind: 'Открыть', title: /\s/.test(raw.trim()) || !/\./.test(raw) ? `Искать «${raw.trim()}»` : `Открыть ${raw.trim()}`, run: () => navigate(raw.trim()), s: 0.5 });
    return out.sort((a, b) => b.s - a.s).slice(0, 12);
  }
  function palRender() {
    pal.items = palItems($('#palInput').value);
    pal.sel = Math.min(pal.sel, Math.max(0, pal.items.length - 1));
    $('#palList').innerHTML = pal.items.map((it, i) => `<div class="pal-row${i === pal.sel ? ' sel' : ''}" data-i="${i}">
      ${it.fav ? `<img src="${esc(it.fav)}" alt="">` : '<span class="pal-ic"></span>'}
      <span class="pal-t">${esc(it.title)}</span><span class="pal-s">${esc(it.sub || '')}</span><span class="pal-k">${esc(it.kind)}</span></div>`).join('')
      || '<div class="pal-empty">Ничего не нашлось</div>';
    $('#palList .sel')?.scrollIntoView({ block: 'nearest' });
  }
  function palRun(i) { const it = pal.items[i]; if (!it) return; closePops(); setTimeout(() => it.run(), 30); }
  window.openPalette = () => {
    openPop('#palette');
    $('#palInput').value = ''; pal.sel = 0; palRender();
    setTimeout(() => $('#palInput').focus(), 30);
  };
  $('#palInput').addEventListener('input', () => { pal.sel = 0; palRender(); });
  $('#palInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { pal.sel = (pal.sel + 1) % Math.max(1, pal.items.length); palRender(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { pal.sel = (pal.sel - 1 + pal.items.length) % Math.max(1, pal.items.length); palRender(); e.preventDefault(); }
    else if (e.key === 'Enter') { palRun(pal.sel); e.preventDefault(); }
    else if (e.key === 'Escape') closePops();
  });
  $('#palList').addEventListener('mousedown', (e) => { const r = e.target.closest('.pal-row'); if (r) { e.preventDefault(); palRun(+r.dataset.i); } });
  $('#palList').addEventListener('mousemove', (e) => { const r = e.target.closest('.pal-row'); if (r && +r.dataset.i !== pal.sel) { pal.sel = +r.dataset.i; document.querySelectorAll('#palList .pal-row').forEach((x, i) => x.classList.toggle('sel', i === pal.sel)); } });
  document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG' && e.target.closest('#palList,#tabPreview')) e.target.style.visibility = 'hidden'; }, true);

  // ================= Превью вкладки при наведении =================
  // Снимок страницы делается, пока вкладка открыта (после загрузки и раз в 30 секунд), — так он есть и у фоновых вкладок
  const prev = $('#tabPreview');
  let prevT = 0, prevTab = null;
  function showPreview(tab) {
    prevTab = tab;
    const u = tabUrl(tab);
    prev.innerHTML = `${tab.thumb ? `<img src="${tab.thumb}" alt="">` : ''}<div class="tp-t">${esc(tab.title || hostOf(u) || 'Новая вкладка')}</div>
      <div class="tp-s">${esc(hostOf(u) || '')}${tab.sleeping ? ' · спит' : ''}${tab.playing ? ' · играет звук' : ''}${tab.group && group(tab.group) ? ' · ' + esc(group(tab.group).name) : ''}</div>`;
    const r = tab.el.getBoundingClientRect();
    prev.style.left = Math.max(8, Math.min(r.left, innerWidth - 308)) + 'px';
    prev.style.top = r.bottom + 8 + 'px';
    prev.classList.add('on');
  }
  function hidePreview() { clearTimeout(prevT); prevT = 0; prevTab = null; prev.classList.remove('on'); }
  function hookPreview(tab) {
    tab.el.addEventListener('mouseenter', () => {
      clearTimeout(prevT);
      if (document.body.classList.contains('popped')) return;
      // уже показываем превью другой вкладки — переключаемся сразу, иначе ждём, чтобы не мелькало
      prevT = setTimeout(() => showPreview(tab), prev.classList.contains('on') ? 0 : 550);
    });
    tab.el.addEventListener('mouseleave', () => { clearTimeout(prevT); prevT = setTimeout(hidePreview, 120); });
    tab.el.addEventListener('mousedown', hidePreview);
  }
  async function snap(tab) {
    if (tab && Date.now() - (tab.thumbAt || 0) < 60e3) return;
    if (!tab || tab !== active || !tab.wv || !tab.wcId || document.hidden || document.body.classList.contains('game') || !/^https?:/.test(tab.url)) return;
    tab.thumbAt = Date.now();
    try { const d = await L.tabs.thumb(tab.wcId); if (d) tab.thumb = d; } catch {}
  }
  const prevCreated = window.onWebviewCreated;
  window.onWebviewCreated = (tab, wv) => {
    prevCreated && prevCreated(tab, wv);
    wv.addEventListener('did-stop-loading', () => setTimeout(() => snap(tab), 1200));
  };
  // снимок — после загрузки страницы и не чаще раза в минуту на вкладку (это копия кадра с видеокарты и сжатие)
  // вкладки, созданные до этого файла (не должно быть, но на всякий случай)
  for (const t of tabs) { if (!t.space) t.space = cur; hookPreview(t); }
  render();
})();
