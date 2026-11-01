"""Пары для обучения: оригинал (HR) → уменьшен в 2 раза и сжат кодеком, как видео на YouTube (LR).
Сохраняем только яркость (Y, BT.709): сеть улучшает яркость, цвет добавляется простым увеличением."""
import numpy as np, glob, os, subprocess, random, tempfile, sys
from PIL import Image, ImageFilter
S = os.path.dirname(os.path.abspath(__file__)) + '/..'
random.seed(7); np.random.seed(7)
files = (sorted(glob.glob(f'{S}/selfex/data/Urban100/image_SRF_2/*_HR.png')) + sorted(glob.glob(f'{S}/selfex/data/BSD100/image_SRF_2/*_HR.png'))
         + sorted(glob.glob(f'{S}/selfex/data/Sun-Hays80/image_SRF_8/*_HR.png')) + sorted(glob.glob(f'{S}/kair/testsets/*/*.png')) + sorted(glob.glob(f'{S}/kair/testsets/*/*.bmp')))
imgs = [Image.open(f).convert('RGB') for f in files]
# фото природы 2048×2048 (грани куба, кроме грани 1 — на ней проверка): режем на куски 1024
cube = Image.open(f'{S}/iob/images/meadow_cube.jpg')
for i in (0, 2, 3, 4, 5):
    face = cube.crop((0, i * 2048, 2048, (i + 1) * 2048))
    for y in range(0, 2048, 1024):
        for x in range(0, 2048, 1024): imgs.append(face.crop((x, y, x + 1024, y + 1024)))
import skimage.data as sd
for n in ('astronaut', 'coffee', 'chelsea', 'rocket'):
    imgs.append(Image.fromarray(getattr(sd, n)()).convert('RGB'))
print('картинок', len(imgs), 'мегапикселей', sum(i.size[0] * i.size[1] for i in imgs) / 1e6)
Y = lambda a: (a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722) / 255.0
def codec(lr, kind, q, tmp):
    w, h = lr.size
    lr.save(f'{tmp}/in.png')
    if kind == 'none': return np.asarray(lr).astype(np.float32)
    enc = {'x264': ['-c:v', 'libx264', '-preset', 'medium', '-crf', str(q)],
           'vp9': ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', str(q), '-deadline', 'good', '-cpu-used', '4'],
           'av1': ['-c:v', 'libsvtav1', '-crf', str(q), '-preset', '8']}[kind]
    ext = 'mp4' if kind != 'vp9' else 'webm'
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', f'{tmp}/in.png', *enc, '-pix_fmt', 'yuv420p', f'{tmp}/o.{ext}'], check=True)
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', f'{tmp}/o.{ext}', '-frames:v', '1', '-pix_fmt', 'rgb24', f'{tmp}/out.png'], check=True)
    return np.asarray(Image.open(f'{tmp}/out.png').convert('RGB')).astype(np.float32)
HR, LR, META = [], [], []
with tempfile.TemporaryDirectory() as tmp:
    for k, im in enumerate(imgs):
        w, h = im.size; w -= w % 4; h -= h % 4; im = im.crop((0, 0, w, h))
        hr = np.asarray(im).astype(np.float32)
        for v in range(3):
            src = im
            r = random.random()
            if r < 0.3: src = im.filter(ImageFilter.GaussianBlur(random.uniform(0.3, 0.8)))   # мягкая камера/оптика
            lr = src.resize((w // 2, h // 2), random.choice([Image.BICUBIC, Image.LANCZOS, Image.BOX, Image.BILINEAR]))
            kind = random.choices(['none', 'x264', 'vp9', 'av1'], [0.15, 0.4, 0.25, 0.2])[0]
            q = {'none': 0, 'x264': random.randint(18, 32), 'vp9': random.randint(24, 44), 'av1': random.randint(24, 44)}[kind]
            out = codec(lr, kind, q, tmp)
            HR.append(Y(hr).astype(np.float16)); LR.append(Y(out).astype(np.float16)); META.append((k, kind, q))
        if k % 40 == 0: print(k, flush=True)
np.save(f'{S}/nn/pairs.npy', np.array([HR, LR, META], dtype=object), allow_pickle=True)
print('готово', len(HR))
