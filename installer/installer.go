//go:build windows

package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

func baseDir() string { return filepath.Join(os.Getenv("LOCALAPPDATA"), "Liquid") }
func srcDir() string  { return filepath.Join(baseDir(), "src") }
func appDir() string  { return filepath.Join(baseDir(), "app") }
func logPath() string { return filepath.Join(baseDir(), "install.log") }
func appExe() string  { return filepath.Join(appDir(), "Liquid.exe") }

// ---------- тихое фоновое обновление (--silent): без окна, Liquid подменяется, когда его закроют ----------
var silent bool
var engineOnly bool      // --engine: только обновить движок Electron (код Liquid тот же)
var engineVersion string // --electron=45.1.2: поставить ровно эту версию движка (браузер сам выбирает её)

func enginePinPath() string { return filepath.Join(baseDir(), "engine.txt") }

// installElectron ставит движок: точную версию от браузера; иначе — запомненную ветку, если она новее той,
// что в package.json (браузер уже переходил на поддерживаемую ветку); иначе последний выпуск ветки из package.json
func installElectron(env []string) error {
	if engineVersion != "" {
		if err := run(srcDir(), env, "cmd", "/c", "npm", "install", "electron@"+engineVersion, "--no-save", "--no-fund", "--no-audit"); err != nil {
			return fmt.Errorf("не удалось поставить Electron %s: %v", engineVersion, err)
		}
		if got := installedElectron(); got != engineVersion {
			return fmt.Errorf("npm поставил Electron %s вместо %s", got, engineVersion)
		}
		os.WriteFile(enginePinPath(), []byte(strings.SplitN(engineVersion, ".", 2)[0]), 0644)
		return nil
	}
	pin, _ := os.ReadFile(enginePinPath())
	pinMajor, _ := strconv.Atoi(strings.TrimSpace(string(pin)))
	pkgMajor, _ := strconv.Atoi(strings.SplitN(strings.TrimLeft(packageElectron(), "^~"), ".", 2)[0])
	if pinMajor > pkgMajor {
		return run(srcDir(), env, "cmd", "/c", "npm", "install", fmt.Sprintf("electron@^%d.0.0", pinMajor), "--no-save", "--no-fund", "--no-audit")
	}
	if pinMajor != 0 {
		os.Remove(enginePinPath()) // новая версия Liquid сама на новой ветке — память о переходе больше не нужна
	}
	// последний выпуск закреплённой ветки (например, 45.x) — с исправлениями безопасности Chromium
	if err := run(srcDir(), env, "cmd", "/c", "npm", "update", "electron", "--no-fund", "--no-audit"); err != nil {
		logf("npm update electron: %v", err)
	}
	return nil
}

func installedElectron() string {
	var p struct{ Version string }
	b, _ := os.ReadFile(filepath.Join(srcDir(), "node_modules", "electron", "package.json"))
	json.Unmarshal(b, &p)
	return p.Version
}

func packageElectron() string {
	var p struct {
		DevDependencies map[string]string `json:"devDependencies"`
	}
	b, _ := os.ReadFile(filepath.Join(srcDir(), "package.json"))
	json.Unmarshal(b, &p)
	return p.DevDependencies["electron"]
}

func statusPath() string   { return filepath.Join(baseDir(), "update-status.json") }
func relaunchFlag() string { return filepath.Join(baseDir(), "relaunch.flag") }
func lockPath() string     { return filepath.Join(baseDir(), "update.lock") }

// writeStatus — состояние обновления для браузера: working, ready (собрано, ждём закрытия), done, error
func writeStatus(state, version, msg string) {
	b, _ := json.Marshal(map[string]any{"state": state, "version": version, "error": msg, "at": time.Now().Unix(), "engine": engineOnly})
	os.WriteFile(statusPath(), b, 0644)
}

func payloadVersion() string {
	var p struct {
		Version string `json:"version"`
	}
	if b, err := os.ReadFile(filepath.Join(srcDir(), "package.json")); err == nil {
		json.Unmarshal(b, &p)
	}
	return p.Version
}

func liquidRunning() bool {
	out, err := hidden(exec.Command("tasklist", "/FI", "IMAGENAME eq Liquid.exe", "/NH")).Output()
	return err == nil && bytes.Contains(bytes.ToLower(out), []byte("liquid.exe"))
}

// takeLock — одно фоновое обновление за раз (зависший замок старше 3 часов не считается)
func takeLock() bool {
	os.MkdirAll(baseDir(), 0755)
	if fi, err := os.Stat(lockPath()); err == nil && time.Since(fi.ModTime()) < 10*time.Minute {
		return false
	}
	return os.WriteFile(lockPath(), []byte(fmt.Sprint(os.Getpid())), 0644) == nil
}

func runSilent() {
	if !takeLock() {
		return
	}
	defer os.Remove(lockPath())
	// пока установщик жив (в том числе ждёт закрытия браузера), замок свежий — второй установщик не запустится
	go func() {
		for {
			time.Sleep(time.Minute)
			now := time.Now()
			os.Chtimes(lockPath(), now, now)
		}
	}()
	if err := runInstall(); err != nil {
		writeStatus("error", payloadVersion(), err.Error())
		return
	}
	writeStatus("done", payloadVersion(), "")
	if _, err := os.Stat(relaunchFlag()); err == nil {
		os.Remove(relaunchFlag())
		launchApp()
	}
}

var (
	logMu    sync.Mutex
	logFile  *os.File
	childMu  sync.Mutex
	children []*exec.Cmd
)

func logf(format string, a ...any) {
	logMu.Lock()
	defer logMu.Unlock()
	if logFile != nil {
		fmt.Fprintf(logFile, "[%s] "+format+"\n", append([]any{time.Now().Format("15:04:05")}, a...)...)
	}
}

func killChildren() {
	childMu.Lock()
	defer childMu.Unlock()
	for _, c := range children {
		if c.Process != nil {
			exec.Command("taskkill", "/T", "/F", "/PID", fmt.Sprint(c.Process.Pid)).Run()
		}
	}
}

func hidden(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	return cmd
}

// Запускает команду скрыто, пишет вывод в лог, последнюю строку — в интерфейс
func run(dir string, env []string, name string, args ...string) error {
	cmd := hidden(exec.Command(name, args...))
	cmd.Dir = dir
	cmd.Env = env
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	var tail []string
	var tailMu sync.Mutex
	done := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		sc.Split(func(data []byte, atEOF bool) (int, []byte, error) {
			for i, b := range data {
				if b == '\n' || b == '\r' {
					return i + 1, data[:i], nil
				}
			}
			if atEOF && len(data) > 0 {
				return len(data), data, nil
			}
			return 0, nil, nil
		})
		for sc.Scan() {
			line := strings.TrimSpace(stripAnsi(sc.Text()))
			if line == "" {
				continue
			}
			logf("  %s", line)
			tailMu.Lock()
			tail = append(tail, line)
			if len(tail) > 6 {
				tail = tail[1:]
			}
			tailMu.Unlock()
			if len([]rune(line)) > 140 {
				line = string([]rune(line)[:140]) + "…"
			}
			setDetail(line)
		}
		close(done)
	}()
	logf("> %s %s", name, strings.Join(args, " "))
	if err := cmd.Start(); err != nil {
		pw.Close()
		return err
	}
	childMu.Lock()
	children = append(children, cmd)
	childMu.Unlock()
	err := cmd.Wait()
	pw.Close()
	<-done
	if err != nil {
		tailMu.Lock()
		defer tailMu.Unlock()
		return fmt.Errorf("%v\n%s", err, strings.Join(tail, "\n"))
	}
	return nil
}

func stripAnsi(s string) string {
	var b strings.Builder
	esc := false
	for _, r := range s {
		if r == 0x1b {
			esc = true
			continue
		}
		if esc {
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
				esc = false
			}
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func findNode() string {
	if p, err := exec.LookPath("node.exe"); err == nil {
		return filepath.Dir(p)
	}
	for _, d := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs")} {
		if d == "" {
			continue
		}
		p := filepath.Join(d, "nodejs", "node.exe")
		if _, err := os.Stat(p); err == nil {
			return filepath.Dir(p)
		}
	}
	return ""
}

func download(url, dst string, from, to float64) error {
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("загрузка %s: HTTP %d", url, resp.StatusCode)
	}
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer f.Close()
	total := resp.ContentLength
	var got int64
	buf := make([]byte, 256*1024)
	last := time.Now()
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				return werr
			}
			got += int64(n)
			if time.Since(last) > 200*time.Millisecond {
				last = time.Now()
				if total > 0 {
					setDetail(fmt.Sprintf("%.1f из %.1f МБ", float64(got)/1e6, float64(total)/1e6))
				} else {
					setDetail(fmt.Sprintf("%.1f МБ", float64(got)/1e6))
				}
			}
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			return rerr
		}
	}
}

func installNode() (string, error) {
	setStep("Скачиваю Node.js", .02, .10, 30)
	resp, err := http.Get("https://nodejs.org/dist/index.json")
	if err != nil {
		return "", fmt.Errorf("не могу связаться с nodejs.org: %v", err)
	}
	defer resp.Body.Close()
	var list []struct {
		Version string          `json:"version"`
		LTS     json.RawMessage `json:"lts"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		return "", err
	}
	ver := ""
	for _, v := range list {
		if string(v.LTS) != "false" {
			ver = v.Version
			break
		}
	}
	if ver == "" {
		return "", errors.New("не нашёл LTS-версию Node.js")
	}
	msi := filepath.Join(os.TempDir(), "node-"+ver+"-x64.msi")
	if err := download(fmt.Sprintf("https://nodejs.org/dist/%s/node-%s-x64.msi", ver, ver), msi, .02, .10); err != nil {
		return "", err
	}
	setStep("Ставлю Node.js — подтверди запрос Windows", .10, .14, 40)
	cmd := exec.Command("msiexec", "/i", msi, "/passive", "/norestart")
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("установка Node.js не завершилась: %v", err)
	}
	if d := findNode(); d != "" {
		return d, nil
	}
	return "", errors.New("Node.js не нашёлся после установки — перезагрузи компьютер и запусти установщик снова")
}

func extractPayload(dst string) error {
	zr, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil {
		return err
	}
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		target := filepath.Join(dst, filepath.FromSlash(f.Name))
		if !strings.HasPrefix(target, dst) {
			continue
		}
		os.MkdirAll(filepath.Dir(target), 0755)
		rc, err := f.Open()
		if err != nil {
			return err
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return err
		}
		if err := os.WriteFile(target, data, 0644); err != nil {
			return err
		}
	}
	return nil
}

func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

func makeShortcuts() {
	ico := filepath.Join(baseDir(), "icon.ico")
	os.WriteFile(ico, iconICO, 0644)
	script := fmt.Sprintf(`$w = New-Object -ComObject WScript.Shell
foreach ($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $s = $w.CreateShortcut((Join-Path $d 'Liquid.lnk'))
  $s.TargetPath = %s
  $s.WorkingDirectory = %s
  $s.IconLocation = %s
  $s.Description = 'Liquid browser'
  $s.Save()
}`, psQuote(appExe()), psQuote(appDir()), psQuote(ico))
	if err := hidden(exec.Command("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script)).Run(); err != nil {
		logf("ярлыки: %v", err)
	}
}

func registerUninstall(setup string) {
	key := `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Liquid`
	add := func(name, typ, val string) {
		hidden(exec.Command("reg", "add", key, "/v", name, "/t", typ, "/d", val, "/f")).Run()
	}
	add("DisplayName", "REG_SZ", "Liquid")
	add("DisplayIcon", "REG_SZ", filepath.Join(baseDir(), "icon.ico"))
	add("Publisher", "REG_SZ", "Liquid")
	add("DisplayVersion", "REG_SZ", "1.6.0")
	add("InstallLocation", "REG_SZ", baseDir())
	add("UninstallString", "REG_SZ", `"`+setup+`" --uninstall`)
	add("NoModify", "REG_DWORD", "1")
	add("NoRepair", "REG_DWORD", "1")
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0755)
}

func runInstall() (err error) {
	os.MkdirAll(baseDir(), 0755)
	logMu.Lock()
	logFile, _ = os.Create(logPath())
	logMu.Unlock()
	defer func() {
		if err != nil {
			logf("ОШИБКА: %v", err)
		} else {
			logf("Готово")
		}
		logMu.Lock()
		if logFile != nil {
			logFile.Close()
			logFile = nil
		}
		logMu.Unlock()
	}()

	setStep("Проверяю Node.js", 0, .02, 2)
	nodeDir := findNode()
	if nodeDir == "" {
		if nodeDir, err = installNode(); err != nil {
			return err
		}
	}
	logf("node: %s", nodeDir)
	env := os.Environ()
	for i, e := range env {
		if strings.HasPrefix(strings.ToUpper(e), "PATH=") {
			env[i] = "PATH=" + nodeDir + ";" + e[5:]
		}
	}

	setStep("Распаковываю файлы", .14, .17, 2)
	// убираем старый код: файлы, удалённые в новой версии, не должны попасть в сборку (движок и xray оставляем)
	if ents, e := os.ReadDir(srcDir()); e == nil {
		for _, en := range ents {
			if n := en.Name(); n != "node_modules" && n != "bin" {
				os.RemoveAll(filepath.Join(srcDir(), n))
			}
		}
	}
	if err = extractPayload(srcDir()); err != nil {
		return fmt.Errorf("не удалось распаковать файлы: %v", err)
	}

	if silent {
		writeStatus("working", payloadVersion(), "")
	} else {
		setStep("Закрываю Liquid, если открыт", .17, .18, 1)
		hidden(exec.Command("taskkill", "/IM", "Liquid.exe", "/F")).Run()
		time.Sleep(700 * time.Millisecond)
	}

	setStep("Скачиваю проверенную версию движка Electron — самая долгая часть", .18, .70, 70)
	if err = run(srcDir(), env, "cmd", "/c", "npm", "install", "--no-fund", "--no-audit"); err != nil {
		return fmt.Errorf("не удалось скачать Electron. Проверь интернет (можно включить VPN в системе) и нажми «Повторить».\n%v", err)
	}
	if err = installElectron(env); err != nil {
		return err
	}

	setStep("Скачиваю xray-core для VPN", .70, .78, 15)
	if err = run(srcDir(), env, "cmd", "/c", "node", `scripts\get-xray.js`); err != nil {
		if _, e2 := os.Stat(filepath.Join(srcDir(), "bin", "xray.exe")); e2 != nil {
			return fmt.Errorf("не удалось скачать xray с GitHub: %v", err)
		}
	}

	setStep("Собираю браузер", .78, .93, 40)
	os.RemoveAll(filepath.Join(srcDir(), "dist"))
	// собираем ровно на том движке, что лежит в node_modules (он может быть новее ветки из package.json)
	if err = run(srcDir(), env, "cmd", "/c", "npx", "electron-builder", "--win", "dir", "-c.electronVersion="+installedElectron()); err != nil {
		return fmt.Errorf("сборка не удалась: %v", err)
	}

	setStep("Устанавливаю", .93, .98, 3)
	unpacked := filepath.Join(srcDir(), "dist", "win-unpacked")
	if _, err = os.Stat(filepath.Join(unpacked, "Liquid.exe")); err != nil {
		return errors.New("после сборки не нашёлся Liquid.exe")
	}
	if silent {
		// всё собрано — ждём, пока человек сам закроет браузер, и только тогда подменяем файлы
		writeStatus("ready", payloadVersion(), "")
		for start := time.Now(); liquidRunning(); time.Sleep(3 * time.Second) {
			if time.Since(start) > 7*24*time.Hour {
				return errors.New("Liquid не закрывали неделю — обновление отложено")
			}
		}
		time.Sleep(1500 * time.Millisecond)
	} else {
		hidden(exec.Command("taskkill", "/IM", "Liquid.exe", "/F")).Run()
	}
	time.Sleep(400 * time.Millisecond)
	if err = os.RemoveAll(appDir()); err != nil {
		return fmt.Errorf("не удалось заменить старую версию (закрой Liquid): %v", err)
	}
	if err = os.CopyFS(appDir(), os.DirFS(unpacked)); err != nil {
		return fmt.Errorf("не удалось скопировать браузер: %v", err)
	}

	// Копия установщика — через неё браузер потом сам обновляется
	setup := filepath.Join(baseDir(), "Liquid-Setup.exe")
	if self, e := os.Executable(); e == nil && !strings.EqualFold(filepath.Clean(self), filepath.Clean(setup)) {
		if e := copyFile(self, setup); e != nil {
			logf("копия установщика: %v", e)
		}
	}
	makeShortcuts()
	registerUninstall(setup)
	setStep("Готово", .98, 1, .5)
	return nil
}

func launchApp() { shellOpen(appExe(), "") }

func uninstall() {
	if messageBox(0, "Удалить браузер Liquid?\n\nКлючи, логины на сайтах и настройки тоже будут удалены.", "Удаление Liquid", 0x4|0x20) != 6 {
		return
	}
	hidden(exec.Command("taskkill", "/IM", "Liquid.exe", "/F")).Run()
	time.Sleep(600 * time.Millisecond)
	for _, d := range []string{"Desktop", "Programs"} {
		hidden(exec.Command("powershell", "-NoProfile", "-Command",
			fmt.Sprintf("Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('%s')) 'Liquid.lnk') -ErrorAction SilentlyContinue", d))).Run()
	}
	hidden(exec.Command("reg", "delete", `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Liquid`, "/f")).Run()
	os.RemoveAll(appDir())
	os.RemoveAll(srcDir())
	os.RemoveAll(filepath.Join(os.Getenv("APPDATA"), "Liquid")) // данные браузера
	// сам установщик лежит в папке — удаляем её после выхода
	c := hidden(exec.Command("cmd"))
	c.SysProcAttr.CmdLine = `cmd /c ping 127.0.0.1 -n 3 >nul & rmdir /s /q "` + baseDir() + `"`
	c.Start()
	messageBox(0, "Liquid удалён.", "Удаление Liquid", 0x40)
}
