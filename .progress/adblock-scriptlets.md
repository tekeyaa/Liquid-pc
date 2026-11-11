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

## Сделано
- (пока ничего)

## В работе / следующий шаг
- main/adblock.js: fetch ресурсов, сборка с ресурсами в adblock-build.js, отпечаток, переопределение onInjectCosmeticFilters.
