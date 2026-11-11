// Движок вкладок. По умолчанию — тег <webview>. Движок «view» (настройка «Эксперименты»): страница — WebContentsView
// в основном процессе (main/tabviews.js), а здесь вместо <webview> — элемент <liquid-view> с теми же методами
// и событиями. Остальной код вкладок не знает, какой движок работает.
//
// WebContentsView рисуется ПОВЕРХ html окна. Поэтому:
//  • элемент <liquid-view> — «место» страницы: его прямоугольник и видимость уходят в основной процесс;
//  • большие окна интерфейса над страницей (меню, настройки, подсказки адресной строки, меню вкладки, превью вкладки,
//    выделение области для скриншота) — страница на это время прячется, а на её месте — её снимок;
//  • маленькие плашки (поиск по странице, сообщения внизу, предупреждение об опасном сайте, обновление) — страница
//    на это время чуть уменьшается, чтобы плашку было видно, а видео и сайт продолжали идти.
(() => {
  const L = window.liquid;
  const engine = new URLSearchParams(location.search).get('engine') === 'view' ? 'view' : 'webview';
  window.TAB_ENGINE = engine;
  window.TAB_TAG = engine === 'view' ? 'liquid-view' : 'webview';
  if (engine !== 'view') return;
  document.documentElement.classList.add('tv-engine');

  const byId = new Map(); // id вкладки → элемент
  let viewFocused = false;
  L.tv.onEvent(({ id, type, state, data }) => { const el = byId.get(id); if (el) el._event(type, state || {}, data || {}); });

  class LiquidView extends HTMLElement {
    constructor() {
      super();
      this._id = 0; this._q = []; this._src = ''; this._url = ''; this._title = ''; this._back = false; this._fwd = false;
      this._zoom = 0; this._loading = false; this._dead = false; this._started = false; this._sent = null; this.__frozen = '';
    }
    get src() { return this._url || this._src; }
    set src(u) { if (this._id) this.loadURL(u).catch(() => {}); else this._src = String(u || ''); }
    connectedCallback() {
      if (this._started || this._dead) return; // перенос по DOM страницу не перезапускает
      this._started = true;
      L.tv.create({}).then((id) => {
        if (!id) return;
        this._id = id; byId.set(id, this);
        if (this._dead) { L.tv.destroy(id); return; }
        layout.add(this);
        this._fire('did-attach');
        for (const f of this._q.splice(0)) f();
        if (this._src) this.loadURL(this._src).catch(() => {});
      }).catch(() => {});
    }
    // убрали из DOM (закрыли вкладку, усыпили) — страница закрывается, как у <webview>
    disconnectedCallback() { queueMicrotask(() => { if (!this.isConnected) this._destroy(); }); }
    _destroy() {
      if (this._dead) return;
      this._dead = true;
      layout.remove(this);
      if (this._id) L.tv.destroy(this._id);
    }
    _whenReady(f) { return this._id ? f() : new Promise((ok, no) => this._q.push(() => { try { ok(f()); } catch (e) { no(e); } })); }
    _call(method, ...args) { return this._whenReady(() => (this._dead ? Promise.reject(new Error('Вкладка закрыта')) : L.tv.call(this._id, method, args))); }
    _void(method, ...args) { const p = this._call(method, ...args); if (p && p.catch) p.catch(() => {}); }
    _fire(type, data) { const ev = new Event(type); if (data) for (const k of Object.keys(data)) { try { ev[k] = data[k]; } catch {} } this.dispatchEvent(ev); }
    _event(type, st, data) {
      if (typeof st.url === 'string') this._url = st.url;
      if (typeof st.title === 'string') this._title = st.title;
      if ('back' in st) { this._back = !!st.back; this._fwd = !!st.fwd; this._zoom = Number(st.zoom) || 0; }
      if (type === 'did-start-loading') this._loading = true;
      if (type === 'did-stop-loading') this._loading = false;
      if (type === 'focus' || type === 'blur') { viewFocused = type === 'focus'; return; }
      if (type === 'nav-state') return;
      if (type === 'destroyed') { byId.delete(this._id); this._dead = true; layout.remove(this); }
      this._fire(type, data);
    }

    // как у <webview>
    getWebContentsId() { if (!this._id) throw new Error('Вкладка ещё не готова'); return this._id; }
    getURL() { return this._url; }
    getTitle() { return this._title; }
    isLoading() { return this._loading; }
    canGoBack() { return this._back; }
    canGoForward() { return this._fwd; }
    getZoomLevel() { return this._zoom; }
    setZoomLevel(z) { this._zoom = z; this._void('setZoomLevel', z); }
    loadURL(u) { this._url = String(u || ''); return this._call('loadURL', this._url); }
    executeJavaScript(code, gesture) { return this._call('executeJavaScript', code, !!gesture); }
    send(channel, ...args) { this._whenReady(() => { if (!this._dead) L.tv.send(this._id, channel, args); }); }
    goBack() { this._void('goBack'); }
    goForward() { this._void('goForward'); }
    goToIndex(i) { this._void('goToIndex', i); }
    reload() { this._void('reload'); }
    reloadIgnoringCache() { this._void('reloadIgnoringCache'); }
    stop() { this._void('stop'); }
    clearHistory() { this._back = false; this._fwd = false; this._void('clearHistory'); }
    focus() { viewFocused = true; this._void('focus'); }
    paste() { this._void('paste'); }
    copy() { this._void('copy'); }
    sendInputEvent(e) { this._void('sendInputEvent', e); }
    findInPage(text, opts) { this._void('findInPage', text, opts || {}); }
    stopFindInPage(action) { this._void('stopFindInPage', action || 'clearSelection'); }
    setAudioMuted(m) { this._void('setAudioMuted', !!m); }
    insertCSS(css) { return this._call('insertCSS', css); }
    print(o) { this._void('print', o || {}); }
    openDevTools() { this._void('openDevTools', { mode: 'detach' }); }
    closeDevTools() { this._void('closeDevTools'); }
    isDevToolsOpened() { return false; }
  }
  customElements.define('liquid-view', LiquidView);

  // Фокус клавиатуры: пока он в странице, html окна его не получит сам — просим основной процесс вернуть его окну,
  // когда интерфейс ставит фокус (Ctrl+L, поиск по странице, поле Claude)
  const focus0 = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (...a) {
    if (viewFocused && !(this instanceof LiquidView)) { viewFocused = false; L.tv.call(0, 'hostFocus', []).catch(() => {}); }
    return focus0.apply(this, a);
  };

  // ---------- где страница и что над ней ----------
  // окна интерфейса над страницей: на это время страница прячется, вместо неё — снимок
  const FREEZE = ['.pop.open', '#suggest.open', '.ctx.open', '#tabPreview.on'];
  // Перетаскивание вкладки или края панели страницу НЕ прячет: смена видимости вида в Chromium обрывает захват мыши
  // окном (lostpointercapture), и вкладку было не вытянуть в окно (CI, тест перетаскивания)
  // плашки: страница уменьшается, чтобы их было видно
  const CARVE = ['#find.open', '#toast.show', '#danger.open', '#update.open', '#updCard.show'];
  const hit = (a, b) => a.width > 0 && a.height > 0 && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const shown = (el) => { if (!el.isConnected) return false; const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden'; };

  const layout = (() => {
    const els = new Set();
    let raf = 0;
    const ro = new ResizeObserver(() => schedule());
    const schedule = () => { if (!raf) raf = requestAnimationFrame(run); };
    function covered(r) {
      for (const sel of FREEZE) for (const o of document.querySelectorAll(sel)) if (shown(o) && hit(o.getBoundingClientRect(), r)) return 'freeze';
      const area = document.getElementById('areaShot');
      if (area && shown(area)) return 'freeze';
      return '';
    }
    function carve(r) {
      let top = r.top, bottom = r.bottom;
      const mid = (r.top + r.bottom) / 2;
      for (const sel of CARVE) for (const o of document.querySelectorAll(sel)) {
        if (!shown(o)) continue;
        const b = o.getBoundingClientRect();
        if (!hit(b, { left: r.left, right: r.right, top, bottom })) continue;
        if ((b.top + b.bottom) / 2 < mid) top = Math.max(top, b.bottom + 6); else bottom = Math.min(bottom, b.top - 6);
      }
      // скругление углов — как у области страницы (на весь экран — без скругления)
      const rad = Math.round(parseFloat(getComputedStyle(document.getElementById('views') || document.body).borderTopLeftRadius) || 0);
      return { x: r.left, y: top, width: r.width, height: Math.max(0, bottom - top), r: rad };
    }
    function run() {
      raf = 0;
      for (const el of els) {
        if (!el._id || el._dead) continue;
        const r = el.getBoundingClientRect();
        const vis = el.isConnected && !document.hidden && r.width > 0 && r.height > 0 && getComputedStyle(el).visibility === 'visible';
        const cov = vis ? covered(r) : '';
        const b = vis ? carve(r) : null;
        const show = vis && !cov;
        if (cov && !el.__frozen) freeze(el);
        if (!cov && el.__frozen) unfreeze(el);
        const key = show ? `${b.x},${b.y},${b.width},${b.height},${b.r}` : 'hidden';
        if (el._sent === key) continue;
        // окно со снимком: сначала снимок на месте, потом прячем страницу (иначе мелькнёт пустое место)
        if (cov && el.__frozen === 'wait') continue;
        el._sent = key;
        L.tv.bounds(el._id, show ? b : null, show);
      }
    }
    function freeze(el) {
      el.__frozen = 'wait';
      const done = (src) => {
        if (el.__frozen !== 'wait') return;
        if (src) el.style.backgroundImage = `url("${src}")`;
        el.__frozen = 'on';
        requestAnimationFrame(schedule);
      };
      el._call('freeze').then(done, () => done(''));
      setTimeout(() => done(''), 250); // снимок задержался — прячем без него, меню важнее
    }
    function unfreeze(el) {
      el.__frozen = '';
      setTimeout(() => { if (!el.__frozen) el.style.backgroundImage = ''; }, 120);
    }
    // перемены в интерфейсе: классы окон и панелей, размеры, анимации
    new MutationObserver(schedule).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    for (const ev of ['transitionend', 'animationend', 'resize', 'visibilitychange']) (ev === 'resize' ? window : document).addEventListener(ev, schedule, true);
    ro.observe(document.body);
    setInterval(schedule, 700); // страховка: сдвиг без смены размера (редко)
    return {
      add(el) { els.add(el); ro.observe(el); schedule(); },
      remove(el) { els.delete(el); try { ro.unobserve(el); } catch {} },
      // для тестов: что сейчас с вкладками
      state: () => [...els].map((el) => ({ id: el._id, sent: el._sent, frozen: el.__frozen })),
    };
  })();
  window.tabViewState = layout.state;
})();
