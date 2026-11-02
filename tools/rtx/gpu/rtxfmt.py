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
