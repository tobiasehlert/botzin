"""Build a clean YOLO dataset for creatures, NPCs and items.

The dataset deliberately does not consume gameplay videos or previous detector
checkpoints. Creature and item artwork comes from the local knowledge assets; NPC
proxies are rendered from the Tibia client's two-layer character/NPC outfits.

Items are placed both in the game viewport and in synthetic equipment, backpack and
hotkey slots. Empty UI, bars, rocks and vegetation are retained as hard negatives so
the detector does not learn that every sharp interface element is an entity.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import shutil
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import yaml
from PIL import Image, ImageDraw, ImageEnhance


CLASS_IDS = {"creature": 0, "npc": 1, "item": 2, "effect": 3, "missile": 4}

# The annotator works with 16 classes; only these five exist in the detector.
# UI panels, the own character, other players and corpses are annotated but have
# no target class here, so their boxes are dropped rather than guessed into one.
HUMAN_CLASS_MAP = {
    "creature_alive": "creature",
    "npc": "npc",
    "item": "item",
    "effect": "effect",
    "missile": "missile",
}
HUMAN_MASK_CLASS = "ignored_region"
TEMPLATE_REGIONS = {
    (255, 255, 0): "head",
    (255, 0, 0): "body",
    (0, 255, 0): "legs",
    (0, 0, 255): "feet",
}


@dataclass(frozen=True)
class OutfitFrame:
    base: Path
    template: Path


@dataclass(frozen=True)
class Placement:
    class_name: str
    sprite: Image.Image
    region: tuple[int, int, int, int]
    size_range: tuple[int, int]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--knowledge", type=Path, default=Path("storage/knowledge"))
    parser.add_argument("--output", type=Path, default=Path("storage/knowledge/entity-training-clean"))
    parser.add_argument("--train-samples", type=int, default=6000)
    parser.add_argument("--val-samples", type=int, default=750)
    parser.add_argument("--train-negatives", type=int, default=750)
    parser.add_argument("--val-negatives", type=int, default=150)
    parser.add_argument("--image-size", type=int, default=320)
    parser.add_argument("--seed", type=int, default=20260810)
    parser.add_argument("--force", action="store_true", help="replace an existing generated dataset")
    parser.add_argument(
        "--human-annotations",
        action="store_true",
        help="fold the reviewed human annotations into the dataset; frames taken from "
             "gameplay video are counted in the manifest and break clean-source isolation",
    )
    parser.add_argument("--self-check", action="store_true", help="run the box geometry asserts and exit")
    return parser.parse_args()


def self_check() -> None:
    """Box geometry is the one place a silent error trains a model on wrong labels."""
    # 640x320 frame letterboxed into 320x320: horizontal untouched, vertical halved
    # and pushed down by the 80px pad.
    assert letterbox_box({"x": 0.5, "y": 0.5, "width": 0.25, "height": 0.5}, (320, 160), (0, 80), 320) \
        == (0.5, 0.5, 0.25, 0.25)
    corner = letterbox_box({"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2}, (320, 160), (0, 80), 320)
    assert corner is not None and abs(corner[1] - 0.3) < 1e-9 and abs(corner[3] - 0.1) < 1e-9
    # An already square frame needs no correction at all.
    assert letterbox_box({"x": 0.5, "y": 0.5, "width": 0.25, "height": 0.5}, (320, 320), (0, 0), 320) \
        == (0.5, 0.5, 0.25, 0.5)
    # A sprite clipped to nothing by the padding is dropped, not emitted as zero.
    assert letterbox_box({"x": 0.0, "y": 0.5, "width": 0.0005, "height": 0.5}, (320, 160), (0, 80), 320) is None
    assert set(HUMAN_CLASS_MAP.values()) <= set(CLASS_IDS)
    print("[clean-dataset] self-check ok")


def main() -> None:
    args = parse_args()
    if args.self_check:
        self_check()
        return
    if args.image_size < 160:
        raise ValueError("--image-size must be at least 160")
    if min(args.train_samples, args.val_samples, args.train_negatives, args.val_negatives) < 0:
        raise ValueError("sample counts must not be negative")

    knowledge = args.knowledge.resolve()
    output = args.output.resolve()
    if output.exists():
        if not args.force:
            raise RuntimeError(f"Dataset already exists: {output}. Pass --force to replace it.")
        shutil.rmtree(output)

    creatures = load_manifest_frames(knowledge / "creature-assets")
    items = load_manifest_frames(knowledge / "item-assets")
    effects = load_manifest_frames(knowledge / "effect-assets")
    missiles = load_manifest_frames(knowledge / "missile-assets")
    outfits = load_outfit_frames(knowledge)
    if not creatures or not items or not effects or not missiles or not outfits:
        raise RuntimeError(
            f"Missing assets: creatures={len(creatures)} items={len(items)} effects={len(effects)} "
            f"missiles={len(missiles)} npcOutfitFrames={len(outfits)}"
        )

    human_records = load_human_records(knowledge / "human-annotations") if args.human_annotations else []
    # Every fifth record validates, so the split is stable across rebuilds and the
    # same frame never lands in train and val at once.
    human_split = {
        "val": [record for index, record in enumerate(human_records) if index % 5 == 0],
        "train": [record for index, record in enumerate(human_records) if index % 5 != 0],
    }
    human_written = {"train": 0, "val": 0}

    rng = random.Random(args.seed)
    for split, positives, negatives in (
        ("train", args.train_samples, args.train_negatives),
        ("val", args.val_samples, args.val_negatives),
    ):
        image_dir = output / "images" / split
        label_dir = output / "labels" / split
        image_dir.mkdir(parents=True, exist_ok=True)
        label_dir.mkdir(parents=True, exist_ok=True)
        build_split(
            rng, image_dir, label_dir, positives, negatives, args.image_size,
            creatures, outfits, items, effects, missiles,
        )
        human_written[split] = add_human_samples(
            human_split[split], image_dir, label_dir, args.image_size, "human"
        )

    gameplay_frames = sum(
        1 for record in human_records if "visual-training" in record["sourcePath"].as_posix()
    )

    data = {
        "path": str(output),
        "train": "images/train",
        "val": "images/val",
        "names": {class_id: name for name, class_id in CLASS_IDS.items()},
    }
    (output / "data.yaml").write_text(
        yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8"
    )
    manifest = {
        "version": 1,
        "kind": "clean-procedural-entities",
        "seed": args.seed,
        "imageSize": args.image_size,
        "classes": CLASS_IDS,
        "sources": {
            # Counted, not asserted: folding in human annotations of gameplay
            # frames is what breaks isolation, and the validator must be able to
            # see it rather than take the builder's word for it.
            "gameplayVideos": gameplay_frames,
            "previousCheckpoints": 0,
            "humanAnnotatedFrames": human_written["train"] + human_written["val"],
            "creatureSpecies": len(creatures),
            "itemAssets": len(items),
            "effectAssets": len(effects),
            "missileAssets": len(missiles),
            "npcOutfitFrames": len(outfits),
        },
        "samples": {
            "trainPositive": args.train_samples,
            "trainNegative": args.train_negatives,
            "valPositive": args.val_samples,
            "valNegative": args.val_negatives,
            "trainHuman": human_written["train"],
            "valHuman": human_written["val"],
        },
        "itemContexts": ["ground", "equipment", "backpack", "hotkey"],
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(
        f"[clean-dataset] ready path={output} creatures={len(creatures)} "
        f"npcFrames={len(outfits)} items={len(items)} effects={len(effects)} missiles={len(missiles)} "
        f"human={human_written['train'] + human_written['val']} gameplayFrames={gameplay_frames} "
        f"train={args.train_samples + args.train_negatives + human_written['train']} "
        f"val={args.val_samples + args.val_negatives + human_written['val']}"
    )


def load_human_records(annotations: Path) -> list[dict]:
    """Reviewed, non-ignored annotation records that still have a readable frame."""
    classes_path = annotations / "classes.json"
    if not classes_path.is_file():
        return []
    classes = json.loads(classes_path.read_text(encoding="utf-8"))
    root = annotations.parents[2]
    records = []
    for path in sorted((annotations / "records").glob("*.json")):
        record = json.loads(path.read_text(encoding="utf-8"))
        if not record.get("reviewed") or record.get("ignored"):
            continue
        source = root / str(record.get("source", "")).replace("\\", "/")
        if not source.is_file():
            continue
        record["sourcePath"] = source
        record["classNames"] = classes
        records.append(record)
    return records


def add_human_samples(
    records: list[dict], image_dir: Path, label_dir: Path, size: int, stem_prefix: str
) -> int:
    """
    Writes the annotated real frames letterboxed into the same square canvas the
    synthetic samples use. The runtime letterboxes at inference too, so stretching
    them to a square here would train on geometry production never sees.
    """
    written = 0
    for index, record in enumerate(records):
        classes = record["classNames"]
        with Image.open(record["sourcePath"]) as opened:
            frame = opened.convert("RGB")

        draw = ImageDraw.Draw(frame)
        width, height = frame.size
        for box in record.get("boxes", []):
            if classes[int(box["classId"])] != HUMAN_MASK_CLASS:
                continue
            draw.rectangle(
                (
                    (box["x"] - box["width"] / 2) * width,
                    (box["y"] - box["height"] / 2) * height,
                    (box["x"] + box["width"] / 2) * width,
                    (box["y"] + box["height"] / 2) * height,
                ),
                fill="black",
            )

        scale = size / max(width, height)
        scaled = (max(1, round(width * scale)), max(1, round(height * scale)))
        canvas = Image.new("RGB", (size, size), (0, 0, 0))
        offset = ((size - scaled[0]) // 2, (size - scaled[1]) // 2)
        canvas.paste(frame.resize(scaled, Image.LANCZOS), offset)

        lines = []
        for box in record.get("boxes", []):
            target = HUMAN_CLASS_MAP.get(classes[int(box["classId"])])
            if target is None:
                continue
            placed = letterbox_box(box, scaled, offset, size)
            if placed is None:
                continue
            x, y, box_width, box_height = placed
            lines.append(
                f"{CLASS_IDS[target]} {x:.6f} {y:.6f} {box_width:.6f} {box_height:.6f}"
            )
        if not lines:
            continue

        stem = f"{stem_prefix}-{index:06d}"
        canvas.save(image_dir / f"{stem}.jpg", quality=95)
        (label_dir / f"{stem}.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
        written += 1
    return written


def letterbox_box(
    box: dict, scaled: tuple[int, int], offset: tuple[int, int], size: int
) -> tuple[float, float, float, float] | None:
    """Normalised box in the original frame → normalised box in the padded canvas."""
    x = (box["x"] * scaled[0] + offset[0]) / size
    y = (box["y"] * scaled[1] + offset[1]) / size
    width = box["width"] * scaled[0] / size
    height = box["height"] * scaled[1] / size
    left, right = max(0.0, x - width / 2), min(1.0, x + width / 2)
    top, bottom = max(0.0, y - height / 2), min(1.0, y + height / 2)
    # The validator rejects zero-sized and out-of-range boxes, so a sprite clipped
    # away by the padding is dropped here instead of failing the whole run later.
    if right - left <= 0.001 or bottom - top <= 0.001:
        return None
    return (left + right) / 2, (top + bottom) / 2, right - left, bottom - top


def load_manifest_frames(root: Path) -> list[list[Path]]:
    groups: list[list[Path]] = []
    for manifest_path in sorted(root.glob("*/manifest.json")):
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        frames = [manifest_path.parent / str(value) for value in payload.get("files", [])]
        frames = [path for path in frames if path.is_file()]
        if frames:
            groups.append(frames)
    return groups


def load_outfit_frames(knowledge: Path) -> list[OutfitFrame]:
    catalog = json.loads((knowledge / "client-outfits.json").read_text(encoding="utf-8"))["entries"]
    sprites = knowledge / "client-sprites"
    frames: list[OutfitFrame] = []
    for entry in catalog:
        for group in entry.get("frameGroups", []):
            info = group.get("spriteInfo", {})
            if info.get("layers") != 2:
                continue
            ids = info.get("spriteIds", [])
            directions = min(4, int(info.get("patternWidth", 1)))
            animation_frames = max(1, int(info.get("frames", 1)))
            for frame in range(animation_frames):
                for direction in range(directions):
                    base_index = sprite_index(info, frame=frame, direction=direction, layer=0)
                    template_index = sprite_index(info, frame=frame, direction=direction, layer=1)
                    if base_index >= len(ids) or template_index >= len(ids):
                        continue
                    base = sprite_path(sprites, int(ids[base_index]))
                    template = sprite_path(sprites, int(ids[template_index]))
                    if base.is_file() and template.is_file():
                        frames.append(OutfitFrame(base, template))
    return list(dict.fromkeys(frames))


def sprite_index(info: dict, *, frame: int, direction: int, layer: int) -> int:
    index = frame
    index *= int(info.get("patternDepth", 1))
    index *= int(info.get("patternHeight", 1))
    index = index * int(info.get("patternWidth", 1)) + direction
    return index * int(info.get("layers", 1)) + layer


def sprite_path(root: Path, sprite_id: int) -> Path:
    return root / f"{sprite_id // 1000:04d}" / f"{sprite_id}.png"


def build_split(
    rng: random.Random,
    image_dir: Path,
    label_dir: Path,
    positives: int,
    negatives: int,
    size: int,
    creatures: list[list[Path]],
    outfits: list[OutfitFrame],
    items: list[list[Path]],
    effects: list[list[Path]],
    missiles: list[list[Path]],
) -> None:
    total = positives + negatives
    for sample_index in range(total):
        stem = f"sample-{sample_index:06d}"
        canvas, viewport, ui_slots = procedural_scene(rng, size)
        placements: list[Placement] = []
        if sample_index < positives:
            classes = ("creature", "npc", "item", "effect", "missile")
            required = classes[sample_index % len(classes)]
            entity_classes = [required]
            entity_classes.extend(rng.choices(classes, weights=(4, 2, 5, 2, 2), k=rng.randint(1, 5)))
            for class_name in entity_classes:
                if class_name == "creature":
                    sprite = load_rgba(rng.choice(rng.choice(creatures)))
                    placements.append(Placement(class_name, sprite, viewport, (8, 34)))
                elif class_name == "npc":
                    sprite = render_outfit(rng.choice(outfits), rng)
                    placements.append(Placement(class_name, sprite, viewport, (9, 32)))
                elif class_name == "item":
                    sprite = load_rgba(rng.choice(rng.choice(items)))
                    if ui_slots and rng.random() < 0.68:
                        slot = rng.choice(ui_slots)
                        placements.append(Placement(class_name, sprite, slot, (10, 22)))
                    else:
                        placements.append(Placement(class_name, sprite, viewport, (8, 20)))
                elif class_name == "effect":
                    sprite = load_rgba(rng.choice(rng.choice(effects)))
                    placements.append(Placement(class_name, sprite, viewport, (10, 38)))
                else:
                    sprite = load_rgba(rng.choice(rng.choice(missiles)))
                    placements.append(Placement(class_name, sprite, viewport, (8, 28)))

        labels = paste_entities(canvas, placements, rng)
        canvas.save(image_dir / f"{stem}.jpg", quality=92, optimize=True)
        (label_dir / f"{stem}.txt").write_text("\n".join(labels) + ("\n" if labels else ""), encoding="utf-8")
        if (sample_index + 1) % 500 == 0 or sample_index + 1 == total:
            print(f"[clean-dataset] {image_dir.name}: {sample_index + 1}/{total}")


def procedural_scene(
    rng: random.Random, size: int
) -> tuple[Image.Image, tuple[int, int, int, int], list[tuple[int, int, int, int]]]:
    palette = rng.choice(
        (
            ((44, 52, 46), (58, 68, 57)),
            ((62, 55, 46), (77, 68, 56)),
            ((46, 48, 55), (61, 63, 72)),
            ((39, 55, 60), (48, 70, 75)),
        )
    )
    base = np.zeros((size, size, 3), dtype=np.int16)
    base[:] = palette[0]
    noise = np.random.default_rng(rng.randrange(2**32)).normal(0, 7, base.shape[:2])
    base += noise[:, :, None].astype(np.int16)
    base = np.clip(base, 0, 255).astype(np.uint8)
    canvas = Image.fromarray(base, "RGB")
    draw = ImageDraw.Draw(canvas)

    sidebar = rng.random() < 0.86
    bottom_bar = rng.random() < 0.78
    sidebar_width = rng.randint(round(size * 0.19), round(size * 0.28)) if sidebar else 0
    bottom_height = rng.randint(round(size * 0.12), round(size * 0.20)) if bottom_bar else 0
    viewport = (0, 0, size - sidebar_width, size - bottom_height)

    tile = rng.choice((16, 20, 24, 32))
    for x in range(0, viewport[2], tile):
        draw.line((x, 0, x, viewport[3]), fill=palette[1], width=1)
    for y in range(0, viewport[3], tile):
        draw.line((0, y, viewport[2], y), fill=palette[1], width=1)
    draw_clutter(draw, rng, viewport, size)

    slots: list[tuple[int, int, int, int]] = []
    panel = (24, 27, 31)
    slot_fill = (38, 42, 47)
    slot_edge = (73, 78, 84)
    slot_size = max(18, round(size * 0.075))
    gap = max(2, round(size * 0.009))
    if sidebar:
        draw.rectangle((viewport[2], 0, size, size), fill=panel)
        columns = max(2, sidebar_width // (slot_size + gap))
        for row in range(max(1, size // (slot_size + gap))):
            for column in range(columns):
                left = viewport[2] + gap + column * (slot_size + gap)
                top = gap + row * (slot_size + gap)
                if left + slot_size >= size or top + slot_size >= size:
                    continue
                slot = (left, top, left + slot_size, top + slot_size)
                draw.rectangle(slot, fill=slot_fill, outline=slot_edge, width=1)
                slots.append(slot)
    if bottom_bar:
        draw.rectangle((0, viewport[3], viewport[2], size), fill=panel)
        for column in range(max(1, viewport[2] // (slot_size + gap))):
            left = gap + column * (slot_size + gap)
            top = viewport[3] + gap
            if left + slot_size >= viewport[2] or top + slot_size >= size:
                continue
            slot = (left, top, left + slot_size, top + slot_size)
            draw.rectangle(slot, fill=slot_fill, outline=slot_edge, width=1)
            slots.append(slot)

    # Status bars and text-like strokes are deliberate sharp negatives.
    for _ in range(rng.randint(3, 10)):
        width = rng.randint(max(10, size // 25), max(20, size // 8))
        left = rng.randint(0, max(0, viewport[2] - width))
        top = rng.randint(0, max(0, viewport[3] - 4))
        draw.rectangle((left, top, left + width, top + 2), fill=rng.choice(((120, 25, 25), (28, 105, 35), (30, 55, 130))))
    return canvas, inset(viewport, max(4, size // 50)), slots


def draw_clutter(draw: ImageDraw.ImageDraw, rng: random.Random, viewport: tuple[int, int, int, int], size: int) -> None:
    left, top, right, bottom = viewport
    for _ in range(rng.randint(10, 28)):
        x = rng.randint(left, max(left, right - 1))
        y = rng.randint(top, max(top, bottom - 1))
        radius = rng.randint(max(2, size // 100), max(3, size // 35))
        colour = rng.choice(((30, 38, 30), (67, 61, 52), (48, 48, 53), (31, 57, 39)))
        if rng.random() < 0.5:
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=colour)
        else:
            points = [(x, y - radius), (x + radius, y), (x, y + radius), (x - radius, y)]
            draw.polygon(points, fill=colour)


def paste_entities(canvas: Image.Image, placements: list[Placement], rng: random.Random) -> list[str]:
    labels: list[str] = []
    occupied: list[tuple[int, int, int, int]] = []
    for placement in placements:
        sprite = trim(placement.sprite)
        if sprite.width == 0 or sprite.height == 0:
            continue
        target_side = rng.randint(*placement.size_range)
        scale = target_side / max(sprite.width, sprite.height)
        width = max(4, round(sprite.width * scale))
        height = max(4, round(sprite.height * scale))
        sprite = sprite.resize((width, height), Image.Resampling.NEAREST)
        if rng.random() < 0.22:
            sprite = ImageEnhance.Brightness(sprite).enhance(rng.uniform(0.72, 1.18))

        region = inset(placement.region, 2)
        position = find_position(rng, region, width, height, occupied)
        if position is None:
            continue
        x, y = position
        canvas.paste(sprite, (x, y), sprite)
        box = (x, y, x + width, y + height)
        occupied.append(box)
        center_x = (x + width / 2) / canvas.width
        center_y = (y + height / 2) / canvas.height
        labels.append(
            f"{CLASS_IDS[placement.class_name]} {center_x:.6f} {center_y:.6f} "
            f"{width / canvas.width:.6f} {height / canvas.height:.6f}"
        )
    return labels


def find_position(
    rng: random.Random,
    region: tuple[int, int, int, int],
    width: int,
    height: int,
    occupied: list[tuple[int, int, int, int]],
) -> tuple[int, int] | None:
    left, top, right, bottom = region
    if right - left < width or bottom - top < height:
        return None
    for _ in range(24):
        x = rng.randint(left, right - width)
        y = rng.randint(top, bottom - height)
        candidate = (x, y, x + width, y + height)
        if all(intersection_over_minimum(candidate, existing) < 0.35 for existing in occupied):
            return x, y
    return None


def intersection_over_minimum(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    width = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    height = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    intersection = width * height
    minimum = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return intersection / minimum if minimum else 0.0


def render_outfit(frame: OutfitFrame, rng: random.Random) -> Image.Image:
    base = load_rgba(frame.base)
    template = load_rgba(frame.template).resize(base.size, Image.Resampling.NEAREST)
    base_px = np.asarray(base, dtype=np.float32).copy()
    template_px = np.asarray(template, dtype=np.uint8)
    colours = {key: np.asarray(palette_colour(rng.randrange(133)), dtype=np.float32) for key in TEMPLATE_REGIONS}
    for mask_rgb, _region in TEMPLATE_REGIONS.items():
        mask = (
            np.all(template_px[:, :, :3] == np.asarray(mask_rgb, dtype=np.uint8), axis=2)
            & (template_px[:, :, 3] > 0)
            & (base_px[:, :, 3] > 0)
        )
        base_px[mask, :3] = base_px[mask, :3] * colours[mask_rgb] / 255.0
    return Image.fromarray(np.clip(base_px, 0, 255).astype(np.uint8), "RGBA")


def palette_colour(index: int) -> tuple[int, int, int]:
    hue_step = index % 19
    shade = index // 19
    hue = hue_step / 18.0
    saturation = 0.0 if shade == 0 else min(1.0, 0.2 + shade * 0.13)
    intensity = min(1.0, 0.28 + shade * 0.115)
    angle = hue * math.tau
    red = intensity * (1 + saturation * math.cos(angle))
    green = intensity * (1 + saturation * math.cos(angle - math.tau / 3))
    blue = intensity * (1 + saturation * math.cos(angle + math.tau / 3))
    maximum = max(red, green, blue, 1.0)
    return tuple(round(max(0.0, min(1.0, value / maximum)) * 255) for value in (red, green, blue))


def load_rgba(path: Path) -> Image.Image:
    with Image.open(path) as source:
        return source.convert("RGBA")


def trim(image: Image.Image) -> Image.Image:
    box = image.getchannel("A").getbbox()
    return image.crop(box) if box else Image.new("RGBA", (0, 0))


def inset(region: tuple[int, int, int, int], amount: int) -> tuple[int, int, int, int]:
    left, top, right, bottom = region
    return left + amount, top + amount, max(left + amount, right - amount), max(top + amount, bottom - amount)


if __name__ == "__main__":
    main()
