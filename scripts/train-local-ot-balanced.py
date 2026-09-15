"""Fine-tune an isolated candidate with extra exposure to underrepresented creatures.

Keeps the existing validation split untouched, records before/after class metrics,
and exports a candidate only. It never changes the active model or machine config.
"""
import argparse
import json
from datetime import datetime
from pathlib import Path

import yaml
from PIL import Image
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parents[1]


def metrics(result):
    return {str(int(cls)): {"precision": float(result.box.p[i]), "recall": float(result.box.r[i]), "map50": float(result.box.ap50[i])}
            for i, cls in enumerate(result.box.ap_class_index)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--epochs", type=int, default=30)
    args = parser.parse_args()
    dataset = ROOT / "storage/datasets/local-ot"
    base = ROOT / "storage/runs/local-ot/weights/best.pt"
    experiment = ROOT / "storage/runs" / ("local-ot-balanced-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
    experiment.mkdir(parents=True, exist_ok=False)
    images = sorted((dataset / "images/train").glob("*.png"))
    weighted = []
    creature_frames = 0
    rejected = []
    def valid_image(path):
        try:
            with Image.open(path) as image:
                valid = min(image.size) >= 32
                image.verify()
            if valid:
                return True
        except (OSError, ValueError):
            pass
        rejected.append(str(path))
        return False
    for path in images:
        if not valid_image(path):
            continue
        labels = (dataset / "labels/train" / (path.stem + ".txt")).read_text().splitlines()
        has_creature = any(line.split()[0] == "0" for line in labels if line.strip())
        creature_frames += int(has_creature)
        weighted.extend([path.as_posix()] * (8 if has_creature else 1))
    if not creature_frames:
        raise RuntimeError("No creature examples in training split")
    (experiment / "train.txt").write_text("\n".join(weighted) + "\n", encoding="utf-8")
    validation = [path.as_posix() for path in sorted((dataset / "images/val").glob("*.png")) if valid_image(path)]
    (experiment / "val.txt").write_text("\n".join(validation) + "\n", encoding="utf-8")
    config = {"path": str(dataset), "train": str(experiment / "train.txt"), "val": str(experiment / "val.txt"), "names": {0: "creature", 1: "npc", 2: "player"}}
    config_path = experiment / "data.yaml"
    config_path.write_text(yaml.safe_dump(config), encoding="utf-8")
    model = YOLO(str(base))
    before = model.val(data=str(config_path), imgsz=416, batch=8, device=0, workers=0, plots=False, verbose=False, project=str(experiment), name="before")
    report = {"base": str(base), "creatureFrames": creature_frames, "originalTrainFrames": len(images), "weightedSamples": len(weighted), "rejectedImages": rejected, "validationFrames": len(validation), "before": metrics(before)}
    (experiment / "comparison.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("BASELINE=" + json.dumps(report), flush=True)
    # Validation can fuse layers in place; reload unfused training weights.
    model = YOLO(str(base))
    trained = model.train(data=str(config_path), epochs=args.epochs, imgsz=416, batch=8, device=0, workers=0,
                          project=str(experiment), name="train", seed=42, patience=10, optimizer="AdamW", lr0=0.001,
                          mosaic=0.3, fliplr=0.0, scale=0.2, translate=0.05, plots=False, verbose=False)
    best = YOLO(str(Path(trained.save_dir) / "weights/best.pt"))
    after = best.val(data=str(config_path), imgsz=416, batch=8, device=0, workers=0, plots=False, verbose=False, project=str(experiment), name="after")
    report["after"] = metrics(after)
    report["checkpoint"] = str(Path(trained.save_dir) / "weights/best.pt")
    report["export"] = str(best.export(format="onnx", imgsz=416, opset=17, simplify=False, dynamic=False))
    labels_path = Path(report["export"]).with_suffix(".labels.json")
    labels_path.write_text(json.dumps([{"id": int(i), "kind": name, "label": name} for i, name in best.names.items()], indent=2), encoding="utf-8")
    report["labels"] = str(labels_path)
    report["limitation"] = "Existing validation split; independent live OBS session still required before promotion."
    (experiment / "comparison.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("COMPARISON=" + json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
