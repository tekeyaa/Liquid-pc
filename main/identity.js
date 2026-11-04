'use strict';
// Кем Liquid представляется сайтам. Защиты от ботов (Cloudflare, DataDome, Яндекс SmartCaptcha и т. п.) сверяют
// три вещи: строку User-Agent, служебные заголовки Sec-CH-UA и navigator.userAgentData в скриптах страницы.
// Electron по умолчанию в строке пишет «Chrome», а в заголовках — только «Chromium» без названия браузера:
// такое противоречие и выглядит как бот. Здесь все три собираются из одного описания, чтобы совпадали.

const MODES = ['chrome', 'yandex', 'edge', 'liquid'];

// Как Chromium сам составляет «мусорный» бренд (GREASE) и порядок брендов по номеру версии —
// components/embedder_support/user_agent_utils.cc. Для Chrome 142 даёт ровно то, что шлёт настоящий Chrome:
// "Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"
const GREASE_CH = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
const GREASE_V = ['8', '99', '24'];
const ORDERS3 = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

function grease(seed) {
  return { brand: `Not${GREASE_CH[seed % 11]}A${GREASE_CH[(seed + 1) % 11]}Brand`, version: GREASE_V[seed % 3] };
}

// Номер Яндекс Браузера по версии Chromium: 25.8 ↔ 138, 25.10 ↔ 140 (выходит примерно раз в месяц)
function yaVer(major) {
  const n = major - 131;
  return `${25 + Math.floor(n / 12)}.${(n % 12 + 12) % 12 + 1}`;
}

function build(mode, chromeFull) {
  if (!MODES.includes(mode)) mode = 'chrome';
  const full = String(chromeFull || '142.0.0.0');
  const major = parseInt(full, 10) || 142;
  const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)';
  const g = grease(major);
  const gFull = { brand: g.brand, version: `${g.version}.0.0.0` };
  const chromium = { brand: 'Chromium', version: String(major) };
  const chromiumFull = { brand: 'Chromium', version: full };
  let ua, brands, fullList;
  if (mode === 'yandex') {
    const ya = yaVer(major);
    ua = `${win} Chrome/${major}.0.0.0 YaBrowser/${ya}.0.0 Safari/537.36`;
    brands = [chromium, g, { brand: 'YaBrowser', version: ya }, { brand: 'Yowser', version: '2.5' }];
    fullList = [chromiumFull, gFull, { brand: 'YaBrowser', version: `${ya}.0.0` }, { brand: 'Yowser', version: '2.5' }];
  } else if (mode === 'liquid') {
    // как есть: строка Chromium без пометок Electron, заголовки — какие шлёт сам движок
    ua = `${win} Chrome/${full} Safari/537.36`;
    return { mode, ua, brands: null, fullList: null, full };
  } else {
    // Chrome и Edge урезают строку до «142.0.0.0» (так делают все Chromium-браузеры с 2023 года)
    const name = mode === 'edge' ? 'Microsoft Edge' : 'Google Chrome';
    ua = `${win} Chrome/${major}.0.0.0 Safari/537.36${mode === 'edge' ? ` Edg/${major}.0.0.0` : ''}`;
    const three = [g, chromium, { brand: name, version: String(major) }];
    const threeF = [gFull, chromiumFull, { brand: name, version: full }];
    const ord = ORDERS3[major % 6];
    brands = []; fullList = [];
    ord.forEach((pos, i) => { brands[pos] = three[i]; fullList[pos] = threeF[i]; });
  }
  return { mode, ua, brands, fullList, full };
}

const hdr = (list) => list.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');

// Подставить заголовки Sec-CH-UA под выбранный браузер (остальные Sec-CH-* — про систему, их не трогаем)
function fixHeaders(h, id) {
  if (!id.brands) return;
  for (const k of Object.keys(h)) {
    const lk = k.toLowerCase();
    if (lk === 'sec-ch-ua') h[k] = hdr(id.brands);
    else if (lk === 'sec-ch-ua-full-version-list') h[k] = hdr(id.fullList);
    else if (lk === 'sec-ch-ua-full-version') h[k] = `"${id.fullList.find((b) => b.brand !== 'Chromium' && !/^Not/.test(b.brand))?.version || id.full}"`;
  }
}

// Для preload вкладок: то, что нужно скриптам страницы (navigator.userAgentData), одной строкой без кавычек
function forPreload(id) {
  return Buffer.from(JSON.stringify({ mode: id.mode, brands: id.brands, fullList: id.fullList })).toString('base64');
}

module.exports = { MODES, build, fixHeaders, forPreload, grease, yaVer };
