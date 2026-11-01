import os, sys, numpy as np
os.environ['FAKE'] = '1'; sys.argv = ['x', '4', '1', '1', '/dev/null']
import importlib.util
spec = importlib.util.spec_from_file_location('tr', os.path.dirname(os.path.abspath(__file__)) + '/train.py'); tr = importlib.util.module_from_spec(spec); spec.loader.exec_module(tr)
tr.P = 4
x, y = tr.batch(2)
x = x.astype(np.float64); y = y.astype(np.float64)
tr.W = [[w.astype(np.float64), b.astype(np.float64) + 0.05] for w, b in tr.W]
def lossf():
    p = tr.forward(x, False)[0]; d = p - y; return np.mean(np.sqrt(d * d + 1e-6))
# аналитический градиент: шаг с lr→ поймаем через разницу весов при Adam нельзя — считаем вручную копией step без обновления
import copy
W0 = copy.deepcopy(tr.W)
pred, ins, hlast = tr.forward(x, True)
d = pred - y; q = np.sqrt(d * d + 1e-6); g = d / q / d.size
gz = np.zeros_like(hlast)
for dy in (0, 1):
    for dx in (0, 1): gz[:, 1:tr.P + 1, 1:tr.P + 1, dy * 2 + dx] = g[:, dy::2, dx::2]
grads = {}
for i in range(tr.L - 1, -1, -1):
    cols, shp, hin = ins[i]; gzf = gz.reshape(-1, gz.shape[-1]); grads[i] = cols.T @ gzf
    if i > 0:
        gc = (gzf @ tr.W[i][0].T).reshape(*shp, hin.shape[-1], 3, 3); gx = np.zeros(hin.shape)
        for ky in range(3):
            for kx in range(3): gx[:, ky:ky + shp[1], kx:kx + shp[2], :] += gc[..., ky, kx]
        gz = gx * (hin > 0)
for i in range(tr.L):
    for (a, b) in [(0, 0), (5, 1), (tr.W[i][0].shape[0] - 1, tr.W[i][0].shape[1] - 1)]:
        e = 1e-5; tr.W[i][0][a, b] += e; l1 = lossf(); tr.W[i][0][a, b] -= 2 * e; l2 = lossf(); tr.W[i][0][a, b] += e
        print(i, a, b, 'числ', (l1 - l2) / (2 * e), 'аналит', grads[i][a, b])
