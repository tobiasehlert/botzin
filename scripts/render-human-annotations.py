from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ANNOTATIONS = ROOT / "storage" / "knowledge" / "human-annotations"
OUTPUT = ROOT / "validacao-anotacoes-humanas"
COLORS = [
    "#2474ff", "#ffb020", "#f4e24b", "#18d7be", "#b68cff", "#ff5e7a",
    "#54c7ec", "#ff4057", "#438cff", "#d46cff", "#ff8a3d", "#a4dc55",
    "#ffffff", "#a052e0", "#777777", "#f0a040",
]


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    classes = json.loads((ANNOTATIONS / "classes.json").read_text(encoding="utf-8"))
    font = ImageFont.load_default(size=16)
    for record_path in sorted((ANNOTATIONS / "records").glob("*.json")):
        record = json.loads(record_path.read_text(encoding="utf-8"))
        source = ROOT / record["source"]
        with Image.open(source) as opened:
            image = opened.convert("RGB")
        draw = ImageDraw.Draw(image)
        width, height = image.size
        for box in record.get("boxes", []):
            class_id = int(box["classId"])
            x1 = int((box["x"] - box["width"] / 2) * width)
            y1 = int((box["y"] - box["height"] / 2) * height)
            x2 = int((box["x"] + box["width"] / 2) * width)
            y2 = int((box["y"] + box["height"] / 2) * height)
            color = COLORS[class_id % len(COLORS)]
            label = classes[class_id]
            if box.get("itemCategory"):
                label += f" · {box['itemCategory']}"
            draw.rectangle((x1, y1, x2, y2), outline=color, width=3)
            text_box = draw.textbbox((x1, y1), label, font=font, stroke_width=2)
            text_height = text_box[3] - text_box[1]
            text_y = max(0, y1 - text_height - 5)
            draw.text((x1 + 2, text_y), label, fill=color, font=font, stroke_width=2, stroke_fill="#000000")
        if record.get("ignored"):
            draw.rectangle((0, 0, width - 1, height - 1), outline="#ff4057", width=8)
            draw.text((14, 14), "FRAME IGNORADO — NÃO ENTRA NO TREINO", fill="#ff4057", font=font, stroke_width=2, stroke_fill="#000000")
        image.save(OUTPUT / f"{record_path.stem}.jpg", quality=94)
    print(f"Geradas {len(list(OUTPUT.glob('*.jpg')))} imagens em {OUTPUT}")


if __name__ == "__main__":
    main()
