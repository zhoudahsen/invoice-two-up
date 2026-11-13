/* =========================================================
   周大神发票合并助手 · 合成引擎
   全部逻辑在浏览器里跑：读入 → 裁白 → 合成 → 打印/导出
   ========================================================= */
(function () {
  'use strict';

  /* ---------- 常量 ---------- */
  var DPI = 300;
  var MM = DPI / 25.4;                 // 11.811 px / mm
  var PAGE_W = Math.round(210 * MM);   // 2480
  var PAGE_H = Math.round(297 * MM);   // 3508
  var MAX_INPUT_AREA = 24e6;           // 单张输入像素上限，防止内存爆掉
  var MAX_PDF_SIDE = 5200;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ---------- 状态 ---------- */
  var state = {
    slots: { a: null, b: null },
    mode: 'compact',
    marginMm: 6,
    gapMm: 4,
    cut: 'dashed',
    whiten: true
  };
  var busy = { a: false, b: false };
  var tokens = { a: 0, b: 0 };
  var lastRender = null;
  var lastMetrics = null;
  var rafId = 0;

  /* ---------- DOM 引用 ---------- */
  var slotUI = {};
  $$('[data-slot]').forEach(function (el) {
    var key = el.getAttribute('data-slot');
    slotUI[key] = {
      root: el,
      drop: $('[data-drop]', el),
      file: $('[data-file]', el),
      empty: $('[data-empty]', el),
      filled: $('[data-filled]', el),
      busy: $('[data-busy]', el),
      thumb: $('[data-thumb]', el),
      name: $('[data-name]', el),
      info: $('[data-info]', el),
      badge: $('[data-badge]', el),
      url: $('[data-url]', el),
      fetch: $('[data-fetch]', el),
      tools: $('[data-tools]', el),
      pages: $('[data-pages]', el),
      pageSelect: $('[data-page-select]', el),
      note: $('[data-note]', el),
      rotate: $('[data-rotate]', el),
      remove: $('[data-remove]', el)
    };
  });

  var preview = $('#preview');
  var statusEl = $('[data-status]');
  var guidesLayer = $('[data-guides-layer]');
  var gMargin = $('.g-margin', guidesLayer);
  var btnPrint = $('[data-print]');
  var btnPdf = $('[data-pdf]');
  var btnPng = $('[data-png]');
  var btnSwap = $('[data-swap]');
  var toastEl = $('[data-toast]');
  var printCanvas = $('#printCanvas');
  var printCtx = printCanvas ? printCanvas.getContext('2d') : null;

  /* =========================================================
     工具函数
     ========================================================= */

  var toastTimer = 0;
  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.hidden = false;
    requestAnimationFrame(function () { toastEl.classList.add('is-on'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('is-on');
      setTimeout(function () { toastEl.hidden = true; }, 220);
    }, 3600);
  }

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function ctx2d(canvas) {
    return canvas.getContext('2d', { willReadFrequently: true });
  }

  function isPdf(name, type) {
    return (type && type.indexOf('pdf') !== -1) || /\.pdf($|\?)/i.test(name || '');
  }

  function isImage(name, type) {
    return (type && /^image\//.test(type)) || /\.(png|jpe?g|webp|bmp|gif|tiff?)($|\?)/i.test(name || '');
  }

  function sniffBlob(blob, name) {
    return blob.slice(0, 8).arrayBuffer().then(function (buf) {
      var head = new Uint8Array(buf);
      var magic = String.fromCharCode.apply(null, Array.prototype.slice.call(head, 0, 5));
      if (magic === '%PDF-') return 'pdf';
      if (head[0] === 0x89 && head[1] === 0x50) return 'image';
      if (head[0] === 0xff && head[1] === 0xd8) return 'image';
      if (head[0] === 0x52 && head[1] === 0x49) return 'image';
      if (isPdf(name, blob.type)) return 'pdf';
      if (isImage(name, blob.type)) return 'image';
      throw new Error('这个文件既不是 PDF 也不是图片');
    });
  }

  function rotateCanvas(src, deg) {
    var d = ((deg % 360) + 360) % 360;
    if (!d) return src;
    var swap = d === 90 || d === 270;
    var out = makeCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
    var ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(d * Math.PI / 180);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    return out;
  }

  /**
   * 找票面内容的外框：把四边像素的中位色当纸张底色，
   * 偏离底色超过阈值的像素算内容。返回原始坐标。
   */
  function detectBox(canvas) {
    var sw = Math.min(canvas.width, 900);
    var sh = Math.max(1, Math.round(canvas.height * sw / canvas.width));
    var tmp = makeCanvas(sw, sh);
    var tctx = ctx2d(tmp);
    tctx.drawImage(canvas, 0, 0, sw, sh);
    var data;
    try { data = tctx.getImageData(0, 0, sw, sh).data; } catch (e) { return null; }

    var rs = [], gs = [], bs = [];
    var x, y, i;
    for (x = 0; x < sw; x += 3) {
      for (var yy = 0; yy < 2; yy++) {
        y = yy * (sh - 1);
        i = (y * sw + x) * 4;
        rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
      }
    }
    for (y = 0; y < sh; y += 3) {
      for (var xx = 0; xx < 2; xx++) {
        x = xx * (sw - 1);
        i = (y * sw + x) * 4;
        rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
      }
    }
    function median(arr) {
      arr.sort(function (a, b) { return a - b; });
      return arr[Math.floor(arr.length / 2)] || 255;
    }
    var br = median(rs), bg = median(gs), bb = median(bs);

    var rows = new Uint16Array(sh), cols = new Uint16Array(sw);
    var thr = 20;
    for (y = 0; y < sh; y++) {
      for (x = 0; x < sw; x++) {
        i = (y * sw + x) * 4;
        var dr = Math.abs(data[i] - br);
        var dg = Math.abs(data[i + 1] - bg);
        var db = Math.abs(data[i + 2] - bb);
        if (dr > thr || dg > thr || db > thr) {
          rows[y]++; cols[x]++;
        }
      }
    }

    var minY = -1, maxY = -1, minX = -1, maxX = -1;
    var needY = Math.max(2, Math.round(sw / 500));
    var needX = Math.max(2, Math.round(sh / 500));
    for (y = 0; y < sh; y++) if (rows[y] >= needY) { if (minY < 0) minY = y; maxY = y; }
    for (x = 0; x < sw; x++) if (cols[x] >= needX) { if (minX < 0) minX = x; maxX = x; }
    if (minY < 0 || minX < 0) return null;

    var wRatio = maxX - minX + 1, hRatio = maxY - minY + 1;
    if (!wRatio || !hRatio) return null;

    var scaleX = canvas.width / sw, scaleY = canvas.height / sh;
    var bx = Math.floor(minX * scaleX);
    var by = Math.floor(minY * scaleY);
    var bw = Math.ceil((maxX - minX + 1) * scaleX);
    var bh = Math.ceil((maxY - minY + 1) * scaleY);

    // 四周留安全区，防止裁到印章边缘
    var pad = Math.max(3, Math.round(canvas.width * 0.007));
    var left = Math.max(0, bx - pad);
    var top = Math.max(0, by - pad);
    var right = Math.min(canvas.width, bx + bw + pad);
    var bottom = Math.min(canvas.height, by + bh + pad);

    var edge = bx <= 1 || by <= 1 || bx + bw >= canvas.width - 1 || by + bh >= canvas.height - 1;

    return {
      sx: left, sy: top,
      sw: right - left, sh: bottom - top,
      edge: edge,
      tight: (right - left) * (bottom - top) / (canvas.width * canvas.height)
    };
  }

  function cropCanvas(src, box) {
    var out = makeCanvas(box.sw, box.sh);
    var ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, box.sx, box.sy, box.sw, box.sh, 0, 0, out.width, out.height);
    return out;
  }

  /**
   * 纸面增白：按高光分位把偏灰的纸推到白色，顺带修一点色偏。
   */
  function whitenCanvas(source) {
    var canvas = makeCanvas(source.width, source.height);
    var ctx = ctx2d(canvas);
    ctx.drawImage(source, 0, 0);
    var img;
    try { img = ctx.getImageData(0, 0, canvas.width, canvas.height); } catch (e) { return source; }
    var d = img.data, len = d.length;

    // 抽样统计各通道 99% 分位
    var histR = new Uint32Array(256), histG = new Uint32Array(256), histB = new Uint32Array(256);
    var step = 4 * 17;
    for (var i = 0; i < len; i += step) {
      histR[d[i]]++; histG[d[i + 1]]++; histB[d[i + 2]]++;
    }
    function percentile(hist, total, p) {
      var acc = 0, target = total * p;
      for (var v = 255; v >= 0; v--) {
        acc += hist[v];
        if (acc >= target) return v;
      }
      return 255;
    }
    var total = Math.ceil(len / step);
    var wr = percentile(histR, total, 0.99);
    var wg = percentile(histG, total, 0.99);
    var wb = percentile(histB, total, 0.99);
    if (wr > 250 && wg > 250 && wb > 250) return canvas;

    var fr = Math.min(1.4, 255 / Math.max(1, wr));
    var fg = Math.min(1.4, 255 / Math.max(1, wg));
    var fb = Math.min(1.4, 255 / Math.max(1, wb));
    if (fr < 1.02 && fg < 1.02 && fb < 1.02) return canvas;

    for (var j = 0; j < len; j += 4) {
      d[j] = Math.min(255, d[j] * fr);
      d[j + 1] = Math.min(255, d[j + 1] * fg);
      d[j + 2] = Math.min(255, d[j + 2] * fb);
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function thumbOf(canvas) {
    var max = 160;
    var scale = Math.min(1, max / canvas.width, max * 1.4 / canvas.height);
    var c = makeCanvas(canvas.width * scale, canvas.height * scale);
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  }

  /* =========================================================
     读入：PDF / 图片 / 网址
     ========================================================= */

  function pdfLib() {
    if (!window.pdfjsLib) return Promise.reject(new Error('PDF 解析库没有加载成功，请刷新页面；或先把发票转成图片再上传'));
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    return Promise.resolve(window.pdfjsLib);
  }

  function renderPdfPage(doc, pageIndex) {
    return doc.getPage(pageIndex + 1).then(function (page) {
      var base = page.getViewport({ scale: 1 });
      var scale = DPI / 72;
      var maxSide = Math.max(base.width, base.height) * scale;
      if (maxSide > MAX_PDF_SIDE) scale *= MAX_PDF_SIDE / maxSide;
      var area = base.width * scale * base.height * scale;
      if (area > MAX_INPUT_AREA) scale *= Math.sqrt(MAX_INPUT_AREA / area);
      var vp = page.getViewport({ scale: scale });
      var canvas = makeCanvas(Math.floor(vp.width), Math.floor(vp.height));
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
        return canvas;
      });
    });
  }

  function imageToCanvas(blob) {
    var load = ('createImageBitmap' in window)
      ? createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(function () { return createImageBitmap(blob); })
      : Promise.reject(new Error('no createImageBitmap'));

    return load.catch(function () {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
        img.src = url;
      });
    }).then(function (src) {
      var w = src.width, h = src.height;
      if (!w || !h) throw new Error('图片尺寸异常');
      var scale = 1;
      if (w * h > MAX_INPUT_AREA) scale = Math.sqrt(MAX_INPUT_AREA / (w * h));
      if (Math.max(w, h) * scale > 5600) scale = 5600 / Math.max(w, h);
      var canvas = makeCanvas(w * scale, h * scale);
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
      if (src.close) src.close();
      return canvas;
    });
  }

  function ingest(key, blob, name, source) {
    var token = ++tokens[key];
    busy[key] = true;
    state.slots[key] = null;
    renderSlot(key);
    flashStatus('正在解析…');

    sniffBlob(blob, name).then(function (kind) {
      if (kind === 'pdf') {
        return pdfLib()
          .then(function (lib) {
            return blob.arrayBuffer().then(function (buf) {
              return lib.getDocument({ data: new Uint8Array(buf) }).promise;
            });
          })
          .then(function (doc) {
            return renderPdfPage(doc, 0).then(function (canvas) {
              return {
                name: name || '发票.pdf',
                kind: 'pdf',
                source: source,
                doc: doc,
                pages: doc.numPages,
                pageIndex: 0,
                sourceCanvas: canvas,
                rotation: 0,
                note: doc.numPages > 1 ? '这份 PDF 共 ' + doc.numPages + ' 页，可在下面选页码。' : '',
                thumb: thumbOf(canvas)
              };
            });
          });
      }
      if (kind === 'image') {
        return imageToCanvas(blob).then(function (canvas) {
          return {
            name: name || '发票.png',
            kind: 'image',
            source: source,
            doc: null,
            pages: 1,
            pageIndex: 0,
            sourceCanvas: canvas,
            rotation: 0,
            note: '',
            thumb: thumbOf(canvas)
          };
        });
      }
      throw new Error('无法识别的文件类型');
    }).then(function (item) {
      if (token !== tokens[key]) return;
      busy[key] = false;
      state.slots[key] = item;
      renderSlot(key);
      schedule();
      if (item.kind === 'pdf' && item.pages > 1) {
        toast('这份 PDF 有 ' + item.pages + ' 页，记得在「页码」里挑对应的那一页');
      }
    }).catch(function (err) {
      if (token !== tokens[key]) return;
      busy[key] = false;
      state.slots[key] = null;
      renderSlot(key);
      showNote(key, (err && err.message) ? err.message : '读取失败', true);
      schedule();
    });
  }

  function fetchInvoice(url) {
    var proxy = location.origin === 'null' || location.protocol === 'file:'
      ? null
      : '/api/proxy?url=' + encodeURIComponent(url);

    var tries = proxy ? [proxy, url] : [url];
    var lastErr = null;

    function attempt(idx) {
      if (idx >= tries.length) {
        return Promise.reject(lastErr || new Error('地址读取失败'));
      }
      var target = tries[idx];
      return fetch(target, { mode: 'cors', credentials: 'omit', redirect: 'follow' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          var type = res.headers.get('content-type') || '';
          if (/text\/html|application\/xhtml/i.test(type)) throw new Error('这个地址返回的是网页，不是发票文件');
          return res.blob();
        })
        .then(function (blob) {
          if (blob.size > 25 * 1024 * 1024) throw new Error('文件超过 25 MB');
          return blob;
        })
        .catch(function (err) {
          lastErr = err;
          return attempt(idx + 1);
        });
    }
    return attempt(0);
  }

  /* =========================================================
     合成
     ========================================================= */

  function processed(item) {
    var cacheKey = state.whiten + '|' + item.rotation;
    if (item._cache && item._cacheKey === cacheKey) return item._cache;

    var canvas = item.rotation ? rotateCanvas(item.sourceCanvas, item.rotation) : item.sourceCanvas;
    var box = detectBox(canvas);
    item.cropped = false;
    item.edge = false;
    if (box && box.tight < 0.995) {
      canvas = cropCanvas(canvas, box);
      item.cropped = true;
      item.edge = box.edge;
    }
    if (state.whiten) canvas = whitenCanvas(canvas);

    item._cache = canvas;
    item._cacheKey = cacheKey;
    return canvas;
  }

  function compose() {
    var out = makeCanvas(PAGE_W, PAGE_H);
    var ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);

    var margin = state.marginMm * MM;
    var gap = state.gapMm * MM;
    var availW = PAGE_W - margin * 2;
    var availH = PAGE_H - margin * 2;

    var keys = ['a', 'b'];
    var items = [];
    keys.forEach(function (k) {
      if (state.slots[k]) items.push({ key: k, canvas: processed(state.slots[k]) });
    });

    var metrics = { count: items.length, minDpi: 0, fill: 0, scaled: false, edge: false };

    if (items.length) {
      var gapTotal = gap * (items.length - 1);
      var drawn = [];

      if (state.mode === 'halves') {
        var slotH = (availH - gapTotal) / items.length;
        items.forEach(function (it, index) {
          var s = Math.min(availW / it.canvas.width, slotH / it.canvas.height);
          var dw = it.canvas.width * s;
          var dh = it.canvas.height * s;
          var dx = margin + (availW - dw) / 2;
          var dy = margin + index * (slotH + gap) + (slotH - dh) / 2;
          drawItem(ctx, it.canvas, dx, dy, dw, dh);
          drawn.push({ item: it, dw: dw, dh: dh, s: s, dx: dx, dy: dy });
        });
      } else {
        var scales = items.map(function (it) { return availW / it.canvas.width; });
        var contentH = items.reduce(function (sum, it, i) { return sum + it.canvas.height * scales[i]; }, 0);

        if (contentH + gapTotal > availH) {
          var k = (availH - gapTotal) / contentH;
          scales = scales.map(function (s) { return s * k; });
          contentH *= k;
          metrics.scaled = true;
        }

        var startY = margin + (availH - (contentH + gapTotal)) / 2;
        var y = startY;
        items.forEach(function (it, i) {
          var dw = it.canvas.width * scales[i];
          var dh = it.canvas.height * scales[i];
          var dx = margin + (availW - dw) / 2;
          drawItem(ctx, it.canvas, dx, y, dw, dh);
          drawn.push({ item: it, dw: dw, dh: dh, s: scales[i], dx: dx, dy: y });
          y += dh + gap;
        });
      }

      metrics.fill = (drawn.reduce(function (s, d) { return s + d.dh; }, 0) + gapTotal) / availH;
      metrics.minDpi = Math.round(Math.min.apply(null, drawn.map(function (d) {
        return d.item.canvas.width / (d.dw / MM / 25.4);
      })));
      metrics.edge = keys.some(function (k) { return state.slots[k] && state.slots[k].edge; });
      metrics.items = drawn;

      if (state.cut !== 'none' && items.length > 1) {
        var cutY = drawn[0].dy + drawn[0].dh + gap / 2;
        if (cutY > margin && cutY < PAGE_H - margin) {
          ctx.save();
          ctx.strokeStyle = 'rgba(20,22,26,0.28)';
          ctx.lineWidth = Math.max(1, Math.round(0.25 * MM));
          if (state.cut === 'dashed') ctx.setLineDash([6 * MM, 4 * MM]);
          ctx.beginPath();
          ctx.moveTo(margin, Math.round(cutY));
          ctx.lineTo(PAGE_W - margin, Math.round(cutY));
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    return { canvas: out, metrics: metrics };
  }

  function drawItem(ctx, canvas, x, y, w, h) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  /* =========================================================
     渲染界面
     ========================================================= */

  function schedule() {
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      render();
    });
  }

  function render() {
    var result = compose();
    lastRender = result.canvas;
    lastMetrics = result.metrics;

    var pw = preview.width, ph = preview.height;
    var pctx = preview.getContext('2d');
    pctx.fillStyle = '#ffffff';
    pctx.fillRect(0, 0, pw, ph);
    pctx.imageSmoothingEnabled = true;
    pctx.imageSmoothingQuality = 'high';
    pctx.drawImage(result.canvas, 0, 0, pw, ph);

    updateStatus();
    updateActions();
    updateGuides();
  }

  function flashStatus(text) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.remove('is-warn');
  }

  function updateStatus() {
    var m = lastMetrics;
    if (!m || m.count === 0) {
      statusEl.textContent = '还没有发票，先放入发票 A。';
      statusEl.classList.remove('is-warn');
      return;
    }
    if (m.count === 1) {
      statusEl.textContent = '目前只有一张发票。再放一张，就会合并到同一页。';
      statusEl.classList.remove('is-warn');
      return;
    }

    var summary = '占版心 ' + Math.round(m.fill * 100) + '%，最低清晰度约 ' + m.minDpi + ' DPI';

    var warn = [];
    if (m.minDpi < 180) warn.push('其中一张放大后印出来只有 ' + m.minDpi + ' DPI，字可能发虚，建议换成原始 PDF');
    if (m.scaled) warn.push('总高超过一页，两张已按同一比例缩小');
    if (m.edge) warn.push('有票面内容贴近原图边缘，请核对没有被截断');

    statusEl.textContent = warn.length
      ? summary + '。' + warn.join('；') + '。'
      : summary + '，两张都完整落在版心内。';
    statusEl.classList.toggle('is-warn', warn.length > 0);
  }

  function updateActions() {
    var ready = !!(lastMetrics && lastMetrics.count);
    btnPrint.disabled = !ready;
    btnPdf.disabled = !ready;
    btnPng.disabled = !ready;
    btnSwap.disabled = !(state.slots.a && state.slots.b);
  }

  function updateGuides() {
    if (!gMargin) return;
    var lr = (state.marginMm / 210) * 100;
    var tb = (state.marginMm / 297) * 100;
    gMargin.style.left = lr + '%';
    gMargin.style.right = lr + '%';
    gMargin.style.top = tb + '%';
    gMargin.style.bottom = tb + '%';
  }

  function renderSlot(key) {
    var ui = slotUI[key];
    if (!ui) return;
    var item = state.slots[key];
    var isBusy = busy[key];

    ui.busy.hidden = !isBusy;
    ui.empty.hidden = isBusy || !!item;
    ui.filled.hidden = isBusy || !item;

    if (item) {
      ui.thumb.src = item.thumb || '';
      ui.name.textContent = item.name;
      var w = item.sourceCanvas.width, h = item.sourceCanvas.height;
      ui.info.textContent = (item.kind === 'pdf' ? 'PDF' : '图片') + ' · ' + w + '×' + h + 'px' +
        (item.pages > 1 ? ' · 第 ' + (item.pageIndex + 1) + '/' + item.pages + ' 页' : '');
    }

    ui.badge.textContent = isBusy ? '解析中' : (item ? '已就绪' : '待放入');
    ui.badge.className = 'slot-badge' + (isBusy ? ' is-work' : (item ? ' is-ready' : ''));

    ui.tools.hidden = !item;
    ui.pages.hidden = !(item && item.doc && item.pages > 1);

    if (item && item.doc && item.pages > 1) {
      if (ui.pageSelect.options.length !== item.pages) {
        ui.pageSelect.innerHTML = '';
        for (var i = 0; i < item.pages; i++) {
          var opt = document.createElement('option');
          opt.value = String(i);
          opt.textContent = (i + 1) + ' / ' + item.pages;
          ui.pageSelect.appendChild(opt);
        }
      }
      ui.pageSelect.value = String(item.pageIndex);
    }

    if (item && item.note) {
      ui.note.textContent = item.note;
      ui.note.className = 'slot-note';
      ui.note.hidden = false;
    } else {
      ui.note.hidden = true;
    }
  }

  function showNote(key, text, isError) {
    var ui = slotUI[key];
    if (!ui) return;
    ui.note.textContent = text;
    ui.note.className = 'slot-note' + (isError ? ' is-error' : ' is-warn');
    ui.note.hidden = false;
  }

  /* =========================================================
     事件绑定
     ========================================================= */

  function wireSlot(key) {
    var ui = slotUI[key];

    ui.drop.addEventListener('click', function () {
      if (!busy[key]) ui.file.click();
    });
    ui.drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!busy[key]) ui.file.click();
      }
    });
    ui.drop.addEventListener('dragover', function (e) {
      e.preventDefault();
      ui.drop.classList.add('is-over');
    });
    ui.drop.addEventListener('dragleave', function () {
      ui.drop.classList.remove('is-over');
    });
    ui.drop.addEventListener('drop', function (e) {
      e.preventDefault();
      ui.drop.classList.remove('is-over');
      handleFiles(key, e.dataTransfer.files);
    });

    ui.file.addEventListener('change', function () {
      handleFiles(key, ui.file.files);
      ui.file.value = '';
    });

    ui.fetch.addEventListener('click', function () { loadUrl(key); });
    ui.url.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); loadUrl(key); }
    });

    ui.remove.addEventListener('click', function () {
      tokens[key]++;
      busy[key] = false;
      state.slots[key] = null;
      ui.url.value = '';
      renderSlot(key);
      schedule();
    });

    ui.rotate.addEventListener('click', function () {
      var item = state.slots[key];
      if (!item) return;
      item.rotation = (item.rotation + 90) % 360;
      item._cache = null;
      renderSlot(key);
      schedule();
    });

    ui.pageSelect.addEventListener('change', function () {
      var item = state.slots[key];
      if (!item || !item.doc) return;
      var idx = parseInt(ui.pageSelect.value, 10) || 0;
      var token = tokens[key];
      busy[key] = true;
      renderSlot(key);
      renderPdfPage(item.doc, idx).then(function (canvas) {
        if (token !== tokens[key]) return;
        busy[key] = false;
        item.pageIndex = idx;
        item.sourceCanvas = canvas;
        item.thumb = thumbOf(canvas);
        item.note = '';
        item._cache = null;
        renderSlot(key);
        schedule();
      }).catch(function (err) {
        busy[key] = false;
        renderSlot(key);
        showNote(key, '这一页渲染失败：' + (err.message || err), true);
      });
    });
  }

  function handleFiles(key, fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    if (files.length === 1) {
      ingest(key, files[0], files[0].name, 'file');
      return;
    }
    // 一次选两张：分给两个位置
    ingest(key, files[0], files[0].name, 'file');
    var other = key === 'a' ? 'b' : 'a';
    ingest(other, files[1], files[1].name, 'file');
    if (files.length > 2) toast('一次最多处理两张，已取前两个文件');
  }

  function splitUrls(text) {
    return String(text || '')
      .split(/[\s,，、\n]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return /^https?:\/\//i.test(s); });
  }

  function loadUrl(key) {
    var ui = slotUI[key];
    var urls = splitUrls(ui.url.value);
    if (!urls.length) { toast('请先粘贴一个以 http 开头的发票直链'); return; }

    var primary = urls[0];
    var other = key === 'a' ? 'b' : 'a';
    var extra = urls[1];

    busy[key] = true;
    renderSlot(key);
    flashStatus('正在通过边缘函数取回文件…');

    fetchInvoice(primary).then(function (blob) {
      var name = decodeURIComponent(primary.split('/').pop().split('?')[0] || '发票文件');
      ingest(key, blob, name, 'url');
      if (extra) {
        fetchInvoice(extra).then(function (blob2) {
          var name2 = decodeURIComponent(extra.split('/').pop().split('?')[0] || '发票文件');
          ingest(other, blob2, name2, 'url');
        }).catch(function (err) {
          toast('第二个链接没取到：' + (err.message || err));
        });
      }
    }).catch(function (err) {
      busy[key] = false;
      renderSlot(key);
      showNote(key, '链接读取失败：' + (err.message || err) + '。换个直链，或先把文件下载到本地再上传。', true);
      toast('链接读取失败');
      schedule();
    });
  }

  /* ---------- 设置 ---------- */
  $$('[data-mode]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.mode = btn.getAttribute('data-mode');
      $$('[data-mode]').forEach(function (b) { b.classList.toggle('is-on', b === btn); });
      var note = $('[data-mode-note]');
      if (note) {
        note.textContent = state.mode === 'halves'
          ? '页面上下各占一半，两张各自在自己的半页里居中；票面偏矮时会留白，但上下两联始终对齐。'
          : '两张票各自去掉白边后上下排列、整体居中；一旦超出一页，两张按同一比例缩小，不会只缩其中一张。';
      }
      schedule();
    });
  });

  $$('[data-cut]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.cut = btn.getAttribute('data-cut');
      $$('[data-cut]').forEach(function (b) { b.classList.toggle('is-on', b === btn); });
      schedule();
    });
  });

  var marginInput = $('[data-margin]');
  var marginOut = $('[data-margin-out]');
  marginInput.addEventListener('input', function () {
    state.marginMm = parseInt(marginInput.value, 10);
    marginOut.textContent = state.marginMm + ' mm';
    schedule();
  });

  var gapInput = $('[data-gap]');
  var gapOut = $('[data-gap-out]');
  gapInput.addEventListener('input', function () {
    state.gapMm = parseInt(gapInput.value, 10);
    gapOut.textContent = state.gapMm + ' mm';
    schedule();
  });

  var whitenInput = $('[data-whiten]');
  whitenInput.addEventListener('change', function () {
    state.whiten = whitenInput.checked;
    ['a', 'b'].forEach(function (k) {
      if (state.slots[k]) state.slots[k]._cache = null;
    });
    schedule();
  });

  var guidesBtn = $('[data-guides]');
  guidesBtn.addEventListener('click', function () {
    var on = guidesBtn.getAttribute('aria-pressed') === 'true';
    guidesBtn.setAttribute('aria-pressed', String(!on));
    guidesLayer.hidden = on;
  });

  /* ---------- 输出 ---------- */
  function canvasBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('生成图片失败'));
      }, type, quality);
    });
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  }

  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  /* ---------- 打印：把成品画进打印层，同步调用 print ---------- */
  function paintPrintCanvas() {
    if (!printCtx || !lastRender) return false;
    if (printCanvas.width !== lastRender.width || printCanvas.height !== lastRender.height) {
      printCanvas.width = lastRender.width;
      printCanvas.height = lastRender.height;
    }
    printCtx.fillStyle = '#ffffff';
    printCtx.fillRect(0, 0, printCanvas.width, printCanvas.height);
    printCtx.drawImage(lastRender, 0, 0);
    return true;
  }

  btnPrint.addEventListener('click', function () {
    if (!lastRender || !lastMetrics || !lastMetrics.count) return;
    if (!paintPrintCanvas()) {
      toast('打印层没有准备好，请刷新页面重试');
      return;
    }
    // 同步调用，不经过 Promise，避免部分浏览器把它当成非用户手势而拦掉
    window.print();
  });

  btnPng.addEventListener('click', function () {
    if (!lastRender) return;
    canvasBlob(lastRender, 'image/png').then(function (blob) {
      download(blob, '发票合并-A4-' + stamp() + '.png');
      toast('已保存 2480×3508 的 A4 PNG');
    });
  });

  btnPdf.addEventListener('click', function () {
    if (!lastRender) return;
    canvasBlob(lastRender, 'image/jpeg', 0.95).then(function (blob) {
      return blob.arrayBuffer().then(function (buf) {
        return buildPdf(new Uint8Array(buf), lastRender.width, lastRender.height);
      });
    }).then(function (pdfBlob) {
      download(pdfBlob, '发票合并-A4-' + stamp() + '.pdf');
      toast('已保存单页 A4 PDF');
    }).catch(function () {
      toast('PDF 生成失败，可以先保存 PNG');
    });
  });

  btnSwap.addEventListener('click', function () {
    var a = state.slots.a, b = state.slots.b;
    state.slots.a = b;
    state.slots.b = a;
    ['a', 'b'].forEach(function (k) {
      var ui = slotUI[k];
      if (ui) ui.url.value = '';
      renderSlot(k);
    });
    schedule();
  });

  /**
   * 极简 PDF 写出：单页 A4，嵌入一张 JPEG（DCTDecode）。
   */
  function buildPdf(jpeg, pxW, pxH) {
    var enc = new TextEncoder();
    var parts = [], len = 0, offsets = {};
    function push(u8) { parts.push(u8); len += u8.length; }
    function text(s) { push(enc.encode(s)); }

    var pageW = 595.28, pageH = 841.89;

    text('%PDF-1.4\n');
    offsets[1] = len;
    text('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    offsets[2] = len;
    text('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
    offsets[3] = len;
    text('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageW + ' ' + pageH +
      '] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n');
    offsets[4] = len;
    text('4 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + pxW + ' /Height ' + pxH +
      ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>\nstream\n');
    push(jpeg);
    text('\nendstream\nendobj\n');

    var content = 'q ' + pageW + ' 0 0 ' + pageH + ' 0 0 cm /Im0 Do Q';
    offsets[5] = len;
    text('5 0 obj\n<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n');

    var xref = len;
    var s = 'xref\n0 6\n0000000000 65535 f \n';
    for (var i = 1; i <= 5; i++) {
      s += ('0000000000' + offsets[i]).slice(-10) + ' 00000 n \n';
    }
    s += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    text(s);

    return new Blob(parts, { type: 'application/pdf' });
  }

  /* ---------- 页内交互：Tab / 复制 ---------- */
  $$('[data-tab]').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var name = tab.getAttribute('data-tab');
      $$('[data-tab]').forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', String(on));
      });
      $$('[data-panel]').forEach(function (panel) {
        panel.hidden = panel.getAttribute('data-panel') !== name;
      });
    });
  });

  $$('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var code = btn.closest('.code');
      var text = code ? $('pre code', code).textContent : '';
      var done = function () {
        btn.textContent = '已复制';
        setTimeout(function () { btn.textContent = '复制'; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () { toast('复制失败，请手动选中'); });
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败'); }
        ta.remove();
      }
    });
  });

  /* ---------- 全局拖拽兜底 ---------- */
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  /* ---------- 初始化 ---------- */
  ['a', 'b'].forEach(wireSlot);
  preview.width = 620;
  preview.height = Math.round(620 * 297 / 210);
  updateGuides();
  updateActions();
  render();

  // 便于自定义扩展
  window.InvoiceTwoUp = {
    state: state,
    compose: compose,
    ingest: ingest
  };
})();
