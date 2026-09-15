"""Compare existing checkpoints on the same live frame without training or deploying."""
import base64
import io
import json
from pathlib import Path
from PIL import Image
from ultralytics import YOLO

root = Path(__file__).resolve().parents[1]
payload = json.loads((root / "storage/desktop-monitor.json").read_text(encoding="utf-8"))
image = Image.open(io.BytesIO(base64.b64decode(payload["image"]))).convert("RGB")
for path, size in [("models/candidates/tibia-entities-five.pt", 320), ("storage/runs/local-ot/weights/best.pt", 416), ("models/candidates/tibia-human-annotations-experimental.pt", 640)]:
    model = YOLO(str(root / path))
    for name, sample in [("full", image), ("map", image.crop((125, 0, 365, 177)))]:
        result = model.predict(sample, imgsz=size, conf=0.1, device="cpu", verbose=False)[0]
        boxes = [{"label": result.names[int(b.cls.item())], "confidence": round(b.conf.item(), 3), "xyxy": b.xyxy.tolist()[0]} for b in result.boxes]
        print(json.dumps({"checkpoint": path, "case": name, "frame": payload["decision"]["frame"]["id"], "detections": boxes}), flush=True)
