"""Four desktop quadrants: OTClient, OBS, decisions and matching perception frame.

Start the agent with BOTZIN_MONITOR_PATH=storage/desktop-monitor.json, then run
this script. Closing either monitor window closes both; it does not stop the agent.
"""
import base64
import ctypes
from ctypes import wintypes
import io
import json
from pathlib import Path
import tkinter as tk
from tkinter.scrolledtext import ScrolledText
from datetime import datetime, timezone

from PIL import Image, ImageDraw, ImageTk

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / "storage" / "desktop-monitor.json"
BG, FG = "#101722", "#e5eef8"


def work_area():
    ctypes.windll.user32.SetProcessDPIAware()
    area = wintypes.RECT()
    if not ctypes.windll.user32.SystemParametersInfoW(48, 0, ctypes.byref(area), 0):
        raise OSError("Não foi possível ler a área da tela")
    return area.left, area.top, area.right - area.left, area.bottom - area.top


def arrange_apps(x, y, width, height):
    user32 = ctypes.windll.user32
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    windows = []

    @callback_type
    def visit(hwnd, _):
        title = ctypes.create_unicode_buffer(1024)
        user32.GetWindowTextW(hwnd, title, len(title))
        windows.append((hwnd, title.value))
        return True

    user32.EnumWindows(visit, 0)
    for hwnd, title in windows:
        if title.startswith("OBS "):
            # Minimizing the OBS owner also hides its projector on Windows.
            user32.ShowWindow(hwnd, 9)
            user32.SetWindowPos(hwnd, wintypes.HWND(1), x, y, width, height, 0x0010)
    for hwnd, title in windows:
        projector = "Tibia Preview" in title and any(word in title.lower() for word in ("projetor", "projeção", "projector"))
        column = 0 if title == "OTClient - Redemption" else 1 if projector else None
        if column is not None:
            user32.ShowWindow(hwnd, 9)
            user32.SetWindowPos(hwnd, None, x + column * width, y, width, height, 0x0010)
        if title in ("Botzin | Decisões da IA", "Botzin | O que a IA está vendo"):
            column = 0 if "Decisões" in title else 1
            user32.SetWindowPos(hwnd, None, x + column * width, y + height, width, height, 0x0010)


def main():
    x, y, width, height = work_area()
    half_w, half_h = width // 2, height // 2
    root = tk.Tk()
    root.title("Botzin | Decisões da IA")
    root.configure(bg=BG)
    root.geometry(f"{half_w - 16}x{half_h - 40}+{x}+{y + half_h}")
    vision = tk.Toplevel(root)
    vision.title("Botzin | O que a IA está vendo")
    vision.configure(bg=BG)
    vision.geometry(f"{half_w - 16}x{half_h - 40}+{x + half_w}+{y + half_h}")
    for window in (root, vision):
        window.protocol("WM_DELETE_WINDOW", root.destroy)
    status = tk.Label(root, text="Aguardando o agente…", bg=BG, fg="#64d8cb", anchor="w", font=("Segoe UI", 12, "bold"))
    status.pack(fill="x", padx=14, pady=10)
    body = ScrolledText(root, bg=BG, fg=FG, insertbackground=FG, relief="flat", wrap="word", font=("Segoe UI", 11))
    body.pack(fill="both", expand=True, padx=10)
    body.configure(state="disabled")
    caption = tk.Label(vision, text="Aguardando o frame usado pela IA", bg=BG, fg="#64d8cb", font=("Segoe UI", 11), wraplength=700)
    caption.pack(fill="x", padx=12, pady=8)
    canvas = tk.Label(vision, bg=BG)
    canvas.pack(fill="both", expand=True, padx=8, pady=8)
    tk.Button(root, text="Reorganizar os quatro quadrantes", command=lambda: arrange_apps(x, y, half_w, half_h)).pack(pady=8)
    cache = {"stamp": None, "payload": None}

    def refresh():
        try:
            stamp = SNAPSHOT.stat().st_mtime_ns
            if stamp != cache["stamp"]:
                cache.update(stamp=stamp, payload=json.loads(SNAPSHOT.read_text(encoding="utf-8")))
            payload = cache["payload"]
            record = payload["decision"]
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(record["observedAt"].replace("Z", "+00:00"))).total_seconds()
            state = "AO VIVO" if age < 5 else f"SEM ATUALIZAÇÃO · {int(age)} s"
            mode = payload.get("executionMode", "observe")
            status.config(text=f"{state}  ·  Modo: {mode}")
            lines = [record["decision"], "", f"Ciclo: {record['observedAt']}", "", "Motivos:", *record.get("reasons", [])]
            for item in record.get("evaluation", []):
                result = "Selecionada" if item.get("rejectedBecause") is None else item["rejectedBecause"]
                lines.extend(["", f"{item['source']} → {item['action']}", item.get("reason", ""), result])
            lines.extend(["", f"Comandos propostos: {len(record.get('commands', []))}", "Proposta não confirma execução no jogo."])
            if record.get("error"):
                lines.extend(["", record["error"]])
            body.configure(state="normal")
            body.delete("1.0", "end")
            body.insert("end", "\n".join(lines))
            body.configure(state="disabled")
            with Image.open(io.BytesIO(base64.b64decode(payload["image"]))) as opened:
                picture = opened.convert("RGB")
            draw = ImageDraw.Draw(picture)
            for entity in record.get("entities", []):
                box = entity["box"]
                left, top = box["x"], box["y"]
                draw.rectangle((left, top, left + box["width"], top + box["height"]), outline="#5fffd2", width=2)
                draw.text((left, max(0, top - 13)), f"{entity.get('label') or entity['kind']} {entity['confidence']:.0%}", fill="#5fffd2")
            picture.thumbnail((max(100, canvas.winfo_width()), max(100, canvas.winfo_height())))
            photo = ImageTk.PhotoImage(picture)
            canvas.configure(image=photo)
            canvas.image = photo
            caption.config(text=f"{state} · Frame {record.get('frame', {}).get('id', '—')}\n{len(record.get('entities', []))} detecções · imagem original com marcações")
        except (OSError, ValueError, KeyError, TypeError) as error:
            status.config(text="Sem dados atuais do agente")
            caption.config(text="Sem frame disponível — aguardando a percepção")
        root.after(500, refresh)

    root.update_idletasks()
    root.after(200, lambda: arrange_apps(x, y, half_w, half_h))
    refresh()
    root.mainloop()


if __name__ == "__main__":
    main()
