/* Агент идей: смотрит, как ты пользуешься браузером, и предлагает, что в нём улучшить.
   Всё считается локально. Claude подключается только по кнопке «Придумать ещё». */
(function () {
  const SKEY = 'liquid.ideas.stats';
  const IKEY = 'liquid.ideas.state';
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  const stats = Object.assign({
    since: Date.now(), visits: 0, hosts: {}, foreign: 0, video: 0, failed: 0, blockedLike: 0,
    maxTabs: 0, vpnOn: 0, claudeAsks: 0, guardWarn: 0, downloads: 0, nightUse: 0, sessions: 0,
  }, load(SKEY, {}));
  // state: { ideas: { id: { status, seen, custom? } }, lastOpen }
  const state = Object.assign({ ideas: {}, lastOpen: 0, custom: [] }, load(IKEY, {}));
  const saveStats = () => store(SKEY, stats);
  const saveState = () => store(IKEY, state);
  stats.sessions++;
  saveStats();

  // ---------- сбор сигналов (вызывается из app.js) ----------
  window.ideasTrack = function (ev, data) {
    switch (ev) {
      case 'visit': {
        stats.visits++;
        if (data?.host) stats.hosts[data.host] = (stats.hosts[data.host] || 0) + 1;
        const h = new Date().getHours();
        if (h >= 23 || h < 6) stats.nightUse++;
        break;
      }
      case 'page':
        if (data?.lang && !/^ru|^uk|^be/i.test(data.lang)) stats.foreign++;
        if (data?.video) stats.video++;
        break;
      case 'fail': stats.failed++; if (data?.blocked) stats.blockedLike++; break;
      case 'tabs': stats.maxTabs = Math.max(stats.maxTabs, data || 0); break;
      case 'vpn': stats.vpnOn++; break;
      case 'claude': stats.claudeAsks++; break;
      case 'guard': stats.guardWarn++; break;
    }
    saveStats();
    scheduleThink();
  };

  const visits = (re) => Object.entries(stats.hosts).reduce((n, [h, c]) => n + (re.test(h) ? c : 0), 0);
  const topHosts = () => Object.entries(stats.hosts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([h, c]) => `${h} (${c})`);

  // ---------- банк идей: оценка = насколько идея нужна именно тебе ----------
  const BANK = [
    { id: 'translate', shipped: true, title: 'Автоперевод сайтов', desc: 'Кнопка в адресной строке, которая переводит страницу на русский, не теряя вёрстку. Можно включить «всегда переводить этот сайт».',
      score: () => 30 + stats.foreign * 12, why: () => stats.foreign ? `Ты открыл ${stats.foreign} стр. не на русском` : 'Пригодится на зарубежных сайтах' },
    { id: 'adblock', shipped: true, title: 'Блокировщик рекламы и трекеров', desc: 'Встроенная фильтрация по спискам uBlock/EasyList: меньше рекламы, быстрее загрузка, меньше слежки и вредоносных баннеров.',
      score: () => 55 + Math.min(40, stats.visits / 3), why: () => 'Реклама — частый путь заразы, и без неё сайты грузятся быстрее' },
    { id: 'extensions', shipped: true, title: 'Поддержка расширений Chrome', desc: 'Установка расширений из Chrome Web Store (.crx): менеджеры паролей, Return YouTube Dislike, 7TV для Twitch и т.д.',
      score: () => 40 + (visits(/twitch|youtube/) ? 15 : 0), why: () => visits(/twitch/) ? 'Например, 7TV и BetterTTV для Twitch' : 'Чтобы не терять привычные расширения' },
    { id: 'lock', title: 'Блокировка браузера PIN-кодом', desc: 'Экран блокировки по PIN или Windows Hello при запуске и после простоя — чтобы никто не залез в твои вкладки и аккаунты.',
      score: () => 35 + (stats.sessions > 5 ? 10 : 0), why: () => 'Защитит логины, если за комп сядет кто-то ещё' },
    { id: 'pip', shipped: true, title: 'Картинка в картинке для видео', desc: 'Кнопка, которая выносит видео или стрим в маленькое окно поверх всех программ.',
      score: () => 20 + stats.video * 8 + visits(/twitch|youtube/) * 2, why: () => stats.video ? `Ты смотрел видео на ${stats.video} стр.` : 'Удобно смотреть стрим и играть' },
    { id: 'smartvpn', shipped: true, title: 'Умный VPN: только для заблокированных сайтов', desc: 'Через VPN идут только сайты, которые не открываются напрямую, остальное — напрямую. Быстрее и не ломает российские сервисы.',
      score: () => 20 + stats.vpnOn * 10 + stats.blockedLike * 8, why: () => stats.vpnOn ? `VPN включался ${stats.vpnOn} раз` : 'Банки и Госуслуги часто не любят VPN' },
    { id: 'autovpn', shipped: true, title: 'Автовключение VPN при блокировке', desc: 'Если сайт не открылся из-за блокировки — браузер сам повторит запрос через VPN, без лишних кликов.',
      score: () => 10 + stats.blockedLike * 15, why: () => stats.blockedLike ? `${stats.blockedLike} раз сайт не открылся похоже из-за блокировки` : 'Чтобы не тыкать VPN руками' },
    { id: 'sleep', shipped: true, title: 'Сон для неактивных вкладок', desc: 'Вкладки, которые долго не открывались, выгружаются из памяти и мгновенно просыпаются при клике. Экономит ОЗУ для игр.',
      score: () => 10 + Math.max(0, stats.maxTabs - 5) * 9, why: () => `Максимум открытых вкладок: ${stats.maxTabs}` },
    { id: 'groups', title: 'Группы вкладок и вертикальные вкладки', desc: 'Цветные группы («Учёба», «Стримы») и режим вертикальной панели вкладок слева.',
      score: () => Math.max(0, stats.maxTabs - 6) * 8, why: () => `У тебя бывает до ${stats.maxTabs} вкладок` },
    { id: 'history', shipped: true, title: 'История и закладки', desc: 'Поиск по истории, закладки со звёздочкой в адресной строке, подсказки при вводе адреса.',
      score: () => 30 + Math.min(45, stats.visits / 4), why: () => `Ты открыл ${stats.visits} страниц — пора их где-то хранить` },
    { id: 'restore', shipped: true, title: 'Восстановление вкладок', desc: 'После закрытия или краша браузер открывает вкладки, которые были. Ctrl+Shift+T — вернуть закрытую вкладку.',
      score: () => 35 + Math.min(30, stats.sessions * 3), why: () => `Браузер запускался ${stats.sessions} раз` },
    { id: 'split', shipped: true, title: 'Два сайта рядом', desc: 'Разделить окно на две половины: стрим слева, чат или гайд справа.',
      score: () => 15 + (visits(/twitch|youtube/) ? 20 : 0), why: () => visits(/twitch/) ? 'Стрим + гайд в одном окне' : 'Удобно для учёбы и работы' },
    { id: 'theater', shipped: true, title: 'Режим кинотеатра для Twitch и YouTube', desc: 'Одна кнопка прячет интерфейс браузера и сайта, остаётся только видео (и чат по желанию).',
      score: () => visits(/twitch|youtube/) * 4, why: () => `Twitch/YouTube открывались ${visits(/twitch|youtube/)} раз` },
    { id: 'ytsum', title: 'Claude пересказывает видео', desc: 'На YouTube кнопка «О чём видео?» — Claude берёт субтитры и делает краткий пересказ с таймкодами.',
      score: () => visits(/youtube/) * 4 + stats.claudeAsks * 2, why: () => 'Экономит время на длинных роликах' },
    { id: 'downloads', shipped: true, title: 'Панель загрузок', desc: 'Список скачанных файлов с прогрессом, паузой и кнопкой «Показать в папке».',
      score: () => 30, why: () => 'Сейчас загрузки видно только в окне «Сохранить как»' },
    { id: 'passwords', title: 'Менеджер паролей', desc: 'Сохранение и автозаполнение паролей с шифрованием Windows, проверка на утёкшие пароли.',
      score: () => 25 + stats.guardWarn * 5, why: () => 'Сложные пароли без запоминания' },
    { id: 'incognito', shipped: true, title: 'Режим инкогнито', desc: 'Окно без истории и куки, всё стирается при закрытии.',
      score: () => 25, why: () => 'Для разовых входов с чужих аккаунтов' },
    { id: 'night', title: 'Тёмный режим для всех сайтов', desc: 'Принудительно делает светлые сайты тёмными — меньше устают глаза ночью.',
      score: () => 15 + stats.nightUse * 3, why: () => stats.nightUse ? `Ты сидел ночью ${stats.nightUse} раз` : 'Глаза скажут спасибо' },
    { id: 'theme', shipped: true, title: 'Свои цвета и обои', desc: 'Выбор акцентного цвета, обоев и прозрачности стекла в настройках.',
      score: () => 22, why: () => 'Чтобы браузер был под тебя' },
    // --- новые идеи (v1.2)
    { id: 'reader', shipped: true, title: 'Режим чтения', desc: 'Одна кнопка убирает с длинной статьи всё лишнее: остаётся текст с удобным шрифтом, тёмный фон и оценка времени чтения.',
      score: () => 25 + Math.min(30, stats.visits / 8), why: () => 'Для статей, гайдов и новостей' },
    { id: 'shot', shipped: true, title: 'Скриншот страницы целиком', desc: 'Снимок всей страницы или выделенной области в PNG — с прокруткой, без обрезки.',
      score: () => 28, why: () => 'Удобно сохранить гайд, чек или переписку' },
    { id: 'palette', title: 'Командная строка Ctrl+K', desc: 'Окно быстрого поиска по вкладкам, закладкам, истории и командам браузера — как в VS Code.',
      score: () => 15 + Math.max(0, stats.maxTabs - 4) * 5, why: () => `При ${stats.maxTabs} вкладках искать мышкой долго` },
    { id: 'speed', shipped: true, title: 'Скорость видео и громкость выше 100%', desc: 'Колёсико над видео меняет скорость 0.25–4×, а громкость можно поднять до 300% для тихих роликов.',
      score: () => stats.video * 5 + visits(/youtube|twitch/) * 2, why: () => stats.video ? `Ты смотрел видео на ${stats.video} стр.` : 'Для тихих стримов и длинных лекций' },
    { id: 'profiles', title: 'Профили: Учёба / Игры / Работа', desc: 'Отдельные наборы вкладок, логинов и закладок — переключение в один клик.',
      score: () => 18 + (stats.sessions > 10 ? 12 : 0), why: () => 'Чтобы разделять аккаунты и задачи' },
    { id: 'sidebar', title: 'Мессенджеры сбоку', desc: 'Telegram Web, Discord или VK в узкой боковой панели — общаться, не переключая вкладки.',
      score: () => 22 + visits(/discord|telegram|vk\.com/) * 4, why: () => visits(/discord|telegram/) ? 'Ты часто заходишь в мессенджеры' : 'Чат всегда под рукой' },
    { id: 'focus', title: 'Режим фокуса', desc: 'Таймер на 25/50 минут, на время которого браузер не пускает на выбранные отвлекающие сайты.',
      score: () => 12 + stats.nightUse * 2 + Math.min(20, visits(/youtube|twitch|tiktok|reddit/)), why: () => 'Помогает доделать дело и не залипнуть' },
    { id: 'phone', title: 'Отправить ссылку на телефон', desc: 'QR-код текущей страницы — навёл камеру телефона и открыл там же.',
      score: () => 16, why: () => 'Быстро перекинуть ссылку без мессенджеров' },
    { id: 'streamer', title: 'Режим стримера', desc: 'Прячет адресную строку, закладки, уведомления и личные данные, пока ты стримишь экран.',
      score: () => visits(/twitch|kick\.com/) * 3, why: () => visits(/twitch/) ? 'Если ведёшь свои стримы' : 'Для показа экрана другим' },
    { id: 'gestures', title: 'Жесты мышью', desc: 'Зажал правую кнопку и провёл: влево — назад, вправо — вперёд, вниз — закрыть вкладку.',
      score: () => 14 + Math.min(16, stats.visits / 20), why: () => 'Быстрее, чем тянуться к кнопкам' },
    { id: 'notes', shipped: true, title: 'Заметки на сайтах', desc: 'Выдели текст → «Сохранить в заметки». Все цитаты со ссылками на источник — в одной панели, можно отдать Claude.',
      score: () => 15 + stats.claudeAsks * 3, why: () => 'Собирать материал для учёбы и проектов' },
    { id: 'voice', title: 'Голосовой ввод для Claude', desc: 'Кнопка микрофона в панели Claude: говоришь — текст появляется сам.',
      score: () => 12 + stats.claudeAsks * 4, why: () => stats.claudeAsks ? `Ты спрашивал Claude ${stats.claudeAsks} раз` : 'Когда лень печатать' },
    { id: 'rtx', shipped: true, title: 'Супер-чёткость видео', desc: '', score: () => 0, why: () => '' },
    { id: 'gamebar', shipped: true, title: 'Игровой режим', desc: 'Пока запущена игра, браузер сам усыпляет все вкладки и снижает приоритет, отдавая ОЗУ и процессор игре.',
      score: () => 20 + Math.max(0, stats.maxTabs - 5) * 4, why: () => 'Больше FPS в играх с открытым браузером' },
  ];

  const SHIPPED = BANK.filter((b) => b.shipped).map((b) => b.title);
  function ideaList() {
    const list = BANK.filter((b) => !b.shipped).map((b) => ({ ...b, s: b.score(), reason: b.why(), st: state.ideas[b.id]?.status || 'new' }));
    for (const c of state.custom) list.push({ id: c.id, title: c.title, desc: c.desc, s: 50, reason: c.why || 'Идея от Claude', st: state.ideas[c.id]?.status || 'new', custom: true });
    const order = { want: 0, new: 1, done: 2, skip: 3 };
    return list.sort((a, b) => order[a.st] - order[b.st] || b.s - a.s);
  }

  // ---------- агент «думает» в фоне и подсвечивает лампочку, когда есть что предложить ----------
  let thinkT = 0;
  function scheduleThink() { clearTimeout(thinkT); thinkT = setTimeout(think, 4000); }
  function think() {
    const fresh = ideaList().filter((i) => i.st === 'new' && i.s >= 45 && !state.ideas[i.id]?.seen);
    $('#ideasBtn').classList.toggle('has-new', fresh.length > 0);
    $('#ideasBtn').title = fresh.length ? `Агент придумал ${fresh.length} идей для браузера` : 'Идеи для браузера';
  }
  setInterval(think, 30 * 60e3);
  setTimeout(think, 2500);

  // ---------- интерфейс ----------
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function render() {
    const list = ideaList();
    const wanted = list.filter((i) => i.st === 'want').length;
    $('#ideasCount').textContent = wanted ? `Хочу: ${wanted}` : '';
    $('#ideasSend').disabled = !wanted;
    $('#ideasList').innerHTML = list.map((i) => `
      <div class="idea ${i.st}" data-id="${esc(i.id)}">
        <div class="idea-top">
          <div class="idea-title">${esc(i.title)}</div>
          ${i.st === 'new' && i.s >= 45 && !state.ideas[i.id]?.seen ? '<span class="idea-new">новое</span>' : ''}
          ${i.st === 'done' ? '<span class="idea-done">сделано</span>' : ''}
        </div>
        <div class="idea-desc">${esc(i.desc)}</div>
        <div class="idea-why">${esc(i.reason)}</div>
        <div class="idea-act">
          <button data-a="want" class="${i.st === 'want' ? 'on' : ''}">${i.st === 'want' ? '✓ Хочу' : 'Хочу'}</button>
          <button data-a="skip" class="${i.st === 'skip' ? 'on' : ''}">Не надо</button>
          ${i.st === 'want' ? '<button data-a="done">Уже сделано</button>' : ''}
        </div>
      </div>`).join('');
  }

  $('#ideasList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const id = b.closest('.idea').dataset.id;
    const cur = state.ideas[id]?.status;
    const a = b.dataset.a;
    state.ideas[id] = { ...(state.ideas[id] || {}), status: cur === a ? 'new' : a, seen: true };
    saveState();
    render();
  });

  window.openIdeas = function () {
    openPop('#ideasPop');
    render();
    // всё, что показали, — больше не «новое»
    for (const i of ideaList()) state.ideas[i.id] = { ...(state.ideas[i.id] || {}), seen: true };
    state.lastOpen = Date.now();
    saveState();
    $('#ideasBtn').classList.remove('has-new');
  };
  $('#ideasBtn').onclick = () => window.openIdeas();

  // «Передать Claude» — готовое ТЗ, которое можно вставить в чат с Claude (где делали браузер)
  $('#ideasSend').onclick = () => {
    const want = ideaList().filter((i) => i.st === 'want');
    if (!want.length) return;
    const text = 'Добавь в мой браузер Liquid (Electron, проект liquid-browser) такие улучшения:\n\n' +
      want.map((i, n) => `${n + 1}. ${i.title} — ${i.desc}`).join('\n') +
      '\n\nСохрани текущий liquid glass дизайн и плавные анимации. Верни обновлённый установщик.';
    L.copy(text);
    toast('Список скопирован — вставь его в чат с Claude, где мы делали браузер');
  };

  // «Придумать ещё» — Claude придумывает новые идеи под твои привычки
  $('#ideasMore').onclick = async () => {
    const known = [...ideaList().map((i) => i.title), ...SHIPPED].join('; ');
    const profile = `Открыто страниц: ${stats.visits}; частые сайты: ${topHosts().join(', ') || 'нет данных'}; ` +
      `страниц не на русском: ${stats.foreign}; страниц с видео: ${stats.video}; макс. вкладок: ${stats.maxTabs}; ` +
      `включений VPN: ${stats.vpnOn}; неоткрывшихся сайтов: ${stats.failed}; вопросов Claude: ${stats.claudeAsks}.`;
    const ask = `Ты — продуктовый агент браузера Liquid (Electron, liquid glass дизайн, встроенный VPN по ключу vless/vmess, панель Claude, защита от фишинга, редактируемые плитки на стартовой странице).\n` +
      `Как пользователь использует браузер: ${profile}\nУже есть в браузере или в списке идей: ${known}.\n` +
      `Придумай 5 НОВЫХ полезных функций именно для этого пользователя, которых нет в списке. Коротко и конкретно, по-русски.`;

    if (!settings.hasClaudeKey) {
      // без ключа — отдаём задачу Claude на claude.ai в боковой панели
      closePops();
      if (typeof sendPageToClaudeWeb === 'function' && settings.claudeMode !== 'api') {
        toggleSide(true);
        L.copy(ask);
        const wv = ensureClaudeWeb();
        wv.focus();
        try { wv.paste(); } catch {}
        toast('Задача для агента вставлена в чат Claude — нажми Enter');
      } else {
        L.copy(ask);
        toast('Задача скопирована — вставь её в чат с Claude');
      }
      return;
    }

    const btn = $('#ideasMore');
    btn.disabled = true;
    btn.textContent = 'Думаю…';
    const r = await L.ask({
      system: 'Ответь ТОЛЬКО JSON-массивом без пояснений: [{"title":"…","desc":"одно-два предложения","why":"почему это нужно этому пользователю"}]',
      user: ask, model: 'claude-sonnet-5-5', maxTokens: 1500,
    });
    btn.disabled = false;
    btn.textContent = 'Придумать ещё';
    if (!r.ok) { toast('Агент не смог: ' + r.error, true); return; }
    try {
      const arr = JSON.parse(r.text.match(/\[[\s\S]*\]/)[0]);
      let added = 0;
      for (const x of arr.slice(0, 6)) {
        if (!x.title || state.custom.some((c) => c.title === x.title)) continue;
        state.custom.push({ id: 'c' + Date.now() + added, title: String(x.title).slice(0, 80), desc: String(x.desc || '').slice(0, 300), why: String(x.why || '').slice(0, 160) });
        added++;
      }
      saveState();
      render();
      toast(added ? `Агент придумал ${added} новых идей` : 'Новых идей нет — всё уже в списке');
    } catch { toast('Не разобрал ответ агента, попробуй ещё раз', true); }
  };
})();
