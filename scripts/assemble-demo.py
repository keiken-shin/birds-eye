#!/usr/bin/env python3
"""Assemble the deterministic documentation workflow frames into demo.gif."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / ".capture" / "docs-workflow"
DEFAULT_OUTPUT = ROOT / "docs" / "assets" / "demo.gif"
DEFAULT_DURATIONS = [1800, 2600, 1800, 2600, 2800]


def build_demo(frame_dir: Path, output: Path, width: int) -> None:
    sources = sorted(frame_dir.glob("*.png"))
    if not sources:
        raise SystemExit(f"No PNG frames found in {frame_dir}")

    frames: list[Image.Image] = []
    for source in sources:
        image = Image.open(source).convert("RGB")
        if image.width > width:
            height = round(image.height * width / image.width)
            image = image.resize((width, height), Image.Resampling.LANCZOS)
        frames.append(image.quantize(colors=192, method=Image.Quantize.MEDIANCUT))

    durations = DEFAULT_DURATIONS[: len(frames)]
    if len(durations) < len(frames):
        durations.extend([2200] * (len(frames) - len(durations)))

    output.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        output,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=2,
    )
    size_mib = output.stat().st_size / 1024 / 1024
    print(f"Wrote {output.relative_to(ROOT)} ({len(frames)} frames, {size_mib:.2f} MiB)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--width", type=int, default=1280)
    args = parser.parse_args()
    build_demo(args.input, args.output, args.width)


if __name__ == "__main__":
    main()

