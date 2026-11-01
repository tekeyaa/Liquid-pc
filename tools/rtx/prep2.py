"""Данные v2 для Liquid RTX: как на YouTube — не отдельные картинки, а КОРОТКИЕ ВИДЕО с движением, сжатые кодеком
с межкадровым предсказанием (кадры P/B, где и живёт основной мусор: плавающие блоки, размазанные детали).
Оригинал (HR) → 6 кадров с плавным сдвигом (целые точки HR = полточки после уменьшения) → ×½ → H.264 / VP9 / AV1
→ берём кадры 0, 2, 5. Плюс синтетические кадры с текстом (субтитры, интерфейс). Храним float16 (яркость BT.709)."""
import numpy as np, glob, os, subprocess, random, tempfile
from PIL import Image, ImageFilter, ImageDraw, ImageFont
S = os.path.dirname(os.path.abspath(__file__)) + '/..'
random.seed(11); np.random.seed(11)
files = (glob.glob(f'{S}/selfex/data/Urban100/image_SRF_2/*_HR.png') + glob.glob(f'{S}/selfex/data/BSD100/image_SRF_2/*_HR.png')
         + glob.glob(f'{S}/selfex/data/Sun-Hays80/image_SRF_8/*_HR.png') + glob.glob(f'{S}/kair/testsets/*/*.png') + glob.glob(f'{S}/kair/testsets/*/*.bmp')
         + glob.glob(f'{S}/x_FFDNet/testsets/Kodak24/*') + glob.glob(f'{S}/x_FFDNet/testsets/McMaster/*') + glob.glob(f'{S}/x_BSDS500/BSDS500/data/images/train/*.jpg'))
imgs = [Image.open(f).convert('RGB') for f in sorted(files)]
cube = Image.open(f'{S}/iob/images/meadow_cube.jpg')
for i in (0, 2, 3, 4, 5):   # грань 1 — проверка
    face = cube.crop((0, i * 2048, 2048, (i + 1) * 2048))
    for y in range(0, 2048, 1024):
        for x in range(0, 2048, 1024): imgs.append(face.crop((x, y, x + 1024, y + 1024)))
import skimage.data as sd
for n in ('astronaut', 'coffee', 'chelsea', 'rocket'): imgs.append(Image.fromarray(getattr(sd, n)()).convert('RGB'))
# синтетика: текст поверх фото — субтитры, интерфейс, табло (другие фразы, чем в проверочном кадре)
FONTS = [f for f in glob.glob('/usr/share/fonts/opentype/inter/*.otf') + glob.glob('/usr/share/fonts/truetype/dejavu/*.ttf') + glob.glob('/usr/share/texmf/fonts/opentype/public/tex-gyre/*.otf')]
WORDS = ('привет мир видео новости игра счёт время матч команда канал подписка смотреть далее серия сезон эпизод погода курс '
         'hello world stream live score level health ammo player settings next episode chapter breaking news market update').split()
def synth(k):
    bg = imgs[random.randrange(len(imgs))].resize((960, 540)).filter(ImageFilter.GaussianBlur(random.choice([0, 2, 6])))
    im = Image.eval(bg, lambda v: int(v * random.uniform(0.35, 1.0))) if random.random() < 0.6 else bg
    d = ImageDraw.Draw(im)
    for _ in range(random.randint(3, 9)):
        f = ImageFont.truetype(random.choice(FONTS), random.randint(11, 44))
        t = ' '.join(random.choice(WORDS) for _ in range(random.randint(1, 6)))
        if random.random() < 0.3: t += f' {random.randint(0, 9999)}:{random.randint(10, 59)}'
        x, y = random.randint(0, 700), random.randint(0, 500)
        col = random.choice([(255, 255, 255), (255, 235, 90), (230, 230, 230), (20, 20, 20), (120, 220, 255), (255, 90, 80)])
        if random.random() < 0.35:
            bb = d.textbbox((x, y), t, font=f); d.rectangle((bb[0] - 6, bb[1] - 4, bb[2] + 6, bb[3] + 4), fill=tuple(random.randint(0, 60) for _ in range(3)))
        sw = random.choice([0, 0, 1, 2]); d.text((x, y), t, font=f, fill=col, stroke_width=sw, stroke_fill=(0, 0, 0))
    if random.random() < 0.4:  # линии интерфейса / графика
        for _ in range(random.randint(2, 8)): d.line([tuple(random.randint(0, 960) for _ in range(2)), tuple(random.randint(0, 540) for _ in range(2))], fill=col, width=random.randint(1, 3))
    return im
imgs += [synth(k) for k in range(90)]
print('исходников', len(imgs), flush=True)
Y = lambda a: (a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722) / 255.0
KERN = [Image.BICUBIC, Image.LANCZOS, Image.BOX, Image.BILINEAR]
def encode(frames, kind, q, tmp):
    for i, f in enumerate(frames): f.save(f'{tmp}/f{i}.png')
    if kind == 'none': return [np.asarray(f).astype(np.float32) for f in frames]
    enc = {'x264': ['-c:v', 'libx264', '-preset', 'faster', '-crf', str(q)],
           'vp9': ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', str(q), '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1'],
           'av1': ['-c:v', 'libsvtav1', '-crf', str(q), '-preset', '12']}[kind]
    ext = 'webm' if kind == 'vp9' else 'mp4'
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-framerate', '30', '-i', f'{tmp}/f%d.png', *enc, '-pix_fmt', 'yuv420p', f'{tmp}/o.{ext}'], check=True)
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', f'{tmp}/o.{ext}', '-pix_fmt', 'rgb24', f'{tmp}/d%d.png'], check=True)
    return [np.asarray(Image.open(f'{tmp}/d{i + 1}.png').convert('RGB')).astype(np.float32) for i in range(len(frames))]
HR, LR, META = [], [], []
with tempfile.TemporaryDirectory() as tmp:
    for k, im in enumerate(imgs):
        W0, H0 = im.size
        for sq in range(2):
            cw, ch = min(W0 - 24, 576), min(H0 - 16, 576); cw -= cw % 4; ch -= ch % 4
            vx, vy = random.randint(-3, 3), random.randint(-2, 2)            # движение: целые точки HR = полточки LR
            x0 = random.randint(max(0, -vx * 5), max(max(0, -vx * 5), W0 - cw - max(0, vx * 5)))
            y0 = random.randint(max(0, -vy * 5), max(max(0, -vy * 5), H0 - ch - max(0, vy * 5)))
            blur = random.uniform(0.3, 0.8) if random.random() < 0.3 else 0
            kern = random.choice(KERN)
            hrs, lrs = [], []
            for t in range(6):
                c = im.crop((x0 + vx * t, y0 + vy * t, x0 + vx * t + cw, y0 + vy * t + ch))
                hrs.append(c)
                src = c.filter(ImageFilter.GaussianBlur(blur)) if blur else c
                lrs.append(src.resize((cw // 2, ch // 2), kern))
            kind = random.choices(['none', 'x264', 'vp9', 'av1'], [0.12, 0.42, 0.26, 0.2])[0]
            q = {'none': 0, 'x264': random.randint(20, 33), 'vp9': random.randint(28, 48), 'av1': random.randint(28, 50)}[kind]
            try: dec = encode(lrs, kind, q, tmp)
            except Exception as e: print('кодек', kind, e); continue
            for t in ((0, 2, 5) if random.random() < 0.35 else (2, 5)):
                HR.append(Y(np.asarray(hrs[t]).astype(np.float32)).astype(np.float16)); LR.append(Y(dec[t]).astype(np.float16)); META.append((k, kind, q, t))
        if k % 50 == 0: print(k, len(HR), flush=True)
np.save(f'{S}/nn/pairs2.npy', np.array([HR, LR, META], dtype=object), allow_pickle=True)
print('готово', len(HR), 'HR Мп', sum(h.size for h in HR) / 1e6)
