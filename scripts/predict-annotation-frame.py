"""Return YOLO suggestions for one annotation frame as normalized JSON boxes."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from ultralytics import YOLO


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=Path)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--confidence", type=float, default=0.28)
    args = parser.parse_args()

    device = "cpu" if args.model.suffix.lower() == ".onnx" else 0
    result = YOLO(str(args.model), task="detect").predict(str(args.image), imgsz=640, conf=args.confidence, device=device, verbose=False)[0]
    width, height = result.orig_shape[1], result.orig_shape[0]
    suggestions = []
    if result.boxes is not None:
        for xyxy, confidence, class_id in zip(result.boxes.xyxy.cpu().tolist(), result.boxes.conf.cpu().tolist(), result.boxes.cls.cpu().tolist()):
            x1, y1, x2, y2 = xyxy
            suggestions.append({
                "classId": int(class_id), "confidence": round(float(confidence), 4),
                "x": ((x1 + x2) / 2) / width, "y": ((y1 + y2) / 2) / height,
                "width": (x2 - x1) / width, "height": (y2 - y1) / height,
            })
    print("PREDICTIONS_JSON=" + json.dumps({"suggestions": suggestions}))


if __name__ == "__main__":
    main()
