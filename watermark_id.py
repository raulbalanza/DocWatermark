#!/usr/bin/env python3
"""
Add a protective watermark to images of identity documents (Spanish DNI / passport).

Following the recommendations of the Spanish Data Protection Agency (AEPD), the
watermark should state *who* receives the copy, *what for*, and *when*, and it
should cover the whole document (including the photo and data fields) so it
cannot simply be cropped out, while keeping the data readable.

What this script does:
  * Tiles the text diagonally across the entire image in staggered rows, with
    small random offsets so the pattern is harder to remove automatically.
  * Overlays thin wavy security lines over the document.
  * Draws text with a thin contrasting outline so it stays visible on both light
    and dark areas (photo, hologram, background).
  * Keeps the document's dark printed text on top of the watermark so the data
    stays easy to read. Intensity is set with --strength light|medium|strong.
  * Appends the current date to the text (disable with --no-date).
  * Strips all metadata (EXIF, GPS...) from the output and optionally
    downscales it (--max-side) to make the copy less useful for forgeries.

Examples:
  python watermark_id.py dni_front.jpg dni_back.jpg \\
      --text "Solo para Inmobiliaria XYZ - Alquiler C/ Mayor 1"

  python watermark_id.py passport.png -t "Copia para Hotel ABC" \\
      --strength medium --color "#1a3fbf" --max-side 1600 -o passport_wm.jpg
"""

from __future__ import annotations

import argparse
import math
import random
import sys
from datetime import date
from pathlib import Path

from PIL import Image, ImageChops, ImageColor, ImageDraw, ImageFilter, ImageFont, ImageOps

FONT_CANDIDATES = [
    # macOS
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Verdana Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    # Linux
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    # Windows
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/verdanab.ttf",
]

MIN_FONT_SIZE = 10

# Presets for --strength. Explicit --opacity / --spacing / --font-size override them.
#   font_div:   font size = shortest image side / font_div
#   lines:      number of wavy security lines
#   line_alpha: line opacity relative to the text opacity
PRESETS = {
    "light":  dict(opacity=0.18, spacing=4.0, font_div=24, lines=6,  line_alpha=0.35),
    "medium": dict(opacity=0.25, spacing=3.2, font_div=20, lines=8,  line_alpha=0.45),
    "strong": dict(opacity=0.35, spacing=2.6, font_div=16, lines=14, line_alpha=0.6),
}

# Printed text (dark strokes on a lighter background) is kept on top of the watermark.
# A pixel counts as text when it is darker than DARK_LO..DARK_HI (fading in between)
# AND at least CONTRAST levels darker than its neighbourhood, so large dark areas
# such as the photo still get watermarked.
DARK_LO, DARK_HI = 50, 110
CONTRAST = 40


def load_font(size: int, font_path: str | None) -> ImageFont.FreeTypeFont:
    candidates = [font_path] if font_path else FONT_CANDIDATES
    for path in candidates:
        if path and Path(path).is_file():
            return ImageFont.truetype(path, size)
    if font_path:
        sys.exit(f"error: font not found: {font_path}")
    # Pillow >= 10.1 ships a scalable default font.
    return ImageFont.load_default(size=size)


def fit_font(text: str, width: int, size: int, font_path: str | None):
    """Shrink the font until one copy of the text fits within ~90% of the width."""
    while True:
        font = load_font(size, font_path)
        left, _, right, _ = font.getbbox(text)
        if right - left <= width * 0.9 or size <= MIN_FONT_SIZE:
            return font
        size = max(MIN_FONT_SIZE, int(size * 0.9))


def contrasting(rgb: tuple[int, int, int]) -> tuple[int, int, int]:
    luminance = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
    return (0, 0, 0) if luminance > 160 else (255, 255, 255)


def text_layer(size, text, font, color, angle, spacing, rng) -> Image.Image:
    """Opaque layer with the text tiled diagonally over the whole area."""
    w, h = size
    side = int(math.hypot(w, h)) + 4 * font.size
    layer = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    stroke = max(1, font.size // 22)
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font, stroke_width=stroke)
    tw, th = right - left, bottom - top
    step_x = tw + font.size * 2
    step_y = int(th * spacing)
    jitter = font.size // 3
    fill = (*color, 255)
    outline = (*contrasting(color), 255)

    for row, y in enumerate(range(-step_y, side + step_y, step_y)):
        row_offset = (row % 2) * step_x // 2 + rng.randint(0, step_x // 3)
        for x in range(-step_x - row_offset, side + step_x, step_x):
            draw.text(
                (x + rng.randint(-jitter, jitter), y + rng.randint(-jitter, jitter)),
                text,
                font=font,
                fill=fill,
                stroke_width=stroke,
                stroke_fill=outline,
            )

    layer = layer.rotate(angle, resample=Image.BICUBIC)
    cx, cy = (side - w) // 2, (side - h) // 2
    return layer.crop((cx, cy, cx + w, cy + h))


def lines_layer(size, color, count, rng) -> Image.Image:
    """Opaque layer with thin sinusoidal security lines across the image."""
    w, h = size
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    width = max(1, min(w, h) // 400)
    for i in range(count):
        base_y = h * (i + 0.5) / count
        amplitude = h * rng.uniform(0.02, 0.06)
        wavelength = w * rng.uniform(0.25, 0.6)
        phase = rng.uniform(0, 2 * math.pi)
        points = [
            (x, base_y + amplitude * math.sin(2 * math.pi * x / wavelength + phase))
            for x in range(0, w + 4, 4)
        ]
        draw.line(points, fill=(*color, 255), width=width)
    return layer


def with_opacity(layer: Image.Image, opacity: float) -> Image.Image:
    alpha = layer.getchannel("A").point(lambda a: int(a * opacity))
    layer.putalpha(alpha)
    return layer


def keep_dark_text(original: Image.Image, marked: Image.Image) -> Image.Image:
    """Restore the original pixels of printed text on top of the watermark."""
    gray = original.convert("L")
    span = DARK_HI - DARK_LO
    darkness = gray.point(
        lambda v: 255 if v <= DARK_LO else 0 if v >= DARK_HI else (DARK_HI - v) * 255 // span
    )
    surroundings = gray.filter(ImageFilter.BoxBlur(max(3, min(gray.size) // 60)))
    local_contrast = ImageChops.subtract(surroundings, gray).point(
        lambda d: min(255, d * 255 // CONTRAST)
    )
    is_text = ImageChops.multiply(darkness, local_contrast)
    return Image.composite(original, marked, is_text)


def watermark(img: Image.Image, args, rng: random.Random) -> Image.Image:
    img = ImageOps.exif_transpose(img).convert("RGBA")

    if args.max_side and max(img.size) > args.max_side:
        img.thumbnail((args.max_side, args.max_side), Image.LANCZOS)

    w, h = img.size
    color = ImageColor.getrgb(args.color)[:3]
    preset = PRESETS[args.strength]
    font_size = args.font_size or max(MIN_FONT_SIZE, min(w, h) // preset["font_div"])
    font = fit_font(args.full_text, w, font_size, args.font)

    original = img
    if not args.no_lines:
        lines = lines_layer(img.size, color, preset["lines"], rng)
        img = Image.alpha_composite(img, with_opacity(lines, args.opacity * preset["line_alpha"]))

    text = text_layer(img.size, args.full_text, font, color, args.angle, args.spacing, rng)
    img = Image.alpha_composite(img, with_opacity(text, args.opacity))
    return keep_dark_text(original, img).convert("RGB")


def output_path(src: Path, args, multiple: bool) -> Path:
    if args.output and not multiple:
        return Path(args.output)
    suffix = src.suffix.lower() if src.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"} else ".jpg"
    directory = Path(args.output) if args.output and multiple else src.parent
    return directory / f"{src.stem}_watermarked{suffix}"


def save(img: Image.Image, path: Path, quality: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # No exif/icc arguments are passed, so the output carries no metadata.
    if path.suffix.lower() in {".jpg", ".jpeg"}:
        img.save(path, "JPEG", quality=quality, optimize=True)
    elif path.suffix.lower() == ".webp":
        img.save(path, "WEBP", quality=quality)
    else:
        img.save(path)


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Watermark images of identity documents (Spanish DNI / passport).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Examples:" + __doc__.split("Examples:", 1)[1],
    )
    p.add_argument("images", nargs="+", type=Path, help="input image(s), e.g. front and back of the DNI")
    p.add_argument("-t", "--text", required=True,
                   help='watermark text: recipient and purpose, e.g. "Solo para Banco X - Apertura de cuenta"')
    p.add_argument("-o", "--output",
                   help="output file (single input) or output directory (multiple inputs). "
                        "Default: <name>_watermarked.<ext> next to the input")
    p.add_argument("--no-date", action="store_true", help="do not append today's date to the text")
    p.add_argument("--color", default="#c8102e", help="watermark color (name or hex). Default: %(default)s")
    p.add_argument("--strength", choices=PRESETS, default="light",
                   help="overall intensity: opacity, density, text size and lines. Default: %(default)s")
    p.add_argument("--opacity", type=float, help="0-1. Overrides the --strength preset")
    p.add_argument("--angle", type=float, default=30, help="text angle in degrees. Default: %(default)s")
    p.add_argument("--font-size", type=int, help="font size in px. Default: auto from image size")
    p.add_argument("--font", help="path to a .ttf/.otf font")
    p.add_argument("--spacing", type=float,
                   help="vertical distance between rows, in text heights. Lower = denser. "
                        "Overrides the --strength preset")
    p.add_argument("--no-lines", action="store_true", help="do not draw the wavy security lines")
    p.add_argument("--max-side", type=int,
                   help="downscale so the longest side is at most this many px (e.g. 1600)")
    p.add_argument("--quality", type=int, default=90, help="JPEG/WebP quality. Default: %(default)s")
    p.add_argument("--seed", type=int, help="random seed for reproducible output")
    args = p.parse_args(argv)

    preset = PRESETS[args.strength]
    if args.opacity is None:
        args.opacity = preset["opacity"]
    if args.spacing is None:
        args.spacing = preset["spacing"]

    if not 0 < args.opacity <= 1:
        p.error("--opacity must be in (0, 1]")
    if args.spacing < 1:
        p.error("--spacing must be >= 1")
    args.full_text = args.text.strip()
    if not args.full_text:
        p.error("--text cannot be empty")
    if not args.no_date:
        args.full_text += f" · {date.today():%d/%m/%Y}"
    return args


def main(argv=None) -> int:
    args = parse_args(argv)
    rng = random.Random(args.seed)
    multiple = len(args.images) > 1
    status = 0

    for src in args.images:
        try:
            with Image.open(src) as img:
                result = watermark(img, args, rng)
        except (OSError, ValueError) as exc:
            print(f"error: {src}: {exc}", file=sys.stderr)
            status = 1
            continue
        dst = output_path(src, args, multiple)
        save(result, dst, args.quality)
        print(f"{src} -> {dst}")

    return status


if __name__ == "__main__":
    sys.exit(main())
