"""Validate clean creature/NPC/item sources and the generated YOLO dataset."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

import yaml
from PIL import Image, UnidentifiedImageError


EXPECTED_CLASSES = {"creature": 0, "npc": 1, "item": 2, "effect": 3, "missile": 4}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--knowledge", type=Path, default=Path("storage/knowledge"))
    parser.add_argument("--dataset", type=Path, default=Path("storage/knowledge/entity-training-clean"))
    parser.add_argument("--report", type=Path)
    parser.add_argument(
        "--allow-gameplay-frames",
        action="store_true",
        help="accept a dataset that includes human-annotated gameplay frames; the "
             "report still records isolated=false",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    knowledge = args.knowledge.resolve()
    dataset = args.dataset.resolve()
    errors: list[str] = []
    warnings: list[str] = []

    creatures = validate_manifest_assets(
        knowledge / "creature-assets", "creature", errors, warnings, require_multiple_frames=True
    )
    items = validate_manifest_assets(
        knowledge / "item-assets", "item", errors, warnings, require_multiple_frames=False
    )
    effects = summarize_numeric_assets(knowledge / "effect-assets", "effect", errors)
    missiles = summarize_numeric_assets(knowledge / "missile-assets", "missile", errors)
    dataset_stats = validate_dataset(dataset, errors)
    manifest_path = dataset / "manifest.json"
    clean_manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {}
    sources = clean_manifest.get("sources", {})
    gameplay_frames = sources.get("gameplayVideos")
    if gameplay_frames != 0:
        # Isolation is the default and the reason this pipeline is called clean.
        # Turning it off has to be a deliberate act recorded in the report, never
        # something a rebuild can do quietly.
        if args.allow_gameplay_frames and isinstance(gameplay_frames, int) and gameplay_frames > 0:
            warnings.append(
                f"dataset includes {gameplay_frames} human-annotated gameplay frames; "
                "clean-source isolation is off for this build"
            )
        else:
            errors.append(
                f"dataset declares gameplayVideos={gameplay_frames!r}, expected 0 "
                "(pass --allow-gameplay-frames to accept human-annotated frames)"
            )
    if sources.get("previousCheckpoints") != 0:
        errors.append(f"dataset declares previousCheckpoints={sources.get('previousCheckpoints')!r}, expected 0")
    if clean_manifest.get("classes") != EXPECTED_CLASSES:
        errors.append(f"dataset manifest classes are {clean_manifest.get('classes')!r}, expected {EXPECTED_CLASSES!r}")

    required = {
        "undeaddragon": "Undead Dragons",
        "hydra": "Hydras",
        "dragon": "Dragons",
    }
    by_race = {entry["race"]: entry for entry in creatures["entries"]}
    required_status = {}
    for race, expected_name in required.items():
        entry = by_race.get(race)
        ok = bool(entry and entry["name"] == expected_name and entry["validFrames"] > 0)
        required_status[race] = {
            "valid": ok,
            "expectedName": expected_name,
            "actualName": entry["name"] if entry else None,
            "validFrames": entry["validFrames"] if entry else 0,
        }
        if not ok:
            errors.append(f"required creature {race!r} is missing or invalid")

    report = {
        "version": 1,
        "valid": not errors,
        "isolated": sources.get("gameplayVideos") == 0 and sources.get("previousCheckpoints") == 0,
        "creatures": without_entries(creatures),
        "items": without_entries(items),
        "effects": without_entries(effects),
        "missiles": without_entries(missiles),
        "requiredCreatures": required_status,
        "dataset": dataset_stats,
        "errors": errors,
        "warnings": warnings[:200],
        "warningCount": len(warnings),
    }
    report_path = (args.report or (dataset / "source-validation.json")).resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"[clean-validate] valid={report['valid']} isolated={report['isolated']} "
        f"creatures={creatures['assetCount']} creatureFrames={creatures['validFrames']} "
        f"items={items['assetCount']} itemFrames={items['validFrames']} "
        f"effects={effects['assetCount']} effectFrames={effects['validFrames']} "
        f"missiles={missiles['assetCount']} missileFrames={missiles['validFrames']} "
        f"errors={len(errors)} warnings={len(warnings)} report={report_path}"
    )
    if errors:
        for error in errors[:30]:
            print(f"[clean-validate] ERROR {error}")
        raise SystemExit(1)


def validate_manifest_assets(
    root: Path,
    kind: str,
    errors: list[str],
    warnings: list[str],
    *,
    require_multiple_frames: bool,
) -> dict:
    entries = []
    races: Counter[str] = Counter()
    names: Counter[str] = Counter()
    catalog_ids: Counter[int] = Counter()
    frame_owners: dict[str, set[str]] = defaultdict(set)
    manifest_paths = sorted(root.glob("*/manifest.json"))
    for index, manifest_path in enumerate(manifest_paths):
        try:
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            errors.append(f"{kind} manifest unreadable: {manifest_path}: {error}")
            continue
        race = str(payload.get("race") or manifest_path.parent.name)
        name = str(payload.get("name") or "").strip()
        files = [manifest_path.parent / str(value) for value in payload.get("files", [])]
        if not name:
            errors.append(f"{kind} manifest has no name: {manifest_path}")
        if require_multiple_frames and len(files) < 2:
            errors.append(f"{kind} {race} has fewer than two declared frames")
        races[race] += 1
        names[name.casefold()] += 1
        if payload.get("catalogId") is not None:
            catalog_ids[int(payload["catalogId"])] += 1

        valid_frames = 0
        for frame_path in files:
            reason = invalid_frame_reason(frame_path)
            if reason:
                errors.append(f"{kind} frame {reason}: {frame_path}")
                continue
            valid_frames += 1
            frame_owners[hashlib.sha256(frame_path.read_bytes()).hexdigest()].add(race)
        entries.append({"race": race, "name": name, "validFrames": valid_frames})
        if (index + 1) % 1000 == 0:
            print(f"[clean-validate] {kind} manifests {index + 1}/{len(manifest_paths)}")

    duplicate_races = sorted(key for key, count in races.items() if count > 1)
    duplicate_catalog_ids = sorted(key for key, count in catalog_ids.items() if count > 1)
    shared_frame_groups = [sorted(owners) for owners in frame_owners.values() if len(owners) > 1]
    if duplicate_races:
        errors.append(f"{kind} duplicate races: {duplicate_races[:20]}")
    if duplicate_catalog_ids:
        errors.append(f"{kind} duplicate catalog ids: {duplicate_catalog_ids[:20]}")
    if shared_frame_groups:
        warnings.append(
            f"{kind} has {len(shared_frame_groups)} exact frame hashes shared by different entries; "
            "this is acceptable for generic detection but not for species classification"
        )
    duplicate_names = sum(1 for name, count in names.items() if name and count > 1)
    return {
        "assetCount": len(entries),
        "validFrames": sum(entry["validFrames"] for entry in entries),
        "duplicateRaceCount": len(duplicate_races),
        "duplicateCatalogIdCount": len(duplicate_catalog_ids),
        "duplicateNameCount": duplicate_names,
        "sharedExactFrameGroups": len(shared_frame_groups),
        "entries": entries,
    }


def summarize_numeric_assets(root: Path, kind: str, errors: list[str]) -> dict:
    manifests = sorted(root.glob("*/manifest.json"))
    valid_frames = 0
    for manifest_path in manifests:
        try:
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            errors.append(f"{kind} manifest unreadable: {manifest_path}: {error}")
            continue
        for value in payload.get("files", []):
            frame_path = manifest_path.parent / str(value)
            reason = invalid_frame_reason(frame_path)
            if reason:
                errors.append(f"{kind} frame {reason}: {frame_path}")
            else:
                valid_frames += 1
    if not manifests or not valid_frames:
        errors.append(f"no valid {kind} assets found under {root}")
    return {"assetCount": len(manifests), "validFrames": valid_frames}


def invalid_frame_reason(frame_path: Path) -> str | None:
    """None when the frame is a decodable, non-empty, not fully transparent image."""
    if not frame_path.is_file():
        return "missing"
    try:
        with Image.open(frame_path) as image:
            image.load()
            rgba = image.convert("RGBA")
            if rgba.width <= 0 or rgba.height <= 0:
                return "has invalid dimensions"
            if rgba.getchannel("A").getbbox() is None:
                return "is fully transparent"
    except (OSError, UnidentifiedImageError, ValueError) as error:
        return f"unreadable: {error}"
    return None


def validate_dataset(dataset: Path, errors: list[str]) -> dict:
    data_path = dataset / "data.yaml"
    if not data_path.is_file():
        errors.append(f"dataset metadata is missing: {data_path}")
        return {}
    data = yaml.safe_load(data_path.read_text(encoding="utf-8"))
    names = data.get("names", {})
    normalized_names = {str(name): int(class_id) for class_id, name in names.items()}
    if normalized_names != EXPECTED_CLASSES:
        errors.append(f"data.yaml classes are {normalized_names!r}, expected {EXPECTED_CLASSES!r}")

    splits = {}
    class_instances: Counter[int] = Counter()
    for split in ("train", "val"):
        image_dir = dataset / "images" / split
        label_dir = dataset / "labels" / split
        images = {path.stem for path in image_dir.glob("*.jpg")}
        labels = {path.stem: path for path in label_dir.glob("*.txt")}
        missing_labels = images - labels.keys()
        missing_images = labels.keys() - images
        if missing_labels:
            errors.append(f"{split} has {len(missing_labels)} images without labels")
        if missing_images:
            errors.append(f"{split} has {len(missing_images)} labels without images")
        negative_count = 0
        for stem, label_path in labels.items():
            lines = label_path.read_text(encoding="utf-8").splitlines()
            if not lines:
                negative_count += 1
            for line_number, line in enumerate(lines, 1):
                parts = line.split()
                if len(parts) != 5:
                    errors.append(f"invalid YOLO row {label_path}:{line_number}")
                    continue
                try:
                    class_id = int(parts[0])
                    box = [float(value) for value in parts[1:]]
                except ValueError:
                    errors.append(f"non-numeric YOLO row {label_path}:{line_number}")
                    continue
                if class_id not in EXPECTED_CLASSES.values():
                    errors.append(f"unknown class {class_id} in {label_path}:{line_number}")
                if not all(0 < value <= 1 for value in box):
                    errors.append(f"out-of-bounds box in {label_path}:{line_number}: {box}")
                class_instances[class_id] += 1
        splits[split] = {
            "images": len(images),
            "labels": len(labels),
            "negativeImages": negative_count,
        }
    return {
        "splits": splits,
        "classInstances": {
            name: class_instances[class_id] for name, class_id in EXPECTED_CLASSES.items()
        },
    }


def without_entries(payload: dict) -> dict:
    return {key: value for key, value in payload.items() if key != "entries"}


if __name__ == "__main__":
    main()
