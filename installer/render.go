package main

import (
	"bytes"
	"image"
	"image/png"
	"math"
)

// Программный рендер интерфейса установщика в BGRA-буфер (сглаженные скругления, градиенты, стекло)

type canvas struct {
	w, h int
	px   []byte
}

func newCanvas(w, h int) *canvas { return &canvas{w, h, make([]byte, w*h*4)} }

func clamp01(v float64) float64 { return math.Max(0, math.Min(1, v)) }

func (c *canvas) blend(x, y int, r, g, b, a float64) {
	if x < 0 || y < 0 || x >= c.w || y >= c.h || a <= 0 {
		return
	}
	i := (y*c.w + x) * 4
	if a > 1 {
		a = 1
	}
	c.px[i] = byte(float64(c.px[i])*(1-a) + b*a)
	c.px[i+1] = byte(float64(c.px[i+1])*(1-a) + g*a)
	c.px[i+2] = byte(float64(c.px[i+2])*(1-a) + r*a)
	c.px[i+3] = 255
}

func sdRound(px, py, x0, y0, x1, y1, r float64) float64 {
	cx, cy := (x0+x1)/2, (y0+y1)/2
	hx, hy := (x1-x0)/2-r, (y1-y0)/2-r
	qx, qy := math.Abs(px-cx)-hx, math.Abs(py-cy)-hy
	return math.Hypot(math.Max(qx, 0), math.Max(qy, 0)) + math.Min(math.Max(qx, qy), 0) - r
}

type fillFn func(x, y float64) (r, g, b, a float64)

func solid(r, g, b, a float64) fillFn {
	return func(float64, float64) (float64, float64, float64, float64) { return r, g, b, a }
}

func (c *canvas) roundRect(x0, y0, x1, y1, rad float64, f fillFn) {
	for y := int(y0) - 1; y <= int(y1)+1; y++ {
		for x := int(x0) - 1; x <= int(x1)+1; x++ {
			fx, fy := float64(x)+.5, float64(y)+.5
			cov := clamp01(.5 - sdRound(fx, fy, x0, y0, x1, y1, rad))
			if cov <= 0 {
				continue
			}
			r, g, b, a := f(fx, fy)
			c.blend(x, y, r, g, b, a*cov)
		}
	}
}

func (c *canvas) roundStroke(x0, y0, x1, y1, rad, width float64, f fillFn) {
	for y := int(y0) - 1; y <= int(y1)+1; y++ {
		for x := int(x0) - 1; x <= int(x1)+1; x++ {
			fx, fy := float64(x)+.5, float64(y)+.5
			d := sdRound(fx, fy, x0, y0, x1, y1, rad)
			cov := clamp01(.5-d) - clamp01(.5-(d+width))
			if cov <= 0 {
				continue
			}
			r, g, b, a := f(fx, fy)
			c.blend(x, y, r, g, b, a*cov)
		}
	}
}

func (c *canvas) line(ax, ay, bx, by, width float64, r, g, b, a float64) {
	minX, maxX := math.Min(ax, bx)-width-1, math.Max(ax, bx)+width+1
	minY, maxY := math.Min(ay, by)-width-1, math.Max(ay, by)+width+1
	for y := int(minY); y <= int(maxY); y++ {
		for x := int(minX); x <= int(maxX); x++ {
			px, py := float64(x)+.5, float64(y)+.5
			pax, pay, bax, bay := px-ax, py-ay, bx-ax, by-ay
			h := clamp01((pax*bax + pay*bay) / (bax*bax + bay*bay))
			d := math.Hypot(pax-bax*h, pay-bay*h) - width/2
			c.blend(x, y, r, g, b, a*clamp01(.5-d))
		}
	}
}

// Фон: тёмная база + мягкие цветные пятна, как в самом браузере
func paintBackground(c *canvas) {
	type blob struct{ x, y, r, cr, cg, cb, s float64 }
	W, H := float64(c.w), float64(c.h)
	blobs := []blob{
		{0.02 * W, -0.15 * H, 0.75 * W, 91, 61, 245, .62},
		{1.02 * W, 0.18 * H, 0.62 * W, 217, 119, 87, .55},
		{0.45 * W, 1.25 * H, 0.7 * W, 14, 165, 233, .35},
		{0.9 * W, 1.12 * H, 0.42 * W, 236, 72, 153, .3},
	}
	for y := 0; y < c.h; y++ {
		for x := 0; x < c.w; x++ {
			r, g, b := 9.0, 9.0, 16.0
			for _, bl := range blobs {
				d := math.Hypot(float64(x)-bl.x, float64(y)-bl.y) / bl.r
				if d < 1 {
					k := (1 - d) * (1 - d) * bl.s
					r += bl.cr * k
					g += bl.cg * k
					b += bl.cb * k
				}
			}
			// лёгкий шум против полос градиента
			n := float64((x*7919+y*104729)%7) - 3
			i := (y*c.w + x) * 4
			c.px[i] = byte(math.Min(255, math.Max(0, b+n*.6)))
			c.px[i+1] = byte(math.Min(255, math.Max(0, g+n*.6)))
			c.px[i+2] = byte(math.Min(255, math.Max(0, r+n*.6)))
			c.px[i+3] = 255
		}
	}
}

func decodeIcon(data []byte, size int) *image.NRGBA {
	src, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil
	}
	b := src.Bounds()
	dst := image.NewNRGBA(image.Rect(0, 0, size, size))
	// усреднение по области — аккуратное уменьшение
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			sx0 := b.Min.X + x*b.Dx()/size
			sx1 := b.Min.X + (x+1)*b.Dx()/size
			sy0 := b.Min.Y + y*b.Dy()/size
			sy1 := b.Min.Y + (y+1)*b.Dy()/size
			var r, g, bb, a, n float64
			for yy := sy0; yy < sy1; yy++ {
				for xx := sx0; xx < sx1; xx++ {
					cr, cg, cb, ca := src.At(xx, yy).RGBA()
					r += float64(cr)
					g += float64(cg)
					bb += float64(cb)
					a += float64(ca)
					n++
				}
			}
			if n == 0 || a == 0 {
				continue
			}
			i := y*dst.Stride + x*4
			dst.Pix[i] = byte(r / a * 255)
			dst.Pix[i+1] = byte(g / a * 255)
			dst.Pix[i+2] = byte(bb / a * 255)
			dst.Pix[i+3] = byte(a / n / 257)
		}
	}
	return dst
}

func (c *canvas) drawImage(img *image.NRGBA, ox, oy int) {
	if img == nil {
		return
	}
	for y := 0; y < img.Rect.Dy(); y++ {
		for x := 0; x < img.Rect.Dx(); x++ {
			i := y*img.Stride + x*4
			a := float64(img.Pix[i+3]) / 255
			c.blend(ox+x, oy+y, float64(img.Pix[i]), float64(img.Pix[i+1]), float64(img.Pix[i+2]), a)
		}
	}
}
