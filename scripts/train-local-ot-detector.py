"""Fine-tune the entity detector on the auto-labelled local-OT dataset and export it for Botzin.

  .venv\\Scripts\\python.exe scripts\\train-local-ot-detector.py --epochs 30

Outputs models/candidates/tibia-entities-local-ot.onnx + .labels.json (kinds creature/npc/player).
Then point the machine config at them (onnxModelPath/onnxLabelsPath, onnxInputWidth/Height 416).
ponytail: CPU fine-tune from the five-class checkpoint; no validation split tricks, no augment tuning.
"""

import argparse
import json
import shutil
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT / "storage" / "datasets" / "local-ot"
BASE = ROOT / "models" / "candidates" / "tibia-entities-five.pt"
OUT_MODEL = ROOT / "models" / "candidates" / "tibia-entities-local-ot.onnx"
OUT_LABELS = ROOT / "models" / "candidates" / "tibia-entities-local-ot.labels.json"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--imgsz", type=int, default=416)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--device", default="cpu")
    args = ap.parse_args()

    names = [line.split(":", 1)[1].strip() for line in (DATASET / "data.yaml").read_text().splitlines() if line.startswith("  ")]
    model = YOLO(str(BASE))
    model.train(data=str(DATASET / "data.yaml"), epochs=args.epochs, imgsz=args.imgsz, batch=args.batch, device=args.device,
                workers=0, project=str(ROOT / "storage" / "runs"), name="local-ot", exist_ok=True, plots=False, verbose=False)
    best = ROOT / "storage" / "runs" / "local-ot" / "weights" / "best.pt"
    exported = YOLO(str(best)).export(format="onnx", imgsz=args.imgsz, opset=17, simplify=False, dynamic=False)
    OUT_MODEL.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(exported, OUT_MODEL)
    shutil.copy2(best, OUT_MODEL.with_suffix(".pt"))
    OUT_LABELS.write_text(json.dumps([{"id": i, "kind": n, "label": n} for i, n in enumerate(names)], indent=2) + "\n", encoding="utf-8")
    metrics = YOLO(str(best)).val(data=str(DATASET / "data.yaml"), imgsz=args.imgsz, device=args.device, plots=False, verbose=False)
    print(json.dumps({"model": str(OUT_MODEL), "labels": names, "map50": round(float(metrics.box.map50), 3), "map": round(float(metrics.box.map), 3)}))


if __name__ == "__main__":
    main()
