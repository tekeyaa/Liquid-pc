# adblock-scriptlets — прогресс

База: origin/v1.24 = 7196777 (1.37.0-beta). Параллельно ветка load-fast трогает renderer/*.js и загрузку вкладок в main.js — их не трогать.

## Цель
Скриптлеты uBlock (json-prune, set-constant…) в блокировщике: ресурсы resources.json качать как списки (зеркало + копия на диске),
сборка в служебном процессе, учёт в отпечатке; выключатель settings.adScripts (по умолчанию вкл) в Настройках;
строка в журнале «скриптлетов доступно»; adAllow отключает и скриптлеты; автотест на tests/site (скриптлет сработал, видео играет,
Liquid Player открывается); поправить adblock-bench и неверный комментарий про json-prune в main/adblock.js.

## Находки
- @ghostery/adblocker-electron 2.20.x: косметика через session.registerPreloadScript({type:'frame'}) + ipcMain.handle
  '@ghostery/adblocker/inject-cosmetic-filters' (глобальный канал!). Скрипты внедряются event.sender.executeJavaScript(script, true)
  после асинхронного IPC — только верхний фрейм.
- ipcMain.handle второй раз (вторая сессия — инкогнито) бросает «second handler» → enable() падает до сетевых обработчиков:
  проверить, работает ли сейчас сетевая блокировка в инкогнито (вероятно нет).
- Хук: BlockingContext вызывает blocker.onInjectCosmeticFilters через замыкание → можно переопределить на экземпляре
  (adAllow, enabled, adScripts).
- npm-реестр из контейнера недоступен; исходники ghostery v2.20.3 — в scratchpad/ghostery-adblocker.

## Сделано (коммит «скриптлеты: ресурсы uBlock, раннее внедрение…»)
- main/adblock.js: RESOURCES (resources.json ghostery master) качается через fetchList вместе со списками; путь к файлу → adblock-build.js;
  отпечаток включает ресурсы; нет ресурсов — сборка без них + строка в журнале + повтор через 30 мин (lastNet=false).
  Движок из кэша без скриптлетов → refresh сразу (не чаще раза в 6 ч, файл adblock-engine-ru4.bin.restry).
- attach() больше не зовёт enableBlockingInSession: свои ipcMain.handle для каналов Ghostery (один раз, hookIpc),
  registerPreloadScript(frame, preload Ghostery) на каждую сессию, свой onBeforeRequest. CSS — с учётом enabled/adAllow.
- Скриптлеты: webview-preload.js (верхний фрейм, http/https) → ipcRenderer.sendSync('adblock:scripts') → webFrame.executeJavaScript
  каждого скрипта ДО скриптов страницы. Слушатель ставится в конструкторе AdBlock (ответ всегда, [] без движка).
- settings.adScripts (по умолч. вкл), adScriptsInfo в publicSettings; переключатель + строка в renderer (index.html, features.js).
- Журнал: «скриптлетов доступно: N (из кэша|после обновления)» или «скриптлеты пока недоступны…»; в строке сборки — размер движка и время загрузки.
- TEST: global.__lqAdblock (addTestRules, scriptletCount). Тест «скриптлеты блокировщика…» + tests/site/adyt.html.
- adblock-bench: ресурсы берёт по RESOURCES из main/adblock.js.

- 3bed4d4: тестовые правила идут в сборку через env LIQUID_ADBLOCK_RULES (addTestRules убран: engine.update давал заминку 155 мс в основном процессе).

## CI
- 42937787867 (ae63873): 32 passed. 42938672224 (3bed4d4): 32 passed, rtx-train и rtx-gl зелёные.
- Скриптлетов в ресурсах: 149. Скриптов: YouTube watch 30 (251 КБ), Shorts 30, Twitch 1 (7 КБ), Дзен 3 (15 КБ), example.com 0.
  Синхронный вопрос страницы (scriptsFor): 0,7 мс YouTube, 0,1–0,2 мс прочие. Движок 5,76 МБ, загрузка 6 мс, сборка 2,7 с в служебном процессе.
- Профиль main: блокировщик 139 мс JS (база v1.24: 111 мс), заминок из-за него 0.
- Замер скорости: «обычный» 493 мс против «без блокировщика» 498 (база 437/426; прогон в целом медленнее — Chromium 387 против 298).
  Память Browser: 184/144 МБ ws/priv (база 181/141) на «5 сайтов».

## В работе / следующий шаг
- Готово. Отчёт руководителю отправлен. Возможные доработки: скриптлеты во фреймах (embed YouTube на чужих сайтах) — сейчас только верхний фрейм.
