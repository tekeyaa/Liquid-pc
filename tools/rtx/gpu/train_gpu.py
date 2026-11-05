r"""Обучение Liquid RTX на видеокарте (PyTorch + CUDA). Та же сеть, что в браузере, — веса встают в Liquid как есть.
python train_gpu.py --net pro [--data папка_или.npz ...]

Данные по умолчанию — то, что собрал режим обучения браузера (%APPDATA%\Liquid\rtx-learn\data).
Результат — сразу в %APPDATA%\Liquid\rtx\, откуда его берёт Liquid (перезапусти браузер).
По умолчанию ДООБУЧАЕТ нынешнюю сеть (свою из %APPDATA%\Liquid\rtx, иначе встроенную) — так она не забудет
старое и быстро подстроится под YouTube. --scratch — учить с нуля. Ctrl+C — остановить и сохранить.
Сохраняется лучший вариант по проверочным кадрам (их сеть не видит), рядом — .pt для продолжения (--resume).
--frames 2 — Liquid RTX 2 на два кадра (второй вход — прошлый кадр 1080p): учится только на данных, где сбор сохранил
прошлый кадр (<ролик>_lp.npy), начинает с весов сети на один кадр (вход прошлого кадра = 0 — считает ровно то же)
и пишет liquid-rtx2-2f.json, только если на проверке стало лучше."""
import argparse, glob, math, os, sys, time
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as Fn
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # встроенный Python (кнопка «Обучить») папку скрипта сам не добавляет
import rtxfmt
import rtx2
from rtx2_torch import Net2

HERE = os.path.dirname(os.path.abspath(__file__))
NETS = {'rtx2': (0, 0, 'liquid-rtx2.json'), 'ultra': (32, 6, 'liquid-rtx-ultra.json'), 'pro': (24, 5, 'liquid-rtx-pro.json'), 'lite': (16, 4, 'liquid-rtx.json'), 'anime': (16, 4, 'liquid-rtx-anime.json')}
ap = argparse.ArgumentParser()
ap.add_argument('--net', choices=NETS, default='rtx2')
APPD = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'Liquid')
ap.add_argument('--data', nargs='+', default=[os.path.join(APPD, 'rtx-learn', 'data')])
ap.add_argument('--out', default=None)
ap.add_argument('--steps', type=int, default=100000)
ap.add_argument('--hours', type=float, default=0, help='учить столько часов (вместо числа шагов): шаг обучения плавно спадает к концу срока')
ap.add_argument('--batch', type=int, default=64)
ap.add_argument('--patch', type=int, default=0, help='кусок кадра (LR) на один пример (по умолчанию 48, у RTX 2 — 64)')
ap.add_argument('--lr', type=float, default=None, help='шаг обучения (по умолчанию 2e-4 дообучение, 1e-3 с нуля)')
ap.add_argument('--scratch', action='store_true')
ap.add_argument('--init', default=None, help='с каких весов начать (json)')
ap.add_argument('--grow-from', default=None, help='своих весов этой сети ещё нет — вырастить её из меньшей (json), не меняя ответа')
ap.add_argument('--resume', default=None, help='продолжить с .pt')
ap.add_argument('--warm', default=None, help='начать с весов из .pt (новый круг: шаг обучения заново)')
ap.add_argument('--allow-cpu', action='store_true', help=argparse.SUPPRESS)
ap.add_argument('--no-baseline', action='store_true', help=argparse.SUPPRESS)   # проверка: сохранять, даже если хуже Pro   # только для проверки на машине без видеокарты
ap.add_argument('--gan', type=float, default=0.0, help='дорисовка деталей: вес сети-судьи (напр. 0.01). Учится от RTX 2, пишет отдельный файл')
ap.add_argument('--percept', type=float, default=0.0, help='вес «на глаз» (VGG), напр. 0.02: детальнее, но PSNR ниже — смотреть глазами')
ap.add_argument('--frames', type=int, choices=(1, 2), default=1, help='2 — RTX 2 на два кадра (нужны данные с прошлым кадром, _lp.npy)')
ap.add_argument('--min-pairs', type=int, default=300, help='на два кадра: сколько нужно пар с прошлым кадром')
ap.add_argument('--always-save', action='store_true', help=argparse.SUPPRESS)   # проверка: записать веса, даже если не стали лучше
a = ap.parse_args()
F, H, fname = NETS[a.net]
TWO = a.frames == 2
if TWO and a.net != 'rtx2': sys.exit('на два кадра учится только Liquid RTX 2 (--net rtx2)')
if TWO and a.gan: sys.exit('дорисовка учится на один кадр (без --frames 2)')
if TWO: fname = "liquid-rtx2-2f.json"
os.makedirs(os.path.join(APPD, 'rtx'), exist_ok=True)
OUT = a.out or os.path.join(APPD, 'rtx', fname)
if not torch.cuda.is_available() and not a.allow_cpu: sys.exit('PyTorch не видит видеокарту (CUDA): обнови драйвер NVIDIA.')
dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
torch.backends.cudnn.benchmark = True
G2 = a.net == 'rtx2'
L = H + 2; M = 0 if G2 else L + 1; dims = [1] + [F] * (L - 1) + [4]
CR = 8   # RTX 2: поля куска (LR), где края повторены искусственно, — в потерях не считаем


class Net(nn.Module):
    def __init__(self):
        super().__init__()
        self.c = nn.ModuleList([nn.Conv2d(dims[i], dims[i + 1], 3) for i in range(L)])   # без полей — как при обучении на numpy

    def forward(self, x, P):  # x: B,1,P+2M,P+2M → B,1,2P,2P
        h = x
        for i, c in enumerate(self.c):
            h = c(h)
            if i < L - 1: h = Fn.relu(h)
        r = Fn.pixel_shuffle(h[:, :, 1:P + 1, 1:P + 1].float(), 2)        # 4 подпикселя 2×2, как в шейдере
        c = x[:, :, M - 1:M + P + 1, M - 1:M + P + 1].float()
        base = Fn.interpolate(c, scale_factor=2, mode='bilinear', align_corners=False)[:, :, 2:2 * P + 2, 2:2 * P + 2]
        return r + base


net = (Net2(frames=a.frames) if G2 else Net()).to(dev)
init = a.init or next((p for p in (os.path.join(APPD, 'rtx', fname), os.path.join(HERE, fname), os.path.join(HERE, '..', '..', '..', 'main', 'rtx', fname)) if os.path.exists(p)), None)
if TWO and not a.init and not init:
    # своей сети на два кадра ещё нет — начинаем с сети на один кадр (вход прошлого кадра нулевой)
    init = next((p for p in (os.path.join(APPD, 'rtx', 'liquid-rtx2.json'), os.path.join(HERE, 'liquid-rtx2.json')) if os.path.exists(p)), None)
    if not init and not a.scratch and not a.resume and not a.warm: sys.exit('Сеть на два кадра учится поверх твоей Liquid RTX 2 — сначала обычное обучение')
if G2 and not a.scratch and not a.resume and not a.warm:
    if init:
        net.load_json(init); print('дообучаю', init)
    else:
        a.scratch = True; print('своей Liquid RTX 2 ещё нет — учу с нуля')
if G2 and a.scratch:
    with torch.no_grad(): net.c[-1].weight.mul_(0.1); net.c[-1].bias.zero_()
elif G2 or a.warm: pass
elif not a.scratch and not a.resume:
    if not init and a.grow_from:
        F0, H0, d0, layers = rtxfmt.load(a.grow_from)
        _, _, _, layers = rtxfmt.grow(layers, F, H)
        init = f'{a.grow_from} (выращена до {F}×{H}: ответ тот же, обучение только улучшит)'
        F0, H0 = F, H
    elif not init: sys.exit(f'Нет {fname} для дообучения — положи его рядом или учи с нуля: --scratch')
    else: F0, H0, d0, layers = rtxfmt.load(init)
    if (F0, H0) != (F, H): sys.exit(f'{init}: сеть {F0}×{H0}, а нужна {F}×{H}')
    with torch.no_grad():
        for c, (W, b) in zip(net.c, layers): c.weight.copy_(torch.from_numpy(W)); c.bias.copy_(torch.from_numpy(b))
    print('дообучаю', init)
elif a.scratch:
    with torch.no_grad(): net.c[-1].weight.mul_(0.1); net.c[-1].bias.zero_()
if a.warm:
    ck = torch.load(a.warm, map_location=dev); net.load_state_dict(ck.get('ema') or ck['net']); print('продолжаю с весов', a.warm)
start = {k: v.clone() for k, v in net.state_dict().items()}
if a.gan and G2:
    # с чего начали — отдельным файлом: браузер смешивает веса «как было» и «с дорисовкой» ползунком (0–100 %)
    rtx2.save(OUT[:-5] + '-base.json', [(c.weight.detach().cpu().numpy(), c.bias.detach().cpu().numpy()) for c in net.c], version='base')
    print('дорисовка: учусь от этих весов, они сохранены как', OUT[:-5] + '-base.json')

# данные — целиком на видеокарте (float16): 1000 кусочков 512² — около 1 ГБ
HR, LR, VAL = [], [], []
f16 = lambda u: (u.astype(np.float32) * (1 / 65535)).astype(np.float16)   # через float32: вдвое меньше памяти, быстрее
def load_data(p):
    """npz (HR, LR, CID в float16) или папка режима обучения браузера: <ролик>_hr.npy, _lr.npy, _cid.npy (uint16),
    у новых роликов ещё _lp.npy — прошлый кадр 1080p (для сети на два кадра). Сеть на один кадр его не читает."""
    if os.path.isdir(p):
        fs = sorted(glob.glob(os.path.join(p, '**', '*_hr.npy'), recursive=True))  # и вложенные (старая папка anime)
        if not fs: sys.exit(f'В {p} пока нет данных: включи «Режим обучения» в настройках Liquid RTX и посмотри ролики с 4K.')
        hr, lr, lp, cid = [], [], [], []
        for k, f in enumerate(fs):
            b = f[:-7]
            if TWO and not os.path.exists(b + '_lp.npy'): continue   # ролик собран до 1.35 — прошлого кадра нет
            try: h, l, c = np.load(f), np.load(b + '_lr.npy'), np.load(b + '_cid.npy'); q = np.load(b + '_lp.npy') if TWO else None
            except Exception as e: print('пропуск', os.path.basename(b), e); continue
            if len(h) != len(l) or len(h) != len(c) or (q is not None and q.shape != l.shape): continue
            hr.append(f16(h)); lr.append(f16(l)); cid.append(c.astype(np.int64) + 1000 * k)
            if TWO: lp.append(f16(q))
        print(p, 'роликов', len(hr), '(с прошлым кадром)' if TWO else '')
        n = sum(len(x) for x in lr)
        if TWO and n < a.min_pairs:
            sys.exit(f'мало данных для сети на два кадра (собрано пар с прошлым кадром: {n}, роликов: {len(lr)}, нужно пар: {a.min_pairs}). '
                     'Сбор сохраняет прошлый кадр с версии 1.35 — посмотри ещё ролики с 4K')
        return np.concatenate(hr), np.concatenate(lr), (np.concatenate(lp) if TWO else None), np.concatenate(cid)
    if TWO: sys.exit('на два кадра — только папка сбора (нужны _lp.npy)')
    d = np.load(p)
    return d['HR'], d['LR'], None, (d['CID'] if 'CID' in d else np.arange(len(d['HR'])))
LP = []
for p in a.data:
    dH, dL, dP, cid = load_data(p)
    va = (cid * 2654435761 % 2 ** 32) % 23 == 0      # каждое ~23-е место — на проверку (сеть его не видит)
    if not va.any(): va[::23] = True
    tr = ~va
    HR.append(torch.from_numpy(dH[tr]).to(dev)); LR.append(torch.from_numpy(dL[tr]).to(dev))
    if TWO: LP.append(torch.from_numpy(dP[tr]).to(dev))
    # проверка — до 128 кадров, взятых равномерно по всем роликам (было 48 первых: разница в 0,1 дБ тонула в шуме)
    vi = np.flatnonzero(va); vi = vi[np.linspace(0, len(vi) - 1, min(128, len(vi))).astype(int)] if len(vi) else vi
    VAL.append((torch.from_numpy(dH[vi]).to(dev), torch.from_numpy(dL[vi]).to(dev), torch.from_numpy(dP[vi]).to(dev) if TWO else None))
    print(p, 'пар', int(tr.sum()), '+ проверка', int(va.sum()))
cnt = np.array([len(x) for x in LR], float)
P = a.patch or (64 if G2 else 48); S = P + 2 * M


AR_S = torch.arange(S, device=dev); AR_2P = torch.arange(2 * P, device=dev)


def cut(lr, hr, n, lp=None):
    # n кусков из одного набора одной операцией на видеокарте (раньше — по одному в цикле: сотни мелких команд на шаг)
    i = torch.randint(len(lr), (n,), device=dev)
    y0 = torch.randint(0, lr.shape[1] - S + 1, (n,), device=dev); x0 = torch.randint(0, lr.shape[2] - S + 1, (n,), device=dev)
    ix = (i[:, None, None], (y0[:, None] + AR_S)[:, :, None], (x0[:, None] + AR_S)[:, None, :])
    xs = lr[ix][:, None]
    if lp is not None: xs = torch.cat([xs, lp[ix][:, None]], 1)   # канал 1 — тот же кусок прошлого кадра
    ys = hr[i[:, None, None], (2 * (y0 + M)[:, None] + AR_2P)[:, :, None], (2 * (x0 + M)[:, None] + AR_2P)[:, None, :]]
    return xs, ys


def batch(B):
    ds = np.random.choice(len(LR), B, p=cnt / cnt.sum())
    parts = [cut(LR[k], HR[k], int((ds == k).sum()), LP[k] if TWO else None) for k in range(len(LR)) if (ds == k).any()]
    x = torch.cat([p[0] for p in parts]).float(); y = torch.cat([p[1] for p in parts])[:, None].float()
    k = np.random.randint(4)
    if k: x = torch.rot90(x, k, (2, 3)); y = torch.rot90(y, k, (2, 3))
    if np.random.rand() < 0.5: x = x.flip(3); y = y.flip(3)
    return x, y


@torch.no_grad()
def validate(sd=None):
    keep = None
    if sd is not None: keep = {k: v.clone() for k, v in net.state_dict().items()}; net.load_state_dict(sd)
    ps, pb = [], []
    for hr, lr, lp in VAL:
        if not len(lr): continue
        Mv = 8 if G2 else M
        Pv = lr.shape[1] - 2 * Mv
        x = lr[:, None].float() if lp is None else torch.stack([lr, lp], 1).float(); t = hr[:, None, 2 * Mv:2 * (Mv + Pv), 2 * Mv:2 * (Mv + Pv)].float()
        for j in range(0, len(x), 8):
            if G2:  # весь кадр, сверяем ту же середину, что у прежних сетей (поля 8 точек)
                o = net(x[j:j + 8])[:, :, 16:16 + 2 * (lr.shape[1] - 16), 16:16 + 2 * (lr.shape[2] - 16)].clamp(0, 1)
            else: o = net(x[j:j + 8], Pv).clamp(0, 1)
            c = x[j:j + 8, :1, Mv - 1:Mv + Pv + 1, Mv - 1:Mv + Pv + 1]
            b = Fn.interpolate(c, scale_factor=2, mode='bilinear', align_corners=False)[:, :, 2:2 * Pv + 2, 2:2 * Pv + 2]
            ps += (10 * torch.log10(1 / ((o - t[j:j + 8]) ** 2).mean((1, 2, 3)))).tolist()
            pb += (10 * torch.log10(1 / ((b - t[j:j + 8]) ** 2).mean((1, 2, 3)))).tolist()
    if keep is not None: net.load_state_dict(keep)
    return float(np.mean(ps)), float(np.mean(pb))


vgg = None
if a.percept > 0:
    import torchvision
    vgg = torchvision.models.vgg16(weights=torchvision.models.VGG16_Weights.IMAGENET1K_V1).features[:16].to(dev).eval()
    for q in vgg.parameters(): q.requires_grad_(False)
    MEAN = torch.tensor([0.485, 0.456, 0.406], device=dev).view(1, 3, 1, 1); STD = torch.tensor([0.229, 0.224, 0.225], device=dev).view(1, 3, 1, 1)
    feat = lambda z: vgg((z.repeat(1, 3, 1, 1) - MEAN) / STD)

opt = torch.optim.Adam(net.parameters(), lr=a.lr or (1e-4 if a.gan else 1e-3 if a.scratch else 2e-4), **({'fused': True} if dev.type == 'cuda' else {}))

# Сеть-судья для дорисовки: учится отличать настоящие кусочки 4K от того, что нарисовала наша сеть, а наша — её
# обманывать. Тогда сеть перестаёт рисовать «гладкое среднее» там, где не уверена, и дорисовывает правдоподобную
# текстуру (трава, кожа, ткань). Судья нужен только при обучении — в браузер не попадает
D = None
if a.gan:
    SN = nn.utils.spectral_norm
    class Disc(nn.Module):
        def __init__(self):
            super().__init__()
            ch = [1, 32, 64, 128, 128]
            self.c = nn.ModuleList([SN(nn.Conv2d(ch[i], ch[i + 1], 3 if i == 0 else 4, stride=1 if i == 0 else 2, padding=1)) for i in range(4)])
            self.out = SN(nn.Conv2d(128, 1, 3, padding=1))
        def forward(self, z):
            h, f = z * 2 - 1, []
            for c in self.c: h = Fn.leaky_relu(c(h), 0.2); f.append(h)
            return self.out(h), f
    D = Disc().to(dev)
    optD = torch.optim.Adam(D.parameters(), lr=1e-4, betas=(0.9, 0.99))
    print(f'дорисовка: вес судьи {a.gan}')
lr0 = opt.param_groups[0]['lr']; it0 = 0
# Среднее весов за последние ~1000 шагов (EMA): точнее и спокойнее, чем веса последнего шага, — их и проверяем, и сохраняем
SD = net.state_dict()
ema = {k: v.detach().clone() for k, v in SD.items()}
FK = [k for k, v in SD.items() if v.is_floating_point()]
if a.resume:
    ck = torch.load(a.resume, map_location=dev); net.load_state_dict(ck['net']); opt.load_state_dict(ck['opt']); it0 = ck['it']; start = ck['start']
    if ck.get('ema'): ema = {k: v.clone() for k, v in ck['ema'].items()}
    print('продолжаю с шага', it0)
v0 = validate(start)
print(f'проверка: простое растягивание {v0[1]:.2f} дБ, сеть в начале {v0[0]:.2f} дБ')
best = v0[0] if not a.scratch else -1
if G2:
    # планка — Pro (твоя, иначе встроенная) на тех же проверочных кадрах: браузеру отдаём, только когда RTX 2 её обогнала
    pro = next((p for p in (os.path.join(APPD, 'rtx', 'liquid-rtx-pro.json'), os.path.join(HERE, 'liquid-rtx-pro.json'), os.path.join(HERE, '..', '..', '..', 'main', 'rtx', 'liquid-rtx-pro.json')) if os.path.exists(p)), None)
    if pro and not a.no_baseline and not a.gan and not TWO:   # на два кадра планка — сама сеть на один кадр (с неё начинаем)
        F, H = 24, 5; L = H + 2; M = L + 1; dims = [1] + [F] * (L - 1) + [4]
        keepnet, G2, net = net, False, Net().to(dev)
        _, _, _, lay = rtxfmt.load(pro)
        with torch.no_grad():
            for c, (W, b) in zip(net.c, lay): c.weight.copy_(torch.from_numpy(W)); c.bias.copy_(torch.from_numpy(b))
        vp = validate()[0]
        net, G2, M = keepnet, True, 0
        best = max(best, vp)
        print(f'планка: Pro {vp:.2f} дБ — сохраню, только когда RTX 2 станет точнее')


def save_json(tag):
    keep = {k: v.clone() for k, v in net.state_dict().items()}; net.load_state_dict(ema)
    layers = [(c.weight.detach().cpu().numpy(), c.bias.detach().cpu().numpy()) for c in net.c]
    net.load_state_dict(keep)
    if G2: rtx2.save(OUT, layers, version=tag, **({'about': 'U-Net ×2 по яркости на два кадра: второй вход — прошлый кадр (tools/rtx/gpu/rtx2.py)'} if TWO else {}))
    else: rtxfmt.save(OUT, F, H, dims, layers, version=tag)


def save_pt(it):
    torch.save({'net': net.state_dict(), 'ema': ema, 'opt': opt.state_dict(), 'it': it, 'start': start}, OUT + '.pt')


EL = [ema[k] for k in FK]; PL = [SD[k] for k in FK]
def ema_step(n):
    d = min(0.999, (1 + n) / (10 + n))
    torch._foreach_lerp_(EL, PL, 1 - d)


t0 = time.time(); run = None; it = it0
TOTAL = a.hours * 3600
def frac():  # какая часть обучения пройдена: по времени (--hours) или по шагам
    return min(1.0, (time.time() - t0) / TOTAL) if TOTAL else min(1.0, it / a.steps)
try:
    while frac() < 1:
        it += 1
        for g in opt.param_groups: g['lr'] = lr0 * 0.5 * (1 + math.cos(math.pi * frac())) + 1e-6
        x, y = batch(a.batch)
        with torch.autocast(dev.type, dtype=torch.bfloat16, enabled=dev.type == 'cuda'):
            o = net(x, P)
        if G2: o, y = o[:, :, 2 * CR:-2 * CR, 2 * CR:-2 * CR], y[:, :, 2 * CR:-2 * CR, 2 * CR:-2 * CR]  # края куска — не настоящие
        loss = torch.sqrt((o - y) ** 2 + 1e-6).mean()
        if D is not None:
            o32, y32 = o.float(), y.float()
            dr, _ = D(y32); df, _ = D(o32.detach())
            ld = Fn.softplus(-dr).mean() + Fn.softplus(df).mean()
            optD.zero_grad(set_to_none=True); ld.backward(); optD.step()
            gf, ff = D(o32)
            with torch.no_grad(): _, fr = D(y32)
            fm = sum(Fn.l1_loss(p, q) for p, q in zip(ff, fr)) / len(ff)
            loss = loss + a.gan * Fn.softplus(-gf).mean() + 10 * a.gan * fm
        if vgg is not None:
            with torch.autocast(dev.type, dtype=torch.bfloat16, enabled=dev.type == 'cuda'):
                loss = loss + a.percept * Fn.l1_loss(feat(o), feat(y))
        opt.zero_grad(set_to_none=True); loss.backward(); opt.step(); ema_step(it - it0)
        # среднее потерь копим на видеокарте: .item() на каждом шаге заставлял её останавливаться и ждать Python
        run = loss.detach() if run is None else 0.99 * run + 0.01 * loss.detach()
        if it % 500 == 0:
            run = float(run)
            el = time.time() - t0
            if TOTAL: eta = max(0, TOTAL - el); tot = int(it / max(frac(), 1e-6))
            else: eta = el / (it - it0) * (a.steps - it); tot = a.steps
            msg = f'{it}/{tot} потери {run:.5f}  осталось ~{eta / 60:.0f} мин  {(it - it0) / max(el, 1e-6):.0f} шаг/с'
            if it % 2000 == 0:
                v = validate(ema)[0]
                msg += f'  проверка {v:.2f} дБ (было {v0[0]:.2f})'
                if v > best or vgg is not None or D is not None or a.always_save: best = max(best, v); save_json(f'gpu-{it}'); msg += '  ✓ сохранено'
                save_pt(it)
            print(msg, flush=True)
except KeyboardInterrupt:
    print('остановлено')
v = validate(ema)[0]
print(f'конец: проверка {v:.2f} дБ', flush=True)
if v > best or vgg is not None or D is not None or a.always_save: best = max(best, v); save_json(f'gpu-{it}')
save_pt(it)
print(f'итог: лучшая проверка {best:.2f} дБ (в начале {v0[0]:.2f}, простое растягивание {v0[1]:.2f})')
print('веса:', OUT if os.path.exists(OUT) and os.path.getmtime(OUT) >= t0 else 'не стали лучше — файл не менялся')
