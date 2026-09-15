"""Build a masked YOLO dataset from reviewed human annotations and train an experimental model."""

from __future__ import annotations

import argparse
import json
import random
import shutil
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageDraw
from ultralytics import YOLO


ROOT = Path(__file__).resolve().parents[1]
ANNOTATIONS = ROOT / "storage" / "knowledge" / "human-annotations"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--image-size", type=int, default=640)
    parser.add_argument("--batch", type=int, default=2)
    parser.add_argument("--device", default="0")
    parser.add_argument("--base-model", default="yolo11n.pt")
    parser.add_argument("--output-model", type=Path, default=ROOT / "models" / "candidates" / "tibia-human-annotations-experimental.pt")
    parser.add_argument("--replay-dataset", type=Path)
    parser.add_argument("--replay-samples", type=int, default=0)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    classes = json.loads((ANNOTATIONS / "classes.json").read_text(encoding="utf-8"))
    ignored_id = classes.index("ignored_region")
    records = []
    for path in sorted((ANNOTATIONS / "records").glob("*.json")):
        record = json.loads(path.read_text(encoding="utf-8"))
        if record.get("reviewed") and not record.get("ignored"):
            records.append((path.stem, record))
    if len(records) < 4:
        raise RuntimeError("São necessários pelo menos quatro frames revisados e não ignorados.")

    rng = random.Random(42)
    rng.shuffle(records)
    validation_count = max(2, round(len(records) * 0.2))
    validation_names = {name for name, _ in records[:validation_count]}
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dataset = ROOT / "storage" / "knowledge" / "human-training-experiments" / stamp
    for split in ("train", "val"):
        (dataset / "images" / split).mkdir(parents=True, exist_ok=True)
        (dataset / "labels" / split).mkdir(parents=True, exist_ok=True)

    counts = {name: 0 for name in classes if name != "ignored_region"}
    for name, record in records:
        split = "val" if name in validation_names else "train"
        source = ROOT / record["source"]
        destination = dataset / "images" / split / f"{name}.jpg"
        with Image.open(source) as opened:
            image = opened.convert("RGB")
        draw = ImageDraw.Draw(image)
        width, height = image.size
        for box in record.get("boxes", []):
            if int(box["classId"]) != ignored_id:
                continue
            x1 = (box["x"] - box["width"] / 2) * width
            y1 = (box["y"] - box["height"] / 2) * height
            x2 = (box["x"] + box["width"] / 2) * width
            y2 = (box["y"] + box["height"] / 2) * height
            draw.rectangle((x1, y1, x2, y2), fill="black")
        image.save(destination, quality=95)

        lines = []
        for box in record.get("boxes", []):
            class_id = int(box["classId"])
            if class_id == ignored_id:
                continue
            counts[classes[class_id]] += 1
            lines.append(f"{class_id} {box['x']:.6f} {box['y']:.6f} {box['width']:.6f} {box['height']:.6f}")
        (dataset / "labels" / split / f"{name}.txt").write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")

    replay_count = 0
    if args.replay_dataset and args.replay_samples > 0:
        replay_images = sorted((args.replay_dataset / "images" / "train").glob("*"))
        replay_images = [path for path in replay_images if path.suffix.lower() in {".jpg", ".jpeg", ".png"}]
        rng.shuffle(replay_images)
        for source in replay_images[: args.replay_samples]:
            source_label = args.replay_dataset / "labels" / "train" / f"{source.stem}.txt"
            if not source_label.exists():
                continue
            target_stem = f"replay_{source.stem}"
            shutil.copy2(source, dataset / "images" / "train" / f"{target_stem}{source.suffix.lower()}")
            shutil.copy2(source_label, dataset / "labels" / "train" / f"{target_stem}.txt")
            replay_count += 1

    yaml_names = "\n".join(f"  {index}: {name}" for index, name in enumerate(classes))
    (dataset / "data.yaml").write_text(
        f"path: {dataset.as_posix()}\ntrain: images/train\nval: images/val\nnames:\n{yaml_names}\n",
        encoding="utf-8",
    )
    manifest = {"frames": len(records), "train": len(records) - validation_count, "validation": validation_count, "replaySamples": replay_count, "classes": counts}
    (dataset / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"[human-train] dataset={dataset}", flush=True)
    print(f"[human-train] train={manifest['train']} val={manifest['validation']} replay={replay_count} epochs={args.epochs}", flush=True)

    result = YOLO(args.base_model).train(
        data=str(dataset / "data.yaml"), epochs=args.epochs, imgsz=args.image_size,
        batch=args.batch, device=args.device, workers=0, seed=42, patience=args.epochs,
        project=str(dataset / "runs"), name="human-annotations", plots=True, verbose=True,
    )
    best = Path(result.save_dir) / "weights" / "best.pt"
    candidate = args.output_model
    candidate.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(best, candidate)
    print(f"[human-train] best={candidate}", flush=True)


if __name__ == "__main__":
    main()
