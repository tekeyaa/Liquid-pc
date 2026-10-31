/* Liquid — история, закладки, подсказки, загрузки, расширения, перевод, PiP, реклама, темы, меню, обновления, разрешения */
(function () {
  const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  // значок берём у самого сайта, а не через Google — чтобы никто посторонний не видел историю и закладки
  const favUrl = (u) => { const h = hostOf(u); const t = tabs.find((x) => x.favicon && hostOf(x.url) === h); return t ? t.favicon : (h ? `https://${h}/favicon.ico` : ''); };
  const isWeb = (u) => /^https?:/.test(u || '');
  const X_ICON = '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>';
  const SEARCH_IC = '<svg class="sg-ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>';

  // ================= История и закладки =================
  // история: { url: {t: заголовок, v: визиты, at: последний визит} }, максимум 4000 адресов
  let history = L.incognito ? {} : lsGet('liquid.history', {});
  let bookmarks = lsGet('liquid.bookmarks', []);
  let histT = 0;
  // окон может быть несколько, история у них общая: перед записью добавляем то, что записали другие окна
  const mergeHistory = () => { const other = lsGet('liquid.history', {}); for (const k in other) if (!history[k] || other[k].at > history[k].at) history[k] = other[k]; };
  const saveHistory = () => { if (L.incognito) return; clearTimeout(histT); histT = setTimeout(() => {
    mergeHistory();
    const keys = Object.keys(history);
    if (keys.length > 4000) keys.sort((a, b) => history[a].at - history[b].at).slice(0, keys.length - 4000).forEach((k) => delete history[k]);
    lsSet('liquid.history', history);
  }, 800); };
  const saveBookmarks = () => lsSet('liquid.bookmarks', bookmarks);
  window.addEventListener('storage', (e) => {
    if (e.key === 'liquid.history' && !L.incognito) mergeHistory();
    if (e.key === 'liquid.bookmarks') { bookmarks = lsGet('liquid.bookmarks', []); try { syncOmniExtras(active); } catch {} }
  });

  window.historyAdd = (tab, url) => {
    if (L.incognito || !isWeb(url)) return;
    const e = history[url] || { t: '', v: 0, at: 0 };
    e.v++; e.at = Date.now();
    history[url] = e;
    saveHistory();
  };
  window.historyTitle = (tab) => {
    if (L.incognito || !tab.wv) return;
    let u = ''; try { u = tab.wv.getURL(); } catch {}
    if (history[u] && tab.title) { history[u].t = tab.title; saveHistory(); }
  };

  // поиск по закладкам и истории — для командной строки Ctrl+K (features4.js)
  window.libSearch = (q, n = 8) => {
    q = q.trim().toLowerCase(); if (!q) return [];
    const hit = (u, t) => u.toLowerCase().includes(q) || (t || '').toLowerCase().includes(q);
    const bm = bookmarks.filter((b) => hit(b.url, b.title)).slice(0, n).map((b) => ({ kind: 'bookmark', url: b.url, title: b.title || b.url }));
    const seen = new Set(bm.map((b) => b.url));
    const hs = Object.entries(history).filter(([u, e]) => !seen.has(u) && hit(u, e.t))
      .sort((a, b) => (b[1].v * 3 + b[1].at / 864e5) - (a[1].v * 3 + a[1].at / 864e5)).slice(0, n)
      .map(([u, e]) => ({ kind: 'history', url: u, title: e.t || u }));
    return [...bm, ...hs].slice(0, n);
  };
  const isBookmarked = (u) => bookmarks.some((b) => b.url === u);
  window.toggleBookmark = () => {
    if (!active || !isWeb(active.url)) return;
    const u = active.url;
    if (isBookmarked(u)) { bookmarks = bookmarks.filter((b) => b.url !== u); toast('Закладка удалена'); }
    else { bookmarks.unshift({ url: u, title: active.title || hostOf(u), at: Date.now() }); toast('Добавлено в закладки ★'); }
    saveBookmarks();
    syncOmniExtras(active);
  };

  // иконки сайтов, которые не загрузились, просто прячем (инлайн-обработчики запрещены CSP)
  document.addEventListener('error', (e) => { const t = e.target; if (t && t.tagName === 'IMG' && t.closest('#suggest,#libList,#extList')) t.style.visibility = 'hidden'; }, true);

  // ================= Подсказки в адресной строке =================
  const sug = { items: [], sel: -1 };
  function suggestions(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const out = [];
    const score = (url, title, bonus) => {
      const u = url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '');
      const t = (title || '').toLowerCase();
      let s = 0;
      if (u.startsWith(q)) s += 100; else if (u.includes(q)) s += 40;
      if (t.includes(q)) s += 30;
      return s ? s + bonus : 0;
    };
    for (const b of bookmarks) { const s = score(b.url, b.title, 50); if (s) out.push({ url: b.url, title: b.title, s, kind: 'закладка' }); }
    for (const [url, e] of Object.entries(history)) {
      if (out.some((o) => o.url === url)) continue;
      const s = score(url, e.t, Math.min(40, e.v * 4) + (Date.now() - e.at < 864e5 * 3 ? 10 : 0));
      if (s) out.push({ url, title: e.t, s, kind: '' });
    }
    out.sort((a, b) => b.s - a.s);
    const list = out.slice(0, 4);
    list.push({ search: q, title: q, main: true });
    return list;
  }
  // подсказки поисковика приходят чуть позже — добавляем их под сайты из истории
  let sugT = 0, sugSeq = 0;
  function fetchSuggest(raw) {
    clearTimeout(sugT);
    const q = raw.trim();
    if (!q || L.incognito || q.length > 120) return;
    const seq = ++sugSeq;
    sugT = setTimeout(async () => {
      let list = []; try { list = await L.claude.suggest(q); } catch {}
      if (seq !== sugSeq || $('#url').value.trim() !== q || document.activeElement !== $('#url')) return;
      const have = new Set(sug.items.filter((it) => it.search).map((it) => it.search.toLowerCase()));
      const add = list.filter((s2) => !have.has(s2.toLowerCase())).slice(0, 6).map((s2) => ({ search: s2, title: s2 }));
      if (!add.length) return;
      const selItem = sug.items[sug.sel];
      sug.items = [...sug.items, ...add];
      sug.sel = selItem ? sug.items.indexOf(selItem) : -1;
      renderSuggest();
    }, 90);
  }
  function renderSuggest() {
    const box = $('#suggest');
    if (!sug.items.length) { box.classList.remove('open'); return; }
    // первая подсказка-сайт — заранее открываем с ним соединение, как Chrome
    const site = sug.items.find((it) => !it.search && /^https?:/.test(it.url || ''));
    if (site) L.preconnect(site.url);
    box.innerHTML = sug.items.map((it, i) => it.search
      ? `<div class="sg ${i === sug.sel ? 'sel' : ''}" data-i="${i}">${SEARCH_IC}<span class="sg-t">${hl(it.title, $('#url').value)}</span>${it.main ? '<span class="sg-u">— поиск</span>' : ''}</div>`
      : `<div class="sg ${i === sug.sel ? 'sel' : ''}" data-i="${i}"><img src="${esc(favUrl(it.url))}"><span class="sg-t">${esc(it.title || hostOf(it.url))}</span><span class="sg-u">${esc(it.url.replace(/^https?:\/\//, ''))}</span>${it.kind ? `<span class="sg-k">${it.kind}</span>` : ''}</div>`).join('');
    box.classList.add('open');
  }
  // как в Chrome: введённое — обычным, дописанное поисковиком — жирным
  function hl(text, typed) {
    const t = typed.trim().toLowerCase();
    return t && text.toLowerCase().startsWith(t) ? esc(text.slice(0, t.length)) + '<b>' + esc(text.slice(t.length)) + '</b>' : esc(text);
  }
  window.hideSuggest = () => { sug.items = []; sug.sel = -1; sugSeq++; $('#suggest').classList.remove('open'); };
  function pickSuggest(i) {
    const it = sug.items[i];
    hideSuggest();
    if (!it) return;
    if (it.search) navigate(it.search); else navigate(it.url);
    $('#url').blur();
  }
  $('#url').addEventListener('input', () => { sug.items = suggestions($('#url').value); sug.sel = -1; renderSuggest(); fetchSuggest($('#url').value); });
  $('#url').addEventListener('keydown', (e) => {
    if (!sug.items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sug.sel = (sug.sel + (e.key === 'ArrowDown' ? 1 : -1) + sug.items.length) % sug.items.length;
      const it = sug.items[sug.sel];
      $('#url').value = it.search || it.url;
      renderSuggest();
    } else if (e.key === 'Enter' && sug.sel >= 0) { e.preventDefault(); pickSuggest(sug.sel); }
  });
  $('#url').addEventListener('blur', () => setTimeout(hideSuggest, 150));
  $('#suggest').addEventListener('mousedown', (e) => { const r = e.target.closest('.sg'); if (r) { e.preventDefault(); pickSuggest(+r.dataset.i); } });
  $('#omni').addEventListener('submit', () => hideSuggest(), true);

  // ================= Кнопки в адресной строке =================
  function syncOmniExtras(tab) {
    if (!tab || tab !== active) return;
    const web = isWeb(tab.url);
    $('#starBtn').classList.toggle('show', web && !L.incognito);
    $('#starBtn').classList.toggle('on', web && isBookmarked(tab.url));
    $('#starBtn').title = isBookmarked(tab.url) ? 'Убрать из закладок (Ctrl+D)' : 'Добавить в закладки (Ctrl+D)';
    $('#trBtn').classList.toggle('show', web && !!(tab.page?.foreign || tab.translated));
    $('#trBtn').classList.toggle('on', !!tab.translated);
    const host = hostOf(tab.url);
    const allowed = (settings.adAllow || []).includes(host);
    const adOn = settings.adblock !== false && web && !allowed;
    $('#adBtn').classList.toggle('off', !adOn);
    $('#adBtn').title = !web ? 'Блокировщик рекламы' : allowed ? `Реклама на ${host} не блокируется` : `Заблокировано: ${tab.ads || 0}`;
    $('#adCount').textContent = adOn && tab.ads ? (tab.ads > 99 ? '99+' : tab.ads) : '';
  }
  window.syncOmniExtras = syncOmniExtras;
  window.onTabActivated = syncOmniExtras;

  $('#starBtn').onclick = () => window.toggleBookmark();

  // сообщения от страниц (preload сайтов)
  const alwaysTr = new Set(lsGet('liquid.alwaysTranslate', []));
  window.onPageMsg = (tab, m) => {
    if (m.type === 'page') {
      tab.page = { ...tab.page, ...m };
      if (m.foreign && !tab.translated && !tab.trAuto && alwaysTr.has(hostOf(tab.url))) { tab.trAuto = true; tab.wv?.send('liquid', { type: 'translate', on: true }); }
    } else if (m.type === 'translate') {
      tab.translated = m.state === 'on' || m.state === 'working';
      if (tab === active) $('#trBtn').classList.toggle('working', m.state === 'working');
      if (m.state === 'off') tab.trAuto = false;
      if (m.state === 'error') { tab.trAuto = false; if (tab === active) toast('Перевод не удался: сервисы перевода не ответили. Попробуй с VPN «Весь трафик». Подробности — в «Настройки → Отладка».', true); }
    }
    syncOmniExtras(tab);
    if (tab === active && $('#trPop').classList.contains('open')) renderTrPop();
  };

  // ================= Перевод =================
  function renderTrPop() {
    const host = hostOf(active?.url);
    $('#trToggle').textContent = active?.translated ? 'Показать оригинал' : 'Перевести на русский';
    $('#trAlwaysLbl').textContent = `Всегда переводить ${host || 'этот сайт'}`;
    $('#trAlways').checked = alwaysTr.has(host);
  }
  window.translatePage = () => {
    if (!active?.wv || !isWeb(active.url)) { toast('Открой сайт, который нужно перевести'); return; }
    active.wv.send('liquid', { type: 'translate', on: !active.translated });
  };
  $('#trBtn').onclick = () => { openPop('#trPop'); renderTrPop(); };
  $('#trToggle').onclick = () => { window.translatePage(); closePops(); };
  $('#trAlways').onchange = (e) => {
    const h = hostOf(active?.url);
    if (!h) return;
    e.target.checked ? alwaysTr.add(h) : alwaysTr.delete(h);
    lsSet('liquid.alwaysTranslate', [...alwaysTr]);
    if (e.target.checked && !active.translated) window.translatePage();
  };

  // ================= Картинка в картинке =================
  window.togglePip = async () => {
    if (!active?.wv) return;
    try {
      const r = await active.wv.executeJavaScript(`(async () => {
        if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return 'off'; }
        const vs = [...document.querySelectorAll('video')].filter(v => v.readyState > 0 || v.src || v.currentSrc);
        vs.sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight));
        const v = vs.find(v => !v.paused) || vs[0];
        if (!v) return 'none';
        v.disablePictureInPicture = false; v.removeAttribute('disablepictureinpicture');
        await v.requestPictureInPicture();
        return 'on';
      })()`, true);
      if (r === 'none') toast('На странице нет видео');
      else if (r === 'on') toast('Видео поверх всех окон — закрыть можно крестиком в мини-окне');
    } catch (e) { toast('Этот сайт не разрешает картинку в картинке', true); }
  };

  // ================= Блокировщик рекламы =================
  L.adblock.onCount(({ wcId, n }) => {
    const t = tabs.find((x) => x.wcId === wcId);
    if (!t) return;
    t.ads = n;
    if (t === active) { syncOmniExtras(t); if ($('#adPop').classList.contains('open')) $('#adBig').textContent = n; }
  });
  $('#adBtn').onclick = () => {
    if (!isWeb(active?.url)) { toast('Блокировщик включится на сайтах'); return; }
    const host = hostOf(active?.url);
    $('#adBig').textContent = active?.ads || 0;
    $('#adSiteLbl').textContent = `Блокировать на ${host}`;
    $('#adSite').checked = !(settings.adAllow || []).includes(host);
    openPop('#adPop');
  };
  $('#adSite').onchange = async () => {
    const host = hostOf(active?.url);
    settings = await L.settings.set({ adAllowToggle: host });
    toast(settings.adAllow.includes(host) ? `Реклама на ${host} не блокируется` : `Реклама на ${host} снова блокируется`);
    active?.wv?.reload();
    syncOmniExtras(active);
  };

  // ================= Загрузки =================
  const dls = new Map(); // id -> данные
  let dlHist = L.incognito ? [] : lsGet('liquid.downloads', []); // завершённые прошлые
  const saveDl = () => { if (!L.incognito) lsSet('liquid.downloads', dlHist.slice(0, 60)); };
  const fmtSize = (b) => b >= 1e9 ? (b / 1e9).toFixed(2) + ' ГБ' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' МБ' : b >= 1e3 ? Math.round(b / 1e3) + ' КБ' : (b || 0) + ' Б';
  L.dl.onUpdate((d) => {
    dls.set(d.id, d);
    if (d.started) { $('#dlBtn').classList.add('show'); toast(`Загрузка: ${d.name}`); }
    if (d.state === 'completed' || d.state === 'cancelled' || d.state === 'interrupted') {
      if (!dlHist.some((x) => x.id === d.id && x.path === d.path)) { dlHist.unshift({ ...d, at: Date.now() }); saveDl(); }
      if (d.state === 'completed') { $('#dlBtn').classList.add('done'); setTimeout(() => $('#dlBtn').classList.remove('done'), 3000); }
    }
    syncDlBtn();
    if ($('#libPop').classList.contains('open') && lib.tab === 'downloads') renderLib();
  });
  function syncDlBtn() {
    const act = [...dls.values()].filter((d) => d.state === 'progressing');
    const btn = $('#dlBtn');
    btn.classList.toggle('active', act.length > 0);
    const tot = act.reduce((a, d) => a + (d.total || 0), 0);
    const got = act.reduce((a, d) => a + (d.received || 0), 0);
    const p = tot ? got / tot : 0.15;
    btn.querySelector('.ring').style.strokeDashoffset = String(100.5 * (1 - p));
    btn.title = act.length ? `Загрузки: ${act.length} · ${Math.round(p * 100)}%` : 'Загрузки';
  }
  $('#dlBtn').onclick = () => window.openLibrary('downloads');
  if (dlHist.length) $('#dlBtn').classList.add('show');

  // ================= Библиотека: закладки / история / загрузки =================
  const lib = { tab: 'bookmarks' };
  window.openLibrary = (tab) => {
    lib.tab = tab || lib.tab;
    $('#libSearch').value = '';
    openPop('#libPop');
    renderLib();
    setTimeout(() => $('#libSearch').focus(), 60);
  };
  $('#libTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { lib.tab = b.dataset.t; renderLib(); } });
  $('#libSearch').addEventListener('input', renderLib);
  function dayLabel(t) {
    const d = new Date(t), now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 864e5);
    return diff === 0 ? 'Сегодня' : diff === 1 ? 'Вчера' : d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function renderLib() {
    $('#libTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === lib.tab));
    const q = $('#libSearch').value.trim().toLowerCase();
    const match = (url, title) => !q || url.toLowerCase().includes(q) || (title || '').toLowerCase().includes(q);
    const box = $('#libList');
    $('#libClear').style.display = lib.tab === 'history' && !L.incognito ? '' : 'none';
    $('#libFolder').style.display = lib.tab === 'downloads' ? '' : 'none';
    $('#libSearch').style.display = lib.tab === 'downloads' ? 'none' : '';
    let html = '';
    if (lib.tab === 'bookmarks') {
      const list = bookmarks.filter((b) => match(b.url, b.title));
      html = list.map((b) => `<div class="li" data-url="${esc(b.url)}"><img src="${esc(favUrl(b.url))}"><div class="li-b"><div class="li-t">${esc(b.title || hostOf(b.url))}</div><div class="li-u">${esc(b.url)}</div></div><button class="li-x" data-del-bm="${esc(b.url)}" title="Удалить">${X_ICON}</button></div>`).join('')
        || `<div class="lib-empty">${q ? 'Ничего не нашлось' : 'Закладок пока нет.<br>Нажми ★ в адресной строке или Ctrl+D'}</div>`;
    } else if (lib.tab === 'history') {
      if (L.incognito) html = '<div class="lib-empty">В инкогнито история не сохраняется</div>';
      else {
        const list = Object.entries(history).filter(([u, e]) => match(u, e.t)).sort((a, b) => b[1].at - a[1].at).slice(0, 300);
        let last = '';
        for (const [u, e] of list) {
          const d = dayLabel(e.at);
          if (d !== last) { html += `<div class="lib-day">${d}</div>`; last = d; }
          html += `<div class="li" data-url="${esc(u)}"><img src="${esc(favUrl(u))}"><div class="li-b"><div class="li-t">${esc(e.t || hostOf(u))}</div><div class="li-u">${esc(u)}</div></div><span class="li-time">${new Date(e.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span><button class="li-x" data-del-h="${esc(u)}" title="Удалить">${X_ICON}</button></div>`;
        }
        if (!html) html = `<div class="lib-empty">${q ? 'Ничего не нашлось' : 'История пуста'}</div>`;
      }
    } else {
      const live = [...dls.values()].sort((a, b) => b.id - a.id);
      const ids = new Set(live.map((d) => d.path));
      const all = [...live, ...dlHist.filter((d) => !ids.has(d.path))];
      html = all.map((d) => {
        const p = d.total ? Math.round(d.received / d.total * 100) : 0;
        const prog = d.state === 'progressing';
        let meta = '';
        if (prog) meta = `${fmtSize(d.received)}${d.total ? ' из ' + fmtSize(d.total) : ''}${d.paused ? ' · на паузе' : d.speed ? ' · ' + fmtSize(d.speed) + '/с' : ''}`;
        else if (d.state === 'completed') meta = fmtSize(d.total || d.received) + ' · ' + hostOf(d.url);
        else meta = d.state === 'cancelled' ? 'Отменено' : 'Ошибка загрузки';
        const live1 = dls.has(d.id) && dls.get(d.id).path === d.path;
        const acts = prog
          ? `<button data-dl="${d.id}" data-a="${d.paused ? 'resume' : 'pause'}">${d.paused ? 'Продолжить' : 'Пауза'}</button><button data-dl="${d.id}" data-a="cancel">Отмена</button>`
          : d.state === 'completed' ? `<button data-open="${esc(d.path)}">Открыть</button><button data-show="${esc(d.path)}">Показать в папке</button>` : '';
        return `<div class="li dl"><div class="dl-top"><img src="${esc(favUrl(d.url))}"><div class="dl-name" title="${esc(d.path)}">${esc(d.name)}</div></div>
          <div class="dl-meta ${d.danger && d.state === 'completed' ? 'warn' : ''}">${d.danger && d.state === 'completed' ? '⚠ Программа — запускай, только если доверяешь сайту · ' : ''}${meta}</div>
          ${prog ? `<div class="dl-bar"><i style="width:${d.total ? p : 30}%"></i></div>` : ''}
          ${acts && (live1 || !prog) ? `<div class="dl-act">${acts}</div>` : ''}</div>`;
      }).join('') || '<div class="lib-empty">Загрузок пока нет</div>';
    }
    box.innerHTML = html;
  }
  $('#libList').addEventListener('click', (e) => {
    const t = e.target.closest('[data-del-bm],[data-del-h],[data-dl],[data-open],[data-show]');
    if (t) {
      e.stopPropagation();
      if (t.dataset.delBm) { bookmarks = bookmarks.filter((b) => b.url !== t.dataset.delBm); saveBookmarks(); syncOmniExtras(active); }
      else if (t.dataset.delH) { delete history[t.dataset.delH]; saveHistory(); }
      else if (t.dataset.dl) L.dl.act(+t.dataset.dl, t.dataset.a);
      else if (t.dataset.open) L.dl.openPath(t.dataset.open);
      else if (t.dataset.show) L.dl.showPath(t.dataset.show);
      renderLib();
      return;
    }
    const row = e.target.closest('.li[data-url]');
    if (row) { closePops(); createTab(row.dataset.url, { after: active }); }
  });
  $('#libClear').onclick = () => { history = {}; lsSet('liquid.history', {}); renderLib(); toast('История очищена'); };
  $('#libFolder').onclick = () => L.dl.folder();

  // ================= Расширения =================
  async function renderExt() {
    const { installed, popular } = await L.ext.list();
    const ids = new Set(installed.map((e) => e.id));
    const row = (e) => `<div class="ext">
        ${e.iconData ? `<img src="${e.iconData}">` : '<span class="ext-ph"></span>'}
        <div class="ext-b"><div class="ext-n">${esc(e.name)}</div><div class="ext-d ${e.error ? 'err' : ''}">${esc(e.error ? 'Не загрузилось: ' + e.error : 'Версия ' + (e.version || '?'))}</div></div>
        ${e.popup && e.enabled !== false ? `<button class="btn ghost sm" data-eo="${e.id}" data-page="${esc(e.popup)}">Открыть</button>` : ''}
        ${e.options && e.enabled !== false ? `<button class="btn ghost sm" data-eo="${e.id}" data-page="${esc(e.options)}">Настройки</button>` : ''}
        <input type="checkbox" class="switch" data-et="${e.id}" ${e.enabled !== false ? 'checked' : ''} title="Вкл/выкл">
        <button class="li-x" style="opacity:1" data-er="${e.id}" title="Удалить">${X_ICON}</button>
      </div>`;
    let html = installed.length ? '<div class="lib-day" style="margin-top:0">Установлены</div>' + installed.map(row).join('') : '';
    const pop = popular.filter((p) => !ids.has(p.id));
    if (pop.length) html += '<div class="lib-day">Популярные</div>' + pop.map((p) => `<div class="ext"><span class="ext-ph"></span><div class="ext-b"><div class="ext-n">${esc(p.name)}</div><div class="ext-d">${esc(p.desc)}</div></div><button class="btn primary sm" data-ei="${p.id}">Установить</button></div>`).join('');
    $('#extList').innerHTML = html;
  }
  async function installExt(input, btn) {
    $('#extErr').classList.remove('show');
    if (btn) { btn.disabled = true; btn.textContent = 'Ставлю…'; }
    const r = await L.ext.install(input);
    if (btn) { btn.disabled = false; btn.textContent = 'Установить'; }
    if (!r.ok) { $('#extErr').textContent = r.error; $('#extErr').classList.add('show'); return; }
    toast(`Расширение «${r.ext.name}» установлено — обнови страницу, где оно нужно`);
    $('#extInput').value = '';
    renderExt();
  }
  window.openExtensions = () => { if (L.incognito) { toast('В инкогнито расширения выключены'); return; } openPop('#extPop'); renderExt(); };
  $('#extInstall').onclick = () => installExt($('#extInput').value, $('#extInstall'));
  $('#extInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') installExt($('#extInput').value, $('#extInstall')); });
  $('#extList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ei],[data-er],[data-eo]');
    if (!b) return;
    if (b.dataset.ei) installExt(b.dataset.ei, b);
    else if (b.dataset.er) { await L.ext.remove(b.dataset.er); renderExt(); toast('Расширение удалено'); }
    else if (b.dataset.eo) L.ext.open(b.dataset.eo, b.dataset.page);
  });
  $('#extList').addEventListener('change', async (e) => {
    const c = e.target.closest('[data-et]');
    if (c) { await L.ext.toggle(c.dataset.et, c.checked); renderExt(); }
  });

  // ================= Меню =================
  $('#menuBtn').onclick = () => openPop('#menuPop');
  $('#menuPop').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]');
    if (!b) return;
    closePops();
    const m = b.dataset.m;
    ({
      newtab: () => createTab(),
      newwin: () => L.win.open(''),
      incognito: () => L.newIncognito(),
      reopen: () => reopenClosed(),
      bookmarks: () => window.openLibrary('bookmarks'),
      history: () => window.openLibrary('history'),
      downloads: () => window.openLibrary('downloads'),
      extensions: () => window.openExtensions(),
      split: () => (split ? endSplit(true) : startSplit()),
      translate: () => window.translatePage(),
      pip: () => window.togglePip(),
      settings: () => window.openSettings(),
    })[m]?.();
  });

  // ================= Темы оформления =================
  const ACCENTS = ['#d97757', '#f43f5e', '#f59e0b', '#22c55e', '#14b8a6', '#0ea5e9', '#6366f1', '#a855f7', '#ec4899'];
  const WALLS = {
    aurora: { name: 'Аврора', css: (a) => `radial-gradient(60vw 60vw at 8% -10%, rgba(91,61,245,.55), transparent 60%), radial-gradient(45vw 45vw at 100% 5%, ${a}80, transparent 60%), radial-gradient(55vw 50vw at 45% 120%, rgba(14,165,233,.32), transparent 60%), radial-gradient(30vw 30vw at 80% 105%, rgba(236,72,153,.28), transparent 60%), #07070d` },
    sunset: { name: 'Закат', css: () => 'radial-gradient(70vw 60vw at 10% 0%, rgba(244,63,94,.5), transparent 60%), radial-gradient(60vw 60vw at 100% 30%, rgba(245,158,11,.45), transparent 60%), radial-gradient(60vw 50vw at 40% 120%, rgba(168,85,247,.35), transparent 60%), #0d0709' },
    ocean: { name: 'Океан', css: () => 'radial-gradient(70vw 60vw at 0% 0%, rgba(14,165,233,.5), transparent 60%), radial-gradient(60vw 60vw at 100% 20%, rgba(20,184,166,.4), transparent 60%), radial-gradient(60vw 50vw at 50% 120%, rgba(99,102,241,.4), transparent 60%), #050a10' },
    forest: { name: 'Лес', css: () => 'radial-gradient(70vw 60vw at 5% 0%, rgba(34,197,94,.38), transparent 60%), radial-gradient(60vw 60vw at 100% 25%, rgba(132,204,22,.25), transparent 60%), radial-gradient(60vw 50vw at 40% 120%, rgba(20,184,166,.3), transparent 60%), #060b08' },
    graphite: { name: 'Графит', css: () => 'radial-gradient(70vw 60vw at 20% -10%, rgba(255,255,255,.09), transparent 60%), radial-gradient(60vw 60vw at 100% 100%, rgba(255,255,255,.05), transparent 60%), #0b0b0e' },
    custom: { name: 'Своя картинка', css: () => '' },
  };
  let theme = Object.assign({ accent: '#d97757', wall: 'aurora', glass: 0.11, img: '' }, lsGet('liquid.theme', {}));
  function hexToHsl(hex) {
    let r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0; const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    return [h, s * 100, l * 100];
  }
  const hsl = (h, s, l) => `hsl(${h.toFixed(0)} ${Math.min(100, s).toFixed(0)}% ${Math.max(0, Math.min(100, l)).toFixed(0)}%)`;
  function themeVars() {
    const [h, s, l] = hexToHsl(theme.accent);
    return { accent: theme.accent, accent2: hsl(h, s, l + 14), accentHi: hsl(h, s, l + 6), accentLo: hsl(h, s, l - 10) };
  }
  function wallCss() {
    if (theme.wall === 'custom' && theme.img) return `linear-gradient(rgba(5,5,10,.45), rgba(5,5,10,.55)), url("${theme.img}") center / cover no-repeat, #07070d`;
    return (WALLS[theme.wall] || WALLS.aurora).css(theme.accent);
  }
  function applyTheme() {
    if (L.incognito) return; // в инкогнито — свой фиолетовый стиль
    const v = themeVars();
    const r = document.documentElement.style;
    r.setProperty('--accent', v.accent); r.setProperty('--accent-2', v.accent2);
    r.setProperty('--accent-hi', v.accentHi); r.setProperty('--accent-lo', v.accentLo);
    r.setProperty('--glass-a', String(theme.glass)); r.setProperty('--glass-b', String(Math.max(0.01, theme.glass * 0.4)));
    $('#bg').style.background = wallCss();
    for (const t of tabs) if (t.wv && isInternal(t.url)) sendTheme(t.wv);
  }
  function sendTheme(wv) {
    if (L.incognito) return;
    const v = themeVars();
    try { wv.send('liquid', { type: 'theme', theme: { accent: v.accent, accentHi: v.accentHi, accentLo: v.accentLo, glass: theme.glass, wall: wallCss() } }); } catch {}
  }
  window.sendTheme = sendTheme;
  function renderThemeUi() {
    $('#accents').innerHTML = ACCENTS.map((c) => `<button class="sw ${c === theme.accent ? 'on' : ''}" data-c="${c}" style="background:${c}"></button>`).join('') +
      `<label class="sw custom ${ACCENTS.includes(theme.accent) ? '' : 'on'}" title="Свой цвет"><input type="color" id="accentPick" value="${theme.accent}"></label>`;
    $('#walls').innerHTML = Object.entries(WALLS).map(([k, w]) => {
      const bg = k === 'custom' ? (theme.img ? `url("${theme.img}") center/cover` : 'rgba(255,255,255,.06)') : w.css(theme.accent);
      return `<button class="wall ${theme.wall === k ? 'on' : ''}" data-w="${k}" style="background:${bg}">${w.name}</button>`;
    }).join('');
    $('#glass').value = theme.glass;
    $('#glassVal').textContent = Math.round(theme.glass * 100) + '%';
  }
  const saveTheme = () => { lsSet('liquid.theme', theme); applyTheme(); renderThemeUi(); };
  $('#accents').addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (b) { theme.accent = b.dataset.c; saveTheme(); } });
  $('#accents').addEventListener('input', (e) => { if (e.target.id === 'accentPick') { theme.accent = e.target.value; lsSet('liquid.theme', theme); applyTheme(); } });
  $('#accents').addEventListener('change', (e) => { if (e.target.id === 'accentPick') renderThemeUi(); });
  $('#walls').addEventListener('click', (e) => {
    const b = e.target.closest('[data-w]');
    if (!b) return;
    if (b.dataset.w === 'custom' && (!theme.img || theme.wall === 'custom')) { $('#wallFile').click(); return; }
    theme.wall = b.dataset.w; saveTheme();
  });
  $('#wallFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      // ужимаем до 2560px, чтобы не раздувать память
      const k = Math.min(1, 2560 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      theme.img = c.toDataURL('image/jpeg', 0.86);
      theme.wall = 'custom';
      URL.revokeObjectURL(img.src);
      saveTheme();
    };
    img.src = URL.createObjectURL(f);
    e.target.value = '';
  });
  $('#glass').addEventListener('input', (e) => { theme.glass = +e.target.value; $('#glassVal').textContent = Math.round(theme.glass * 100) + '%'; lsSet('liquid.theme', theme); applyTheme(); });

  // ================= Настройки: VPN, производительность, вкладки =================
  const MODE_HINT = {
    smart: 'Через VPN идут только заблокированные и замедленные сайты. Банки, Госуслуги и российские сервисы — напрямую и быстро.',
    all: 'Весь трафик браузера идёт через VPN.',
  };
  function renderVpnExtras() {
    const m = settings.vpnMode || 'smart';
    $('#vpnMode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === m));
    $('#vpnModeHint').textContent = MODE_HINT[m];
    $('#autoVpn').checked = settings.autoVpn !== false;
    $('#antiDpi').checked = settings.antiDpi !== false;
    $('#antiDpiState').textContent = settings.antiDpi === false ? 'Выключен' : settings.antiDpiOn ? 'Работает: Twitch, YouTube, Discord — напрямую, без сервера' : 'Не запустился — подробности в «Настройки → Отладка»';
    if (document.activeElement !== $('#vpnSites')) $('#vpnSites').value = settings.vpnSites || '';
    const ls = (settings.learned || []).slice().sort();
    const box = $('#learnedInfo');
    box.replaceChildren();
    if (!ls.length) box.textContent = 'Выученных сайтов пока нет. Сайт попадёт сюда, только если не открывается напрямую, а остальной интернет работает.';
    else {
      box.append(document.createTextNode('Выучено само: '));
      ls.forEach((d) => {
        const chip = document.createElement('span'); chip.className = 'chip-x'; chip.textContent = d + ' ';
        const x = document.createElement('button'); x.textContent = '×'; x.title = 'Убрать — снова напрямую';
        x.onclick = async () => { settings = await L.settings.set({ learnedRemove: d }); renderVpnExtras(); };
        chip.appendChild(x); box.appendChild(chip);
      });
    }
  }
  $('#vpnMode').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    settings = await L.settings.set({ vpnMode: b.dataset.v });
    renderVpnExtras();
    toast(b.dataset.v === 'smart' ? 'Умный VPN: только заблокированные сайты' : 'VPN для всего трафика');
  });
  $('#autoVpn').onchange = async (e) => { settings = await L.settings.set({ autoVpn: e.target.checked }); };
  $('#antiDpi').onchange = async (e) => {
    settings = await L.settings.set({ antiDpi: e.target.checked });
    renderVpnExtras();
    toast(e.target.checked ? (settings.antiDpiOn ? 'Обход замедления включён — обнови страницу Twitch или YouTube' : 'Обход не запустился — подробности в «Настройки → Отладка»') : 'Обход замедления выключен', e.target.checked && !settings.antiDpiOn);
    if (active && /twitch|youtube|discord/.test(active.url)) active.wv?.reload();
  };
  let sitesT = 0;
  $('#vpnSites').addEventListener('input', () => { clearTimeout(sitesT); sitesT = setTimeout(async () => { settings = await L.settings.set({ vpnSites: $('#vpnSites').value }); renderVpnExtras(); }, 700); });
  $('#forgetLearned').onclick = async () => { settings = await L.settings.set({ forgetLearned: true }); renderVpnExtras(); toast('Выученные сайты сброшены'); };
  $('#vpnBtn').addEventListener('click', () => renderVpnExtras());

  // ================= Обновления =================
  const UPD_TEXT = (u) => ({
    idle: `Liquid ${u.current}. Обновления проверяются раз в 3 часа.`,
    latest: `У тебя последняя версия — ${u.current}.`,
    download: `Скачиваю Liquid ${u.version}${u.progress ? ` — ${u.progress} %` : '…'}`,
    building: u.engine ? `Обновляю движок до Electron ${u.engine} в фоне — браузером можно пользоваться.` : `Ставлю Liquid ${u.version} в фоне — браузером можно пользоваться.`,
    ready: u.engine ? `Новый движок Electron ${u.engine} готов. Применится, когда закроешь браузер.` : `Liquid ${u.version} готов. Применится, когда закроешь браузер.`,
    done: u.engine ? `Движок обновлён до Electron ${u.engine}.` : `Liquid обновился до ${u.version}.`,
    error: `Обновление не удалось: ${u.error}`,
  }[u.state] || '');
  // карточка в углу: «вышла новая версия, скачивается в фоне, заработает после перезапуска»
  const card = $('#updCard');
  let hidden = '', doneT = 0;          // какую стадию пользователь закрыл крестиком
  function renderCard(u) {
    const st = u.state, eng = !!u.engine;
    const show = ['download', 'building', 'ready', 'done'].includes(st) || (st === 'error' && card.classList.contains('show'));
    const key = (st === 'building' ? 'download' : st) + ':' + (u.version || '') + ':' + (u.engine || ''); // скачивание и установка — одна стадия
    if (!show || hidden === key) { card.classList.remove('show'); return; }
    const T = {
      download: [`Вышла Liquid ${u.version}`, `Скачивается в фоне${u.progress ? ` — ${u.progress} %` : '…'}. Браузером можно пользоваться, новая версия заработает после перезапуска.`],
      building: eng ? ['Обновляю движок браузера', `Electron ${u.engine} с исправлениями безопасности ставится в фоне. Заработает после перезапуска браузера.`]
                    : [`Устанавливаю Liquid ${u.version}`, 'Ставится в фоне — браузером можно пользоваться. Новая версия заработает после перезапуска браузера.'],
      ready: eng ? ['Новый движок готов', 'Заработает после перезапуска браузера. Можно сейчас — вкладки откроются заново.']
                 : [`Liquid ${u.version} готов`, 'Новая версия заработает после перезапуска браузера. Можно сейчас — вкладки откроются заново, или просто закрой браузер, когда удобно.'],
      done: eng ? ['Движок браузера обновлён', `Теперь Electron ${u.engine} — с последними исправлениями безопасности.`]
                : [`Liquid обновился до ${u.version}`, u.notes?.length ? 'Что нового:' : 'Обновление установлено.'],
      error: ['Обновление не удалось', `${u.error}. Попробую позже, подробности — в «Настройки → Отладка».`],
    }[st];
    card.className = 'glass show ' + st;
    $('#ucTitle').textContent = T[0]; $('#ucSub').textContent = T[1];
    card.querySelector('.uc-ico').textContent = st === 'ready' || st === 'done' ? '✓' : st === 'error' ? '!' : '⬇';
    $('#ucBar').style.width = (st === 'download' ? (u.progress || 3) : 0) + '%';
    const ul = $('#ucNotes'); ul.textContent = '';
    if (!eng && ['download', 'ready', 'done'].includes(st)) for (const n of (u.notes || [])) { const li = document.createElement('li'); li.textContent = n; ul.appendChild(li); }
    clearTimeout(doneT);
    if (st === 'done' || st === 'error') doneT = setTimeout(() => { hidden = key; card.classList.remove('show'); }, st === 'done' ? 14000 : 9000);
    card.dataset.key = key;
  }
  $('#ucClose').onclick = $('#ucLater').onclick = () => { hidden = card.dataset.key; card.classList.remove('show');
    if (card.classList.contains('ready')) toast('Новая версия включится, когда закроешь браузер'); };
  $('#ucRestart').onclick = () => L.update.restart();
  function renderUpd(u) {
    if (!u) return;
    $('#updState').textContent = UPD_TEXT(u);
    $('#autoUpdate').checked = u.auto;
    renderCard(u);
  }
  L.update.onState(renderUpd);
  L.update.state().then(renderUpd);
  $('#autoUpdate').onchange = async (e) => { settings = await L.settings.set({ autoUpdate: e.target.checked }); L.update.state().then(renderUpd); };
  $('#updCheck').onclick = async () => { $('#updState').textContent = 'Проверяю…'; renderUpd(await L.update.check()); };

  // ================= Разрешения сайтов =================
  const PERM_NAMES = { media: 'Камера и микрофон', geolocation: 'Местоположение', notifications: 'Уведомления', 'clipboard-read': 'Чтение буфера обмена', popup: 'Всплывающие окна' };
  async function renderPerms() {
    const box = $('#permList'); if (!box) return;
    const list = await L.perms.list();
    box.replaceChildren();
    if (!list.length) { const d = document.createElement('div'); d.className = 'muted sm'; d.textContent = 'Пока ни одному сайту ничего не разрешено и не запрещено.'; box.appendChild(d); return; }
    for (const p of list) {
      const row = document.createElement('div'); row.className = 'perm-row';
      const b = document.createElement('b'); b.textContent = p.site;
      const m = document.createElement('span'); m.className = 'muted sm'; m.textContent = `${PERM_NAMES[p.what] || p.what} · ${p.allow ? 'разрешено' : 'запрещено'}`;
      const x = document.createElement('button'); x.textContent = '×'; x.title = 'Забыть — сайт спросит снова';
      x.onclick = async () => { await L.perms.remove(p.key); renderPerms(); };
      row.append(b, m, x); box.appendChild(row);
    }
  }
  $('#permReset').onclick = async () => { await L.perms.remove('*'); renderPerms(); toast('Сайты снова спросят разрешения'); };
  document.querySelector('[data-t="privacy"]')?.addEventListener('click', renderPerms);
  renderPerms();

  $('#sleepAfter').onchange = async (e) => { settings = await L.settings.set({ sleepAfter: +e.target.value }); };
  $('#memSaver').onchange = async (e) => { settings = await L.settings.set({ memSaver: e.target.checked }); toast('Применится после перезапуска браузера'); };
  $('#restore').onchange = async (e) => { settings = await L.settings.set({ restore: e.target.checked }); };
  $('#adblockOn').onchange = async (e) => { settings = await L.settings.set({ adblock: e.target.checked }); active?.wv?.reload(); syncOmniExtras(active); };
  $('#dlAsk').onchange = async (e) => { settings = await L.settings.set({ dlAsk: e.target.checked }); };
  $('#sleepAll').onclick = async () => {
    let n = 0;
    for (const t of tabs) if (sleepTab(t)) n++;
    await L.trimCache().catch(() => {});
    toast(n ? `Усыплено вкладок: ${n}` : 'Нечего усыплять — фоновых вкладок нет');
    setTimeout(refreshMem, 800);
  };
  async function refreshMem() {
    try {
      const m = await L.mem();
      $('#memTotal').textContent = m.totalMb >= 1024 ? (m.totalMb / 1024).toFixed(1) + ' ГБ' : m.totalMb + ' МБ';
      const asleep = tabs.filter((t) => t.sleeping).length;
      $('#memSleep').textContent = `${asleep} из ${tabs.length}`;
      // память вкладок — в подсказке при наведении
      for (const t of tabs) {
        const x = m.tabs.find((v) => v.wcId === t.wcId);
        if (x) t.el.title = `${t.title}\n${x.mb} МБ памяти`;
      }
    } catch {}
  }
  window.refreshMem = refreshMem;
  window.onSettingsOpen = () => { renderThemeUi(); setTimeout(refreshMem, 300); };

  // ================= Старт =================
  window.featuresInit = () => {
    $('#sleepAfter').value = String(settings.sleepAfter ?? 20);
    $('#memSaver').checked = settings.memSaver !== false;
    $('#restore').checked = settings.restore !== false;
    $('#adblockOn').checked = settings.adblock !== false;
    $('#dlAsk').checked = !!settings.dlAsk;
    renderVpnExtras();
    renderThemeUi();
    applyTheme();
    if (L.incognito) { document.title = 'Liquid — инкогнито'; }
  };
})();
