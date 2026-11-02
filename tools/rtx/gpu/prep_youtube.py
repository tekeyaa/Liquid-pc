"""Данные для Liquid RTX прямо с YouTube: настоящие пары «1080p → 4K» одного и того же ролика.
python prep_youtube.py ссылки.txt выход.npz [--per-video 16]

На входе — то, что YouTube отдаёт в 1080p (его сжатие: каша в движении, кубики, полосы), образец — 4K-версия того же кадра.
Ролики целиком не качаются: из потоков берутся только нужные места (по несколько кадров). Кадры двух потоков
сверяются между собой (сдвиг на кадр, совпадение картинки) — несовпавшие выбрасываются.
Храним яркость BT.709 в float16, как prep у основной сети."""
import argparse, json, os, random, subprocess, sys
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('links', nargs='?', help='файл со ссылками (по одной в строке) или сама ссылка')
ap.add_argument('out')
ap.add_argument('--per-video', type=int, default=16, help='сколько мест брать из каждого ролика')
ap.add_argument('--crops', type=int, default=3, help='кусочков с одного кадра')
ap.add_argument('--crop', type=int, default=512, help='размер кусочка 4K, кратно 8')
ap.add_argument('--seed', type=int, default=1)
ap.add_argument('--pair', nargs=2, metavar=('LO', 'HI'), help='проверка без YouTube: два своих файла 1080p и 4K')
a = ap.parse_args()
random.seed(a.seed); np.random.seed(a.seed)
C = a.crop - a.crop % 8; c = C // 2
YTX = os.environ.get('YTDLP_ARGS', '').split()   # напр. --cookies-from-browser firefox


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, **kw)


Y = lambda arr: (arr[..., 0] * 0.2126 + arr[..., 1] * 0.7152 + arr[..., 2] * 0.0722) / 255.0


def decode(src, hdr, t, n, w, h, flags='bicubic'):
    """n кадров подряд с момента t → яркость float32 [n,h,w]. Из сети качается только кусок около t."""
    cmd = ['ffmpeg', '-loglevel', 'error', '-nostdin']
    if hdr:
        cmd += ['-user_agent', hdr.get('User-Agent', ''), '-headers', ''.join(f'{k}: {v}\r\n' for k, v in hdr.items() if k != 'User-Agent')]
    cmd += ['-ss', f'{t:.3f}', '-i', src, '-frames:v', str(n), '-vf', f'scale={w}:{h}:flags={flags}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:']
    r = run(cmd, timeout=180)
    k = len(r.stdout) // (w * h * 3)
    if not k: raise RuntimeError((r.stderr.decode('utf-8', 'replace').strip().splitlines() or ['пусто'])[-1])
    return Y(np.frombuffer(r.stdout[:k * w * h * 3], np.uint8).reshape(k, h, w, 3).astype(np.float32))


def down2(x):  # 4K → 1080 для сверки (среднее 2×2)
    return x.reshape(x.shape[0], x.shape[1] // 2, 2, x.shape[2] // 2, 2).mean((2, 4))


def psnr(p, q): return 10 * np.log10(1 / max(np.mean((p - q) ** 2), 1e-10))


def pick(info):
    """Образец и 1080p того же ролика (та же частота кадров). Образец — 8K, уменьшенный до 4K (почти без следов сжатия),
    а если 8K нет — 4K-поток. Кодек 1080p — случайный: браузер получает от YouTube то AV1, то VP9, то H.264."""
    fs = [f for f in info.get('formats', []) if f.get('vcodec') not in (None, 'none') and f.get('acodec') in (None, 'none')
          and (f.get('dynamic_range') or 'SDR') == 'SDR' and str(f.get('protocol', '')).startswith('http') and f.get('width') and f.get('height')]
    his = [f for f in fs if f['width'] * f['height'] >= 6_000_000]
    if not his: return None, 'нет 4K'
    best = None
    for k in (4, 2):   # сначала 8K, потом 4K
        for hi in sorted(his, key=lambda f: -(f.get('tbr') or 0)):
            los = [f for f in fs if f['width'] * k == hi['width'] and f['height'] * k == hi['height'] and round(f.get('fps') or 0) == round(hi.get('fps') or 0)]
            if los: best = (hi, random.choice(los)); break
        if best: break
    return (best, '') if best else (None, 'нет пары 1080p к 4K')


src = []   # (имя, lo, hi, длительность)
if a.pair:
    for p in a.pair:
        if not os.path.exists(p): sys.exit(f'нет файла {p}')
    pr = lambda p: json.loads(run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', p]).stdout)
    jl, jh = pr(a.pair[0]), pr(a.pair[1])
    src.append(('проверка', {'url': a.pair[0], 'width': jl['streams'][0]['width'], 'height': jl['streams'][0]['height'], 'vcodec': 'файл'},
                {'url': a.pair[1], 'width': jh['streams'][0]['width'], 'height': jh['streams'][0]['height']}, float(jl['format']['duration'])))
else:
    if not a.links: sys.exit('Дай файл со ссылками или ссылку.')
    links = [l.strip() for l in open(a.links, encoding='utf-8')] if os.path.exists(a.links) else [a.links]
    links = [l for l in links if l and not l.startswith('#')]
    print('ссылок:', len(links))
    for u in links:
        r = run([sys.executable, '-m', 'yt_dlp', '-J', '--no-playlist', '--no-warnings', *YTX, u], timeout=180)
        if r.returncode:
            err = (r.stderr.decode('utf-8', 'replace').strip().splitlines() or ['?'])[-1]
            print('  не открылся:', u, '—', err)
            if 'bot' in err or 'Sign in' in err: print('  YouTube просит войти: см. README, пункт про cookies')
            continue
        info = json.loads(r.stdout)
        pr, why = pick(info)
        title = (info.get('title') or u)[:60]
        if not pr: print('  пропуск:', title, '—', why); continue
        src.append((title, pr[1], pr[0], float(info.get('duration') or 0)))
        print(f"  {title}: {pr[1]['width']}×{pr[1]['height']} {pr[1].get('vcodec', '').split('.')[0]} → {pr[0]['width']}×{pr[0]['height']}" + (' (8K → 4K)' if pr[0]['width'] >= 4 * pr[1]['width'] else ''))
if not src: sys.exit('Ни одного ролика с 4K. Нужны ролики, у которых в YouTube есть качество 2160p.')

HR, LR, CID = [], [], []
cid = 0
for title, lo, hi, dur in src:
    if dur < 20: print('  слишком короткий:', title); continue
    got = fails = 0
    ts = sorted(random.uniform(dur * 0.05, dur * 0.95 - 2) for _ in range(a.per_video))
    for t in ts:
        try:
            L = decode(lo['url'], lo.get('http_headers'), t, 4, lo['width'], lo['height'])
            # 8K сразу уменьшаем до 4K (среднее по площади) — так образец чище самого 4K-потока
            Hh = decode(hi['url'], hi.get('http_headers'), t, 4, 2 * lo['width'], 2 * lo['height'], 'area')
        except Exception as e:
            fails += 1
            if fails <= 2: print('  не скачалось место', f'{t:.0f}с:', str(e)[:120])
            if fails >= 4 and not got: print('  бросаю ролик (обнови yt-dlp: 1-setup.bat)'); break
            continue
        Hd = down2(Hh)
        # сверка: тот ли это кадр (потоки могут разойтись на кадр)
        sc = {}
        for d in (-1, 0, 1):
            pairs = [(i, i + d) for i in range(len(L)) if 0 <= i + d < len(Hh)]
            if pairs: sc[d] = np.mean([psnr(L[i], Hd[j]) for i, j in pairs])
        d = max(sc, key=sc.get)
        if sc[d] < 27:
            print(f'  {t:.0f}с: кадры не совпали ({sc[d]:.1f} дБ), пропуск'); continue
        pairs = [(i, i + d) for i in range(len(L)) if 0 <= i + d < len(Hh)]
        for i, j in random.sample(pairs, min(2, len(pairs))):
            for _ in range(a.crops):
                y0, x0 = random.randint(0, L.shape[1] - c), random.randint(0, L.shape[2] - c)
                lr, hr = L[i, y0:y0 + c, x0:x0 + c], Hh[j, 2 * y0:2 * y0 + C, 2 * x0:2 * x0 + C]
                if hr.std() < 0.04: continue      # пустое место (небо, чёрный фон) — учить нечему
                LR.append(lr.astype(np.float16)); HR.append(hr.astype(np.float16)); CID.append(cid)
        cid += 1; got += 1
    print(f'  {title}: мест {got}/{len(ts)}, всего пар {len(HR)}', flush=True)
if not HR: sys.exit('Не вышло ни одной пары.')
np.savez(a.out, HR=np.stack(HR), LR=np.stack(LR), CID=np.array(CID))
print('готово:', a.out, len(HR), 'пар', f'{os.path.getsize(a.out) / 2 ** 20:.0f} МБ')
