#!/usr/bin/env python3
"""
Generate fake Spanish ID card (DNI) images to try watermark_id.py on.

The card loosely follows the DNI 4.0 layout but uses the fictional data from the
official specimen (CARMEN ESPAÑOLA ESPAÑOLA, 99999999R), has no emblems or
security features and is clearly marked as MUESTRA / SPECIMEN.

Writes to samples/ (or --out):
  dni_front.png        flat scan of the front
  dni_back.png         flat scan of the back, with a valid-format MRZ
  dni_front_photo.jpg  the front as if photographed with a phone on a table

Usage:
  python make_sample_id.py
  python watermark_id.py samples/dni_front.png samples/dni_back.png -t "Solo para pruebas"
"""

from __future__ import annotations

import argparse
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ID-1 card: 85.6 x 54 mm at 20 px/mm.
W, H = 1712, 1080

FONTS = {
    "regular": [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ],
    "bold": [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
    ],
    "mono": [
        "/System/Library/Fonts/Supplemental/Courier New Bold.ttf",
        "/System/Library/Fonts/Menlo.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
        "C:/Windows/Fonts/courbd.ttf",
    ],
}

PERSON = {
    "surname1": "ESPAÑOLA",
    "surname2": "ESPAÑOLA",
    "name": "CARMEN",
    "sex": "F",
    "nationality": "ESP",
    "birth": (1980, 1, 1),
    "expiry": (2031, 1, 1),
    "issue": (2021, 1, 1),
    "dni": "99999999R",
    "support": "BAA000589",
    "can": "000000",
    "address": "C. ARTISTA LOS PIRINEOS 1",
    "town": "MADRID",
    "province": "MADRID",
    "birthplace": "MADRID / MADRID",
    "parents": "JUAN / CARMEN",
}

INK = (25, 25, 30)
LABEL = (70, 80, 95)


def font(kind: str, size: int) -> ImageFont.FreeTypeFont:
    for path in FONTS[kind]:
        if Path(path).is_file():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size=size)


def card_background(rng: random.Random, tint: tuple[int, int, int]) -> Image.Image:
    """Pastel gradient with fine guilloche-style curves."""
    img = Image.new("RGB", (W, H))
    draw = ImageDraw.Draw(img)
    top, bottom = (232, 240, 238), tint
    for y in range(H):
        t = y / (H - 1)
        draw.line([(0, y), (W, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)))

    for i in range(60):
        amplitude = rng.uniform(20, 70)
        wavelength = rng.uniform(250, 600)
        phase = rng.uniform(0, 2 * math.pi)
        base_y = i * H / 60
        color = (190 + rng.randint(-15, 15), 205 + rng.randint(-15, 15), 210 + rng.randint(-15, 15))
        points = [(x, base_y + amplitude * math.sin(2 * math.pi * x / wavelength + phase))
                  for x in range(0, W + 6, 6)]
        draw.line(points, fill=color, width=1)
    return img


def rounded(img: Image.Image, radius: int = 64) -> Image.Image:
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, *img.size), radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def portrait(size: tuple[int, int]) -> Image.Image:
    """Grayscale placeholder portrait: light background, dark hair, mid-tone face."""
    w, h = size
    img = Image.new("L", size, 215)
    draw = ImageDraw.Draw(img)
    cx = w // 2
    draw.ellipse((cx - w * 0.36, h * 0.08, cx + w * 0.36, h * 0.62), fill=45)          # hair
    draw.ellipse((cx - w * 0.62, h * 0.70, cx + w * 0.62, h * 1.35), fill=70)          # shoulders
    draw.rectangle((cx - w * 0.11, h * 0.52, cx + w * 0.11, h * 0.78), fill=150)       # neck
    draw.ellipse((cx - w * 0.27, h * 0.16, cx + w * 0.27, h * 0.66), fill=165)         # face
    for ex in (-0.11, 0.11):                                                           # eyes
        draw.ellipse((cx + w * (ex - 0.04), h * 0.36, cx + w * (ex + 0.04), h * 0.40), fill=40)
    draw.arc((cx - w * 0.08, h * 0.48, cx + w * 0.08, h * 0.56), 20, 160, fill=90, width=4)  # mouth
    return img.filter(ImageFilter.GaussianBlur(2)).convert("RGB")


def field(draw, xy, label, value, value_size=40):
    x, y = xy
    draw.text((x, y), label, font=font("regular", 24), fill=LABEL)
    draw.text((x, y + 30), value, font=font("bold", value_size), fill=INK)


def dmy(d: tuple[int, int, int]) -> str:
    return f"{d[2]:02d} {d[1]:02d} {d[0]}"


def header(draw, title: str):
    draw.rectangle((0, 0, W, 130), fill=(176, 32, 45))
    draw.text((50, 22), "ESPAÑA", font=font("bold", 44), fill="white")
    draw.text((50, 76), title, font=font("regular", 30), fill=(255, 225, 225))
    draw.text((W - 50, 65), "MUESTRA / SPECIMEN", font=font("bold", 34),
              fill=(255, 230, 120), anchor="rm")


def front(rng: random.Random) -> Image.Image:
    img = card_background(rng, (238, 222, 232))
    draw = ImageDraw.Draw(img)
    header(draw, "DOCUMENTO NACIONAL DE IDENTIDAD")

    p = PERSON
    draw.text((50, 160), "DNI", font=font("regular", 30), fill=LABEL)
    draw.text((115, 150), p["dni"], font=font("bold", 48), fill=INK)

    img.paste(portrait((430, 540)), (50, 230))

    x = 540
    field(draw, (x, 160 + 70), "APELLIDOS / SURNAME", p["surname1"])
    draw.text((x, 160 + 145), p["surname2"], font=font("bold", 40), fill=INK)
    field(draw, (x, 370), "NOMBRE / NAME", p["name"])
    field(draw, (x, 470), "SEXO / SEX", p["sex"])
    field(draw, (x + 260, 470), "NACIONALIDAD / NATIONALITY", p["nationality"])
    field(draw, (x, 570), "FECHA DE NACIMIENTO / DATE OF BIRTH", dmy(p["birth"]))
    field(draw, (x, 670), "NÚM. SOPORTE / DOCUMENT NO.", p["support"])
    field(draw, (x + 520, 670), "VÁLIDO HASTA / EXPIRY", dmy(p["expiry"]))
    field(draw, (x, 770), "FECHA DE EXPEDICIÓN / ISSUE DATE", dmy(p["issue"]))

    # Signature
    draw.text((50, 800), "FIRMA / SIGNATURE", font=font("regular", 22), fill=LABEL)
    points = [(70 + t * 3.2, 900 + 28 * math.sin(t / 9) + 14 * math.sin(t / 3.3)) for t in range(110)]
    draw.line(points, fill=(20, 30, 90), width=4)

    draw.text((W - 50, H - 50), f"CAN {p['can']}", font=font("bold", 34), fill=INK, anchor="rs")
    return rounded(img)


def check_digit(data: str) -> str:
    values = {**{str(d): d for d in range(10)},
              **{chr(c): c - 55 for c in range(ord("A"), ord("Z") + 1)}, "<": 0}
    return str(sum(values[ch] * (7, 3, 1)[i % 3] for i, ch in enumerate(data)) % 10)


def mrz() -> list[str]:
    """ICAO 9303 TD1 machine readable zone (3 x 30 characters)."""
    p = PERSON
    yymmdd = lambda d: f"{d[0] % 100:02d}{d[1]:02d}{d[2]:02d}"
    doc, birth, expiry = p["support"], yymmdd(p["birth"]), yymmdd(p["expiry"])
    optional1 = p["dni"].ljust(15, "<")
    line1 = f"ID{p['nationality']}{doc}{check_digit(doc)}{optional1}"
    line2 = (f"{birth}{check_digit(birth)}{p['sex']}{expiry}{check_digit(expiry)}"
             f"{p['nationality']}" + "<" * 11)
    composite = line1[5:30] + line2[0:7] + line2[8:15] + line2[18:29]
    line2 += check_digit(composite)
    names = f"{p['surname1']}<{p['surname2']}<<{p['name']}".replace("Ñ", "N")
    line3 = names.ljust(30, "<")[:30]
    return [line1, line2, line3]


def back(rng: random.Random) -> Image.Image:
    img = card_background(rng, (225, 232, 245))
    draw = ImageDraw.Draw(img)
    header(draw, "DOCUMENTO NACIONAL DE IDENTIDAD")

    p = PERSON
    field(draw, (50, 170), "DOMICILIO / ADDRESS", p["address"], 36)
    draw.text((50, 246), f"{p['town']} / {p['province']}", font=font("bold", 36), fill=INK)
    field(draw, (50, 310), "LUGAR DE NACIMIENTO / PLACE OF BIRTH", p["birthplace"], 36)
    field(draw, (50, 410), "HIJO/A DE / CHILD OF", p["parents"], 36)
    field(draw, (1150, 410), "EQUIPO / OFFICE", "28000A0A0", 36)

    # Chip contact plate
    draw.rounded_rectangle((1300, 170, 1560, 360), 24, fill=(212, 175, 90), outline=(150, 115, 50), width=3)
    for x in (1390, 1470):
        draw.line([(x, 175), (x, 355)], fill=(150, 115, 50), width=3)
    draw.line([(1305, 265), (1555, 265)], fill=(150, 115, 50), width=3)

    draw.rectangle((0, 640, W, H), fill=(245, 245, 240))
    mono = font("mono", 64)
    for i, line in enumerate(mrz()):
        draw.text((W // 2, 700 + i * 110), line, font=mono, fill=INK, anchor="mt")
    return rounded(img)


def phone_photo(card: Image.Image, rng: random.Random) -> Image.Image:
    """Place the card slightly rotated on a dark textured table with a shadow."""
    bw, bh = 2400, 1800
    noise = Image.effect_noise((bw // 4, bh // 4), 40).resize((bw, bh), Image.BICUBIC)
    table = Image.merge("RGB", [noise.point(lambda v, o=o: int(v * 0.35) + o) for o in (60, 42, 30)])

    rotated = card.rotate(rng.uniform(-6, 6), resample=Image.BICUBIC, expand=True)
    x, y = (bw - rotated.width) // 2, (bh - rotated.height) // 2

    shadow = Image.new("RGBA", table.size, (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 150), (x + 25, y + 30), rotated.getchannel("A"))
    shadow = shadow.filter(ImageFilter.GaussianBlur(25))

    photo = Image.alpha_composite(table.convert("RGBA"), shadow)
    photo.paste(rotated, (x, y), rotated)

    # Uneven lighting, as from a lamp on one side.
    vertical = Image.linear_gradient("L").resize((bw, bh))
    horizontal = Image.linear_gradient("L").rotate(90).resize((bw, bh))
    light = Image.blend(vertical, horizontal, 0.5)
    photo = Image.composite(photo, Image.new("RGBA", (bw, bh), (0, 0, 0, 255)),
                            light.point(lambda v: 170 + v * 85 // 255))
    return photo.convert("RGB")


def flatten(card: Image.Image) -> Image.Image:
    """Put the rounded card on a white scanner background."""
    bg = Image.new("RGB", (W + 80, H + 80), "white")
    bg.paste(card, (40, 40), card)
    return bg


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[1],
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=Path(__file__).parent / "samples",
                        help="output directory. Default: samples/")
    parser.add_argument("--seed", type=int, default=7, help="random seed. Default: %(default)s")
    args = parser.parse_args()

    rng = random.Random(args.seed)
    args.out.mkdir(parents=True, exist_ok=True)
    card_front, card_back = front(rng), back(rng)

    outputs = {
        "dni_front.png": flatten(card_front),
        "dni_back.png": flatten(card_back),
        "dni_front_photo.jpg": phone_photo(card_front, rng),
    }
    for name, img in outputs.items():
        path = args.out / name
        img.save(path, quality=90) if path.suffix == ".jpg" else img.save(path)
        print(path)


if __name__ == "__main__":
    main()
