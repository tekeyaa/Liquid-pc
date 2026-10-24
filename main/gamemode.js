// Игровой режим: следим, не запущена ли игра на весь экран (или из списка известных),
// и тогда отдаём ресурсы игре — понижаем приоритет процессов браузера и замораживаем вкладки.
const { spawn } = require('child_process');
const os = require('os');

const KNOWN = /^(cs2|csgo|dota2|valorant|valorant-win64-shipping|r5apex|fortniteclient-win64-shipping|gta5|gta5_enhanced|playgta5|rdr2|eldenring|cyberpunk2077|robloxplayerbeta|league of legends|overwatch|warframe\.x64|tslgame|destiny2|rocketleague|witcher3|bg3|bg3_dx11|starfield|helldivers2|palworld-win64-shipping|deadlock|project8|marvel-win64-shipping|cod|blackops6|modernwarfare|escapefromtarkov|rustclient|terraria|osu!|genshinimpact|zenlesszonezero|starrail|wow|hearthstone|minecraft\.windows|forzahorizon5|forzahorizon4|nba2k\d+|fc\d+|fifa\d+|eafc\d+|dyinglight2|re4|re8|monsterhunterwilds|stalker2|hogwartslegacy|darksouls3|sekiro|apexlegends|pathofexile|pathofexile2|diablo iv|wuthering waves|client-win64-shipping|bf2042|bf6|thefinals|arc raiders|pioneergame|lethalcompany|phasmophobia|schedulei|gorilla tag)$/i;

// полноэкранные окна, которые игрой не являются: плееры, браузеры, офис, мессенджеры
const NOT_GAME = /^(vlc|mpc-hc64|mpc-hc|mpc-be64|potplayermini64|potplayermini|mpv|wmplayer|video\.ui|microsoft\.media\.player|powerpnt|winword|excel|acrord32|chrome|msedge|firefox|opera|browser|yandex|telegram|discord|obs64|zoom|teams|ms-teams|explorer|applicationframehost|photos|steamwebhelper)$/i;

const PS = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace LQ -Name W -MemberDefinition @'
[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int s);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
'@
while ($true) {
  $s = 0; [void][LQ.W]::SHQueryUserNotificationState([ref]$s)
  $p = 0; [void][LQ.W]::GetWindowThreadProcessId([LQ.W]::GetForegroundWindow(), [ref]$p)
  $n = ''; try { $n = (Get-Process -Id $p).ProcessName } catch {}
  [Console]::Out.WriteLine("$s|$p|$n"); [Console]::Out.Flush()
  Start-Sleep -Seconds 4
}`;

class GameMode {
  constructor({ isOwnPid, onChange }) {
    this.isOwnPid = isOwnPid;
    this.onChange = onChange;
    this.on = false;
    this.forced = null; // null = авто, true/false = вручную
    this.game = '';
    this.hits = 0;
    this.miss = 0;
    this.proc = null;
    this.enabled = true;
  }

  start() {
    if (process.platform !== 'win32' || this.proc) return;
    const enc = Buffer.from(PS, 'utf16le').toString('base64');
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    try { os.setPriority(this.proc.pid, os.constants.priority.PRIORITY_LOW); } catch {}
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { this.tick(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
    });
    this.proc.on('exit', () => { this.proc = null; });
  }

  stop() { try { this.proc?.kill(); } catch {} this.proc = null; }

  tick(line) {
    if (!this.enabled || this.forced !== null) return;
    const [state, pid, name] = line.split('|');
    const st = Number(state);
    const own = this.isOwnPid(Number(pid));
    // 3 = полноэкранный Direct3D (игра). 2 = просто чужое окно на весь экран — это бывает и видеоплеер, и презентация,
    // поэтому его считаем игрой, только если это не известный плеер, браузер или офис
    const game = !own && (st === 3 || KNOWN.test(name || '') || (st === 2 && name && !NOT_GAME.test(name)));
    if (game) { this.hits++; this.miss = 0; } else { this.miss++; this.hits = 0; }
    if (!this.on && this.hits >= 2) this.set(true, name);
    else if (this.on && this.miss >= 3) this.set(false);
  }

  set(on, name = '') {
    if (this.on === on) return;
    this.on = on;
    this.game = on ? name : '';
    this.onChange({ on, game: this.game });
  }

  force(on) {
    this.forced = on;
    if (on === null) { this.hits = 0; this.miss = 0; this.set(false); }
    else this.set(on, on ? 'вручную' : '');
  }
}

module.exports = { GameMode };
