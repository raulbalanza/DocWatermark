/* UI for the watermark tool. All processing happens locally (see watermark.js). */
(function () {
  'use strict';

  const W = window.Watermark;
  const $ = (id) => document.getElementById(id);

  const els = {
    form: $('controls'),
    text: $('text'),
    withDate: $('withDate'),
    today: $('today'),
    finalText: $('finalText'),
    color: $('color'),
    colorReset: $('colorReset'),
    opacity: $('opacity'),
    opacityOut: $('opacityOut'),
    spacing: $('spacing'),
    spacingOut: $('spacingOut'),
    angle: $('angle'),
    fontSize: $('fontSize'),
    fontFile: $('fontFile'),
    fontReset: $('fontReset'),
    fontHint: $('fontHint'),
    lines: $('lines'),
    maxSide: $('maxSide'),
    format: $('format'),
    quality: $('quality'),
    qualityOut: $('qualityOut'),
    seed: $('seed'),
    reshuffle: $('reshuffle'),
    dropzone: $('dropzone'),
    files: $('files'),
    pick: $('pick'),
    notice: $('notice'),
    items: $('items'),
    actions: $('actions'),
    downloadAll: $('downloadAll'),
    addMore: $('addMore'),
    clearAll: $('clearAll'),
    template: $('itemTemplate'),
  };

  const FONT_HINT = els.fontHint.textContent;

  const state = {
    items: [], // { id, file, img, canvas, error, el, showOriginal }
    sessionSeed: W.randomSeed(),
    customFont: null,
    generation: 0,
    nextId: 1,
  };

  /* ---------- settings ---------- */

  function positiveInt(value) {
    const n = Math.floor(Number(value));
    return value !== '' && Number.isFinite(n) && n > 0 ? n : null;
  }

  function settings() {
    const angle = Number(els.angle.value);
    const seedValue = els.seed.value.trim();
    return {
      text: W.fullText(els.text.value, els.withDate.checked),
      color: els.color.value,
      strength: els.form.elements.strength.value,
      opacity: Number(els.opacity.value),
      spacing: Number(els.spacing.value),
      angle: els.angle.value === '' || !Number.isFinite(angle) ? W.DEFAULTS.angle : angle,
      fontSize: positiveInt(els.fontSize.value),
      font: state.customFont || W.DEFAULT_FONT,
      lines: els.lines.checked,
      maxSide: positiveInt(els.maxSide.value),
      format: els.format.value,
      quality: Number(els.quality.value),
      seed: seedValue === '' ? state.sessionSeed : Math.floor(Math.abs(Number(seedValue))) >>> 0,
    };
  }

  function applyPreset() {
    const preset = W.PRESETS[els.form.elements.strength.value];
    els.opacity.value = preset.opacity;
    els.spacing.value = preset.spacing;
    updateOutputs();
  }

  function updateOutputs() {
    els.opacityOut.textContent = Math.round(Number(els.opacity.value) * 100) + '%';
    els.spacingOut.textContent = Number(els.spacing.value).toFixed(1) + '×';
    els.qualityOut.textContent = els.quality.value;
    els.finalText.textContent = W.fullText(els.text.value, els.withDate.checked);
  }

  /* ---------- notices ---------- */

  function notify(message) {
    els.notice.textContent = message || '';
    els.notice.hidden = !message;
  }

  function refreshStatus() {
    const hasItems = state.items.length > 0;
    const hasText = !!settings().text;
    const ready = state.items.some((it) => it.canvas);
    document.body.classList.toggle('has-items', hasItems);
    els.actions.hidden = !hasItems;
    els.downloadAll.disabled = !ready;
    for (const it of state.items) {
      it.el.querySelector('.download').disabled = !it.canvas;
      it.el.querySelector('.compare').disabled = !it.canvas;
    }
    if (hasItems && !hasText) {
      notify('Type who gets the copy and what for to add the watermark.');
    } else if (els.notice.dataset.sticky !== '1') {
      notify('');
    }
  }

  function stickyNotice(message) {
    els.notice.dataset.sticky = '1';
    notify(message);
    clearTimeout(stickyNotice.timer);
    stickyNotice.timer = setTimeout(() => {
      els.notice.dataset.sticky = '';
      refreshStatus();
    }, 6000);
  }

  /* ---------- rendering ---------- */

  let renderTimer = 0;
  function scheduleRender(delay = 150) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderAll, delay);
  }

  const nextFrame = () => new Promise((r) => setTimeout(r, 0));

  async function renderAll() {
    const gen = ++state.generation;
    // Never draw with a fallback font while the bundled one is still loading.
    await W.fontReady;
    if (gen !== state.generation) return;
    const opts = settings();
    // One random generator for all images in order, like the script.
    const rng = W.makeRng(opts.seed);

    for (const it of state.items) {
      if (it.error || !it.img) continue;
      if (!opts.text) {
        it.canvas = null;
        showPreview(it);
        continue;
      }
      it.el.classList.add('is-busy');
      await nextFrame();
      if (gen !== state.generation) return;
      try {
        it.canvas = W.render(it.img, opts, rng);
      } catch (err) {
        it.canvas = null;
        stickyNotice(`${it.file.name}: ${err.message}`);
      }
      it.el.classList.remove('is-busy');
      showPreview(it);
    }
    refreshStatus();
  }

  function showPreview(it) {
    const preview = it.el.querySelector('.preview');
    const compare = it.el.querySelector('.compare');
    const showOriginal = it.showOriginal || !it.canvas;
    const node = showOriginal ? it.img : it.canvas;
    compare.setAttribute('aria-pressed', String(!!it.showOriginal && !!it.canvas));
    compare.textContent = it.showOriginal && it.canvas ? 'Show watermark' : 'Show original';

    const size = it.el.querySelector('.item-size');
    if (it.canvas) size.textContent = `${it.canvas.width} × ${it.canvas.height} px`;
    else if (it.img) size.textContent = `${it.img.naturalWidth} × ${it.img.naturalHeight} px`;

    if (node && preview.firstChild !== node) {
      preview.replaceChildren(node);
    }
    if (node) node.setAttribute('alt', showOriginal ? `${it.file.name}, original` : `${it.file.name}, watermarked`);
  }

  /* ---------- files ---------- */

  function looksLikeImage(file) {
    return file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i.test(file.name);
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []).filter(looksLikeImage);
    if (!files.length) {
      if (fileList && fileList.length) stickyNotice('Those files are not images. Use JPEG, PNG or WebP.');
      return;
    }
    const added = files.map((file) => {
      const it = { id: state.nextId++, file, img: null, canvas: null, error: null, showOriginal: false };
      it.el = createItemElement(it);
      els.items.appendChild(it.el);
      state.items.push(it);
      return it;
    });
    refreshStatus();

    await Promise.all(
      added.map(async (it) => {
        try {
          it.img = await W.loadImage(it.file);
          it.img.className = 'original';
        } catch (err) {
          it.error = err.message;
          const msg = document.createElement('p');
          msg.className = 'error';
          msg.textContent = `${it.file.name}: ${err.message}. Try a JPEG or PNG.`;
          it.el.querySelector('.preview').replaceChildren(msg);
        }
      })
    );
    scheduleRender(0);
  }

  function createItemElement(it) {
    const li = els.template.content.firstElementChild.cloneNode(true);
    li.querySelector('.item-name').textContent = it.file.name;
    li.querySelector('.download').addEventListener('click', () => downloadOne(it));
    li.querySelector('.remove').addEventListener('click', () => removeItem(it));
    li.querySelector('.remove').setAttribute('aria-label', `Remove ${it.file.name}`);
    li.querySelector('.compare').addEventListener('click', () => {
      it.showOriginal = !it.showOriginal;
      showPreview(it);
    });
    return li;
  }

  function removeItem(it) {
    state.items = state.items.filter((x) => x !== it);
    it.el.remove();
    refreshStatus();
    // Offsets depend on image order, so re-render the rest.
    if (state.items.length) scheduleRender(0);
  }

  /* ---------- downloads ---------- */

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function encode(it, opts) {
    const name = W.outputName(it.file.name, opts.format);
    const blob = await W.toBlob(it.canvas, name, opts.quality);
    return { name, blob };
  }

  async function downloadOne(it) {
    if (!it.canvas) return;
    try {
      const { name, blob } = await encode(it, settings());
      saveBlob(blob, name);
    } catch (err) {
      stickyNotice(`${it.file.name}: ${err.message}`);
    }
  }

  async function downloadAll() {
    const opts = settings();
    const ready = state.items.filter((it) => it.canvas);
    if (!ready.length) return;
    els.downloadAll.disabled = true;
    const label = els.downloadAll.textContent;
    els.downloadAll.textContent = 'Preparing…';
    try {
      const used = new Set();
      const files = [];
      for (const it of ready) {
        const f = await encode(it, opts);
        let name = f.name;
        for (let n = 2; used.has(name); n++) name = f.name.replace(/(\.[^.]+)$/, `_${n}$1`);
        used.add(name);
        files.push({ name, blob: f.blob });
      }
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      saveBlob(await window.makeZip(files), `id_watermarked_${stamp}.zip`);
    } catch (err) {
      stickyNotice(err.message);
    } finally {
      els.downloadAll.textContent = label;
      els.downloadAll.disabled = false;
    }
  }

  /* ---------- custom font ---------- */

  async function loadCustomFont(file) {
    try {
      const face = new FontFace('WatermarkCustomFont', await file.arrayBuffer());
      await face.load();
      // Replace any font loaded before.
      for (const f of Array.from(document.fonts)) {
        if (f.family.replace(/"/g, '') === 'WatermarkCustomFont') document.fonts.delete(f);
      }
      document.fonts.add(face);
      // Use the file as it is (no synthetic bold), like the script does with --font.
      state.customFont = { family: '"WatermarkCustomFont"', weight: 'normal' };
      els.fontHint.textContent = `Using ${file.name}.`;
      els.fontReset.hidden = false;
    } catch {
      state.customFont = null;
      els.fontFile.value = '';
      stickyNotice(`${file.name} is not a font this browser can read. Use a .ttf, .otf or .woff file.`);
    }
    scheduleRender(0);
  }

  /* ---------- events ---------- */

  els.form.addEventListener('submit', (e) => e.preventDefault());

  els.text.addEventListener('input', () => {
    updateOutputs();
    scheduleRender(250);
  });

  els.withDate.addEventListener('change', () => {
    updateOutputs();
    scheduleRender(0);
  });

  for (const radio of els.form.elements.strength) {
    radio.addEventListener('change', () => {
      applyPreset();
      scheduleRender(0);
    });
  }

  for (const el of [els.opacity, els.spacing, els.color, els.angle, els.fontSize, els.maxSide, els.seed]) {
    el.addEventListener('input', () => {
      updateOutputs();
      scheduleRender();
    });
  }

  els.lines.addEventListener('change', () => scheduleRender(0));
  els.quality.addEventListener('input', updateOutputs);

  els.colorReset.addEventListener('click', () => {
    els.color.value = W.DEFAULTS.color;
    scheduleRender(0);
  });

  els.fontFile.addEventListener('change', () => {
    const file = els.fontFile.files[0];
    if (file) loadCustomFont(file);
  });

  els.fontReset.addEventListener('click', () => {
    state.customFont = null;
    els.fontFile.value = '';
    els.fontReset.hidden = true;
    els.fontHint.textContent = FONT_HINT;
    scheduleRender(0);
  });

  els.reshuffle.addEventListener('click', () => {
    state.sessionSeed = W.randomSeed();
    els.seed.value = '';
    scheduleRender(0);
  });

  els.pick.addEventListener('click', () => els.files.click());
  els.addMore.addEventListener('click', () => els.files.click());
  els.files.addEventListener('change', () => {
    addFiles(els.files.files);
    els.files.value = '';
  });

  els.downloadAll.addEventListener('click', downloadAll);

  els.clearAll.addEventListener('click', () => {
    state.generation++;
    state.items = [];
    els.items.replaceChildren();
    refreshStatus();
  });

  // Drop anywhere on the page; never let the browser open the dropped file.
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    dragDepth++;
    els.dropzone.classList.add('is-over');
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.dropzone.classList.remove('is-over');
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.dropzone.classList.remove('is-over');
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  document.addEventListener('paste', (e) => {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter(looksLikeImage);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  /* ---------- masthead guilloche ---------- */

  function drawGuilloche() {
    const svg = $('guilloche');
    const NS = 'http://www.w3.org/2000/svg';
    const width = 1200;
    const height = 220;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const rng = W.makeRng(20261015);

    const wave = (cls, baseY, a1, l1, p1, a2, l2, p2) => {
      let d = '';
      for (let x = 0; x <= width; x += 4) {
        const y =
          baseY + a1 * Math.sin((2 * Math.PI * x) / l1 + p1) + a2 * Math.sin((2 * Math.PI * x) / l2 + p2);
        d += (x ? 'L' : 'M') + x + ' ' + y.toFixed(1);
      }
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', cls);
      svg.appendChild(path);
    };

    // Interlaced teal rosette-like band: pairs of waves drifting out of phase.
    for (let i = 0; i < 28; i++) {
      const t = i / 27;
      wave('g-teal', height * (0.15 + 0.7 * t), 28, 420, t * 2.4, 12, 150, -t * 5.2);
    }
    // A few red security lines, like the ones the tool draws.
    for (let i = 0; i < 3; i++) {
      wave(
        'g-red',
        height * (0.25 + 0.25 * i),
        height * rng.uniform(0.08, 0.16),
        width * rng.uniform(0.3, 0.6),
        rng.uniform(0, 2 * Math.PI),
        0,
        1,
        0
      );
    }
  }

  /* ---------- init ---------- */

  W.fontReady.then((ok) => {
    if (!ok) {
      els.fontHint.textContent =
        'The bundled font could not be loaded, so a system font is used and the text may look slightly different.';
    }
  });

  els.today.textContent = W.formatDate(new Date());
  applyPreset();
  drawGuilloche();
  refreshStatus();
})();
