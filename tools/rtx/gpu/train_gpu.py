r"""Обучение Liquid RTX на видеокарте (PyTorch + CUDA). Та же сеть, что в браузере, — веса встают в Liquid как есть.
python train_gpu.py --net pro [--data папка_или.npz ...]

Данные по умолчанию — то, что собрал режим обучения браузера (%APPDATA%\Liquid\rtx-learn\data).
Результат — сразу в %APPDATA%\Liquid\rtx\, откуда его берёт Liquid (перезапусти браузер).
По умолчанию ДООБУЧАЕТ нынешнюю сеть (свою из %APPDATA%\Liquid\rtx, иначе встроенную) — так она не забудет
старое и быстро подстроится под YouTube. --scratch — учить с нуля. Ctrl+C — остановить и сохранить.
Сохраняется лучший вариант по проверочным кадрам (их сеть не видит), рядом — .pt для продолжения (--resume)."""
import argparse, glob, math, os, sys, time
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as Fn
import rtxfmt

HERE = os.path.dirname(os.path.abspath(__file__))
NETS = {'pro': (24, 5, 'liquid-rtx-pro.json'), 'lite': (16, 4, 'liquid-rtx.json'), 'anime': (16, 4, 'liquid-rtx-anime.json')}
ap = argparse.ArgumentParser()
ap.add_argument('--net', choices=NETS, default='pro')
APPD = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'Liquid')
ap.add_argument('--data', nargs='+', default=[os.path.join(APPD, 'rtx-learn', 'data')])
ap.add_argument('--out', default=None)
ap.add_argument('--steps', type=int, default=100000)
ap.add_argument('--batch', type=int, default=64)
ap.add_argument('--patch', type=int, default=48, help='кусок кадра (LR) на один пример')
ap.add_argument('--lr', type=float, default=None, help='шаг обучения (по умолчанию 2e-4 дообучение, 1e-3 с нуля)')
ap.add_argument('--scratch', action='store_true')
ap.add_argument('--init', default=None, help='с каких весов начать (json)')
ap.add_argument('--resume', default=None, help='продолжить с .pt')
ap.add_argument('--percept', type=float, default=0.0, help='вес «на глаз» (VGG), напр. 0.02: детальнее, но PSNR ниже — смотреть глазами')
a = ap.parse_args()
F, H, fname = NETS[a.net]
os.makedirs(os.path.join(APPD, 'rtx'), exist_ok=True)
OUT = a.out or os.path.join(APPD, 'rtx', fname)
if not torch.cuda.is_available(): sys.exit('PyTorch не видит видеокарту (CUDA). Поставь torch с сайта pytorch.org для CUDA — см. README.')
dev = torch.device('cuda')
torch.backends.cudnn.benchmark = True
L = H + 2; M = L + 1; dims = [1] + [F] * (L - 1) + [4]


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


net = Net().to(dev)
init = a.init or next((p for p in (os.path.join(APPD, 'rtx', fname), os.path.join(HERE, fname), os.path.join(HERE, '..', '..', '..', 'main', 'rtx', fname)) if os.path.exists(p)), None)
if not a.scratch and not a.resume:
    if not init: sys.exit(f'Нет {fname} для дообучения — положи его рядом или учи с нуля: --scratch')
    F0, H0, d0, layers = rtxfmt.load(init)
    if (F0, H0) != (F, H): sys.exit(f'{init}: сеть {F0}×{H0}, а нужна {F}×{H}')
    with torch.no_grad():
        for c, (W, b) in zip(net.c, layers): c.weight.copy_(torch.from_numpy(W)); c.bias.copy_(torch.from_numpy(b))
    print('дообучаю', init)
elif a.scratch:
    with torch.no_grad(): net.c[-1].weight.mul_(0.1); net.c[-1].bias.zero_()
start = {k: v.clone() for k, v in net.state_dict().items()}

# данные — целиком на видеокарте (float16): 1000 кусочков 512² — около 1 ГБ
HR, LR, VAL = [], [], []
def load_data(p):
    """npz (HR, LR, CID в float16) или папка режима обучения браузера: <ролик>_hr.npy, _lr.npy, _cid.npy (uint16)."""
    if os.path.isdir(p):
        fs = sorted(glob.glob(os.path.join(p, '*_hr.npy')))
        if not fs: sys.exit(f'В {p} пока нет данных: включи «Режим обучения» в настройках Liquid RTX и посмотри ролики с 4K.')
        hr, lr, cid = [], [], []
        for k, f in enumerate(fs):
            b = f[:-7]
            try: h, l, c = np.load(f), np.load(b + '_lr.npy'), np.load(b + '_cid.npy')
            except Exception as e: print('пропуск', os.path.basename(b), e); continue
            if len(h) != len(l) or len(h) != len(c): continue
            hr.append((h / 65535).astype(np.float16)); lr.append((l / 65535).astype(np.float16)); cid.append(c.astype(np.int64) + 1000 * k)
        print(p, 'роликов', len(hr))
        return np.concatenate(hr), np.concatenate(lr), np.concatenate(cid)
    d = np.load(p)
    return d['HR'], d['LR'], (d['CID'] if 'CID' in d else np.arange(len(d['HR'])))
for p in a.data:
    dH, dL, cid = load_data(p)
    va = (cid * 2654435761 % 2 ** 32) % 23 == 0      # каждое ~23-е место — на проверку (сеть его не видит)
    if not va.any(): va[::23] = True
    tr = ~va
    HR.append(torch.from_numpy(dH[tr]).to(dev)); LR.append(torch.from_numpy(dL[tr]).to(dev))
    VAL.append((torch.from_numpy(dH[va][:48]).to(dev), torch.from_numpy(dL[va][:48]).to(dev)))
    print(p, 'пар', int(tr.sum()), '+ проверка', int(va.sum()))
cnt = np.array([len(x) for x in LR], float)
P = a.patch; S = P + 2 * M


def batch(B):
    ds = np.random.choice(len(LR), B, p=cnt / cnt.sum())
    xs, ys = [], []
    for k in ds:
        lr, hr = LR[k], HR[k]
        i = np.random.randint(len(lr)); y0 = np.random.randint(0, lr.shape[1] - S + 1); x0 = np.random.randint(0, lr.shape[2] - S + 1)
        xs.append(lr[i, y0:y0 + S, x0:x0 + S]); ys.append(hr[i, 2 * (y0 + M):2 * (y0 + M + P), 2 * (x0 + M):2 * (x0 + M + P)])
    x = torch.stack(xs)[:, None].float(); y = torch.stack(ys)[:, None].float()
    k = np.random.randint(4)
    if k: x = torch.rot90(x, k, (2, 3)); y = torch.rot90(y, k, (2, 3))
    if np.random.rand() < 0.5: x = x.flip(3); y = y.flip(3)
    return x, y


@torch.no_grad()
def validate(sd=None):
    keep = None
    if sd is not None: keep = {k: v.clone() for k, v in net.state_dict().items()}; net.load_state_dict(sd)
    ps, pb = [], []
    for hr, lr in VAL:
        if not len(lr): continue
        Pv = lr.shape[1] - 2 * M
        x = lr[:, None].float(); t = hr[:, None, 2 * M:2 * (M + Pv), 2 * M:2 * (M + Pv)].float()
        for j in range(0, len(x), 8):
            o = net(x[j:j + 8], Pv).clamp(0, 1)
            c = x[j:j + 8, :, M - 1:M + Pv + 1, M - 1:M + Pv + 1]
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

opt = torch.optim.Adam(net.parameters(), lr=a.lr or (1e-3 if a.scratch else 2e-4))
lr0 = opt.param_groups[0]['lr']; it0 = 0
if a.resume:
    ck = torch.load(a.resume, map_location=dev); net.load_state_dict(ck['net']); opt.load_state_dict(ck['opt']); it0 = ck['it']; start = ck['start']
    print('продолжаю с шага', it0)
v0 = validate(start)
print(f'проверка: простое растягивание {v0[1]:.2f} дБ, сеть в начале {v0[0]:.2f} дБ')
best = v0[0] if not a.scratch else -1


def save_json(tag):
    layers = [(c.weight.detach().cpu().numpy(), c.bias.detach().cpu().numpy()) for c in net.c]
    rtxfmt.save(OUT, F, H, dims, layers, version=tag)


def save_pt(it):
    torch.save({'net': net.state_dict(), 'opt': opt.state_dict(), 'it': it, 'start': start}, OUT + '.pt')


t0 = time.time(); run = None; it = it0
try:
    for it in range(it0 + 1, a.steps + 1):
        for g in opt.param_groups: g['lr'] = lr0 * 0.5 * (1 + math.cos(math.pi * it / a.steps)) + 1e-6
        x, y = batch(a.batch)
        with torch.autocast('cuda', dtype=torch.bfloat16):
            o = net(x, P)
        loss = torch.sqrt((o - y) ** 2 + 1e-6).mean()
        if vgg is not None:
            with torch.autocast('cuda', dtype=torch.bfloat16):
                loss = loss + a.percept * Fn.l1_loss(feat(o), feat(y))
        opt.zero_grad(set_to_none=True); loss.backward(); opt.step()
        run = loss.item() if run is None else 0.99 * run + 0.01 * loss.item()
        if it % 500 == 0:
            eta = (time.time() - t0) / (it - it0) * (a.steps - it)
            msg = f'{it}/{a.steps} потери {run:.5f}  осталось ~{eta / 60:.0f} мин'
            if it % 2000 == 0:
                v = validate()[0]
                msg += f'  проверка {v:.2f} дБ (было {v0[0]:.2f})'
                if v > best or vgg is not None: best = max(best, v); save_json(f'gpu-{it}'); msg += '  ✓ сохранено'
                save_pt(it)
            print(msg, flush=True)
except KeyboardInterrupt:
    print('остановлено')
v = validate()[0]
if v > best or vgg is not None: best = v; save_json(f'gpu-{it}')
save_pt(it)
print(f'итог: лучшая проверка {best:.2f} дБ (в начале {v0[0]:.2f}, простое растягивание {v0[1]:.2f})')
print('веса:', OUT if best > v0[0] or a.scratch or vgg is not None else 'не стали лучше — файл не менялся')
