"""Формат весов Liquid RTX (main/rtx/*.json) <-> раскладка PyTorch. Без torch — только numpy.
В JSON у слоя w[9*cin][cout], строка = c*9 + ky*3 + kx (так шейдер netShaders берёт веса), b[cout].
В PyTorch Conv2d.weight[cout][cin][ky][kx] — та же взаимная корреляция, так что достаточно переставить оси."""
import json
import numpy as np

ABOUT = 'Свёрточная сеть ×2 по яркости, обучена на кадрах, уменьшенных вдвое и сжатых H.264/VP9/AV1 (tools/rtx).'


def w_to_torch(w, cin, cout):
    return np.asarray(w, np.float32).reshape(cin, 3, 3, cout).transpose(3, 0, 1, 2).copy()


def w_from_torch(W):
    W = np.asarray(W, np.float32)
    cout, cin = W.shape[:2]
    return W.transpose(1, 2, 3, 0).reshape(cin * 9, cout)


def load(path):
    j = json.load(open(path, encoding='utf-8'))
    dims = j['dims']
    layers = [(w_to_torch(l['w'], dims[i], dims[i + 1]), np.asarray(l['b'], np.float32)) for i, l in enumerate(j['layers'])]
    return j['F'], j['H'], dims, layers


def save(path, F, H, dims, layers, version='1', about=ABOUT):
    r = lambda x: float(f'{x:.6g}')
    out = {'name': 'Liquid RTX', 'version': str(version), 'F': F, 'H': H, 'dims': dims, 'about': about,
           'layers': [{'w': [[r(x) for x in row] for row in w_from_torch(W)], 'b': [r(x) for x in np.asarray(b).ravel()]} for W, b in layers]}
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))


def grow(layers, F2, H2, seed=0):
    """Вырастить сеть до F2 каналов и H2 скрытых слоёв, НЕ меняя её ответа (Net2Net).
    Новые каналы получают маленькие случайные входные веса, но их выходные веса — нули: на результат не влияют,
    пока обучение их не задействует. Новые слои — тождественные свёртки (центр 1): после ReLU вход неотрицательный,
    так что ReLU(x) = x и слой ничего не меняет. Итог — ровно та же картинка, а обучение может только улучшить."""
    rng = np.random.default_rng(seed)
    L = len(layers)
    out = []
    for i, (W, b) in enumerate(layers):
        cout, cin = W.shape[:2]
        last = i == L - 1
        co2, ci2 = (cout if last else F2), (cin if i == 0 else F2)
        if co2 < cout or ci2 < cin: raise ValueError('сеть можно только растить')
        W2 = np.zeros((co2, ci2, 3, 3), np.float32); W2[:cout, :cin] = W
        if co2 > cout: W2[cout:, :ci2] = rng.normal(0, 1e-3, (co2 - cout, ci2, 3, 3))
        b2 = np.zeros(co2, np.float32); b2[:cout] = b
        out.append((W2, b2))
    H = L - 2
    if H2 < H: raise ValueError('сеть можно только растить')
    ident = np.zeros((F2, F2, 3, 3), np.float32)
    for c in range(F2): ident[c, c, 1, 1] = 1
    for _ in range(H2 - H): out.insert(len(out) - 1, (ident.copy(), np.zeros(F2, np.float32)))
    dims = [1] + [F2] * (H2 + 1) + [4]
    return F2, H2, dims, out
