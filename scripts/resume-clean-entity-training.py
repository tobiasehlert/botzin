"""Resume clean creature/NPC/item training from the portable Git LFS bundle."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import yaml
from ultralytics import YOLO


EXPECTED_CLASSES = {"creature": 0, "npc": 1, "item": 2, "effect": 3, "missile": 4}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=Path("storage/knowledge/entity-training-clean"))
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--image-size", type=int, default=320)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--device", default="0")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument(
        "--output-model",
        type=Path,
        default=Path("models/candidates/tibia-entities-five-resumed.onnx"),
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    dataset = args.dataset.resolve()
    checkpoint = args.checkpoint.resolve()
    validate_portable_dataset(dataset)
    if not checkpoint.is_file():
        raise FileNotFoundError(f"Checkpoint not found: {checkpoint}")

    portable_yaml = dataset / "data-portable.yaml"
    portable_yaml.write_text(
        yaml.safe_dump(
            {
                "path": str(dataset),
                "train": "images/train",
                "val": "images/val",
                "names": {class_id: name for name, class_id in EXPECTED_CLASSES.items()},
            },
            sort_keys=False,
            allow_unicode=True,
        ),
        encoding="utf-8",
    )

    result = YOLO(str(checkpoint)).train(
        data=str(portable_yaml),
        epochs=args.epochs,
        imgsz=args.image_size,
        batch=args.batch,
        device=args.device,
        workers=args.workers,
        freeze=0,
        project=str(dataset / "runs"),
        name="clean-resumed",
        exist_ok=False,
        patience=max(10, args.epochs),
        warmup_epochs=1.0,
        seed=20260810,
        plots=True,
        verbose=True,
    )
    best = Path(result.save_dir) / "weights" / "best.pt"
    exported = Path(
        YOLO(str(best)).export(
            format="onnx",
            imgsz=args.image_size,
            opset=17,
            simplify=False,
            dynamic=False,
        )
    )
    args.output_model.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(exported, args.output_model)
    print(f"[clean-resume] checkpoint={best.resolve()}")
    print(f"[clean-resume] model={args.output_model.resolve()}")


def validate_portable_dataset(dataset: Path) -> None:
    manifest_path = dataset / "manifest.json"
    report_path = dataset / "source-validation.json"
    if not manifest_path.is_file() or not report_path.is_file():
        raise RuntimeError("The clean dataset manifest or validation report is missing.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if manifest.get("classes") != EXPECTED_CLASSES:
        raise RuntimeError(f"Unexpected classes: {manifest.get('classes')!r}")
    sources = manifest.get("sources", {})
    if sources.get("gameplayVideos") != 0 or sources.get("previousCheckpoints") != 0:
        raise RuntimeError(f"The dataset is not isolated: {sources!r}")
    if not report.get("valid") or not report.get("isolated"):
        raise RuntimeError("The packaged dataset did not pass clean-source validation.")

    expected = report.get("dataset", {}).get("splits", {})
    for split in ("train", "val"):
        image_count = sum(1 for _ in (dataset / "images" / split).glob("*.jpg"))
        label_count = sum(1 for _ in (dataset / "labels" / split).glob("*.txt"))
        split_expected = expected.get(split, {})
        if image_count != split_expected.get("images") or label_count != split_expected.get("labels"):
            raise RuntimeError(
                f"Incomplete {split} split: images={image_count}, labels={label_count}, "
                f"expected={split_expected!r}"
            )


if __name__ == "__main__":
    main()
