// Анимации интерфейса Liquid: «жидкое» стекло под активной вкладкой и пунктами настроек,
// блик стекла за курсором. Всё считается в requestAnimationFrame, поэтому идёт с частотой монитора
// (60, 144, 180 Гц) и само останавливается, когда движение закончилось.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');

  // ---------- пружина ----------
  // Каждый край выделения — отдельная пружина. Передний край (в сторону движения) жёстче заднего,
  // поэтому по пути выделение вытягивается, как капля, и стягивается обратно на месте.
  const LEAD = { k: 640, c: 40 };
  const TRAIL = { k: 300, c: 29 };

  function makeGlider(box, pick, cls) {
    const g = document.createElement('div');
    g.className = 'glider ' + cls;
    g.setAttribute('aria-hidden', 'true');
    box.prepend(g);
    box.classList.add('has-glider');

    // края: a — левый/верхний, b — правый/нижний; по второй оси следим без растяжения
    const cur = { l: 0, r: 0, t: 0, b: 0 }, vel = { l: 0, r: 0, t: 0, b: 0 };
    let ready = false, raf = 0, last = 0, followUntil = 0;

    function target() {
      const el = pick(box);
      if (!el || !el.offsetWidth || !el.offsetHeight || !box.offsetWidth) return null;
      return { l: el.offsetLeft, r: el.offsetLeft + el.offsetWidth, t: el.offsetTop, b: el.offsetTop + el.offsetHeight };
    }
    function paint(speed) {
      g.style.transform = `translate3d(${cur.l.toFixed(2)}px, ${cur.t.toFixed(2)}px, 0)`;
      g.style.width = Math.max(0, cur.r - cur.l).toFixed(2) + 'px';
      g.style.height = Math.max(0, cur.b - cur.t).toFixed(2) + 'px';
      g.style.setProperty('--speed', Math.min(1, speed / 2200).toFixed(3));
    }
    function snap(tg) { Object.assign(cur, tg); vel.l = vel.r = vel.t = vel.b = 0; paint(0); }

    function frame(now) {
      raf = 0;
      const tg = target();
      if (!tg) { g.classList.remove('on'); ready = false; return; }
      if (!ready || reduce.matches || document.hidden) { ready = true; g.classList.add('on'); snap(tg); return; }
      let dt = Math.min(0.034, (now - (last || now)) / 1000) || 1 / 120;
      last = now;
      const dirX = Math.sign((tg.l + tg.r) - (cur.l + cur.r));
      const dirY = Math.sign((tg.t + tg.b) - (cur.t + cur.b));
      const spec = { l: dirX < 0 ? LEAD : TRAIL, r: dirX > 0 ? LEAD : TRAIL, t: dirY < 0 ? LEAD : TRAIL, b: dirY > 0 ? LEAD : TRAIL };
      // два шага на кадр — пружина устойчива и при 60 Гц, и при просадках
      for (let s = 0; s < 2; s++) {
        const h = dt / 2;
        for (const e of ['l', 'r', 't', 'b']) {
          const { k, c } = spec[e];
          vel[e] += (k * (tg[e] - cur[e]) - c * vel[e]) * h;
          cur[e] += vel[e] * h;
        }
      }
      const speed = Math.max(Math.abs(vel.l), Math.abs(vel.r), Math.abs(vel.t), Math.abs(vel.b));
      const off = Math.max(Math.abs(tg.l - cur.l), Math.abs(tg.r - cur.r), Math.abs(tg.t - cur.t), Math.abs(tg.b - cur.b));
      if (off < 0.25 && speed < 4 && now > followUntil) { snap(tg); last = 0; return; }
      paint(speed);
      raf = requestAnimationFrame(frame);
    }
    // ms — сколько ещё следить за целью: вкладки сами анимируют ширину, выделение едет вместе с ними
    function kick(ms = 520) {
      followUntil = Math.max(followUntil, performance.now() + ms);
      if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
    }

    new MutationObserver(() => kick()).observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    new ResizeObserver(() => kick(120)).observe(box);
    addEventListener('resize', () => kick(120));
    kick();
    return { kick };
  }

  // вкладки
  const tabs = document.getElementById('tabs');
  if (tabs) makeGlider(tabs, (b) => b.querySelector('.tab.active:not(.closing)'), 'tab-glider');

  // разделы настроек
  const nav = document.getElementById('setNav');
  if (nav) makeGlider(nav, (b) => b.querySelector('button.on'), 'nav-glider');

  // переключатели-сегменты (режим VPN, чёткость, фильтр журнала, библиотека)
  document.querySelectorAll('.seg2').forEach((s) => makeGlider(s, (b) => b.querySelector(':scope > button.on'), 'seg-glider'));

  // ---------- блик стекла за курсором ----------
  // Светлое пятно на стеклянных кнопках и панелях идёт за мышью. Только для небольших элементов:
  // перерисовывать большую панель с размытием фона на каждом движении мыши — лишняя нагрузка.
  let hot = null, px = 0, py = 0, glowRaf = 0;
  function glow() {
    glowRaf = 0;
    if (!hot) return;
    const r = hot.getBoundingClientRect();
    hot.style.setProperty('--mx', (px - r.left).toFixed(1) + 'px');
    hot.style.setProperty('--my', (py - r.top).toFixed(1) + 'px');
  }
  document.addEventListener('pointermove', (e) => {
    if (reduce.matches || document.body.classList.contains('game')) return;
    const el = e.target.closest && e.target.closest('.glass, .tab');
    const ok = el && el.offsetWidth < 640 && el.offsetHeight < 200 ? el : null;
    if (ok !== hot) { hot?.classList.remove('lit'); hot = ok; hot?.classList.add('lit'); }
    px = e.clientX; py = e.clientY;
    if (hot && !glowRaf) glowRaf = requestAnimationFrame(glow);
  }, { passive: true });
  document.addEventListener('pointerleave', () => { hot?.classList.remove('lit'); hot = null; });
})();
