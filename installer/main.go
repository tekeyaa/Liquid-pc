//go:build windows

package main

import (
	_ "embed"
	"image"
	"math"
	"os"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

//go:embed payload.zip
var payload []byte

//go:embed icon.png
var iconPNG []byte

//go:embed icon.ico
var iconICO []byte

func init() { runtime.LockOSThread() }

// ---------- состояние интерфейса ----------
const (
	phaseWelcome = iota
	phaseWork
	phaseDone
	phaseError
)

type uiState struct {
	sync.Mutex
	phase    int
	status   string
	detail   string
	pFrom    float64 // прогресс шага: от
	pTo      float64 // до
	pTau     float64 // скорость «доползания», сек
	pStart   time.Time
	shown    float64
	errText  string
	hoverBtn int // 0 нет, 1 основная, 2 вторичная, 3 закрыть
	pressed  int
}

var (
	st       = &uiState{}
	hwndMain uintptr
	scale    = 1.0
	W, H     int // физические пиксели
	bgCache  *canvas
	iconImg  *image.NRGBA
	fonts    = map[string]uintptr{}
	mode     = "install" // install | update
)

const LW, LH = 580, 400 // логический размер окна

func s(v float64) float64 { return v * scale }
func si(v float64) int    { return int(math.Round(v * scale)) }

func setStep(status string, from, to, tau float64) {
	st.Lock()
	st.status, st.detail = status, ""
	if from < st.shown {
		from = st.shown
	}
	st.pFrom, st.pTo, st.pTau, st.pStart = from, to, tau, time.Now()
	st.Unlock()
	refresh()
}

func setDetail(d string) {
	st.Lock()
	st.detail = d
	st.Unlock()
	refresh()
}

func refresh() {
	if hwndMain != 0 {
		pPostMessageW.Call(hwndMain, wmApp, 0, 0)
	}
}

func progressNow() float64 {
	t := time.Since(st.pStart).Seconds()
	k := 1 - math.Exp(-t/math.Max(st.pTau, .1))
	return st.pFrom + (st.pTo-st.pFrom)*k*0.97
}

// ---------- кнопки ----------
type box struct{ x0, y0, x1, y1 float64 }

func (b box) has(x, y float64) bool { return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 }

func mainBtn() box { return box{LW - 32 - 190, LH - 32 - 46, LW - 32, LH - 32} }
func secBtn() box  { return box{LW - 32 - 190 - 12 - 150, LH - 32 - 46, LW - 32 - 190 - 12, LH - 32} }
func closeBtn() box {
	return box{LW - 50, 12, LW - 14, 44}
}

func mainLabel() string {
	switch st.phase {
	case phaseWelcome:
		return "Установить"
	case phaseWork:
		return "Устанавливаю…"
	case phaseDone:
		return "Запустить Liquid"
	default:
		return "Повторить"
	}
}

// ---------- отрисовка ----------
func render(hdc uintptr) {
	st.Lock()
	defer st.Unlock()

	if bgCache == nil || bgCache.w != W || bgCache.h != H {
		bgCache = newCanvas(W, H)
		paintBackground(bgCache)
		iconImg = decodeIcon(iconPNG, si(64))
	}
	c := newCanvas(W, H)
	copy(c.px, bgCache.px)

	// логотип
	c.drawImage(iconImg, si(36), si(40))

	// стеклянная карточка
	cx0, cy0, cx1, cy1 := s(32), s(130), s(LW-32), s(LH-98)
	c.roundRect(cx0, cy0, cx1, cy1, s(20), func(x, y float64) (float64, float64, float64, float64) {
		t := (y - cy0) / (cy1 - cy0)
		return 255, 255, 255, .075 + .06*(1-t)
	})
	c.roundStroke(cx0, cy0, cx1, cy1, s(20), s(1), func(x, y float64) (float64, float64, float64, float64) {
		t := (y - cy0) / (cy1 - cy0)
		return 255, 255, 255, .26 - .14*t
	})

	// прогресс
	if st.phase == phaseWork || st.phase == phaseDone || st.phase == phaseError {
		p := st.shown
		if st.phase == phaseDone {
			p = 1
		}
		px0, py0, px1, py1 := cx0+s(22), cy1-s(34), cx1-s(22), cy1-s(26)
		c.roundRect(px0, py0, px1, py1, s(4), solid(255, 255, 255, .1))
		fx := px0 + (px1-px0)*p
		if fx > px0+s(8) {
			red := st.phase == phaseError
			phase := float64(time.Now().UnixMilli()%1600) / 1600
			c.roundRect(px0, py0, fx, py1, s(4), func(x, y float64) (float64, float64, float64, float64) {
				t := (x - px0) / (px1 - px0)
				r, g, b := 217+25*t, 119+41*t, 87+36*t
				if red {
					r, g, b = 230, 80, 80
				}
				if st.phase == phaseWork {
					// бегущий блик
					hx := px0 + (fx-px0+s(120))*phase - s(60)
					k := math.Exp(-math.Pow((x-hx)/s(40), 2)) * .55
					r, g, b = r+(255-r)*k, g+(255-g)*k, b+(255-b)*k
				}
				return r, g, b, 1
			})
		}
	}

	// кнопки
	drawBtn := func(b box, primary, hover, pressed, disabled bool) {
		x0, y0, x1, y1 := s(b.x0), s(b.y0), s(b.x1), s(b.y1)
		if pressed {
			x0, y0, x1, y1 = x0+s(2), y0+s(1.5), x1-s(2), y1-s(1.5)
		}
		if primary {
			for i := 3; i >= 1; i-- { // мягкое свечение
				e := s(float64(i) * 3)
				c.roundRect(x0-e, y0-e+s(6), x1+e, y1+e+s(6), s(16)+e, solid(217, 119, 87, .05))
			}
			c.roundRect(x0, y0, x1, y1, s(15), func(x, y float64) (float64, float64, float64, float64) {
				t := (y - y0) / (y1 - y0)
				r, g, bb := 238-34*t, 142-42*t, 108-44*t
				if hover {
					r, g, bb = r+10, g+10, bb+10
				}
				a := 1.0
				if disabled {
					a = .55
				}
				return r, g, bb, a
			})
			c.roundStroke(x0, y0, x1, y1, s(15), s(1), func(x, y float64) (float64, float64, float64, float64) {
				return 255, 255, 255, .35 * (1 - (y-y0)/(y1-y0))
			})
		} else {
			a := .08
			if hover {
				a = .14
			}
			c.roundRect(x0, y0, x1, y1, s(15), solid(255, 255, 255, a))
			c.roundStroke(x0, y0, x1, y1, s(15), s(1), solid(255, 255, 255, .16))
		}
	}
	drawBtn(mainBtn(), true, st.hoverBtn == 1, st.pressed == 1, st.phase == phaseWork)
	if st.phase == phaseError {
		drawBtn(secBtn(), false, st.hoverBtn == 2, st.pressed == 2, false)
	}

	// крестик
	cb := closeBtn()
	if st.hoverBtn == 3 {
		c.roundRect(s(cb.x0), s(cb.y0), s(cb.x1), s(cb.y1), s(10), solid(229, 72, 77, .9))
	}
	m := s(12.5)
	c.line(s(cb.x0)+m, s(cb.y0)+m, s(cb.x1)-m, s(cb.y1)-m, s(1.6), 255, 255, 255, .85)
	c.line(s(cb.x1)-m, s(cb.y0)+m, s(cb.x0)+m, s(cb.y1)-m, s(1.6), 255, 255, 255, .85)

	// ---- выводим буфер в память и пишем текст поверх ----
	mdc, _, _ := pCreateCompatibleDC.Call(hdc)
	bmp, _, _ := pCreateCompatibleBitmap.Call(hdc, uintptr(W), uintptr(H))
	old, _, _ := pSelectObject.Call(mdc, bmp)
	bi := bitmapInfoHeader{size: 40, width: int32(W), height: -int32(H), planes: 1, bitCount: 32}
	pSetDIBitsToDevice.Call(mdc, 0, 0, uintptr(W), uintptr(H), 0, 0, 0, uintptr(H), uintptr(unsafe.Pointer(&c.px[0])), uintptr(unsafe.Pointer(&bi)), 0)
	pSetBkMode.Call(mdc, 1)

	text := func(font string, col uintptr, str string, x0, y0, x1, y1 float64, flags uintptr) {
		pSelectObject.Call(mdc, fonts[font])
		pSetTextColor.Call(mdc, col)
		drawText(mdc, str, si(x0), si(y0), si(x1), si(y1), flags)
	}
	white := rgb(245, 245, 250)
	muted := rgb(168, 166, 184)

	text("title", white, "Liquid", 116, 38, LW-60, 82, dtSingleLine|dtVCenter)
	text("sub", muted, "Браузер с VPN и Claude", 117, 80, LW-60, 104, dtSingleLine|dtVCenter)

	tx0, tx1 := 32.0+24, float64(LW-32-24)
	switch st.phase {
	case phaseWelcome:
		text("h", white, "Установка займёт 2–5 минут", tx0, 150, tx1, 176, dtSingleLine|dtVCenter)
		text("body", muted, "•  Скачаю движок Electron (~120 МБ)\n•  Скачаю xray-core для VPN\n•  Соберу браузер и создам ярлыки на рабочем столе и в Пуске\n•  Если нет Node.js — поставлю его тоже", tx0, 184, tx1, LH-110, dtWordBreak)
	case phaseWork:
		text("h", white, st.status, tx0, 150, tx1, 178, dtSingleLine|dtVCenter|dtEndEllipsis)
		text("small", muted, st.detail, tx0, 182, tx1, LH-140, dtWordBreak|dtEndEllipsis)
		text("small", muted, itoa(int(st.shown*100))+"%", tx1-60, LH-98-58, tx1, LH-98-38, dtSingleLine|dtRight)
	case phaseDone:
		text("h", white, "Готово!", tx0, 150, tx1, 178, dtSingleLine|dtVCenter)
		text("body", muted, "Liquid установлен. Ярлыки — на рабочем столе и в меню Пуск.\nОбновления браузер будет предлагать сам.", tx0, 184, tx1, LH-140, dtWordBreak)
	case phaseError:
		text("h", rgb(255, 170, 170), "Не получилось", tx0, 150, tx1, 178, dtSingleLine|dtVCenter)
		text("small", muted, st.errText, tx0, 182, tx1, LH-140, dtWordBreak|dtEndEllipsis)
	}

	mb := mainBtn()
	text("btn", rgb(255, 255, 255), mainLabel(), mb.x0, mb.y0, mb.x1, mb.y1, dtSingleLine|dtVCenter|dtCenter)
	if st.phase == phaseError {
		sb := secBtn()
		text("btn", white, "Открыть лог", sb.x0, sb.y0, sb.x1, sb.y1, dtSingleLine|dtVCenter|dtCenter)
	}
	foot := "Папка: %LOCALAPPDATA%\\Liquid"
	if st.phase == phaseError {
		foot = ""
	}
	text("small", rgb(120, 118, 138), foot, 34, LH-32-46, LW-32-190-16, LH-32, dtSingleLine|dtVCenter|dtEndEllipsis)

	pBitBlt.Call(hdc, 0, 0, uintptr(W), uintptr(H), mdc, 0, 0, 0x00CC0020)
	pSelectObject.Call(mdc, old)
	pDeleteObject.Call(bmp)
	pDeleteDC.Call(mdc)
}

func itoa(n int) string {
	if n <= 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// ---------- обработка событий ----------
func hitButton(x, y float64) int {
	if closeBtn().has(x, y) {
		return 3
	}
	if mainBtn().has(x, y) {
		return 1
	}
	if st.phase == phaseError && secBtn().has(x, y) {
		return 2
	}
	return 0
}

var tracking bool

func wndProc(hwnd, msg, wp, lp uintptr) uintptr {
	switch msg {
	case wmEraseBkgnd:
		return 1
	case wmPaint:
		var ps paintStruct
		hdc, _, _ := pBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
		render(hdc)
		pEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
		return 0
	case wmApp:
		pInvalidateRect.Call(hwnd, 0, 0)
		return 0
	case wmTimer:
		st.Lock()
		animating := st.phase == phaseWork
		if animating {
			target := progressNow()
			st.shown += (target - st.shown) * .12
		}
		st.Unlock()
		if animating {
			pInvalidateRect.Call(hwnd, 0, 0)
		}
		return 0
	case wmNcHitTest:
		var r rect
		pGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
		x := float64(int16(lp&0xffff)-int16(r.left)) / scale
		y := float64(int16((lp>>16)&0xffff)-int16(r.top)) / scale
		if hitButton(x, y) == 0 && y < 120 {
			return htCaption
		}
		return htClient
	case wmMouseMove:
		x, y := float64(int16(lp&0xffff))/scale, float64(int16((lp>>16)&0xffff))/scale
		h := hitButton(x, y)
		if !tracking {
			tme := trackMouseEventT{cbSize: uint32(unsafe.Sizeof(trackMouseEventT{})), dwFlags: 2, hwndTrack: hwnd}
			pTrackMouseEvent.Call(uintptr(unsafe.Pointer(&tme)))
			tracking = true
		}
		st.Lock()
		changed := st.hoverBtn != h
		st.hoverBtn = h
		st.Unlock()
		if changed {
			pInvalidateRect.Call(hwnd, 0, 0)
		}
		return 0
	case wmMouseLeave:
		tracking = false
		st.Lock()
		st.hoverBtn, st.pressed = 0, 0
		st.Unlock()
		pInvalidateRect.Call(hwnd, 0, 0)
		return 0
	case wmSetCursor:
		st.Lock()
		h := st.hoverBtn
		busy := st.phase == phaseWork
		st.Unlock()
		id := uintptr(32512) // стрелка
		if h != 0 && !(h == 1 && busy) {
			id = 32649 // рука
		}
		cur, _, _ := pLoadCursorW.Call(0, id)
		pSetCursor.Call(cur)
		return 1
	case wmLButtonDown:
		x, y := float64(int16(lp&0xffff))/scale, float64(int16((lp>>16)&0xffff))/scale
		st.Lock()
		st.pressed = hitButton(x, y)
		st.Unlock()
		pInvalidateRect.Call(hwnd, 0, 0)
		return 0
	case wmLButtonUp:
		x, y := float64(int16(lp&0xffff))/scale, float64(int16((lp>>16)&0xffff))/scale
		st.Lock()
		p := st.pressed
		st.pressed = 0
		phase := st.phase
		st.Unlock()
		pInvalidateRect.Call(hwnd, 0, 0)
		if p == 0 || p != hitButton(x, y) {
			return 0
		}
		switch p {
		case 3:
			pPostMessageW.Call(hwnd, wmClose, 0, 0)
		case 2:
			shellOpen(logPath(), "")
		case 1:
			switch phase {
			case phaseWelcome, phaseError:
				startInstall()
			case phaseDone:
				launchApp()
				pDestroyWindow.Call(hwnd)
			}
		}
		return 0
	case wmClose:
		st.Lock()
		busy := st.phase == phaseWork
		st.Unlock()
		if busy && messageBox(hwnd, "Установка ещё идёт. Прервать?", "Liquid", 0x4|0x30) != 6 {
			return 0
		}
		killChildren()
		pDestroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		pPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(hwnd, msg, wp, lp)
	return r
}

func startInstall() {
	st.Lock()
	st.phase = phaseWork
	st.shown = 0
	st.Unlock()
	go func() {
		err := runInstall()
		st.Lock()
		if err != nil {
			st.phase = phaseError
			st.errText = err.Error()
		} else {
			st.phase = phaseDone
			st.shown = 1
		}
		st.Unlock()
		refresh()
		if err == nil && mode == "update" {
			time.Sleep(1200 * time.Millisecond)
			launchApp()
			pPostMessageW.Call(hwndMain, wmClose, 0, 0)
		}
	}()
}

func main() {
	for _, a := range os.Args[1:] {
		switch strings.TrimLeft(a, "-/") {
		case "update":
			mode = "update"
		case "uninstall":
			uninstall()
			return
		}
	}

	pSetProcessDpiAwarenessContext.Call(^uintptr(3)) // PER_MONITOR_AWARE_V2
	if dpi, _, _ := pGetDpiForSystem.Call(); dpi >= 96 {
		scale = float64(dpi) / 96
	}
	W, H = si(LW), si(LH)

	fonts["title"] = createFont(si(30), 600)
	fonts["sub"] = createFont(si(14), 400)
	fonts["h"] = createFont(si(17), 600)
	fonts["body"] = createFont(si(14), 400)
	fonts["small"] = createFont(si(13), 400)
	fonts["btn"] = createFont(si(15), 600)

	hInst, _, _ := pGetModuleHandleW.Call(0)
	var hIcon uintptr
	icoPath := os.TempDir() + "\\liquid-setup.ico"
	if os.WriteFile(icoPath, iconICO, 0644) == nil {
		hIcon, _, _ = pLoadImageW.Call(0, up(u16(icoPath)), 1, 0, 0, 0x10|0x40)
	}
	cursor, _, _ := pLoadCursorW.Call(0, 32512)
	cls := u16("LiquidSetup")
	wc := wndClassExW{
		style:         0x20000 | 0x2 | 0x1, // тень + перерисовка
		lpfnWndProc:   syscall.NewCallback(wndProc),
		hInstance:     hInst,
		hIcon:         hIcon,
		hIconSm:       hIcon,
		hCursor:       cursor,
		lpszClassName: cls,
	}
	wc.cbSize = uint32(unsafe.Sizeof(wc))
	pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	sw, _, _ := pGetSystemMetrics.Call(0)
	sh, _, _ := pGetSystemMetrics.Call(1)
	x, y := (int(sw)-W)/2, (int(sh)-H)/2
	title := "Установка Liquid"
	if mode == "update" {
		title = "Обновление Liquid"
	}
	hwndMain, _, _ = pCreateWindowExW.Call(0x40000, up(cls), up(u16(title)),
		0x80000000|0x00020000|0x00080000, // POPUP | MINIMIZEBOX | SYSMENU
		uintptr(x), uintptr(y), uintptr(W), uintptr(H), 0, 0, hInst, 0)

	corner := int32(2)
	pDwmSetWindowAttribute.Call(hwndMain, 33, uintptr(unsafe.Pointer(&corner)), 4)
	dark := int32(1)
	pDwmSetWindowAttribute.Call(hwndMain, 20, uintptr(unsafe.Pointer(&dark)), 4)

	pShowWindow.Call(hwndMain, 1)
	pUpdateWindow.Call(hwndMain)
	pSetTimer.Call(hwndMain, 1, 16, 0)

	if mode == "update" {
		startInstall()
	}

	var m msgT
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
}
