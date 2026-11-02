"""Данные для обучения Liquid RTX из ТВОИХ видео.
python prep_video.py ПАПКА_С_ВИДЕО выход.npz [--clips 800] [--crop 512]

Из случайных мест видео берём по 6 кадров подряд (настоящее движение), это «оригинал».
Чтобы оригинал был чистым: 4K берём как есть, видео ниже ~1800 строк сначала уменьшаем вдвое (сжатие при этом исчезает).
Дальше как у YouTube: ×½ случайным фильтром (иногда лёгкое размытие), сжатие H.264 / VP9 / AV1 с разным качеством,
берём кадры P/B (2 и 5, иногда и 0). Храним яркость BT.709 в float16."""
import argparse, json, os, random, subprocess, tempfile, sys
import numpy as np
from PIL import Image, ImageFilter

ap = argparse.ArgumentParser()
ap.add_argument('videos'); ap.add_argument('out')
ap.add_argument('--clips', type=int, default=800, help='сколько кусочков нарезать (каждый даёт 2–3 пары)')
ap.add_argument('--crop', type=int, default=512, help='размер кусочка оригинала, кратно 8')
ap.add_argument('--seed', type=int, default=1)
a = ap.parse_args()
random.seed(a.seed); np.random.seed(a.seed)
C = a.crop - a.crop % 8
EXT = ('.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.ts', '.flv')


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


try:
    encs = run(['ffmpeg', '-hide_banner', '-encoders']).stdout
except FileNotFoundError:
    sys.exit('Не найден ffmpeg. Поставь: winget install Gyan.FFmpeg — и открой новое окно.')
KINDS = [k for k, n in (('x264', 'libx264'), ('vp9', 'libvpx-vp9'), ('av1', 'libsvtav1')) if n in encs]
print('кодеки:', ', '.join(KINDS) or 'нет (будет без сжатия)')

files = sorted(os.path.join(r, f) for r, _, fs in os.walk(a.videos) for f in fs if f.lower().endswith(EXT))
info = []
for f in files:
    try:
        j = json.loads(run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', f]).stdout)
        d, w, h = float(j['format']['duration']), j['streams'][0]['width'], j['streams'][0]['height']
        sc = 1.0 if h >= 1800 else 0.5
        if d > 8 and min(w, h) * sc >= C: info.append((f, d, sc))
        else: print('пропуск (короткое или маленькое):', os.path.basename(f))
    except Exception:
        print('не читается:', os.path.basename(f))
if not info: sys.exit(f'В папке нет подходящих видео (нужны от {C}×{C} после уменьшения: 1080p и выше).')
print('видео:', len(info), ' 4K:', sum(1 for i in info if i[2] == 1.0))

Y = lambda arr: (arr[..., 0] * 0.2126 + arr[..., 1] * 0.7152 + arr[..., 2] * 0.0722) / 255.0
KERN = [Image.BICUBIC, Image.LANCZOS, Image.BOX, Image.BILINEAR]


def encode(frames, kind, q, tmp):
    if kind == 'none': return [np.asarray(f).astype(np.float32) for f in frames]
    for i, f in enumerate(frames): f.save(f'{tmp}/f{i}.png')
    enc = {'x264': ['-c:v', 'libx264', '-preset', 'faster', '-crf', str(q)],
           'vp9': ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', str(q), '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1'],
           'av1': ['-c:v', 'libsvtav1', '-crf', str(q), '-preset', '12']}[kind]
    ext = 'webm' if kind == 'vp9' else 'mp4'
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-framerate', '30', '-i', f'{tmp}/f%d.png', *enc, '-pix_fmt', 'yuv420p', f'{tmp}/o.{ext}'], check=True, capture_output=True)
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', f'{tmp}/o.{ext}', '-pix_fmt', 'rgb24', f'{tmp}/d%d.png'], check=True, capture_output=True)
    return [np.asarray(Image.open(f'{tmp}/d{i + 1}.png').convert('RGB')).astype(np.float32) for i in range(len(frames))]


HR, LR, CID = [], [], []
weights = [d for _, d, _ in info]
with tempfile.TemporaryDirectory() as tmp:
    k = tries = 0
    while k < a.clips and tries < a.clips * 4:
        tries += 1
        f, d, sc = random.choices(info, weights)[0]
        t = random.uniform(d * 0.04, d * 0.96 - 1)
        for p in os.listdir(tmp): os.remove(os.path.join(tmp, p))
        vf = f"scale=trunc(iw*{sc}/2)*2:trunc(ih*{sc}/2)*2:flags=area" if sc != 1.0 else 'null'
        r = run(['ffmpeg', '-loglevel', 'error', '-y', '-ss', f'{t:.3f}', '-i', f, '-frames:v', '6', '-vf', vf, '-pix_fmt', 'rgb24', f'{tmp}/h%d.png'])
        try: hrs = [Image.open(f'{tmp}/h{i + 1}.png').convert('RGB') for i in range(6)]
        except Exception: continue
        W0, H0 = hrs[0].size
        if W0 < C or H0 < C: continue
        x0, y0 = random.randint(0, W0 - C), random.randint(0, H0 - C)
        hrs = [h.crop((x0, y0, x0 + C, y0 + C)) for h in hrs]
        y = [Y(np.asarray(h).astype(np.float32)) for h in hrs]
        if y[0].std() < 0.04 or np.abs(y[0] - y[5]).mean() > 0.12: continue   # пустой/тёмный кадр или склейка сцен
        blur = random.uniform(0.3, 0.8) if random.random() < 0.3 else 0
        kern = random.choice(KERN)
        lrs = [(h.filter(ImageFilter.GaussianBlur(blur)) if blur else h).resize((C // 2, C // 2), kern) for h in hrs]
        kind = random.choices(['none'] + KINDS, [0.12] + [{'x264': 0.42, 'vp9': 0.26, 'av1': 0.2}[x] for x in KINDS])[0]
        q = {'none': 0, 'x264': random.randint(20, 33), 'vp9': random.randint(28, 48), 'av1': random.randint(28, 50)}[kind]
        try: dec = encode(lrs, kind, q, tmp)
        except Exception as e: print('кодек', kind, e); continue
        for i in ((0, 2, 5) if random.random() < 0.35 else (2, 5)):
            HR.append(y[i].astype(np.float16)); LR.append(Y(dec[i]).astype(np.float16)); CID.append(k)
        k += 1
        if k % 50 == 0: print(f'{k}/{a.clips} кусочков, {len(HR)} пар', flush=True)
if not HR: sys.exit('Не вышло ни одной пары — проверь видео.')
np.savez(a.out, HR=np.stack(HR), LR=np.stack(LR), CID=np.array(CID))
print('готово:', a.out, len(HR), 'пар', f'{os.path.getsize(a.out) / 2 ** 20:.0f} МБ')
