/*
 * Watermark engine: a browser port of watermark_id.py.
 *
 * Same algorithm as the Python script:
 *   - text tiled diagonally in staggered rows with small random offsets,
 *   - thin wavy security lines,
 *   - text drawn with a thin contrasting outline,
 *   - the document's dark printed text restored on top of the watermark,
 *   - optional downscaling; exported files carry no metadata (canvas export).
 *
 * Exposes window.Watermark. No dependencies, no network access.
 */
(function (global) {
  'use strict';

  // Presets for strength. Explicit opacity / spacing / fontSize override them.
  //   fontDiv:   font size = shortest image side / fontDiv
  //   lines:     number of wavy security lines
  //   lineAlpha: line opacity relative to the text opacity
  const PRESETS = {
    light:  { opacity: 0.18, spacing: 4.0, fontDiv: 24, lines: 6,  lineAlpha: 0.35 },
    medium: { opacity: 0.25, spacing: 3.2, fontDiv: 20, lines: 8,  lineAlpha: 0.45 },
    strong: { opacity: 0.35, spacing: 2.6, fontDiv: 16, lines: 14, lineAlpha: 0.6 },
  };

  const DEFAULTS = {
    color: '#c8102e',
    strength: 'light',
    angle: 30,
    lines: true,
    maxSide: null,
    quality: 90,
  };

  const MIN_FONT_SIZE = 10;

  // Printed text (dark strokes on a lighter background) is kept on top of the
  // watermark. A pixel counts as text when it is darker than DARK_LO..DARK_HI
  // (fading in between) AND at least CONTRAST levels darker than its
  // neighbourhood, so large dark areas such as the photo still get watermarked.
  const DARK_LO = 50;
  const DARK_HI = 110;
  const CONTRAST = 40;

  // Bundled Liberation Sans Bold (SIL OFL, see fonts/): metric-compatible with
  // Arial Bold, the script's first choice, so the result is the same on every
  // system. The system fonts after it are only used if the file cannot load.
  const BUNDLED_FONT_FAMILY = 'Watermark Sans';
  const BUNDLED_FONT_URL = 'fonts/LiberationSans-Bold.ttf';
  const DEFAULT_FONT = {
    family: `"${BUNDLED_FONT_FAMILY}", Arial, "Helvetica Neue", Helvetica, sans-serif`,
    weight: 'bold',
  };

  /** Resolves to true once the bundled font is ready, false if it could not load. */
  const fontReady = (async () => {
    try {
      const face = new FontFace(BUNDLED_FONT_FAMILY, `url("${BUNDLED_FONT_URL}")`, { weight: 'bold' });
      document.fonts.add(await face.load());
      return true;
    } catch (err) {
      console.warn(`Could not load ${BUNDLED_FONT_URL}, using a system font instead.`, err);
      return false;
    }
  })();

  /* ---------- random numbers ---------- */

  // mulberry32: small seedable PRNG so a seed reproduces the same output.
  function makeRng(seed) {
    let a = seed >>> 0;
    const random = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      random,
      uniform: (lo, hi) => lo + (hi - lo) * random(),
      randint: (lo, hi) => lo + Math.floor(random() * (hi - lo + 1)), // inclusive, like Python
    };
  }

  function randomSeed() {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0];
  }

  /* ---------- helpers ---------- */

  function hexToRgb(hex) {
    let h = String(hex).trim().replace(/^#/, '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`invalid color: ${hex}`);
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbCss(rgb) {
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  }

  function contrasting(rgb) {
    const luminance = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    return luminance > 160 ? [0, 0, 0] : [255, 255, 255];
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function fontString(size, font) {
    return `${font.weight} ${size}px ${font.family}`;
  }

  function inkBox(ctx, text) {
    const m = ctx.measureText(text);
    const left = m.actualBoundingBoxLeft || 0;
    const right = m.actualBoundingBoxRight || m.width;
    const ascent = m.actualBoundingBoxAscent || 0;
    const descent = m.actualBoundingBoxDescent || 0;
    return { width: left + right, height: ascent + descent, left, ascent };
  }

  /** Shrink the font until one copy of the text fits within ~90% of the width. */
  function fitFontSize(text, width, size, font) {
    const ctx = makeCanvas(1, 1).getContext('2d');
    for (;;) {
      ctx.font = fontString(size, font);
      if (inkBox(ctx, text).width <= width * 0.9 || size <= MIN_FONT_SIZE) return size;
      size = Math.max(MIN_FONT_SIZE, Math.floor(size * 0.9));
    }
  }

  /** Full watermark text: the user's text plus today's date (dd/mm/yyyy). */
  function fullText(text, withDate, today = new Date()) {
    let t = String(text || '').trim();
    if (!t) return '';
    if (withDate) t += ` · ${formatDate(today)}`;
    return t;
  }

  function formatDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  }

  /* ---------- layers ---------- */

  /** Opaque layer with the text tiled diagonally over the whole area. */
  function textLayer(w, h, text, fontSize, font, color, angle, spacing, rng) {
    const layer = makeCanvas(w, h);
    const ctx = layer.getContext('2d');
    const side = Math.floor(Math.hypot(w, h)) + 4 * fontSize;

    // Draw on a virtual side x side square rotated around its centre and
    // centred on the image: the same as rotating a big layer and cropping it.
    // PIL rotates counter-clockwise for positive angles; canvas is clockwise.
    ctx.translate(w / 2, h / 2);
    ctx.rotate((-angle * Math.PI) / 180);
    ctx.translate(-side / 2, -side / 2);

    ctx.font = fontString(fontSize, font);
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;

    const stroke = Math.max(1, Math.floor(fontSize / 22));
    const box = inkBox(ctx, text);
    const tw = Math.round(box.width) + 2 * stroke;
    const th = Math.round(box.height) + 2 * stroke;
    const stepX = tw + fontSize * 2;
    const stepY = Math.max(1, Math.floor(th * spacing));
    const jitter = Math.floor(fontSize / 3);

    ctx.fillStyle = rgbCss(color);
    ctx.strokeStyle = rgbCss(contrasting(color));
    ctx.lineWidth = 2 * stroke; // canvas strokes are centred on the outline

    let row = 0;
    for (let y = -stepY; y < side + stepY; y += stepY, row++) {
      const rowOffset = (row % 2) * Math.floor(stepX / 2) + rng.randint(0, Math.floor(stepX / 3));
      for (let x = -stepX - rowOffset; x < side + stepX; x += stepX) {
        const px = x + rng.randint(-jitter, jitter) + box.left + stroke;
        const py = y + rng.randint(-jitter, jitter) + box.ascent + stroke;
        ctx.strokeText(text, px, py);
        ctx.fillText(text, px, py);
      }
    }
    return layer;
  }

  /** Opaque layer with thin sinusoidal security lines across the image. */
  function linesLayer(w, h, color, count, rng) {
    const layer = makeCanvas(w, h);
    const ctx = layer.getContext('2d');
    ctx.strokeStyle = rgbCss(color);
    ctx.lineWidth = Math.max(1, Math.floor(Math.min(w, h) / 400));
    ctx.lineJoin = 'round';
    for (let i = 0; i < count; i++) {
      const baseY = (h * (i + 0.5)) / count;
      const amplitude = h * rng.uniform(0.02, 0.06);
      const wavelength = w * rng.uniform(0.25, 0.6);
      const phase = rng.uniform(0, 2 * Math.PI);
      ctx.beginPath();
      for (let x = 0; x < w + 4; x += 4) {
        const y = baseY + amplitude * Math.sin((2 * Math.PI * x) / wavelength + phase);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    return layer;
  }

  /* ---------- keep printed text on top ---------- */

  /** Box blur with edge pixels extended (like PIL's BoxBlur). */
  function boxBlur(src, w, h, r) {
    const size = 2 * r + 1;
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    const cx = (v, max) => (v < 0 ? 0 : v > max ? max : v);

    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[row + cx(k, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum / size;
        sum += src[row + cx(x + r + 1, w - 1)] - src[row + cx(x - r, w - 1)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[cx(k, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = sum / size;
        sum += tmp[cx(y + r + 1, h - 1) * w + x] - tmp[cx(y - r, h - 1) * w + x];
      }
    }
    return out;
  }

  /** Restore the original pixels of printed text on top of the watermark. */
  function keepDarkText(original, marked, w, h) {
    const o = original.data;
    const m = marked.data;
    const n = w * h;
    const gray = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      // ITU-R 601-2 luma, as in PIL's convert("L").
      gray[i] = (o[p] * 19595 + o[p + 1] * 38470 + o[p + 2] * 7471 + 0x8000) >> 16;
    }
    const surroundings = boxBlur(gray, w, h, Math.max(3, Math.floor(Math.min(w, h) / 60)));
    const span = DARK_HI - DARK_LO;

    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const v = gray[i];
      if (v >= DARK_HI) continue;
      const darkness = v <= DARK_LO ? 255 : Math.floor(((DARK_HI - v) * 255) / span);
      const diff = Math.round(surroundings[i]) - v;
      if (diff <= 0) continue;
      const contrast = Math.min(255, Math.floor((diff * 255) / CONTRAST));
      const a = (darkness * contrast) / 65025; // 0..1 mask: printed text
      if (a <= 0) continue;
      m[p] = o[p] * a + m[p] * (1 - a);
      m[p + 1] = o[p + 1] * a + m[p + 1] * (1 - a);
      m[p + 2] = o[p + 2] * a + m[p + 2] * (1 - a);
    }
    return marked;
  }

  /* ---------- main entry point ---------- */

  /**
   * Watermark an image.
   * @param source  HTMLImageElement / ImageBitmap / canvas (EXIF orientation already applied)
   * @param opts    { text (full text, date included), color, strength, opacity, spacing,
   *                  angle, fontSize, font: {family, weight}, lines, maxSide }
   * @param rng     from makeRng()
   * @returns       a canvas with the watermarked image (opaque RGB)
   */
  function render(source, opts, rng) {
    const preset = PRESETS[opts.strength] || PRESETS.light;
    const opacity = opts.opacity ?? preset.opacity;
    const spacing = opts.spacing ?? preset.spacing;
    const angle = opts.angle ?? DEFAULTS.angle;
    const font = opts.font || DEFAULT_FONT;
    const color = hexToRgb(opts.color || DEFAULTS.color);

    if (!(opacity > 0 && opacity <= 1)) throw new Error('opacity must be in (0, 1]');
    if (!(spacing >= 1)) throw new Error('spacing must be >= 1');
    if (!opts.text) throw new Error('text cannot be empty');

    let w = source.naturalWidth || source.width;
    let h = source.naturalHeight || source.height;
    if (opts.maxSide && Math.max(w, h) > opts.maxSide) {
      const s = opts.maxSide / Math.max(w, h);
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
    }

    const out = makeCanvas(w, h);
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; // transparent areas become white, the output is RGB
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    const original = ctx.getImageData(0, 0, w, h);

    const autoSize = Math.max(MIN_FONT_SIZE, Math.floor(Math.min(w, h) / preset.fontDiv));
    const fontSize = fitFontSize(opts.text, w, opts.fontSize || autoSize, font);

    if (opts.lines !== false) {
      ctx.globalAlpha = opacity * preset.lineAlpha;
      ctx.drawImage(linesLayer(w, h, color, preset.lines, rng), 0, 0);
    }
    ctx.globalAlpha = opacity;
    ctx.drawImage(textLayer(w, h, opts.text, fontSize, font, color, angle, spacing, rng), 0, 0);
    ctx.globalAlpha = 1;

    const marked = ctx.getImageData(0, 0, w, h);
    ctx.putImageData(keepDarkText(original, marked, w, h), 0, 0);
    return out;
  }

  /* ---------- export ---------- */

  const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

  /** Output name: <stem>_watermarked.<ext>; ext follows the input unless a format is forced. */
  function outputName(inputName, format) {
    const dot = inputName.lastIndexOf('.');
    const stem = dot > 0 ? inputName.slice(0, dot) : inputName;
    let ext = dot > 0 ? inputName.slice(dot + 1).toLowerCase() : '';
    if (format && format !== 'auto') ext = format;
    else if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) ext = 'jpg';
    return `${stem}_watermarked.${ext}`;
  }

  /** Encode a canvas. Canvas exports never include EXIF, GPS or other metadata. */
  function toBlob(canvas, fileName, quality) {
    const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
    const mime = ext === 'jpeg' ? MIME.jpg : MIME[ext] || MIME.jpg;
    const q = Math.min(100, Math.max(1, quality ?? DEFAULTS.quality)) / 100;
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error('could not encode the image'));
          if (blob.type !== mime) return reject(new Error(`this browser cannot save ${ext.toUpperCase()} files`));
          resolve(blob);
        },
        mime,
        mime === MIME.png ? undefined : q
      );
    });
  }

  /** Decode a File/Blob into an image element with EXIF orientation applied. */
  function loadImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('this browser cannot open this file as an image'));
      };
      img.src = url; // modern browsers honour EXIF orientation when drawing
    });
  }

  global.Watermark = {
    PRESETS,
    DEFAULTS,
    DEFAULT_FONT,
    fontReady,
    makeRng,
    randomSeed,
    fullText,
    formatDate,
    render,
    outputName,
    toBlob,
    loadImage,
  };
})(window);
