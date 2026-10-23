// Скачивает свежий xray-core с GitHub в папку bin/
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin');
const exe = process.platform === 'win32' ? 'xray.exe' : 'xray';

function assetName() {
  const a = process.arch;
  if (process.platform === 'win32') return a === 'arm64' ? 'Xray-windows-arm64-v8a.zip' : a === 'ia32' ? 'Xray-windows-32.zip' : 'Xray-windows-64.zip';
  if (process.platform === 'darwin') return a === 'arm64' ? 'Xray-macos-arm64-v8a.zip' : 'Xray-macos-64.zip';
  return a === 'arm64' ? 'Xray-linux-arm64-v8a.zip' : 'Xray-linux-64.zip';
}

(async () => {
  if (fs.existsSync(path.join(BIN, exe)) && !process.argv.includes('--force')) {
    console.log('xray уже есть:', path.join(BIN, exe));
    return;
  }
  fs.mkdirSync(BIN, { recursive: true });
  const name = assetName();
  console.log('Ищу последний релиз xray-core…');
  const rel = await (await fetch('https://api.github.com/repos/XTLS/Xray-core/releases/latest', { headers: { 'user-agent': 'liquid-browser' } })).json();
  const asset = (rel.assets || []).find((x) => x.name === name);
  if (!asset) throw new Error('Не нашёл ' + name + ' в релизе ' + (rel.tag_name || '?'));
  console.log(`Качаю ${name} (${rel.tag_name})…`);
  const res = await fetch(asset.browser_download_url, { headers: { 'user-agent': 'liquid-browser' } });
  if (!res.ok) throw new Error('Загрузка не удалась: ' + res.status);
  const zip = path.join(os.tmpdir(), 'xray-' + Date.now() + '.zip');
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  const out = path.join(os.tmpdir(), 'xray-' + Date.now());
  fs.mkdirSync(out);
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${out}' -Force`], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-o', zip, '-d', out], { stdio: 'inherit' });
  }
  fs.copyFileSync(path.join(out, exe), path.join(BIN, exe));
  if (process.platform !== 'win32') fs.chmodSync(path.join(BIN, exe), 0o755);
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
  console.log('Готово:', path.join(BIN, exe));
})().catch((e) => {
  console.error('\nНе удалось скачать xray:', e.message);
  console.error('Скачай вручную Xray-windows-64.zip с https://github.com/XTLS/Xray-core/releases и положи xray.exe в папку bin');
  process.exit(1);
});
