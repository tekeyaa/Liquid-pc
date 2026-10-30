/* Liquid 1.8 — надёжность: «Почему не открылось?», безопасный DNS, автоповтор зависшей пустой страницы */
(() => {
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

  // ================= «Почему не открылось?» =================
  let netRun = 0, netOrigin = '', netTab = null;
  async function runDiag() {
    const tab = netTab;
    // пока страница не загрузилась, webview может ещё не знать свой адрес — тогда берём адрес вкладки
    const url = tab && ((tab.wv && (() => { try { return tab.wv.getURL(); } catch { return ''; } })()) || tab.url);
    const my = ++netRun;
    $('#netHost').textContent = hostOf(url) || 'Нет открытого сайта';
    $('#netVerdict').className = 'net-verdict wait';
    $('#netVerdict').textContent = 'Проверяю: DNS, соединение, загрузку напрямую и через Liquid… до 15 секунд';
    $('#netChecks').innerHTML = '';
    $('#netClear').hidden = true;
    let r;
    try { r = await L.net.diagnose(url || ''); } catch (e) { r = { verdict: 'Проверка не удалась: ' + e.message, checks: [] }; }
    if (my !== netRun) return;
    netOrigin = r.origin || '';
    $('#netVerdict').className = 'net-verdict';
    $('#netVerdict').textContent = r.verdict + (r.action === 'vpn' && !settings.hasVpnKey ? ' В Liquid не добавлен ключ VPN — вставь его в окне VPN или включи свой VPN.' : '');
    $('#netChecks').innerHTML = (r.checks || []).map((c, i) => `<div class="net-check ${esc(c.status)}" style="animation-delay:${i * 30}ms"><i></i><div><b>${esc(c.title)}</b><span>${esc(c.text)}</span></div></div>`).join('');
    $('#netClear').hidden = !netOrigin;
  }
  window.openNetDiag = (tab = active) => { netTab = tab; openPop('#netPop'); runDiag(); };
  $('#netRetry').onclick = runDiag;
  $('#netReload').onclick = () => { closePops(); try { netTab?.wv?.reload(); } catch {} };
  $('#netClear').onclick = async () => {
    if (!netOrigin) return;
    await L.net.clearSite(netOrigin);
    toast('Данные сайта очищены — открываю заново');
    closePops();
    try { netTab?.wv?.reloadIgnoringCache(); } catch {}
  };
  $('#menuPop').addEventListener('click', (e) => {
    if (e.target.closest('button[data-m="netdiag"]')) { closePops(); setTimeout(() => window.openNetDiag(), 60); }
  });

  // ================= Зависшая пустая страница =================
  // Страница 15 секунд грузится и при этом пустая — перезагружаем её один раз сами и записываем в журнал
  // (по журналу видно, какие сайты так себя ведут). Повторно зависла — предлагаем проверку.
  const STALL_MS = 15000;
  const retried = new Map(); // адрес -> когда перезагружали сами
  const stallOn = () => lsGet('liquid.stallRetry', true);
  // пуста ли страница; если она так зависла, что даже не отвечает за 2 секунды, — тоже считаем пустой
  const blank = (wv) => Promise.race([
    wv.executeJavaScript(`(() => { const b = document.body; return !b || ((b.innerText || '').trim().length < 20 && b.getElementsByTagName('*').length < 25 && !document.querySelector('video,canvas,img,iframe,svg')); })()`).catch(() => true),
    new Promise((r) => setTimeout(() => r(true), 2000)),
  ]);
  window.onWebviewCreated = (tab, wv) => {
    let timer = 0;
    const stop = () => { clearTimeout(timer); timer = 0; };
    wv.addEventListener('did-start-navigation', (e) => {
      if (!e.isMainFrame || e.isInPlace || e.isSameDocument || !/^https?:/.test(e.url)) return;
      stop();
      const url = e.url;
      timer = setTimeout(async () => {
        timer = 0;
        if (!tab.wv || tab.wv !== wv || !tab.loading) return;
        let cur = ''; try { cur = wv.getURL(); } catch {}
        if (cur && cur !== url && hostOf(cur) !== hostOf(url)) return;
        if (!(await blank(wv))) return;
        const host = hostOf(url);
        const again = Date.now() - (retried.get(url) || 0) < 5 * 60e3;
        L.diag.log('warn', 'загрузка', `Страница ${STALL_MS / 1000} с грузится и пустая${again ? ' (снова, после перезагрузки)' : ''}`, host);
        if (stallOn() && !again) {
          retried.set(url, Date.now());
          try { wv.reload(); } catch {}
          if (tab === active) toast(`${host} завис пустым — перезагрузил`, false, { label: 'Почему?', run: () => window.openNetDiag(tab) });
        } else if (tab === active) {
          toast(`${host} не загружается`, true, { label: 'Почему не открылось?', run: () => window.openNetDiag(tab) });
        }
      }, STALL_MS);
    });
    wv.addEventListener('did-stop-loading', stop);
    wv.addEventListener('did-fail-load', (e) => { if (e.isMainFrame) stop(); });
    wv.addEventListener('destroyed', stop);
  };

  // ================= настройки =================
  window.features3Init = () => {
    $('#dns').value = settings.dns || 'auto';
    $('#stallRetry').checked = stallOn();
  };
  $('#dns').addEventListener('change', async (e) => {
    settings = await L.settings.set({ dns: e.target.value });
    toast(settings.dns === 'off' ? 'Безопасный DNS выключен' : 'Безопасный DNS включён — адреса сайтов идут зашифрованно');
  });
  $('#stallRetry').addEventListener('change', (e) => lsSet('liquid.stallRetry', e.target.checked));
})();
