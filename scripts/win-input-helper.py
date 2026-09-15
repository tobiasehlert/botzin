"""Windows keyboard/mouse output for Botzin (SendInput via ctypes, stdlib only).

Used two ways:
  * as a subprocess by src/execution/windows-input-executor.ts: one JSON command per stdin line,
    one JSON reply per stdout line;
  * imported by scripts/local-ot-qlearn.py (--via botzin) to act directly.

Frame -> screen mapping: Botzin sees the OBS "Tibia Preview" source, which is the client window
cropped to the map viewport (BOTZIN_MAP_CROP="left,top,width,height" in client pixels, default
matches scripts/obs-crop-map.ts) and scaled to `frameWidth`. So
  screen = clientOrigin + crop.origin + frame * (crop.width / frameWidth)
ponytail: assumes one OTClient window and no DPI scaling surprises; add per-monitor DPI when needed.
"""

import ctypes
import ctypes.wintypes as wt
import json
import os
import sys
import time

user32 = ctypes.windll.user32
user32.SetProcessDPIAware()

VK = {"up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27, "enter": 0x0D, "return": 0x0D, "escape": 0x1B, "esc": 0x1B,
      "space": 0x20, "tab": 0x09, "backspace": 0x08, "ctrl": 0x11, "shift": 0x10, "alt": 0x12}
VK.update({f"f{i}": 0x6F + i for i in range(1, 13)})
CROP = tuple(int(v) for v in os.environ.get("BOTZIN_MAP_CROP", "242,50,589,430").split(","))
WINDOW_TITLE = os.environ.get("BOTZIN_WINDOW_TITLE", "OTClient - Redemption")

INPUT_KEYBOARD, INPUT_MOUSE = 1, 0
KEYEVENTF_KEYUP, KEYEVENTF_UNICODE = 0x0002, 0x0004
MOUSEEVENTF_MOVE, MOUSEEVENTF_ABSOLUTE = 0x0001, 0x8000
MOUSE_DOWN = {"left": 0x0002, "right": 0x0008}
MOUSE_UP = {"left": 0x0004, "right": 0x0010}


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD), ("time", wt.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD), ("dwFlags", wt.DWORD), ("time", wt.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class _U(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wt.DWORD), ("u", _U)]


def _send(*inputs):
    arr = (INPUT * len(inputs))(*inputs)
    user32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT))


def _key_input(vk, up=False, scan=0, unicode=False):
    flags = (KEYEVENTF_KEYUP if up else 0) | (KEYEVENTF_UNICODE if unicode else 0)
    return INPUT(INPUT_KEYBOARD, _U(ki=KEYBDINPUT(vk, scan, flags, 0, None)))


def key_press(key, hold_ms=40):
    key = str(key).lower()
    vk = VK.get(key) or (ord(key.upper()) if len(key) == 1 else None)
    if vk is None:
        raise ValueError(f"unknown key {key!r}")
    _send(_key_input(vk))
    time.sleep(hold_ms / 1000)
    _send(_key_input(vk, up=True))


def type_text(text, submit=False):
    for ch in text:
        _send(_key_input(0, scan=ord(ch), unicode=True), _key_input(0, up=True, scan=ord(ch), unicode=True))
        time.sleep(0.01)
    if submit:
        key_press("enter")


def window_client_origin():
    hwnd = user32.FindWindowW(None, WINDOW_TITLE)
    if not hwnd:
        raise RuntimeError(f"window {WINDOW_TITLE!r} not found")
    pt = wt.POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(pt))
    return pt.x, pt.y


def focus_window():
    hwnd = user32.FindWindowW(None, WINDOW_TITLE)
    if hwnd and user32.GetForegroundWindow() != hwnd:
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.05)


def frame_to_screen(frame_x, frame_y, frame_width):
    ox, oy = window_client_origin()
    left, top, width, _ = CROP
    scale = width / float(frame_width)
    return int(ox + left + frame_x * scale), int(oy + top + frame_y * scale)


def mouse_click(x, y, button="left"):
    sw, sh = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    ax, ay = int(x * 65535 / sw), int(y * 65535 / sh)
    move = INPUT(INPUT_MOUSE, _U(mi=MOUSEINPUT(ax, ay, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0, None)))
    _send(move)
    time.sleep(0.03)
    _send(INPUT(INPUT_MOUSE, _U(mi=MOUSEINPUT(0, 0, 0, MOUSE_DOWN[button], 0, None))))
    time.sleep(0.03)
    _send(INPUT(INPUT_MOUSE, _U(mi=MOUSEINPUT(0, 0, 0, MOUSE_UP[button], 0, None))))


def execute(command):
    """Run one Botzin InputCommand-like dict: {type, payload, frameWidth?}."""
    kind, p = command.get("type"), command.get("payload", {})
    focus_window()
    if kind == "keyboard-press":
        key_press(p["key"])
    elif kind == "keyboard-type":
        type_text(str(p.get("text", "")), bool(p.get("submit")))
    elif kind == "mouse-click":
        if "frameX" in p:
            x, y = frame_to_screen(float(p["frameX"]), float(p["frameY"]), float(command.get("frameWidth") or p.get("frameWidth") or 640))
        else:
            x, y = int(p["x"]), int(p["y"])
        mouse_click(x, y, str(p.get("button", "left")))
    elif kind == "mouse-move":
        x, y = frame_to_screen(float(p["frameX"]), float(p["frameY"]), float(command.get("frameWidth") or 640)) if "frameX" in p else (int(p["x"]), int(p["y"]))
        sw, sh = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
        _send(INPUT(INPUT_MOUSE, _U(mi=MOUSEINPUT(int(x * 65535 / sw), int(y * 65535 / sh), 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0, None))))
    elif kind == "keyboard-release":
        pass  # press already released the key
    else:
        raise ValueError(f"unsupported command type {kind!r}")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            command = json.loads(line)
            execute(command)
            reply = {"ok": True, "id": command.get("id")}
        except Exception as error:  # report, keep serving
            reply = {"ok": False, "error": str(error)}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selfcheck":
        assert frame_to_screen(0, 0, 640)[0] >= 0
        print(json.dumps({"origin": window_client_origin(), "crop": CROP}))
    else:
        main()
