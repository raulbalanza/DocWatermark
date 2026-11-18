# id_watermark

Adds a protective watermark to photos/scans of a Spanish DNI or passport, following the
AEPD recommendation: say **who** gets the copy, **what for**, and **when**, and cover the
whole document so the mark can't be cropped out.

## Setup

```sh
pip install -r requirements.txt
```

## Usage

```sh
# Front and back of the DNI -> dni_front_watermarked.jpg, dni_back_watermarked.jpg
python watermark_id.py dni_front.jpg dni_back.jpg -t "Solo para Inmobiliaria XYZ - Alquiler vivienda"

# Passport, blue, downscaled, custom output
python watermark_id.py passport.png -t "Copia para Hotel ABC" --strength medium --color "#1a3fbf" --max-side 1600 -o passport_wm.jpg
```

Today's date is appended automatically (`· 15/10/2026`); use `--no-date` to turn that off.

| Option | Default | Purpose |
|---|---|---|
| `-t, --text` | required | Recipient + purpose |
| `-o, --output` | `<name>_watermarked.<ext>` | Output file, or directory if several inputs |
| `--color` | `#c8102e` | Watermark color (an outline in a contrasting color is added automatically) |
| `--strength` | `light` | `light`, `medium` or `strong`: sets opacity, density, text size and lines together |
| `--opacity` | from preset | 0–1 |
| `--angle` | `30` | Text angle in degrees |
| `--spacing` | from preset | Space between rows, in text heights (lower = denser) |
| `--font-size`, `--font` | auto | Override the size or the .ttf/.otf font |
| `--no-lines` | off | Turn off the wavy security lines |
| `--max-side` | none | Downscale the longest side to this many px |
| `--quality` | `90` | JPEG/WebP quality |
| `--seed` | random | Fix the random offsets so the output can be reproduced |

The document's printed text (dark strokes on a lighter background) is kept on top of the
watermark, so names and numbers stay sharp. Large dark areas, such as the photo, are still
watermarked.

The output contains no EXIF, GPS or other metadata, and the watermark is merged into the
image pixels.

## Web app

`web/` holds a browser version of `watermark_id.py` with the same options and algorithm.
It runs fully client-side, with no backend, build step or dependencies, and makes no
network requests: images never leave the browser.

Open `web/index.html` directly, or serve the folder as static files (e.g. GitHub Pages):

```sh
python -m http.server -d web 8000   # then open http://localhost:8000
```

Drop, choose or paste images, type who the copy is for, and download each result or all of
them as a .zip. The preview updates as you change the options. **More options** has the
equivalents of `--opacity`, `--spacing`, `--angle`, `--font-size`, `--font`, `--no-lines`,
`--max-side`, `--quality` and `--seed`, plus the output format.

Both the web app and `watermark_id.py` use the bundled font
`web/fonts/LiberationSans-Bold.ttf` (Liberation Sans 2.1.5, SIL Open Font License 1.1,
license alongside it), so the text looks the same everywhere. It has the same letter widths
as Arial Bold. A system font is only used if the file is missing or can't be loaded
(`--font` still overrides it in the script).

Differences from the script:
- `--seed` gives repeatable output within the web app, but not the same pattern as the
  Python script for the same number (they use different random generators).
- Transparent areas become white instead of black.

## Sample images for testing

`make_sample_id.py` creates a fake DNI marked MUESTRA / SPECIMEN. It uses the fictional
data from the official specimen and has no official emblems or security features.

```sh
python make_sample_id.py          # writes samples/dni_front.png, dni_back.png, dni_front_photo.jpg
python watermark_id.py samples/dni_front.png samples/dni_back.png -t "Solo para pruebas"
```

`dni_front_photo.jpg` shows the card as if photographed with a phone on a table: tilted,
with a shadow and uneven lighting.
