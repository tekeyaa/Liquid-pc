# RAVU-Zoom-AR — апскейлер для Liquid RTX

Файлы `ravu-zoom-ar-r2-rgb.hook` и `ravu-zoom-ar-r3-rgb.hook` — шейдеры проекта
[bjin/mpv-prescalers](https://github.com/bjin/mpv-prescalers) (коммит b3f0a59, январь 2024) **без изменений**.
Лицензия — GNU LGPL 3.0 (`LICENSE-LGPL-3.0.txt`).

Liquid читает из них тело шейдера и таблицы весов (`main/ravu.js`) и собирает обычный WebGL2-шейдер
(`webview-preload.js`, раздел 7). Файлы можно заменить своими версиями того же формата mpv.
