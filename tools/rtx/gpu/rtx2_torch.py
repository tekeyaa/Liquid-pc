"""Liquid RTX 2 на PyTorch — та же сеть, что в rtx2.py (эталон на numpy) и в шейдерах браузера."""
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as Fn
import rtx2


class Net2(nn.Module):
    """U-Net (см. rtx2.py). Свёртки с повтором краёв — как texelFetch с clamp в шейдере.
    frames = 2 — сеть на два кадра: вход B,2,H,W (канал 0 — текущий кадр, 1 — прошлый)."""
    def __init__(self, frames=1):
        super().__init__()
        self.frames = frames
        self.g = rtx2.graph(frames=frames)
        self.c = nn.ModuleList([nn.Conv2d(cin, cout * 4 if op == 'up' else cout, 3, stride=s) for op, i, o, cin, cout, s, relu, skip in self.g])

    def res(self, x):  # x: B,frames,H,W → добавка 4 подпикселя B,4,H,W (то, что шейдер пишет в текстуру res)
        if self.frames == 2 and x.shape[1] == 1: x = torch.cat([x, x], 1)   # прошлого нет — прошлым считается текущий
        t = {'x': x}
        for (op, i, o, cin, cout, s, relu, skip), conv in zip(self.g, self.c):
            y = conv(Fn.pad(t[i], (1, 1, 1, 1), mode='replicate'))
            if op == 'up': y = Fn.pixel_shuffle(y, 2)[:, :, :t[skip].shape[2], :t[skip].shape[3]] + t[skip]
            t[o] = Fn.relu(y) if relu else y
        return t['res']

    def forward(self, x, P=None):  # → B,1,2H,2W: подпиксели к билинейной основе (из текущего кадра), как у прежних сетей
        base = Fn.interpolate(x[:, :1].float(), scale_factor=2, mode='bilinear', align_corners=False)
        return Fn.pixel_shuffle(self.res(x).float(), 2) + base

    def load_json(self, path):
        """Веса из JSON. Сеть на два кадра можно загрузить и из весов на один (вход прошлого кадра = 0)."""
        _, layers = rtx2.load(path)
        if self.frames == 2: layers = rtx2.two_frames(layers)
        elif np.asarray(layers[0][0]).shape[1] != 1: raise ValueError(f'{path}: сеть на два кадра, а нужна на один')
        with torch.no_grad():
            for c, (W, b) in zip(self.c, layers): c.weight.copy_(torch.from_numpy(W)); c.bias.copy_(torch.from_numpy(b))

    def layers_np(self):
        return [(c.weight.detach().cpu().numpy(), c.bias.detach().cpu().numpy()) for c in self.c]
