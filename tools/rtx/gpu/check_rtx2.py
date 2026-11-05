"""Проверка цепочки: сеть на PyTorch (как учится) == эталон на numpy по сохранённому файлу (как считает браузер).
python check_rtx2.py веса.json — печатает «расхождение …» и выходит с ошибкой, если больше 1e-4.
Подходят оба вида весов: на один кадр и на два (тогда на входе ещё и прошлый кадр)."""
import sys, os
import numpy as np
import torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rtx2
from rtx2_torch import Net2
j = rtx2.load(sys.argv[1])[0]
fr = rtx2.frames_of(j)
net = Net2(frames=fr); net.load_json(sys.argv[1]); net.eval()
rng = np.random.default_rng(3)
worst = 0
for H, W in ((40, 56), (37, 51)):   # кратный 4 и нечётный размер — у браузера кадры любые
    x = rng.random((H, W)).astype(np.float32); xp = rng.random((H, W)).astype(np.float32)
    inp = np.stack([x, xp]) if fr == 2 else x[None]
    with torch.no_grad(): a = net.res(torch.from_numpy(inp)[None]).numpy()[0]
    b = rtx2.forward_np(j, x, xp if fr == 2 else None)
    worst = max(worst, float(np.abs(a - b).max()))
print(f'расхождение PyTorch и эталона ({"два кадра" if fr == 2 else "один кадр"}): {worst:.2e}')
sys.exit(0 if worst < 1e-4 else 1)
