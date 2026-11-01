"""Обучение Liquid RTX: маленькая свёрточная сеть ×2 по яркости (как FSRCNNX/ArtCNN), чистит сжатие и увеличивает.
numpy, без фреймворков. python3 train.py F H STEPS out.json [resume.json]
F — каналов, H — скрытых слоёв 3×3. Вход: кадр (яркость) уменьшенный и сжатый; выход: 4 подпикселя 2×2 к билинейной основе."""
import numpy as np, sys, json, time, os
D = os.path.dirname(os.path.abspath(__file__))
F, H, STEPS, OUT = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
rng = np.random.default_rng(1)
HR, LR, META = np.load(f"{D}/{os.environ.get('DATA', 'pairs.npy')}", allow_pickle=True) if not os.environ.get('FAKE') else ([rng.random((200, 200)) for _ in range(3)], [rng.random((100, 100)) for _ in range(3)], [0, 0, 0])
HR = list(HR); LR = list(LR)  # float16 в памяти, в float32 — только вырезанные куски
L = H + 2                       # всего свёрток
P = 40                          # выход: P×P точек кадра LR → 2P×2P HR
M = L + 1                       # поля: L свёрток + 1 точка для билинейной основы
dims = [1] + [F] * (L - 1) + [4]
W = []
for i in range(L):
    cin, cout = dims[i], dims[i + 1]
    w = rng.normal(0, np.sqrt(2.0 / (9 * cin)), (9 * cin, cout)).astype(np.float32)
    if i == L - 1: w *= 0.1
    W.append([w, np.zeros(cout, np.float32)])
if len(sys.argv) > 5:
    j = json.load(open(sys.argv[5])); W = [[np.array(l['w'], np.float32), np.array(l['b'], np.float32)] for l in j['layers']]
mA = [[np.zeros_like(w), np.zeros_like(b)] for w, b in W]; vA = [[np.zeros_like(w), np.zeros_like(b)] for w, b in W]
sw = np.lib.stride_tricks.sliding_window_view
def im2col(x):  # x: B,h,w,C → B*(h-2)*(w-2), C*9 (порядок: C, ky, kx)
    B, h, w, C = x.shape
    c = sw(x, (3, 3), axis=(1, 2))              # B,h-2,w-2,C,3,3
    return np.ascontiguousarray(c).reshape(B * (h - 2) * (w - 2), C * 9), (B, h - 2, w - 2)
def batch(B):
    xs, ys = [], []
    S = P + 2 * M
    while len(xs) < B:
        i = rng.integers(len(LR)); lr, hr = LR[i], HR[i]
        if lr.shape[0] < S + 2 or lr.shape[1] < S + 2: continue
        y0 = rng.integers(0, lr.shape[0] - S); x0 = rng.integers(0, lr.shape[1] - S)
        a = lr[y0:y0 + S, x0:x0 + S].astype(np.float32)
        t = hr[2 * (y0 + M):2 * (y0 + M + P), 2 * (x0 + M):2 * (x0 + M + P)].astype(np.float32)
        k = rng.integers(4); a = np.rot90(a, k); t = np.rot90(t, k)
        if rng.random() < 0.5: a = a[:, ::-1]; t = t[:, ::-1]
        xs.append(a); ys.append(t)
    return np.stack(xs)[..., None].astype(np.float32), np.stack(ys).astype(np.float32)
def base(x):  # билинейное ×2 центра (как texture() с LINEAR в шейдере): веса 0.75/0.25
    c = x[:, M - 1:M + P + 1, M - 1:M + P + 1, 0]
    up = np.empty((x.shape[0], 2 * P, 2 * P), x.dtype)
    for dy in (0, 1):
        for dx in (0, 1):
            oy, ox = (0, 1) if dy == 0 else (1, 2), (0, 1) if dx == 0 else (1, 2)
            wy = (0.25, 0.75) if dy == 0 else (0.75, 0.25); wx = (0.25, 0.75) if dx == 0 else (0.75, 0.25)
            v = 0
            for a, fy in zip(oy, wy):
                for b, fx in zip(ox, wx): v = v + fy * fx * c[:, a:a + P, b:b + P]
            up[:, dy::2, dx::2] = v
    return up
def forward(x, keep):
    ins = []; h = x
    for i, (w, b) in enumerate(W):
        cols, shp = im2col(h)
        if keep: ins.append((cols, shp, h))
        z = (cols @ w + b).reshape(*shp, -1)
        h = np.maximum(z, 0) if i < L - 1 else z
    r = h[:, 1:P + 1, 1:P + 1, :]   # центр P×P (поле в 1 точку под билинейную основу)
    out = np.empty((x.shape[0], 2 * P, 2 * P), x.dtype)
    for dy in (0, 1):
        for dx in (0, 1): out[:, dy::2, dx::2] = r[..., dy * 2 + dx]
    return out + base(x), ins, h
T = 0
def step(x, y, lr_):
    global T
    T += 1
    pred, ins, hlast = forward(x, True)
    d = pred - y; eps = 1e-3
    q = np.sqrt(d * d + eps * eps)
    loss = float(np.mean(q))
    g = (d / q / d.size).astype(np.float32)
    gz = np.zeros_like(hlast)
    for dy in (0, 1):
        for dx in (0, 1): gz[:, 1:P + 1, 1:P + 1, dy * 2 + dx] = g[:, dy::2, dx::2]
    for i in range(L - 1, -1, -1):
        cols, shp, hin = ins[i]
        gzf = gz.reshape(-1, gz.shape[-1])
        gw = cols.T @ gzf; gb = gzf.sum(0)
        if i > 0:
            gc = (gzf @ W[i][0].T).reshape(*shp, hin.shape[-1], 3, 3)
            gx = np.zeros(hin.shape, np.float32)
            for ky in range(3):
                for kx in range(3): gx[:, ky:ky + shp[1], kx:kx + shp[2], :] += gc[..., ky, kx]
            gz = gx * (hin > 0)       # вход слоя i — выход ReLU слоя i-1
        for k, gg in enumerate((gw, gb)):
            mA[i][k] = 0.9 * mA[i][k] + 0.1 * gg; vA[i][k] = 0.999 * vA[i][k] + 0.001 * gg * gg
            W[i][k] -= lr_ * (mA[i][k] / (1 - 0.9 ** T)) / (np.sqrt(vA[i][k] / (1 - 0.999 ** T)) + 1e-8)
    return loss
def save(path, extra):
    json.dump({'F': F, 'H': H, 'dims': dims, 'layers': [{'w': w.tolist(), 'b': b.tolist()} for w, b in W], **extra}, open(path, 'w'))
# проверка на отложенных кадрах: средняя ошибка и PSNR против билинейного
VAL = [i for i in range(len(LR)) if i % 23 == 0]
def val():
    ps, pb = [], []
    for i in VAL[:12]:
        lr, hr = LR[i], HR[i]
        hh, ww = min(lr.shape[0], 200), min(lr.shape[1], 200)
        x = lr[:hh, :ww][None, ..., None].astype(np.float32)
        global P
        P0 = P; P = min(hh, ww) - 2 * M
        out = forward(x, False)[0][0]; b = base(x)[0]
        t = hr[2 * M:2 * (M + P), 2 * M:2 * (M + P)].astype(np.float32)
        ps.append(10 * np.log10(1 / np.mean((np.clip(out, 0, 1) - t) ** 2))); pb.append(10 * np.log10(1 / np.mean((b - t) ** 2)))
        P = P0
    return float(np.mean(ps)), float(np.mean(pb))
if __name__ == '__main__':
    B = int(os.environ.get('B', 16)); lr0 = float(os.environ.get('LR', 2e-3))
    t0 = time.time(); run = 0
    for it in range(1, STEPS + 1):
        lr_ = lr0 * 0.5 * (1 + np.cos(np.pi * min(1, it / STEPS))) + 1e-5
        x, y = batch(B); run = 0.98 * run + 0.02 * step(x, y, lr_) if it > 1 else step(x, y, lr_)
        if it % 200 == 0 or it == 20:
            v = val() if it % 1000 == 0 else ('', '')
            print(f'{it} loss {run:.5f} {time.time() - t0:.0f}с val {v}', flush=True)
        if it % 1000 == 0: save(OUT, {'step': it})
    save(OUT, {'step': STEPS, 'val': val()})
