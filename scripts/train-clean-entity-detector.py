"""Train/export the isolated creature, NPC and item detector.

This script refuses datasets that mention gameplay videos or previous checkpoints.
By default it initializes YOLO11n from architecture only (random weights), so no
class head or metadata from an older Botzin model can leak into the new detector.
Pass --pretrained-backbone to start from the official COCO weights instead.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

from ultralytics import YOLO


EXPECTED_CLASSES = {"creature": 0, "npc": 1, "item": 2, "effect": 3, "missile": 4}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--knowledge", type=Path, default=Path("storage/knowledge"))
    parser.add_argument("--dataset", type=Path, default=Path("storage/knowledge/entity-training-clean"))
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--image-size", type=int, default=320)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--workers", type=int, default=0)
    parser.add_argument("--pretrained-backbone", action="store_true")
    parser.add_argument("--output-model", type=Path, default=Path("models/candidates/tibia-entities-five.onnx"))
    parser.add_argument("--output-labels", type=Path, default=Path("models/candidates/tibia-entities-five.labels.json"))
    parser.add_argument(
        "--allow-gameplay-frames",
        action="store_true",
        help="train on a dataset built with --human-annotations from gameplay frames",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    dataset = args.dataset.resolve()
    validator = Path(__file__).with_name("validate-clean-entity-sources.py")
    subprocess.run(
        [
            sys.executable,
            str(validator),
            "--knowledge", str(args.knowledge.resolve()),
            "--dataset", str(dataset),
        ]
        + (["--allow-gameplay-frames"] if args.allow_gameplay_frames else []),
        check=True,
    )
    validation = json.loads((dataset / "source-validation.json").read_text(encoding="utf-8"))
    if not validation.get("valid"):
        raise RuntimeError("Clean source validation did not pass.")
    if not validation.get("isolated") and not args.allow_gameplay_frames:
        raise RuntimeError("Clean source validation did not pass.")
    manifest = json.loads((dataset / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("classes") != EXPECTED_CLASSES:
        raise RuntimeError(f"Unexpected dataset classes: {manifest.get('classes')}")
    sources = manifest.get("sources", {})
    if sources.get("previousCheckpoints") != 0:
        raise RuntimeError(f"Dataset is not isolated: {sources}")
    if sources.get("gameplayVideos") != 0 and not args.allow_gameplay_frames:
        raise RuntimeError(f"Dataset is not isolated: {sources}")
    if args.allow_gameplay_frames:
        print(
            f"[clean-train] isolation off: {sources.get('gameplayVideos')} gameplay frames, "
            f"{sources.get('humanAnnotatedFrames')} human-annotated samples"
        )

    base = "yolo11n.pt" if args.pretrained_backbone else "yolo11n.yaml"
    run_name = "clean-pretrained" if args.pretrained_backbone else "clean-random-init"
    result = YOLO(base).train(
        data=str(dataset / "data.yaml"),
        epochs=args.epochs,
        imgsz=args.image_size,
        batch=args.batch,
        device=args.device,
        workers=args.workers,
        freeze=0,
        project=str(dataset / "runs"),
        name=run_name,
        exist_ok=False,
        patience=max(4, args.epochs),
        warmup_epochs=1.0,
        seed=int(manifest["seed"]),
        plots=True,
        verbose=True,
    )
    best = Path(result.save_dir) / "weights" / "best.pt"
    exported = Path(YOLO(str(best)).export(
        format="onnx", imgsz=args.image_size, opset=17, simplify=False, dynamic=False
    ))
    args.output_model.parent.mkdir(parents=True, exist_ok=True)
    args.output_labels.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(exported, args.output_model)
    labels = [
        {"id": class_id, "kind": name, "label": name}
        for name, class_id in sorted(EXPECTED_CLASSES.items(), key=lambda entry: entry[1])
    ]
    args.output_labels.write_text(json.dumps(labels, indent=2) + "\n", encoding="utf-8")
    print(f"[clean-train] model={args.output_model.resolve()} labels={args.output_labels.resolve()}")


if __name__ == "__main__":
    main()
