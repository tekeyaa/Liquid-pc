"""Liquid RTX 2 на PyTorch — та же сеть, что в rtx2.py (эталон на numpy) и в шейдерах браузера."""
import torch
import torch.nn as nn
import torch.nn.functional as Fn
import rtx2


class Net2(nn.Module):
    """U-Net (см. rtx2.py). Свёртки с повтором краёв — как texelFetch с clamp в шейдере."""
    def __init__(self):
        super().__init__()
        self.g = rtx2.graph()
        self.c = nn.ModuleList([nn.Conv2d(cin, cout * 4 if op == 'up' else cout, 3, stride=s) for op, i, o, cin, cout, s, relu, skip in self.g])

    def res(self, x):  # x: B,1,H,W → добавка 4 подпикселя B,4,H,W (то, что шейдер пишет в текстуру res)
        t = {'x': x}
        for (op, i, o, cin, cout, s, relu, skip), conv in zip(self.g, self.c):
            y = conv(Fn.pad(t[i], (1, 1, 1, 1), mode='replicate'))
            if op == 'up': y = Fn.pixel_shuffle(y, 2)[:, :, :t[skip].shape[2], :t[skip].shape[3]] + t[skip]
            t[o] = Fn.relu(y) if relu else y
        return t['res']

    def forward(self, x, P=None):  # → B,1,2H,2W: подпиксели к билинейной основе, как у прежних сетей
        base = Fn.interpolate(x.float(), scale_factor=2, mode='bilinear', align_corners=False)
        return Fn.pixel_shuffle(self.res(x).float(), 2) + base

    def load_json(self, path):
        _, layers = rtx2.load(path)
        with torch.no_grad():
            for c, (W, b) in zip(self.c, layers): c.weight.copy_(torch.from_numpy(W)); c.bias.copy_(torch.from_numpy(b))

    def layers_np(self):
        return [(c.weight.detach().cpu().numpy(), c.bias.detach().cpu().numpy()) for c in self.c]
