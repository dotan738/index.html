/* Card image "fingerprint" – shared by the app (browser) and the index builder (Node).
   Input: RGBA pixels of a whole card resized to 60 x 84.
   Output: 168 signed bytes:
     - artwork brightness, 10 x 8 cells
     - artwork colour (blue-ish / red-ish difference), 5 x 4 cells each
     - whole-card brightness, 6 x 8 cells (frame / layout – helps full-art cards)
   Each part is normalised on its own (mean 0, spread 1), so light and camera
   colour differences between a phone photo and the official scan mostly cancel out. */
(function (root) {
  const W = 60, H = 84;
  const PARTS = [
    // [channel, x0, y0, x1, y1, columns, rows, weight]
    ['y', 4, 9, 56, 41, 10, 8, 1.0],
    ['cb', 4, 9, 56, 41, 5, 4, 0.5],
    ['cr', 4, 9, 56, 41, 5, 4, 0.5],
    ['y', 0, 0, 60, 84, 6, 8, 0.7],
  ];
  const DIM = PARTS.reduce((s, p) => s + p[5] * p[6], 0); // 168
  const SEGMENTS = [];
  (function () {
    let off = 0;
    for (const p of PARTS) { const n = p[5] * p[6]; SEGMENTS.push([off, off + n, p[7]]); off += n; }
  })();

  function features(rgba) {
    const n = W * H;
    const ch = { y: new Float32Array(n), cb: new Float32Array(n), cr: new Float32Array(n) };
    for (let i = 0; i < n; i++) {
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      ch.y[i] = y; ch.cb[i] = b - y; ch.cr[i] = r - y;
    }
    const out = new Int8Array(DIM);
    let o = 0;
    for (const [c, x0, y0, x1, y1, cols, rows] of PARTS) {
      const src = ch[c], vals = [];
      for (let ry = 0; ry < rows; ry++) {
        const ya = Math.round(y0 + (y1 - y0) * ry / rows), yb = Math.round(y0 + (y1 - y0) * (ry + 1) / rows);
        for (let rx = 0; rx < cols; rx++) {
          const xa = Math.round(x0 + (x1 - x0) * rx / cols), xb = Math.round(x0 + (x1 - x0) * (rx + 1) / cols);
          let s = 0, k = 0;
          for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) { s += src[y * W + x]; k++; }
          vals.push(k ? s / k : 0);
        }
      }
      const m = vals.reduce((a, v) => a + v, 0) / vals.length;
      const sd = Math.max(4, Math.sqrt(vals.reduce((a, v) => a + (v - m) * (v - m), 0) / vals.length));
      for (const v of vals) out[o++] = Math.max(-127, Math.min(127, Math.round((v - m) / sd * 32)));
    }
    return out;
  }

  /** Similarity between two fingerprints (about -1 .. 1, 1 = identical). b may be a big array, bOff = start index. */
  function similarity(a, b, bOff) {
    bOff = bOff || 0;
    let tot = 0, wsum = 0;
    for (const [s, e, w] of SEGMENTS) {
      let dot = 0;
      for (let i = s; i < e; i++) dot += a[i] * b[bOff + i];
      tot += w * dot / ((e - s) * 1024);
      wsum += w;
    }
    return tot / wsum;
  }

  root.CardFeatures = { W, H, DIM, features, similarity };
})(typeof self !== 'undefined' ? self : globalThis);
