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
основе. Этот файл — без torch: формат весов (JSON «g2») и эталонный расчёт на numpy для проверок.

Сеть на два кадра (frames = 2): у первого слоя второй вход — яркость ПРОШЛОГО кадра (того же размера, без сдвига по
движению: сеть разбирается сама). В JSON: "frames": 2 и у первого слоя cin = 2, "prev": 1 (канал 1 — прошлый кадр),
строки весов 9..17 — для прошлого кадра. Старые веса (cin = 1, без "frames") — сеть на один кадр, как раньше.
Сеть на два кадра стартует с весов сети на один кадр: веса нового входа = 0, и считает она ровно то же самое."""
import json
import numpy as np

C0, C1, C2 = 8, 32, 48   # каналы на уровнях 0, 1, 2


def graph(c0=C0, c1=C1, c2=C2, frames=1):
    """Слои по порядку: (op, вход, выход, cin, cout, шаг, relu, пропуск). frames = 2 — у первого слоя вход ещё и
    прошлый кадр."""
    return [
        ('conv', 'x', 'e0', frames, c0, 1, 1, None),
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


def frames_of(net):
    """Сколько кадров нужно сети: 2 — у первого слоя второй вход (прошлый кадр), иначе 1."""
    return 2 if net['layers'][0]['cin'] == 2 else 1


def forward_np(net, luma, prev=None):
    """Эталон: luma H×W (0..1) → добавка 4 подпикселя (4,H,W) — то, что сеть кладёт в текстуру res.
    prev — яркость прошлого кадра (для сети на два кадра; нет — прошлым считается текущий, как в браузере)."""
    x = luma[None].astype(np.float64)
    if frames_of(net) == 2: x = np.concatenate([x, (luma if prev is None else prev)[None].astype(np.float64)])
    t = {'x': x}
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


def save(path, layers_np, version='1', about=None, frames=None):
    """layers_np: [(W cout,cin,3,3 ; b)] по порядку graph(); у up — cout = 4×каналов (порядок как у pixel_shuffle).
    frames — по форме первого слоя (2 входа — сеть на два кадра), если не задано."""
    r = lambda x: float(f'{x:.6g}')
    frames = frames or int(np.asarray(layers_np[0][0]).shape[1])
    g = graph(frames=frames)
    out = {'name': 'Liquid RTX 2', 'arch': 'g2', 'version': str(version),
           'about': about or 'U-Net ×2 по яркости: основная работа на 1/2 и 1/4 кадра (tools/rtx/gpu/rtx2.py)',
           'c': [C0, C1, C2], **({'frames': 2} if frames == 2 else {}), 'layers': []}
    for li, ((op, i, o, cin, cout, s, relu, skip), (W, b)) in enumerate(zip(g, layers_np)):
        W = np.asarray(W, np.float32)
        co = W.shape[0]
        out['layers'].append({'op': op, 'in': i, 'out': o, 'cin': cin, 'cout': cout, 's': s, 'relu': relu, **({'skip': skip} if skip else {}),
                              **({'prev': 1} if li == 0 and frames == 2 else {}),
                              'w': [[r(v) for v in row] for row in W.transpose(1, 2, 3, 0).reshape(cin * 9, co)], 'b': [r(v) for v in np.asarray(b).ravel()]})
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))


def load(path):
    j = json.load(open(path, encoding='utf-8'))
    if j.get('arch') != 'g2': raise ValueError('не Liquid RTX 2')
    return j, [(np.asarray(L['w'], np.float32).reshape(L['cin'], 3, 3, -1).transpose(3, 0, 1, 2).copy(), np.asarray(L['b'], np.float32)) for L in j['layers']]


def two_frames(layers_np):
    """Сеть на один кадр → на два: у первого слоя добавляется вход «прошлый кадр» с нулевыми весами (считает то же)."""
    W, b = layers_np[0]
    W = np.asarray(W, np.float32)
    if W.shape[1] == 2: return layers_np
    return [(np.concatenate([W, np.zeros_like(W)], axis=1), b)] + list(layers_np[1:])


def random_net(seed=0, scale=0.25, frames=1):
    """Случайные веса правильной формы — для проверок шейдеров (у сети на два кадра веса прошлого кадра не нулевые)."""
    rng = np.random.default_rng(seed)
    out = []
    for op, i, o, cin, cout, s, relu, skip in graph(frames=frames):
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
