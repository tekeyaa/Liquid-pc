"""Данные для режима «Аниме / мультики»: рисованные кадры без чужих картинок — генерируем сами:
заливки с контурами (сглаженными, как в настоящей рисовке), cel-shading (жёсткие тени), градиенты неба, «волосы»
из кривых, глаза с бликами, штриховка, текст в облачках; плюс фото, превращённые в «рисунок» (заливка сегментов +
контуры). Дальше как в prep2: короткие видео с движением, ×½, H.264 / VP9 / AV1, кадры P/B."""
import numpy as np, os, random, math, subprocess, tempfile, glob
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from skimage.segmentation import slic, find_boundaries
S = os.path.dirname(os.path.abspath(__file__)) + '/..'
random.seed(21); np.random.seed(21)
SS = 4  # рисуем в 4 раза крупнее и уменьшаем — сглаженные линии, как у настоящей рисовки
PAL = [(250, 220, 200), (255, 238, 225), (60, 50, 70), (240, 90, 110), (90, 160, 240), (250, 210, 80), (120, 200, 140), (180, 120, 220),
       (40, 40, 60), (255, 255, 255), (200, 60, 60), (70, 110, 200), (250, 160, 70), (150, 220, 230), (230, 200, 240), (110, 80, 60)]
def jit(c, k=18): return tuple(max(0, min(255, v + random.randint(-k, k))) for v in c)
def shade(c, f): return tuple(int(v * f) for v in c)
def bez(p0, p1, p2, n=24): return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]) for t in [i / n for i in range(n + 1)]]
def blob(cx, cy, r, n=None):
    n = n or random.randint(5, 11)
    return [(cx + math.cos(a) * r * random.uniform(0.6, 1.25), cy + math.sin(a) * r * random.uniform(0.6, 1.25)) for a in [i * 2 * math.pi / n + random.uniform(-.2, .2) for i in range(n)]]
def scene(W=704, H=448):
    w, h = W * SS, H * SS
    if random.random() < 0.6:  # небо-градиент
        top, bot = jit(random.choice([(90, 150, 230), (250, 170, 120), (40, 40, 90), (170, 220, 250)]), 25), jit((235, 240, 250), 20)
        arr = np.linspace(0, 1, h)[:, None, None] * (np.array(bot) - np.array(top)) + np.array(top)
        im = Image.fromarray(np.repeat(arr, w, 1).astype(np.uint8))
    else: im = Image.new('RGB', (w, h), jit(random.choice(PAL), 30))
    d = ImageDraw.Draw(im)
    ink = jit((30, 25, 40), 15); lw = lambda: int(random.uniform(1.2, 3.8) * SS)
    for _ in range(random.randint(1, 3)):  # холмы / пол
        y0 = random.uniform(.5, .85) * h; pts = [(0, h), (0, y0)] + [(x, y0 + random.uniform(-.08, .08) * h) for x in np.linspace(0, w, 6)] + [(w, h)]
        c = jit(random.choice(PAL), 25); d.polygon(pts, fill=c); d.line(pts[1:-1], fill=ink, width=lw())
    for _ in range(random.randint(3, 9)):  # объекты с контуром и жёсткой тенью
        cx, cy, r = random.uniform(0, w), random.uniform(0, h), random.uniform(.05, .22) * min(w, h)
        c = jit(random.choice(PAL), 22); pts = blob(cx, cy, r) if random.random() < .6 else None
        if pts:
            d.polygon(pts, fill=c)
            sh = [(x + r * .25, y + r * .2) for x, y in blob(cx, cy, r * .7)]; d.polygon(sh, fill=shade(c, random.uniform(.68, .85)))
            d.line(pts + [pts[0]], fill=ink, width=lw(), joint='curve')
        else:
            bb = (cx - r, cy - r * random.uniform(.6, 1.2), cx + r, cy + r * random.uniform(.6, 1.2)); d.ellipse(bb, fill=c, outline=ink, width=lw())
            if random.random() < .5: d.ellipse((bb[0] + r * .3, bb[1] + r * .2, bb[0] + r * .6, bb[1] + r * .5), fill=(255, 255, 255))  # блик
    for _ in range(random.randint(0, 3)):  # «волосы»: пучки кривых
        x, y = random.uniform(0, w), random.uniform(0, h * .6); c = jit(random.choice(PAL), 20)
        for k in range(random.randint(4, 12)):
            p0 = (x + random.uniform(-60, 60) * SS, y); p2 = (p0[0] + random.uniform(-90, 90) * SS, y + random.uniform(60, 200) * SS)
            p1 = ((p0[0] + p2[0]) / 2 + random.uniform(-60, 60) * SS, (p0[1] + p2[1]) / 2)
            d.line(bez(p0, p1, p2), fill=c, width=int(random.uniform(4, 14) * SS)); d.line(bez(p0, p1, p2), fill=ink, width=max(SS, lw() // 2))
    for _ in range(random.randint(0, 2)):  # глаза
        cx, cy, r = random.uniform(.1, .9) * w, random.uniform(.2, .7) * h, random.uniform(10, 26) * SS
        d.ellipse((cx - r, cy - r * 1.3, cx + r, cy + r * 1.3), fill=(255, 255, 255), outline=ink, width=lw())
        ic = jit(random.choice(PAL)); d.ellipse((cx - r * .7, cy - r * .9, cx + r * .7, cy + r * 1.1), fill=ic)
        d.ellipse((cx - r * .35, cy - r * .3, cx + r * .35, cy + r * .5), fill=shade(ic, .35)); d.ellipse((cx - r * .5, cy - r * .7, cx - r * .1, cy - r * .3), fill=(255, 255, 255))
    if random.random() < .4:  # штриховка
        x, y, s = random.uniform(0, w * .8), random.uniform(0, h * .8), random.uniform(60, 180) * SS
        for k in range(random.randint(5, 14)): d.line([(x + k * 9 * SS, y), (x + k * 9 * SS + s * .4, y + s)], fill=ink, width=max(SS, lw() // 2))
    if random.random() < .3:  # облачко с текстом
        f = ImageFont.truetype(random.choice(glob.glob('/usr/share/fonts/opentype/inter/*.otf')), random.randint(14, 30) * SS)
        x, y = random.uniform(0, w * .6), random.uniform(0, h * .6); t = random.choice(['Что?!', 'Пойдём!', 'Wait...', 'Нет!', 'OK', 'Ха-ха'])
        bb = d.textbbox((x, y), t, font=f); d.ellipse((bb[0] - 30 * SS, bb[1] - 20 * SS, bb[2] + 30 * SS, bb[3] + 20 * SS), fill=(255, 255, 255), outline=ink, width=lw()); d.text((x, y), t, font=f, fill=ink)
    im = im.resize((W, H), Image.LANCZOS)
    if random.random() < .25: im = Image.blend(im, im.filter(ImageFilter.GaussianBlur(8)), .25)  # мягкое свечение
    return im
def toon(photo):  # фото → «рисунок»: заливка сегментов средним цветом + тёмные контуры
    a = np.asarray(photo).astype(np.float32)
    seg = slic(a / 255, n_segments=random.randint(80, 300), compactness=random.uniform(8, 20), start_label=0)
    out = np.zeros_like(a)
    for s in np.unique(seg): m = seg == s; out[m] = a[m].mean(0)
    up = Image.fromarray(out.astype(np.uint8)).resize((photo.width * 2, photo.height * 2), Image.NEAREST)
    b = find_boundaries(np.asarray(up.resize((up.width, up.height))).sum(2).astype(np.int32) if False else np.kron(seg, np.ones((2, 2), int)), mode='thick')
    u = np.asarray(up).copy(); u[b] = (u[b] * 0.25).astype(np.uint8)
    return Image.fromarray(u).filter(ImageFilter.GaussianBlur(0.6)).resize(photo.size, Image.LANCZOS)
photos = sorted(glob.glob(f'{S}/x_BSDS500/BSDS500/data/images/train/*.jpg')) + sorted(glob.glob(f'{S}/x_FFDNet/testsets/Kodak24/*'))
srcs = [scene() for _ in range(420)] + [toon(Image.open(f).convert('RGB')) for f in random.sample(photos, 110)]
print('исходников', len(srcs), flush=True)
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'prep2.py')).read().split('HR, LR, META = [], [], []')[0].split("KERN = ")[1].join(['KERN = ', '']) if False else '')
Y = lambda a: (a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722) / 255.0
KERN = [Image.BICUBIC, Image.LANCZOS, Image.BOX, Image.BILINEAR]
def encode(frames, kind, q, tmp):
    for i, f in enumerate(frames): f.save(f'{tmp}/f{i}.png')
    if kind == 'none': return [np.asarray(f).astype(np.float32) for f in frames]
    enc = {'x264': ['-c:v', 'libx264', '-preset', 'faster', '-tune', random.choice(['animation', 'film']), '-crf', str(q)],
           'vp9': ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', str(q), '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1'],
           'av1': ['-c:v', 'libsvtav1', '-crf', str(q), '-preset', '12']}[kind]
    ext = 'webm' if kind == 'vp9' else 'mp4'
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-framerate', '24', '-i', f'{tmp}/f%d.png', *enc, '-pix_fmt', 'yuv420p', f'{tmp}/o.{ext}'], check=True)
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', f'{tmp}/o.{ext}', '-pix_fmt', 'rgb24', f'{tmp}/d%d.png'], check=True)
    return [np.asarray(Image.open(f'{tmp}/d{i + 1}.png').convert('RGB')).astype(np.float32) for i in range(len(frames))]
HR, LR, META = [], [], []
with tempfile.TemporaryDirectory() as tmp:
    for k, im in enumerate(srcs):
        W0, H0 = im.size
        for sq in range(2):
            cw, ch = min(W0 - 24, 576), min(H0 - 16, 576); cw -= cw % 4; ch -= ch % 4
            vx, vy = random.randint(-3, 3), random.randint(-2, 2)
            x0 = random.randint(max(0, -vx * 5), max(max(0, -vx * 5), W0 - cw - max(0, vx * 5)))
            y0 = random.randint(max(0, -vy * 5), max(max(0, -vy * 5), H0 - ch - max(0, vy * 5)))
            kern = random.choice(KERN); hrs, lrs = [], []
            for t in range(6):
                c = im.crop((x0 + vx * t, y0 + vy * t, x0 + vx * t + cw, y0 + vy * t + ch)); hrs.append(c); lrs.append(c.resize((cw // 2, ch // 2), kern))
            kind = random.choices(['none', 'x264', 'vp9', 'av1'], [0.12, 0.42, 0.26, 0.2])[0]
            q = {'none': 0, 'x264': random.randint(20, 34), 'vp9': random.randint(28, 50), 'av1': random.randint(28, 52)}[kind]
            try: dec = encode(lrs, kind, q, tmp)
            except Exception as e: print('кодек', kind, e); continue
            for t in ((0, 2, 5) if random.random() < 0.35 else (2, 5)):
                HR.append(Y(np.asarray(hrs[t]).astype(np.float32)).astype(np.float16)); LR.append(Y(dec[t]).astype(np.float16)); META.append((k, kind, q, t))
        if k % 50 == 0: print(k, len(HR), flush=True)
np.save(f'{S}/nn/pairs_anime.npy', np.array([HR, LR, META], dtype=object), allow_pickle=True)
print('готово', len(HR))
