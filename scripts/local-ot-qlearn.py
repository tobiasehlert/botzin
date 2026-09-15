"""Trial-and-error training on the local Canary world (tabular Q-learning).

Two channels:
  server file bridge (local-ot/training/botzin_arena.lua) - always used for episode control
    (reset/spawn) and, with --via server, also for perception and actions.
  client HTTP bridge (OTClient bot script botzin.lua, --via client) - actions go through the
    real client (target frame, spells, looting) and perception is what the client sees.

Run (Knight online in the OTClient, bot enabled with the "botzin" config for --via client):
  python scripts/local-ot-qlearn.py --via client --mode arena --monster wasp --no-reset
  python scripts/local-ot-qlearn.py --via client --mode explore --goto 32426,32293,7

ponytail: tabular Q over (dx, dy, targeting). Swap for the vision detector + a policy net once
this loop is boringly stable.
"""

import argparse
import json
import os
import random
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IO_DIR = ROOT / "local-ot" / "training" / "io"
QTABLE = ROOT / "storage" / "local-ot-qtable.json"
LOG = ROOT / "storage" / "local-ot-episodes.csv"
MAP = ROOT / "storage" / "local-ot-map.json"

ACTIONS = ["n", "s", "e", "w", "attack", "wait", "loot", "heal"]
STEP_SECONDS = 0.5
MAX_STEPS = 80
MONSTER = "rat"
HEAL_SPELL = "exura ico"


class Bridge:
    """Server-side file bridge: cmd.txt in, state.txt out."""

    def __init__(self):
        self.next_id = int(time.time()) % 1_000_000

    def send(self, action, arg=""):
        self.next_id += 1
        tmp = IO_DIR / "cmd.txt.tmp"
        # newline="\n": Windows text mode would write \r\n and the Lua side would read "rat\r"
        tmp.write_text(f"{self.next_id} {action} {arg}".strip() + "\n", newline="\n")
        os.replace(tmp, IO_DIR / "cmd.txt")
        started = time.time()
        while True:
            state = self.read()
            if state and state.get("id") == self.next_id:
                return state
            if time.time() - started > 10 and not (IO_DIR / "cmd.txt").exists():
                # bridge consumed the command but never answered (server restarting): resend
                return self.send(action, arg)
            if time.time() - started > 10:
                print("bridge not answering (server restarting?), still waiting...", flush=True)
                started = time.time()
            time.sleep(0.05)

    def act(self, action):
        """Map a policy action to this channel."""
        if action == "heal":
            return  # no spell casting through the server channel
        if action == "loot":
            return
        self.send(action)

    def read(self):
        for _ in range(5):  # the server rewrites the file every 100 ms; a read can land mid-rename
            try:
                return json.loads((IO_DIR / "state.txt").read_text())
            except (OSError, ValueError):
                time.sleep(0.03)
        return {"online": False}


class ClientBridge:
    """OTClient bot bridge: the bot polls GET /cmd and POSTs its snapshot to /state."""

    def __init__(self, port=8765):
        self.pending, self.raw, self.raw_time = None, None, 0.0
        self.lock = threading.Lock()
        self.next_id = int(time.time()) % 1_000_000
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def _reply(self, body):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                with bridge.lock:
                    cmd, bridge.pending = bridge.pending, None
                self._reply(json.dumps(cmd or {}).encode())

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                try:
                    data = json.loads(raw)
                except ValueError:
                    data = None
                if isinstance(data, dict):
                    with bridge.lock:
                        bridge.raw, bridge.raw_time = data, time.time()
                self._reply(b"{}")

        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def send(self, action, arg=""):
        self.next_id += 1
        with self.lock:
            self.pending = {"id": self.next_id, "action": action, "arg": str(arg)}
        started = time.time()
        while True:
            state = self.read()
            if state.get("online") and state.get("cmd") == self.next_id:
                return state
            if time.time() - started > 10:
                print("client bot not answering: enable the bot with the 'botzin' config in the OTClient", flush=True)
                started = time.time()
            time.sleep(0.05)

    def act(self, action):
        if action in ("n", "s", "e", "w"):
            self.send("walk", action)
        elif action == "attack":
            self.send("attack", self.read().get("monster", {}).get("id", 0) if self.read().get("monster") else 0)
        elif action == "heal":
            self.send("say", HEAL_SPELL)
        elif action == "loot":
            self.send("loot")
        else:
            self.send("wait")

    def read(self):
        with self.lock:
            raw, t = self.raw, self.raw_time
        if not raw or time.time() - t > 3:
            return {"online": False}
        return normalize_client(raw)


class BotzinBridge:
    """Perceive through Botzin's own pipeline (OBS capture + ONNX detector, read from the live
    decision log) and act with real keyboard/mouse input on the OTClient window. Vitals and the
    kill signal still come from the server file bridge (reward/safety only)."""

    DECISIONS = ROOT / "storage" / "live-decisions.jsonl"
    FRAME_WIDTH = 640  # obsCaptureWidth in the machine config
    VIEW_TILES = (15, 11)
    ARROWS = {"n": "up", "s": "down", "e": "right", "w": "left"}

    def __init__(self, ctl):
        import importlib.util
        spec = importlib.util.spec_from_file_location("win_input_helper", ROOT / "scripts" / "win-input-helper.py")
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)
        self.ctl = ctl
        self.targeting = False

    def _last_decision(self):
        try:
            with self.DECISIONS.open("rb") as f:
                f.seek(0, 2)
                size = f.tell()
                f.seek(max(0, size - 65536))
                lines = f.read().decode("utf-8", "ignore").strip().splitlines()
            rec = json.loads(lines[-1])
            age = time.time() - time.mktime(time.strptime(rec["observedAt"][:19], "%Y-%m-%dT%H:%M:%S")) + time.timezone
            return rec if abs(age) < 5 else None
        except (OSError, ValueError, IndexError, KeyError):
            return None

    def _vision_monster(self, rec):
        tile_w = self.FRAME_WIDTH / self.VIEW_TILES[0]
        frame_h = self.FRAME_WIDTH * 430 / 589  # crop aspect (see scripts/obs-crop-map.ts)
        tile_h = frame_h / self.VIEW_TILES[1]
        cx0, cy0 = self.FRAME_WIDTH / 2, frame_h / 2
        best = None
        for e in rec.get("entities", []):
            if e.get("kind") != "creature":
                continue
            b = e["box"]
            fx, fy = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
            dx, dy = (fx - cx0) / tile_w, (fy - cy0) / tile_h
            if abs(dx) < 0.6 and abs(dy) < 0.6:
                continue  # that's us
            dist = max(abs(dx), abs(dy))
            if best is None or dist < best[0]:
                best = (dist, {"name": e.get("label") or "creature", "hp": 100, "hpmax": 100, "x": round(dx), "y": round(dy), "fx": fx, "fy": fy, "id": e.get("id")})
        return best[1] if best else None

    def read(self):
        server = self.ctl.read() or {"online": False}
        rec = self._last_decision()
        if not server.get("online") or rec is None:
            return {"online": False}
        state = dict(server)
        state["server_monster"] = server.get("monster")
        m = self._vision_monster(rec)
        if m:
            m = dict(m, x=server["x"] + m["x"], y=server["y"] + m["y"], z=server["z"])  # tile offsets -> world tiles
        else:
            self.targeting = False
        state["monster"] = m
        state["targeting"] = bool(m) and self.targeting
        return state

    def act(self, action):
        h = self.helper
        if action in self.ARROWS:
            h.key_press(self.ARROWS[action])
        elif action == "attack":
            m = self.read().get("monster")
            if m:
                x, y = h.frame_to_screen(m["fx"], m["fy"], self.FRAME_WIDTH)
                h.focus_window()
                h.mouse_click(x, y, "left")
                self.targeting = True
        elif action == "heal":
            h.focus_window()
            h.key_press("enter")
            h.type_text(HEAL_SPELL, submit=True)
        # loot/wait: nothing through this channel yet


def normalize_client(raw):
    """Shape the client snapshot like the server state (monster = target, else nearest monster)."""
    x, y = raw["x"], raw["y"]
    monsters = [c for c in raw.get("creatures", []) if c["kind"] == "monster" and c["z"] == raw["z"]]
    monster = next((c for c in monsters if c["id"] == raw.get("target")), None)
    if monster is None and monsters:
        monster = min(monsters, key=lambda c: max(abs(c["x"] - x), abs(c["y"] - y)))
        if max(abs(monster["x"] - x), abs(monster["y"] - y)) > 8:
            monster = None
    state = {k: raw.get(k) for k in ("online", "cmd", "hp", "hpmax", "mana", "manamax", "level", "x", "y", "z", "skills", "corpses", "loot", "slots")}
    state["targeting"] = bool(raw.get("target")) and monster is not None and monster["id"] == raw["target"]
    state["monster"] = dict(monster, hpmax=100) if monster else None
    return state


def discretize(state):
    m = state.get("monster")
    if not m:
        return "corpse" if state.get("corpses") else "none"
    dx = max(-4, min(4, m["x"] - state["x"]))
    dy = max(-4, min(4, m["y"] - state["y"]))
    return f"{dx},{dy},{int(state['targeting'])}"


def greedy(qs):
    best = max(qs)
    return random.choice([i for i, v in enumerate(qs) if v == best])


def reward_between(prev, cur, done_kill, done_death):
    r = -0.1
    pm, cm = prev.get("monster"), cur.get("monster")
    if pm and cm and pm.get("id", 0) == cm.get("id", 0):
        r += 4 * max(0.0, pm["hp"] / pm["hpmax"] - cm["hp"] / cm["hpmax"])  # 4 per whole creature
    r -= 0.2 * max(0, prev["hp"] - cur["hp"])
    if cm:
        # melee shaping: the knight only hits when adjacent, so reward closing the distance
        dist = max(abs(cm["x"] - cur["x"]), abs(cm["y"] - cur["y"]))
        r += 0.3 if dist <= 1 else -0.05 * dist
    r += 1.0 * max(0, (cur.get("loot") or 0) - (prev.get("loot") or 0))  # items looted
    if done_kill:
        r += 10
    if done_death:
        r -= 20
    return r


def wait_online(ctl, act, action, arg=""):
    state = ctl.send(action, arg)
    while not state.get("online") or not act.read().get("online"):
        print("Knight offline or client bot not connected: waiting...", flush=True)
        time.sleep(15)
        state = ctl.send(action, arg)
    time.sleep(STEP_SECONDS)
    return act.read()


def learn_step(q, args, state, act):
    """One epsilon-greedy step with a Q update. Returns (next_state, reward, killed, died)."""
    s = discretize(state)
    qs = q.setdefault(s, [0.0] * len(ACTIONS))
    a = random.randrange(len(ACTIONS)) if random.random() < args.epsilon else greedy(qs)
    act.act(ACTIONS[a])
    time.sleep(STEP_SECONDS)
    nxt = act.read()
    if not nxt.get("online"):
        return nxt, 0.0, False, False
    # kill = the episode creature is gone (server truth when available, else what we perceive)
    killed = bool(state.get("server_monster", state.get("monster"))) and not nxt.get("server_monster", nxt.get("monster"))
    died = nxt["hp"] <= 0
    r = reward_between(state, nxt, killed, died)
    best_next = 0.0 if killed or died else max(q.setdefault(discretize(nxt), [0.0] * len(ACTIONS)))
    qs[a] += args.alpha * (r + args.gamma * best_next - qs[a])
    return nxt, r, killed, died


DELTAS = {"n": (0, -1), "s": (0, 1), "e": (1, 0), "w": (-1, 0)}


def explore(args, q, ctl, act):
    """Free roam: walk toward the least-visited neighbour (biased toward --goto when given),
    fight whatever comes close with the Q-table (still learning), loot corpses, retreat to the
    arena to heal when HP is low. The map is persisted."""
    known = json.loads(MAP.read_text()) if MAP.exists() else {"visited": {}, "blocked": []}
    visited, blocked = known["visited"], set(known["blocked"])
    goal = tuple(int(v) for v in args.goto.split(",")) if args.goto else None
    state = wait_online(ctl, act, "reset", "none")
    kills = 0
    for step in range(1, args.steps + 1):
        if not state.get("online"):
            state = wait_online(ctl, act, "wait")
        pos = f"{state['x']},{state['y']},{state['z']}"
        visited[pos] = visited.get(pos, 0) + 1
        m = state.get("monster")
        if state["hp"] < 0.4 * state["hpmax"]:
            print(f"step {step}: hp {state['hp']}/{state['hpmax']}, retreating to the arena", flush=True)
            ctl.send("reset", "none")
            time.sleep(STEP_SECONDS)
            state = act.read()
        elif m and max(abs(m["x"] - state["x"]), abs(m["y"] - state["y"])) <= 5:
            state, r, killed, died = learn_step(q, args, state, act)
            kills += killed
        elif state.get("corpses"):
            state, r, killed, died = learn_step(q, args, state, act)
        elif goal and isinstance(act, ClientBridge) and step % 40 == 0:
            act.send("goto", f"{goal[0]},{goal[1]},{goal[2]}")  # client pathfinding over the known minimap
            time.sleep(3)
            state = act.read()
        else:
            options = []
            for d, (dx, dy) in DELTAS.items():
                nx, ny = state["x"] + dx, state["y"] + dy
                dest = f"{nx},{ny},{state['z']}"
                if dest in blocked:
                    continue
                score = visited.get(dest, 0)
                if goal and goal[2] == state["z"]:
                    score += 0.02 * (abs(nx - goal[0]) + abs(ny - goal[1]))
                options.append((score, random.random(), d, dest))
            _, _, d, dest = min(options) if options else (0, 0, random.choice(list(DELTAS)), None)
            act.act(d)
            time.sleep(STEP_SECONDS)
            state = act.read()
            if dest and f"{state.get('x')},{state.get('y')},{state.get('z')}" == pos:
                blocked.add(dest)
        if step % 100 == 0:
            MAP.write_text(json.dumps({"visited": visited, "blocked": sorted(blocked)}))
            QTABLE.write_text(json.dumps(q))
            print(f"step {step:5d} tiles known {len(visited):5d} blocked {len(blocked):4d} kills {kills} hp {state.get('hp')} pos {state.get('x')},{state.get('y')},{state.get('z')}", flush=True)
    MAP.write_text(json.dumps({"visited": visited, "blocked": sorted(blocked)}))
    QTABLE.write_text(json.dumps(q))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--via", choices=["server", "client", "botzin"], default="server", help="act/perceive through the server file bridge, the OTClient bot, or Botzin's OBS+ONNX pipeline with real keyboard/mouse")
    ap.add_argument("--mode", choices=["arena", "explore"], default="arena")
    ap.add_argument("--episodes", type=int, default=100)
    ap.add_argument("--steps", type=int, default=3000, help="explore mode: steps to walk")
    ap.add_argument("--goto", default="", help="explore mode: x,y,z to head for (e.g. wasp cave 32426,32293,7)")
    ap.add_argument("--monster", default=MONSTER, help="arena mode: creature spawned each episode (rat, wasp, ...)")
    ap.add_argument("--no-reset", action="store_true", help="arena mode: spawn the next creature beside the player instead of teleporting/healing (corpses stay); heals only below 40%% HP")
    ap.add_argument("--epsilon", type=float, default=0.3)
    ap.add_argument("--alpha", type=float, default=0.3)
    ap.add_argument("--gamma", type=float, default=0.95)
    args = ap.parse_args()

    q = json.loads(QTABLE.read_text()) if QTABLE.exists() else {}
    for row in q.values():  # older tables had fewer actions
        row.extend([0.0] * (len(ACTIONS) - len(row)))
    ctl = Bridge()
    act = {"client": lambda: ClientBridge(), "botzin": lambda: BotzinBridge(ctl), "server": lambda: ctl}[args.via]()
    LOG.parent.mkdir(exist_ok=True)
    if args.mode == "explore":
        return explore(args, q, ctl, act)
    if not LOG.exists():
        LOG.write_text("episode,steps,reward,outcome\n")

    for episode in range(1, args.episodes + 1):
        if args.no_reset:
            state = wait_online(ctl, act, "wait")
            low = state["hp"] < 0.4 * state["hpmax"]
            ctl.send("reset" if low else "spawn", args.monster)
            time.sleep(STEP_SECONDS)
            state = act.read()
        else:
            state = wait_online(ctl, act, "reset", args.monster)
        total, outcome = 0.0, "timeout"
        for step in range(MAX_STEPS):
            nxt, r, killed, died = learn_step(q, args, state, act)
            if not nxt.get("online"):
                outcome = "offline"
                break
            total += r
            state = nxt
            if killed:
                outcome = "kill"
                for _ in range(4):  # a few extra steps so it can learn to loot the corpse it just made
                    if state.get("monster") or not state.get("corpses"):
                        break
                    state, r2, _, _ = learn_step(q, args, state, act)
                    total += r2
                break
            if died:
                outcome = "death"
                break
        QTABLE.write_text(json.dumps(q))
        with LOG.open("a") as f:
            f.write(f"{episode},{step + 1},{total:.2f},{outcome}\n")
        print(f"episode {episode:4d} steps {step + 1:3d} reward {total:7.2f} {outcome}", flush=True)


if __name__ == "__main__":
    main()
