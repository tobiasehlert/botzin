"""Always-on-top overlay showing what the local-OT trainee perceives and prefers.

Reads local-ot/training/io/state.txt (server truth, 100 ms) and storage/local-ot-qtable.json,
so it works alongside any running trainer without touching it.
  python scripts/local-ot-overlay.py
"""

import json
import tkinter as tk
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "local-ot" / "training" / "io" / "state.txt"
QTABLE = ROOT / "storage" / "local-ot-qtable.json"
LOG = ROOT / "storage" / "local-ot-train.log"
ACTIONS = ["n", "s", "e", "w", "attack", "wait"]
CELL, R = 22, 4  # radar: (2R+1)^2 cells around the knight


def load(path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def state_key(s):
    m = s.get("monster")
    if not m:
        return "none"
    dx = max(-4, min(4, m["x"] - s["x"]))
    dy = max(-4, min(4, m["y"] - s["y"]))
    return f"{dx},{dy},{int(s['targeting'])}"


root = tk.Tk()
root.title("Botzin vê")
root.attributes("-topmost", True)
root.geometry("+20+20")
root.configure(bg="#111")
text = tk.Label(root, font=("Consolas", 11), justify="left", anchor="w", fg="#eee", bg="#111", width=44)
text.pack(padx=8, pady=(8, 4))
radar = tk.Canvas(root, width=CELL * (2 * R + 1), height=CELL * (2 * R + 1), bg="#222", highlightthickness=0)
radar.pack(padx=8, pady=(0, 8))
q_cache = {"mtime": 0, "q": {}}


def refresh():
    s = load(STATE, {})
    try:
        mtime = QTABLE.stat().st_mtime
        if mtime != q_cache["mtime"]:
            q_cache.update(mtime=mtime, q=load(QTABLE, {}))
    except OSError:
        pass
    lines = []
    if not s.get("online"):
        lines.append("Knight OFFLINE (faça login no OTClient)")
    else:
        lines.append(f"Knight  hp {s['hp']}/{s['hpmax']}  mana {s['mana']}  pos {s['x']},{s['y']},{s['z']}")
        m = s.get("monster")
        if m:
            dx, dy = m["x"] - s["x"], m["y"] - s["y"]
            lines.append(f"Monstro {m['name']}  hp {m['hp']}/{m['hpmax']}  dx {dx:+d} dy {dy:+d}  alvo: {'sim' if s['targeting'] else 'nao'}")
        else:
            lines.append("Monstro nenhum detectado")
        key = state_key(s)
        qs = q_cache["q"].get(key)
        if qs:
            best = ACTIONS[max(range(len(ACTIONS)), key=qs.__getitem__)]
            lines.append(f"Estado  {key}  -> prefere: {best}")
            lines.append("Q " + "  ".join(f"{a}:{v:+.1f}" for a, v in zip(ACTIONS, qs)))
        else:
            lines.append(f"Estado  {key}  (ainda nao visto)")
    try:
        tail = [l.strip() for l in LOG.read_text().splitlines() if l.startswith("episode")][-2:]
        lines.extend(tail)
    except OSError:
        pass
    text.config(text="\n".join(lines))

    radar.delete("all")
    for i in range(2 * R + 1):
        for j in range(2 * R + 1):
            radar.create_rectangle(i * CELL, j * CELL, (i + 1) * CELL, (j + 1) * CELL, outline="#333")
    radar.create_oval(R * CELL + 4, R * CELL + 4, (R + 1) * CELL - 4, (R + 1) * CELL - 4, fill="#4af")
    m = s.get("monster") if s.get("online") else None
    if m:
        dx = max(-R, min(R, m["x"] - s["x"]))
        dy = max(-R, min(R, m["y"] - s["y"]))
        i, j = R + dx, R + dy
        radar.create_oval(i * CELL + 4, j * CELL + 4, (i + 1) * CELL - 4, (j + 1) * CELL - 4, fill="#f44" if s["targeting"] else "#fa4")
    root.after(200, refresh)


refresh()
root.mainloop()
