"""Liquid RTX 2 — сеть ×2 по яркости, U-Net. Почти вся работа — на уменьшенных копиях кадра (1/2 и 1/4), где каждый
слой в 4 и 16 раз дешевле; в полном разрешении — только начало и конец. Так у сети ~в 6 раз больше весов, чем у Pro,
и в разы шире «поле зрения» (кубики сжатия 8–16 точек видны целиком), а считать её не тяжелее Pro.

Граф (уровень 0 — кадр как есть, 1 — вдвое меньше, 2 — вчетверо):
  x  →conv→ e0 →conv→ e0b ═════════════════════════════════════╗ (пропуск)
              e0b →conv/2→ d1 →conv→ e1 ═══════════════════╗     ║
                         e1 →conv/2→ d2 →conv×3→ m3        ║     ║
                                     m3 →up→ (+e1) → u1 →conv→ f1 →up→ (+e0b) → u0 →conv→ f0 →conv→ res (4 подпикселя)
conv — 3×3 с повтором краёв, conv/2 — то же с шагом 2, up — 3×3 на низком уровне с 4×каналов и перестановкой
2×2 (pixel shuffle) на уровень выше, плюс пропуск, ReLU. Итог, как у прежних сетей: 4 подпикселя 2×2 к билинейной
основе. Этот файл — без torch: формат весов (JSON «g2») и эталонный расчёт на numpy для проверок."""
import json
import numpy as np

C0, C1, C2 = 8, 32, 48   # каналы на уровнях 0, 1, 2


def graph(c0=C0, c1=C1, c2=C2):
    """Слои по порядку: (op, вход, выход, cin, cout, шаг, relu, пропуск)."""
    return [
        ('conv', 'x', 'e0', 1, c0, 1, 1, None),
        ('conv', 'e0', 'e0b', c0, c0, 1, 1, None),
        ('conv', 'e0b', 'd1', c0, c1, 2, 1, None),
        ('conv', 'd1', 'e1', c1, c1, 1, 1, None),
        ('conv', 'e1', 'd2', c1, c2, 2, 1, None),
        ('conv', 'd2', 'm1', c2, c2, 1, 1, None),
        ('conv', 'm1', 'm2', c2, c2, 1, 1, None),
        ('conv', 'm2', 'm3', c2, c2, 1, 1, None),
        ('up', 'm3', 'u1', c2, c1, 1, 1, 'e1'),
        ('conv', 'u1', 'f1', c1, c1, 1, 1, None),
        ('up', 'f1', 'u0', c1, c0, 1, 1, 'e0b'),
        ('conv', 'u0', 'f0', c0, c0, 1, 1, None),
        ('conv', 'f0', 'res', c0, 4, 1, 0, None),
    ]


def conv_np(x, W, b, stride):
    """x: C,H,W; W: cout,cin,3,3 (взаимная корреляция, как Conv2d); края повторяются; шаг 2 — центр в точке 2p."""
    C, H, Wd = x.shape
    xp = np.pad(x, ((0, 0), (1, 1), (1, 1)), mode='edge')
    Ho, Wo = (H + 1) // 2 if stride == 2 else H, (Wd + 1) // 2 if stride == 2 else Wd
    out = np.zeros((W.shape[0], Ho, Wo), np.float64)
    for ky in range(3):
        for kx in range(3):
            sl = xp[:, ky:ky + H, kx:kx + Wd][:, ::stride, ::stride][:, :Ho, :Wo]
            out += np.einsum('oc,chw->ohw', W[:, :, ky, kx], sl)
    return out + b[:, None, None]


def shuffle_np(y, H, Wd):
    """y: 4C,h,w → C,H,W: канал c*4 + dy*2 + dx → точка (2i+dy, 2j+dx), как torch.pixel_shuffle; лишнее обрезаем."""
    C = y.shape[0] // 4
    h, w = y.shape[1:]
    o = np.zeros((C, 2 * h, 2 * w), y.dtype)
    for dy in (0, 1):
        for dx in (0, 1):
            o[:, dy::2, dx::2] = y[dy * 2 + dx::4]
    return o[:, :H, :Wd]


def forward_np(net, luma):
    """Эталон: luma H×W (0..1) → добавка 4 подпикселя (4,H,W) — то, что сеть кладёт в текстуру res."""
    t = {'x': luma[None].astype(np.float64)}
    for L in net['layers']:
        op, i, o, s, relu, skip = L['op'], L['in'], L['out'], L['s'], L['relu'], L.get('skip')
        cin, cout = L['cin'], L['cout']
        W = np.asarray(L['w'], np.float64).reshape(cin, 3, 3, -1).transpose(3, 0, 1, 2)
        b = np.asarray(L['b'], np.float64)
        y = conv_np(t[i], W, b, s)
        if op == 'up':
            H, Wd = t[skip].shape[1:]
            y = shuffle_np(y, H, Wd) + t[skip]
        t[o] = np.maximum(y, 0) if relu else y
    return t['res']


def save(path, layers_np, version='1', about=None):
    """layers_np: [(W cout,cin,3,3 ; b)] по порядку graph(); у up — cout = 4×каналов (порядок как у pixel_shuffle)."""
    r = lambda x: float(f'{x:.6g}')
    g = graph()
    out = {'name': 'Liquid RTX 2', 'arch': 'g2', 'version': str(version),
           'about': about or 'U-Net ×2 по яркости: основная работа на 1/2 и 1/4 кадра (tools/rtx/gpu/rtx2.py)',
           'c': [C0, C1, C2], 'layers': []}
    for (op, i, o, cin, cout, s, relu, skip), (W, b) in zip(g, layers_np):
        W = np.asarray(W, np.float32)
        co = W.shape[0]
        out['layers'].append({'op': op, 'in': i, 'out': o, 'cin': cin, 'cout': cout, 's': s, 'relu': relu, **({'skip': skip} if skip else {}),
                              'w': [[r(v) for v in row] for row in W.transpose(1, 2, 3, 0).reshape(cin * 9, co)], 'b': [r(v) for v in np.asarray(b).ravel()]})
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))


def load(path):
    j = json.load(open(path, encoding='utf-8'))
    if j.get('arch') != 'g2': raise ValueError('не Liquid RTX 2')
    return j, [(np.asarray(L['w'], np.float32).reshape(L['cin'], 3, 3, -1).transpose(3, 0, 1, 2).copy(), np.asarray(L['b'], np.float32)) for L in j['layers']]


def random_net(seed=0, scale=0.25):
    """Случайные веса правильной формы — для проверок шейдеров."""
    rng = np.random.default_rng(seed)
    out = []
    for op, i, o, cin, cout, s, relu, skip in graph():
        co = cout * 4 if op == 'up' else cout
        out.append((rng.normal(0, scale / np.sqrt(9 * cin), (co, cin, 3, 3)).astype(np.float32), rng.normal(0, 0.02, co).astype(np.float32)))
    return out


def cost(H=1080, W=1920):
    """Сколько умножений на кадр (для оценки скорости) и сколько весов."""
    g = graph(); lv = {'x': 0}; mul = 0; par = 0
    for op, i, o, cin, cout, s, relu, skip in g:
        l = lv[i] + (1 if s == 2 else 0)
        if op == 'up': lv[o] = l - 1; co = cout * 4
        else: lv[o] = l; co = cout
        px = (H >> l) * (W >> l)
        mul += px * 9 * cin * co; par += 9 * cin * co + co
    return mul, par
