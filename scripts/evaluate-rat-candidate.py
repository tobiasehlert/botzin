"""Compare creature detections at fixed confidence on the untouched valid holdout."""
import argparse
import json
from pathlib import Path
from PIL import Image, ImageDraw
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parents[1]


def iou(a, b):
    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection
    return intersection / union if union > 0 else 0


def evaluate(model_path, paths, output, name):
    model = YOLO(str(model_path))
    totals = {"truePositive": 0, "falsePositive": 0, "falseNegative": 0, "frames": len(paths)}
    examples = []
    for path in paths:
        result = model.predict(str(path), imgsz=416, conf=0.25, device=0, verbose=False)[0]
        height, width = result.orig_shape
        labels = (path.parent.parent.parent / "labels" / path.parent.name / (path.stem + ".txt")).read_text().splitlines()
        truth = []
        for line in labels:
            cls, x, y, w, h = map(float, line.split())
            if int(cls) == 0:
                truth.append([(x - w / 2) * width, (y - h / 2) * height, (x + w / 2) * width, (y + h / 2) * height])
        predictions = [(b.xyxy.tolist()[0], float(b.conf.item())) for b in result.boxes if int(b.cls.item()) == 0]
        unmatched = set(range(len(truth)))
        for box, confidence in sorted(predictions, key=lambda item: -item[1]):
            match = max(unmatched, key=lambda i: iou(box, truth[i]), default=None)
            if match is not None and iou(box, truth[match]) >= 0.5:
                unmatched.remove(match)
                totals["truePositive"] += 1
            else:
                totals["falsePositive"] += 1
        totals["falseNegative"] += len(unmatched)
        if truth and len(examples) < 3:
            with Image.open(path) as opened:
                image = opened.convert("RGB")
            draw = ImageDraw.Draw(image)
            for box in truth:
                draw.rectangle(box, outline="#ffc857", width=2)
            for box, confidence in predictions:
                draw.rectangle(box, outline="#39ff98", width=2)
                draw.text((box[0], max(0, box[1] - 13)), f"creature {confidence:.0%}", fill="#39ff98")
            artifact = output / f"{name}-{path.stem}.png"
            image.save(artifact)
            examples.append(str(artifact))
    tp, fp, fn = totals["truePositive"], totals["falsePositive"], totals["falseNegative"]
    return {**totals, "precision": tp / (tp + fp) if tp + fp else 0, "recall": tp / (tp + fn) if tp + fn else 0, "examples": examples}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("experiment", type=Path)
    args = parser.parse_args()
    report = json.loads((args.experiment / "comparison.json").read_text())
    paths = [Path(line) for line in (args.experiment / "val.txt").read_text().splitlines()]
    output = args.experiment / "fixed-evaluation"
    output.mkdir(exist_ok=True)
    evaluation = {"confidence": 0.25, "iou": 0.5, "class": "creature", "before": evaluate(Path(report["base"]), paths, output, "before"), "after": evaluate(Path(report["checkpoint"]), paths, output, "after")}
    (output / "report.json").write_text(json.dumps(evaluation, indent=2), encoding="utf-8")
    print(json.dumps(evaluation), flush=True)


if __name__ == "__main__":
    main()
