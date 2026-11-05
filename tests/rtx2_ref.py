"""Эталон для проверки шейдеров Liquid RTX 2 (tests/rtx2-gl.js): случайная сеть, два кадра нечётного размера и
что сеть должна дать (rtx2.forward_np). python rtx2_ref.py выход.json [ширина высота кадров(1|2) seed]"""
import json, os, sys
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools', 'rtx', 'gpu'))
import rtx2

out = sys.argv[1]
W, H = (int(sys.argv[2]), int(sys.argv[3])) if len(sys.argv) > 3 else (61, 45)
frames = int(sys.argv[4]) if len(sys.argv) > 4 else 1
seed = int(sys.argv[5]) if len(sys.argv) > 5 else 1
rng = np.random.default_rng(seed)
tmp = out + '.net.json'
layers = rtx2.random_net(seed, frames=frames)
rtx2.save(tmp, layers, version='test', frames=frames)
net = json.load(open(tmp, encoding='utf-8')); os.remove(tmp)
# кадры — серые (яркость = значение / 255 точно), с деталями и плавными местами; прошлый — сдвинутый текущий с шумом
yy, xx = np.mgrid[0:H, 0:W]
cur = np.clip(128 + 70 * np.sin(xx * 0.37) * np.cos(yy * 0.23) + rng.normal(0, 25, (H, W)), 0, 255).astype(np.uint8)
prev = np.clip(np.roll(cur.astype(np.int32), 1, axis=1) + rng.normal(0, 6, (H, W)), 0, 255).astype(np.uint8)
res = rtx2.forward_np(net, cur / 255.0, prev / 255.0 if frames == 2 else None)
json.dump({'net': net, 'w': W, 'h': H, 'cur': cur.ravel().tolist(), 'prev': prev.ravel().tolist(),
           'res': res.astype(np.float32).ravel().tolist()}, open(out, 'w', encoding='utf-8'))
