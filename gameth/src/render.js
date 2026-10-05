/* HOTPLATE — render.js
 * Four-layer canvas renderer: terrain (static town), demand (period heatmap),
 * territory (animated market-share morph), entities (restaurants, radii, deserts,
 * best-response heatmap, customer/scooter flow). DPR-aware, reduced-motion aware.
 * Consumes HP.Core + HP.Engine. UMD (browser + Node no-op).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'), require('./engine.js'));
  else { root.HP = root.HP || {}; root.HP.Render = factory(root.HP.Core, root.HP.Engine); }
})(typeof self !== 'undefined' ? self : this, function (Core, Engine) {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : self);
  var ZONES = Core.ZONES, CFG = Engine.CONFIG;

  // ---- palette (mirrors style.css: A amber, B teal, C rose) ----
  var PLAYER_RGB = [[245, 166, 35], [45, 212, 191], [244, 63, 94]];
  // Building footprints: a small stock of shapes drawn per cell. A uniform inset
  // box on every cell reads as graph paper; irregular slabs read as a town.
  var BODY = [
    [0.26, 0.24, 0.48, 0.54], [0.14, 0.30, 0.72, 0.36], [0.33, 0.16, 0.34, 0.70],
    [0.20, 0.20, 0.60, 0.62], [0.40, 0.26, 0.30, 0.46], [0.24, 0.40, 0.56, 0.30]
  ];
  // A tower block: body plus two offsets, for high-density cells.
  var TOWER = [
    [0.22, 0.28, 0.52, 0.50], [0.36, 0.16, 0.34, 0.30], [0.30, 0.56, 0.40, 0.26]
  ];
  var PAL = { bg: '#0d0e13', grid: 'rgba(255,255,255,0.045)', water: '#12203c', waterEdge: 'rgba(110,168,240,0.62)', bridge: '#4b3b28', bridgePlank: 'rgba(210,170,120,0.35)', arterial: 'rgba(228,232,240,0.62)', arterialCore: 'rgba(255,255,255,0.28)', oneway: 'rgba(245,166,35,0.85)', desert: 'rgba(150,150,165,0.55)', label: 'rgba(232,236,245,0.72)' };
  // Land sits warm and mid-toned, water cool and dark. The glow pass in
  // drawDemand is additive and warm, so if land is also warm the whole board
  // washes out to one orange-blue sheet; these values are deliberately kept
  // apart in both hue and value.
  var ZONE_FILL = { residential: '#20222c', mall: '#2a1d3a', office: '#152a38', campus: '#172c20', park: '#182e1d' };

  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function colorFor(i) { var c = PLAYER_RGB[i % 3]; return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  var R = {
    cvs: null, ctx: null, host: null, town: null, cell: 18, cw: 0, ch: 0, dpr: 1,
    reduced: false, _terr: null, _entArgs: null, _anim: {},
    fx: [], _glide: null, _glideTracks: null
  };

  function init(canvases, host) {
    R.cvs = canvases; R.ctx = {}; R.host = host || null;
    for (var k in canvases) if (canvases[k]) R.ctx[k] = canvases[k].getContext('2d');
    if (typeof matchMedia === 'function') {
      try { R.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { R.reduced = false; }
    }
    return R;
  }
  function setReducedMotion(b) { R.reduced = !!b; }

  // Size every layer to a shared grid derived from the AVAILABLE stage area.
  // Measuring the canvas itself is wrong: an unsized canvas reports 300x150 and
  // the map collapses to a thumbnail.
  function resize(town) {
    R.town = town;
    var availW = 0, availH = 0;
    if (R.host) {
      var hb = R.host.getBoundingClientRect();
      var cs = (typeof getComputedStyle === 'function') ? getComputedStyle(R.host) : null;
      var padX = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 0;
      var padY = cs ? (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) : 0;
      availW = hb.width - padX; availH = hb.height - padY;
    }
    if (!(availW > 0)) availW = 900;
    if (!(availH > 0)) availH = 600;
    var cell = Math.max(10, Math.floor(Math.min(availW / town.W, availH / town.H)));
    R.cell = cell; R.cw = cell * town.W; R.ch = cell * town.H;
    R.dpr = Math.min(2, (root.devicePixelRatio || 1));
    for (var k in R.cvs) {
      var c = R.cvs[k]; if (!c) continue;
      c.width = Math.round(R.cw * R.dpr); c.height = Math.round(R.ch * R.dpr);
      c.style.width = R.cw + 'px'; c.style.height = R.ch + 'px';
      R.ctx[k].setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    }
    if (R.cvs.terrain && R.cvs.terrain.parentNode && R.cvs.terrain.parentNode.style) {
      R.cvs.terrain.parentNode.style.width = R.cw + 'px';
      R.cvs.terrain.parentNode.style.height = R.ch + 'px';
    }
  }
  function clear(ctx) { ctx.clearRect(0, 0, R.cw, R.ch); }
  function P(v) { return v * R.cell; }              // cell units -> css px
  function isRoad(t, i) { return t.road[i] === 1 || t.road[i] === 2; }

  // Deterministic hash -> [0,1). Same town always draws the same buildings, so
  // the map does not shimmer between redraws.
  function hash2(x, y) {
    var h = x * 374761393 + y * 668265263;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  }

  // Building slabs for one cell. Coordinates come back in CELL units (0..1),
  // so the caller multiplies by the live cell size.
  //
  // The important part is `drawable`: real city blocks are contiguous masses
  // with gaps between them, not one tidy box per lot. Cells are grouped into
  // 3x3 super-blocks and the whole group is skipped when its hash misses, which
  // carves genuine streets and courtyards out of what would otherwise be an even
  // polka-dot field. A small proportion of groups are kept at low density so
  // there is still the occasional lone building.
  function groupKeeps(x, y, dens) {
    var gx = (x / 3) | 0, gy = (y / 3) | 0;
    var h = hash2(gx * 71 + 13, gy * 97 + 29);
    var thresh = 0.80 + Math.min(0.13, dens * 0.16);   // denser areas keep more
    if (h < thresh) return hash2(gx + 5, gy + 3) < 0.22;  // thinned, not empty
    return true;
  }
  function blockRects(x, y, dens) {
    var r1 = hash2(x, y), r2 = hash2(x + 91, y + 17), r3 = hash2(x + 7, y + 131);
    var out = [], spr = (r1 < 0.62) ? BODY[(r1 * 6) | 0] : TOWER[(r1 * 3) | 0];
    for (var i = 0; i < spr.length; i += 4) {
      var jx = (r2 - 0.5) * 0.07, jy = (r3 - 0.5) * 0.07;
      out.push([spr[i] + jx, spr[i + 1] + jy, spr[i + 2], spr[i + 3]]);
    }
    if (dens > 0.55) {                              // a neighbouring annexe
      var ax = 0.58 + r3 * 0.16, ay = 0.30 + r2 * 0.28;
      out.push([ax, ay, 0.24, 0.30]);
    }
    // Merge into a joint mass where the neighbour to the east or south is also
    // kept: adjacent cells then read as one block face rather than two lots.
    if (groupKeeps(x + 1, y, dens) && hash2(x + 200, y) < 0.55) out.push([0.82 + r2 * 0.10, 0.24, 0.34, 0.52]);
    if (groupKeeps(x, y + 1, dens) && hash2(x, y + 200) < 0.55) out.push([0.26, 0.82 + r3 * 0.10, 0.50, 0.34]);
    return out;
  }

  // ---------- LAYER 1: terrain ----------
  function drawTown(town) {
    resize(town);
    var g = R.ctx.terrain, W = town.W, H = town.H, cell = R.cell;
    clear(g);
    g.fillStyle = PAL.bg; g.fillRect(0, 0, R.cw, R.ch);

    // zone district fills
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var i = y * W + x; if (town.water[i]) continue;
      g.fillStyle = ZONE_FILL[ZONES[town.zone[i]]] || ZONE_FILL.residential;
      g.fillRect(P(x), P(y), cell, cell);
    }

    // building footprints — density becomes visible urban texture, not flat colour.
    // Shapes vary per cell so the town reads as built-up rather than as a lattice.
    for (var by2 = 0; by2 < H; by2++) for (var bx2 = 0; bx2 < W; bx2++) {
      var bi2 = by2 * W + bx2;
      if (town.water[bi2] || isRoad(town, bi2)) continue;
      var dens = town.base[bi2]; if (dens <= 0.04) continue;
      var zn2 = ZONES[town.zone[bi2]];
      if (zn2 === 'park') continue;
      if (!groupKeeps(bx2, by2, dens)) continue;     // leave a street or a yard
      var recs = blockRects(bx2, by2, dens);
      var lit = 0.028 + Math.min(0.085, dens * 0.11);
      // two passes: every footprint's drop shadow first, then every lit face, so
      // overlapping masses in the same cell do not shadow each other
      for (var ri = 0; ri < recs.length; ri++) {
        var rc = recs[ri];
        g.fillStyle = 'rgba(0,0,0,0.34)';
        g.fillRect(P(bx2) + rc[0] * cell + cell * 0.05, P(by2) + rc[1] * cell + cell * 0.06, rc[2] * cell, rc[3] * cell);
      }
      for (var rj = 0; rj < recs.length; rj++) {
        var rd = recs[rj];
        var rw = rd[2] * cell, rh = rd[3] * cell;
        if (rw < 2 || rh < 2) continue;
        var rx = P(bx2) + rd[0] * cell, ry = P(by2) + rd[1] * cell;
        g.fillStyle = 'rgba(255,255,255,' + lit.toFixed(3) + ')';
        g.fillRect(rx, ry, rw, rh);
        // sunlit top edge
        g.fillStyle = 'rgba(255,236,200,' + (lit * 0.9).toFixed(3) + ')';
        g.fillRect(rx, ry, rw, Math.max(1, cell * 0.055));
        // shaded west edge
        g.fillStyle = 'rgba(0,0,0,0.16)';
        g.fillRect(rx, ry, Math.max(1, cell * 0.05), rh);
      }
    }

    // faint grid — drawn only over land, and clipped short of the buildings so it
    // reads as a soft street lattice rather than graph paper
    g.strokeStyle = PAL.grid; g.lineWidth = 1; g.beginPath();
    for (var gx = 0; gx <= W; gx++) {
      for (var gy2 = 0; gy2 < H; gy2++) {
        var ci = gy2 * W + Math.min(W - 1, gx);
        if (town.water[ci] && (gx === 0 || town.water[gy2 * W + gx - 1])) continue;
        g.moveTo(P(gx), P(gy2)); g.lineTo(P(gx), P(gy2 + 1));
      }
    }
    for (var gy = 0; gy <= H; gy++) {
      for (var gx2 = 0; gx2 < W; gx2++) {
        var cj = Math.min(H - 1, gy) * W + gx2;
        if (town.water[cj] && (gy === 0 || town.water[(gy - 1) * W + gx2])) continue;
        g.moveTo(P(gx2), P(gy)); g.lineTo(P(gx2 + 1), P(gy));
      }
    }
    g.stroke();

    // water + carved riverbanks. Depth is faked with distance from the nearest
    // land cell so the ocean has a shelf instead of being one flat fill.
    var depth = new Int16Array(W * H).fill(-1);
    var queue = [];
    for (var wy0 = 0; wy0 < H; wy0++) for (var wx0 = 0; wx0 < W; wx0++) {
      var wi0 = wy0 * W + wx0;
      if (!town.water[wi0]) { depth[wi0] = 0; queue.push(wi0); }
    }
    for (var qi = 0; qi < queue.length; qi++) {
      var cur = queue[qi], cxx = cur % W, cyy = (cur / W) | 0, nd = depth[cur] + 1;
      if (nd > 6) continue;
      if (cxx > 0 && depth[cur - 1] < 0) { depth[cur - 1] = nd; queue.push(cur - 1); }
      if (cxx < W - 1 && depth[cur + 1] < 0) { depth[cur + 1] = nd; queue.push(cur + 1); }
      if (cyy > 0 && depth[cur - W] < 0) { depth[cur - W] = nd; queue.push(cur - W); }
      if (cyy < H - 1 && depth[cur + W] < 0) { depth[cur + W] = nd; queue.push(cur + W); }
    }
    for (var wy = 0; wy < H; wy++) for (var wx = 0; wx < W; wx++) {
      var wi = wy * W + wx; if (!town.water[wi]) continue;
      var dp = depth[wi];
      // shelf: near water is lighter and bluer, deep water falls away to near-black
      var k = dp < 0 ? 1 : Math.min(1, Math.max(0, dp / 5));
      var rr = Math.round(30 + (14 - 30) * k), gg2 = Math.round(56 + (24 - 56) * k), bb = Math.round(96 + (46 - 96) * k);
      g.fillStyle = 'rgb(' + rr + ',' + gg2 + ',' + bb + ')';
      g.fillRect(P(wx), P(wy), cell, cell);
      g.fillStyle = 'rgba(120,180,255,' + (0.055 * (1 - k)).toFixed(3) + ')';
      g.fillRect(P(wx), P(wy) + cell * (0.2 + 0.5 * ((wx * 7 + wy * 13) % 3) / 3), cell, Math.max(1, cell * 0.12));
    }
    g.strokeStyle = PAL.waterEdge; g.lineWidth = Math.max(1, cell * 0.075);
    for (var ey = 0; ey < H; ey++) for (var ex = 0; ex < W; ex++) {
      var ei = ey * W + ex; if (!town.water[ei]) continue;
      // stroke edges adjacent to land
      if (ex > 0 && !town.water[ei - 1]) line(g, P(ex), P(ey), P(ex), P(ey) + cell);
      if (ex < W - 1 && !town.water[ei + 1]) line(g, P(ex) + cell, P(ey), P(ex) + cell, P(ey) + cell);
      if (ey > 0 && !town.water[ei - W]) line(g, P(ex), P(ey), P(ex) + cell, P(ey));
      if (ey < H - 1 && !town.water[ei + W]) line(g, P(ex), P(ey) + cell, P(ex) + cell, P(ey) + cell);
    }

    // shallow-water glow on the land side of every shoreline — this is what makes
    // the coast read instantly instead of relying on a 1px edge
    g.save();
    g.beginPath();
    for (var sy = 0; sy < H; sy++) for (var sx = 0; sx < W; sx++) {
      var si = sy * W + sx; if (town.water[si]) continue;
      var shore = (sx > 0 && town.water[si - 1]) || (sx < W - 1 && town.water[si + 1]) ||
                  (sy > 0 && town.water[si - W]) || (sy < H - 1 && town.water[si + W]);
      if (!shore) continue;
      var gx0 = P(sx), gy0 = P(sy), grx = P(sx) + cell, gry = P(sy) + cell;
      var sg = g.createRadialGradient((gx0 + grx) / 2, (gy0 + gry) / 2, cell * 0.1, (gx0 + grx) / 2, (gy0 + gry) / 2, cell * 1.15);
      sg.addColorStop(0, 'rgba(120,180,255,0.22)');
      sg.addColorStop(1, 'rgba(120,180,255,0)');
      g.fillStyle = sg;
      g.rect(gx0, gy0, cell, cell);
    }
    g.fill();
    g.restore();

    // bridges (wood decks with planks)
    for (var by = 0; by < H; by++) for (var bx = 0; bx < W; bx++) {
      var bi = by * W + bx; if (town.road[bi] !== 2) continue;
      g.fillStyle = PAL.bridge; g.fillRect(P(bx), P(by) + cell * 0.18, cell, cell * 0.64);
      g.strokeStyle = PAL.bridgePlank; g.lineWidth = 1;
      for (var pl = 0; pl < 3; pl++) line(g, P(bx) + cell * (0.2 + pl * 0.3), P(by) + cell * 0.18, P(bx) + cell * (0.2 + pl * 0.3), P(by) + cell * 0.82);
    }

    // arterial road network — casing, asphalt, then a dashed centre line, so a
    // road reads as a road rather than as a bright bar laid over the blocks
    drawRoads(g, town, 1, 'rgba(6,7,10,0.85)', cell * 0.50);
    drawRoads(g, town, 1, PAL.arterial, cell * 0.34);
    drawRoads(g, town, 1, PAL.arterialCore, cell * 0.055, true);

    // one-way chevrons (eastbound flow where westward entry is penalised)
    g.fillStyle = PAL.oneway;
    for (var oy = 0; oy < H; oy++) for (var ox = 0; ox < W; ox++) {
      if (!town.owWest[oy * W + ox]) continue;
      chevron(g, P(ox) + cell * 0.5, P(oy) + cell * 0.5, cell * 0.22);
    }

    // vignette — focuses the eye on the middle of the town
    var vg = g.createRadialGradient(R.cw / 2, R.ch / 2, Math.min(R.cw, R.ch) * 0.34, R.cw / 2, R.ch / 2, Math.max(R.cw, R.ch) * 0.78);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.42)');
    g.fillStyle = vg; g.fillRect(0, 0, R.cw, R.ch);

    // district labels as quiet badges
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '700 ' + Math.max(8, Math.round(cell * 0.42)) + 'px ui-sans-serif,system-ui,sans-serif';
    var lb = town.labels || [
      { p: town.mall, t: 'DOWNTOWN', w: 2.2, h: 1.5 }, { p: town.office, t: 'OFFICE', w: 2, h: 1.5 },
      { p: town.campus, t: 'CAMPUS', w: 2.5, h: 2 }, { p: town.park, t: 'PARK', w: 1.5, h: 1.5 }
    ];
    for (var li = 0; li < lb.length; li++) {
      var L = lb[li]; if (!L.p) continue;
      label(g, L.p, L.t, L.w || 1.5, L.h || 1.5);
    }
    R._terr = town;
  }

  function drawRoads(g, town, kind, color, wd, dash) {
    var W = town.W, H = town.H, cell = R.cell;
    g.strokeStyle = color; g.lineWidth = wd; g.lineCap = 'round';
    g.beginPath();
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var i = y * W + x; if (town.road[i] !== kind && !(kind === 1 && town.road[i] === 2)) continue;
      var cx = P(x) + cell / 2, cy = P(y) + cell / 2;
      // Centre lines break at every cell boundary, where a continuous stroke
      // would smear across junctions; short repeated segments keep the rhythm.
      if (x < W - 1 && (town.road[i + 1] === kind || town.road[i + 1] === 2)) {
        if (dash) { for (var k = 0; k < 3; k++) { g.moveTo(cx + cell * k * 0.34, cy); g.lineTo(cx + cell * (k * 0.34 + 0.2), cy); } }
        else { g.moveTo(cx, cy); g.lineTo(cx + cell, cy); }
      }
      if (y < H - 1 && (town.road[i + W] === kind || town.road[i + W] === 2)) {
        if (dash) { for (var k2 = 0; k2 < 3; k2++) { g.moveTo(cx, cy + cell * k2 * 0.34); g.lineTo(cx, cy + cell * (k2 * 0.34 + 0.2)); } }
        else { g.moveTo(cx, cy); g.lineTo(cx, cy + cell); }
      }
    }
    g.stroke();
  }
  function line(g, a, b, c, d) { g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke(); }
  function chevron(g, cx, cy, s) { g.beginPath(); g.moveTo(cx - s * 0.5, cy - s); g.lineTo(cx + s * 0.5, cy); g.lineTo(cx - s * 0.5, cy + s); g.lineTo(cx - s * 0.15, cy); g.closePath(); g.fill(); }
  function label(g, blk, txt, ox, oy) {
    if (!blk) return;
    var cx = P(blk.x + ox), cy = P(blk.y + oy);
    var w = g.measureText(txt).width + R.cell * 0.55, h = R.cell * 0.72;
    cx = Math.min(Math.max(cx, w / 2 + 3), R.cw - w / 2 - 3);      // keep the badge on the map
    cy = Math.min(Math.max(cy, h / 2 + 3), R.ch - h / 2 - 3);
    g.fillStyle = 'rgba(8,9,13,0.55)';
    roundRect(g, cx - w / 2, cy - h / 2, w, h, h / 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = 1; g.stroke();
    g.fillStyle = PAL.label;
    g.fillText(txt, cx, cy + 0.5);
  }

  // ---------- LAYER 2: demand heatmap (period-adjusted glow) ----------
  function drawDemand(town, period) {
    var g = R.ctx.demand, W = town.W, N = town.N, cell = R.cell;
    clear(g);
    var use2d = true, zm = CFG.zoneMult, ps = CFG.periodShare;
    var inten = new Float64Array(N), max = 0;
    for (var i = 0; i < N; i++) {
      if (town.water[i] || town.base[i] <= 0) continue;
      var zn = ZONES[town.zone[i]];
      var mult = (period && period !== 'all' && use2d) ? (zm[zn][period] * ps[period]) : 1;
      var v = town.base[i] * mult; inten[i] = v; if (v > max) max = v;
    }
    if (max <= 0) return;
    // Two soft passes: a wide low-alpha bloom that reads as city glow, then a
    // tighter core. Overlapping radial gradients blend continuously, so there are
    // no cell edges here — only the per-cell centres are sampled.
    g.globalCompositeOperation = 'lighter';
    for (var c = 0; c < N; c++) {
      var t = inten[c] / max; if (t < 0.06) continue;
      var x = c % W, y = (c / W) | 0, cx = P(x) + cell / 2, cy = P(y) + cell / 2;
      var wide = cell * (1.5 + t * 0.9);
      var gw = g.createRadialGradient(cx, cy, 0, cx, cy, wide);
      gw.addColorStop(0, 'rgba(255,178,72,' + (0.022 + 0.052 * t) + ')');
      gw.addColorStop(0.55, 'rgba(255,150,60,' + (0.010 + 0.026 * t) + ')');
      gw.addColorStop(1, 'rgba(255,140,50,0)');
      g.fillStyle = gw; g.beginPath(); g.arc(cx, cy, wide, 0, 6.2832); g.fill();

      var rad = cell * (0.72 + t * 0.42);
      var grd = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
      grd.addColorStop(0, 'rgba(255,206,118,' + (0.035 + 0.165 * t) + ')');
      grd.addColorStop(0.6, 'rgba(255,166,64,' + (0.015 + 0.075 * t) + ')');
      grd.addColorStop(1, 'rgba(255,150,60,0)');
      g.fillStyle = grd; g.beginPath(); g.arc(cx, cy, rad, 0, 6.2832); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  }

  // ---------- LAYER 3: territory (animated morph) ----------
  function fieldOf(result, N) {
    var arr = new Float32Array(N * 4);
    for (var c = 0; c < N; c++) {
      var own = result.territory[c], sh = result.shareField[c] || 0, o = c * 4;
      if (own === 255) { arr[o] = 150; arr[o + 1] = 150; arr[o + 2] = 165; arr[o + 3] = sh > 0 ? 0.05 + 0.12 * sh : 0; }
      else { var col = PLAYER_RGB[own % 3]; arr[o] = col[0]; arr[o + 1] = col[1]; arr[o + 2] = col[2]; arr[o + 3] = 0.10 + 0.34 * Math.min(1, sh); }
    }
    return arr;
  }

  // Ownership borders. Because the demand glow is also warm, an amber FILL alone
  // cannot be told apart from an amber HEATMAP — the region boundary is what
  // actually communicates "this block is mine". Drawn on the entities layer after
  // the glow so it always sits on top.
  function paintBorders(g, result, town) {
    if (!result || !result.territory) return;
    var W = town.W, H = town.H, cell = R.cell;
    g.lineWidth = Math.max(1.6, cell * 0.085);
    g.lineCap = 'round';
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var i = y * W + x, own = result.territory[i];
      if (own === 255 || town.water[i]) continue;
      var col = PLAYER_RGB[own % 3];
      g.strokeStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',0.85)';
      g.beginPath();
      // an edge exists where the neighbour belongs to someone else
      if (x === 0 || result.territory[i - 1] !== own) { g.moveTo(P(x), P(y)); g.lineTo(P(x), P(y) + cell); }
      if (x === W - 1 || result.territory[i + 1] !== own) { g.moveTo(P(x) + cell, P(y)); g.lineTo(P(x) + cell, P(y) + cell); }
      if (y === 0 || result.territory[i - W] !== own) { g.moveTo(P(x), P(y)); g.lineTo(P(x) + cell, P(y)); }
      if (y === H - 1 || result.territory[i + W] !== own) { g.moveTo(P(x), P(y) + cell); g.lineTo(P(x) + cell, P(y) + cell); }
      g.stroke();
    }
  }
  // The territory wash is the thing that reads as "blocky" if painted naively: a
  // hard fillRect per cell is a checkerboard. Instead we paint the field into a
  // small offscreen buffer at 1 device pixel per CELL and let the upscale to the
  // full canvas interpolate between cells, which turns the per-cell squares into
  // smooth coloured regions with soft edges — for free, and with no per-frame
  // blur cost. Resolved cell colours are cached so the only work per animation
  // frame is a byte lerp.
  var TERR = { buf: null, bctx: null, img: null, N: 0, W: 0, H: 0 };
  function terrEnsure(town) {
    if (TERR.N === town.N && TERR.buf) return;
    TERR.N = town.N; TERR.W = town.W; TERR.H = town.H;
    TERR.buf = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
    if (!TERR.buf) return;
    TERR.buf.width = town.W; TERR.buf.height = town.H;
    TERR.bctx = TERR.buf.getContext('2d');
    TERR.img = TERR.bctx.createImageData(town.W, town.H);
  }
  // Fill the offscreen buffer from an interpolated field; transparent water.
  function terrBlit(from, to, t) {
    var N = TERR.N, W = TERR.W, H = TERR.H, d = TERR.img.data, town = R.town;
    for (var c = 0; c < N; c++) {
      var o = c * 4, q = c * 4;
      if (town.water[c]) { d[q + 3] = 0; continue; }
      var a = from ? from[o + 3] + (to[o + 3] - from[o + 3]) * t : to[o + 3] * t;
      if (a <= 0.004) { d[q + 3] = 0; continue; }
      d[q]     = (from ? from[o]     + (to[o]     - from[o])     * t : to[o])     | 0;
      d[q + 1] = (from ? from[o + 1] + (to[o + 1] - from[o + 1]) * t : to[o + 1]) | 0;
      d[q + 2] = (from ? from[o + 2] + (to[o + 2] - from[o + 2]) * t : to[o + 2]) | 0;
      d[q + 3] = (Math.min(1, a) * 255) | 0;
    }
    TERR.bctx.putImageData(TERR.img, 0, 0);
    roundCorners(town);
    blurBuf(town, 1);
    TERR.bctx.putImageData(TERR.img, 0, 0);
  }
  // Knock the alpha out of convex corners. A grid of axis-aligned squares has
  // nothing but 90-degree angles, which is the single loudest "this is a grid"
  // signal on the board; eroding the four corner pixels of each exposed corner
  // and then letting the blur+upscale soften them makes coastlines read as
  // drawn curves instead of as stairs.
  function roundCorners(town) {
    var W = town.W, H = town.H, d = TERR.img.data;
    var w = function (x, y) { return (x < 0 || y < 0 || x >= W || y >= H) ? 1 : (town.water[y * W + x] ? 1 : 0); };
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      if (w(x, y)) continue;
      var o = (y * W + x) * 4;
      // top-left, top-right, bottom-left, bottom-right convex corners
      if (w(x - 1, y) && w(x, y - 1)) d[o + 3] = 0;
      if (w(x + 1, y) && w(x, y - 1)) d[o + 3] = 0;
      if (w(x - 1, y) && w(x, y + 1)) d[o + 3] = 0;
      if (w(x + 1, y) && w(x, y + 1)) d[o + 3] = 0;
    }
  }

  // Cheap separable box blur, run on the small buffer before upscaling. This is
  // the step that actually fuses one cell's colour into its neighbour's: without
  // it the upscale still shows faint steps at every cell boundary.
  function blurBuf(town, r) {
    var W = town.W, H = town.H, N = W * H, d = TERR.img.data;
    if (!TERR.scratch || TERR.scratch.length !== N * 4) TERR.scratch = new Uint8ClampedArray(N * 4);
    var s = TERR.scratch, i, x, y, k, sum, cnt, q, o;
    // horizontal, premultiplied so transparent water does not darken the edge
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        sum = [0, 0, 0, 0]; cnt = 0;
        for (k = -r; k <= r; k++) {
          var xx = x + k; if (xx < 0 || xx >= W) continue;
          o = (y * W + xx) * 4;
          var a = d[o + 3] / 255;
          sum[0] += d[o] * a; sum[1] += d[o + 1] * a; sum[2] += d[o + 2] * a; sum[3] += a; cnt++;
        }
        q = (y * W + x) * 4;
        if (sum[3] > 0) { s[q] = sum[0] / sum[3]; s[q + 1] = sum[1] / sum[3]; s[q + 2] = sum[2] / sum[3]; }
        s[q + 3] = (sum[3] / cnt) * 255;
      }
    }
    // vertical
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        sum = [0, 0, 0, 0]; cnt = 0;
        for (k = -r; k <= r; k++) {
          var yy = y + k; if (yy < 0 || yy >= H) continue;
          o = (yy * W + x) * 4;
          var a2 = s[o + 3] / 255;
          sum[0] += s[o] * a2; sum[1] += s[o + 1] * a2; sum[2] += s[o + 2] * a2; sum[3] += a2; cnt++;
        }
        q = (y * W + x) * 4;
        if (sum[3] > 0) { d[q] = sum[0] / sum[3]; d[q + 1] = sum[1] / sum[3]; d[q + 2] = sum[2] / sum[3]; }
        d[q + 3] = (sum[3] / cnt) * 255;
      }
    }
  }

  function paintField(g, town, from, to, t) {
    clear(g);
    if (typeof document === 'undefined') return;
    terrEnsure(town);
    if (!TERR.buf) return;
    terrBlit(from, to, t);
    g.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high';
    g.drawImage(TERR.buf, 0, 0, town.W, town.H, 0, 0, R.cw, R.ch);
  }
  function animateTerritory(prevResult, nextResult, ondone) {    var g = R.ctx.territory, town = R.town, N = town.N;
    if (R._anim.terr) { root.cancelAnimationFrame(R._anim.terr); R._anim.terr = null; }
    var to = fieldOf(nextResult, N), from = prevResult ? fieldOf(prevResult, N) : null;
    if (R.reduced || !root.requestAnimationFrame) { paintField(g, town, null, to, 1); if (ondone) ondone(); return; }
    var dur = 620, start = null;
    function step(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / dur), e = easeInOut(t);
      paintField(g, town, from, to, e);
      if (t < 1) R._anim.terr = root.requestAnimationFrame(step);
      else { R._anim.terr = null; if (ondone) ondone(); }
    }
    R._anim.terr = root.requestAnimationFrame(step);
  }
  function paintTerritory(result) { paintField(R.ctx.territory, R.town, null, fieldOf(result, R.town.N), 1); }

  // ---------- LAYER 4: entities & overlays ----------
  function drawEntities(town, state, overlays) {
    overlays = overlays || {}; R._entArgs = [town, state, overlays];
    var g = R.ctx.entities, cell = R.cell, W = town.W;
    clear(g);

    // ownership borders sit directly on the terrain+d glow, under the pins
    if (overlays.result) paintBorders(g, overlays.result, town);

    // best-response profit landscape (Lab)
    if (overlays.heatmap) {
      var hm = overlays.heatmap, min = Infinity, mx = -Infinity;
      for (var i = 0; i < hm.length; i++) if (isFinite(hm[i])) { if (hm[i] < min) min = hm[i]; if (hm[i] > mx) mx = hm[i]; }
      if (mx > min) {
        var best = -1, bv = -Infinity;
        for (var h = 0; h < hm.length; h++) {
          if (!isFinite(hm[h])) continue;
          var t = (hm[h] - min) / (mx - min);
          if (hm[h] > bv) { bv = hm[h]; best = h; }
          var col = t < 0.5 ? [40 + t * 200, 120 + t * 180, 220 - t * 120] : [240, 200 - (t - 0.5) * 180, 60];
          g.fillStyle = 'rgba(' + (col[0] | 0) + ',' + (col[1] | 0) + ',' + (col[2] | 0) + ',' + (0.12 + 0.5 * t) + ')';
          g.fillRect(P(h % W), P((h / W) | 0), cell, cell);
        }
        if (best >= 0) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(P(best % W) + 1, P((best / W) | 0) + 1, cell - 2, cell - 2); }
      }
    }

    // food deserts
    if (overlays.deserts && overlays.deserts.length) {
      g.strokeStyle = PAL.desert; g.setLineDash([3, 3]); g.lineWidth = 1.5;
      for (var d = 0; d < overlays.deserts.length; d++) { var dc = overlays.deserts[d]; g.strokeRect(P(dc % W) + 2, P((dc / W) | 0) + 2, cell - 4, cell - 4); }
      g.setLineDash([]);
    }

    // entry-risk pulse around the hottest desert
    if (overlays.entryRisk > 0 && overlays.deserts && overlays.deserts.length) {
      var pulse = overlays.pulse == null ? 0.5 : overlays.pulse;
      var hot = overlays.deserts[0], hb = town.base[hot];
      for (var e = 1; e < overlays.deserts.length; e++) if (town.base[overlays.deserts[e]] > hb) { hb = town.base[overlays.deserts[e]]; hot = overlays.deserts[e]; }
      var hx = P(hot % W) + cell / 2, hy = P((hot / W) | 0) + cell / 2;
      g.strokeStyle = rgba(PLAYER_RGB[2], 0.35 + 0.4 * overlays.entryRisk);
      g.lineWidth = 2; g.beginPath(); g.arc(hx, hy, cell * (1.2 + pulse * 1.6), 0, 6.2832); g.stroke();
    }

    // delivery radius rings
    if (overlays.showRadius !== false && state.mods.delivery) {
      for (var p = 0; p < state.players.length; p++) {
        var pr = state.players[p]; if (!pr.radius) continue;
        g.strokeStyle = rgba(PLAYER_RGB[p % 3], 0.28); g.setLineDash([5, 5]); g.lineWidth = 1.5;
        g.beginPath(); g.arc(P(pr.x) + cell / 2, P(pr.y) + cell / 2, pr.radius * cell * 0.62, 0, 6.2832); g.stroke();
        g.setLineDash([]);
      }
    }

    // ghost placement preview
    if (overlays.ghost) { marker(g, overlays.ghost.x, overlays.ghost.y, overlays.ghost.idx, '?', 1, null, false, false, 0.45); }

    // restaurant markers — a glide override slides them between cells
    for (var m = 0; m < state.players.length; m++) {
      var pl = state.players[m], mx = pl.x, my = pl.y;
      var gv = R._glide && R._glide[pl.id];
      if (gv) { mx = gv.x; my = gv.y; }
      marker(g, mx, my, m, pl.isChain ? 'C' : pl.id, pl.tier, pl.price, pl.isChain, overlays.selected === pl.id, 1);
    }

    // hover highlight
    if (overlays.hover) { g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 2; g.strokeRect(P(overlays.hover.x) + 1, P(overlays.hover.y) + 1, cell - 2, cell - 2); }
  }

  function marker(g, x, y, idx, letter, tier, price, isChain, sel, alpha) {
    var cell = R.cell, cx = P(x) + cell / 2, cy = P(y) + cell / 2;
    var r = Math.max(9, cell * 0.42), col = PLAYER_RGB[idx % 3];
    g.save(); g.globalAlpha = alpha == null ? 1 : alpha;
    // shadow
    g.fillStyle = 'rgba(0,0,0,0.45)'; g.beginPath(); g.arc(cx, cy + 2, r, 0, 6.2832); g.fill();
    // selection halo
    if (sel) { g.strokeStyle = rgba(col, 0.9); g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, r + 4, 0, 6.2832); g.stroke(); }
    // body
    g.fillStyle = rgba(col, 1); g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.fill();
    g.strokeStyle = isChain ? '#fff' : 'rgba(10,10,14,0.85)'; g.lineWidth = 2; g.stroke();
    // tier pips (quality)
    if (tier != null) {
      g.fillStyle = 'rgba(12,12,16,0.9)';
      for (var t = 0; t <= tier; t++) { var a = -Math.PI / 2 + (t - tier / 2) * 0.5; g.beginPath(); g.arc(cx + Math.cos(a) * r * 0.62, cy + Math.sin(a) * r * 0.62, Math.max(1.4, r * 0.11), 0, 6.2832); g.fill(); }
    }
    // letter
    g.fillStyle = '#12120f'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '800 ' + Math.round(r * 1.05) + 'px ui-sans-serif,system-ui,sans-serif';
    g.fillText(letter, cx, cy + 1);
    // price chip
    if (price != null) {
      var txt = '$' + (Math.round(price * 10) / 10), pw = txt.length * r * 0.34 + r * 0.5, ph = r * 0.7, py = cy + r + ph * 0.55;
      g.fillStyle = 'rgba(8,9,13,0.9)'; roundRect(g, cx - pw / 2, py - ph / 2, pw, ph, ph / 2); g.fill();
      g.fillStyle = rgba(col, 1); g.font = '700 ' + Math.round(r * 0.62) + 'px ui-monospace,Consolas,monospace';
      g.fillText(txt, cx, py + 0.5);
    }
    g.restore();
  }
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

  // ---------- FX: truck glides, impact rings, floating numbers ----------
  // Everything rides on the entities layer above a fresh drawEntities(), so the
  // same two helpers serve both the FX loop and the customer-flow loop below.
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function fxClear() {
    R.fx.length = 0; R._glide = null; R._glideTracks = null;
    if (R._anim.fx) { root.cancelAnimationFrame(R._anim.fx); R._anim.fx = null; }
  }
  function fxFloat(x, y, idx, text, kind) { R.fx.push({ k: 'float', x: x, y: y, idx: idx, text: text, kind: kind || 'up', born: -1, life: 1500 }); }
  function fxRing(x, y, idx, life) { R.fx.push({ k: 'ring', x: x, y: y, idx: idx, born: -1, life: life || 820 }); }
  function fxGlide(tracks, dur) {                    // tracks: [{id,x0,y0,x1,y1}]
    if (!tracks || !tracks.length) return;
    R._glideTracks = { list: tracks, dur: dur || 620, born: -1 };
  }

  // advance the glide interpolation; must run BEFORE drawEntities each frame
  function glideStep(ts) {
    if (!R._glideTracks) return false;
    var gt = R._glideTracks;
    if (gt.born < 0) gt.born = ts;
    var p = Math.min(1, (ts - gt.born) / gt.dur), e = easeInOut(p), map = {};
    for (var i = 0; i < gt.list.length; i++) {
      var tr = gt.list[i];
      map[tr.id] = { x: tr.x0 + (tr.x1 - tr.x0) * e, y: tr.y0 + (tr.y1 - tr.y0) * e };
    }
    R._glide = map;
    if (p >= 1) { R._glide = null; R._glideTracks = null; return false; }
    return true;
  }

  // paint queued rings / floating numbers; must run AFTER drawEntities
  function fxPaint(ts, g) {
    var live = false, cell = R.cell;
    for (var i = 0; i < R.fx.length; i++) {
      var f = R.fx[i];
      if (f.born < 0) f.born = ts;
      var k = (ts - f.born) / f.life;
      if (k >= 1) continue;
      live = true;
      var col = PLAYER_RGB[f.idx % 3], cx = P(f.x) + cell / 2, cy = P(f.y) + cell / 2;
      if (f.k === 'ring') {
        g.strokeStyle = rgba(col, 0.6 * (1 - k)); g.lineWidth = Math.max(1.5, cell * 0.12 * (1 - k));
        g.beginPath(); g.arc(cx, cy, cell * (0.45 + 2.6 * easeOutCubic(k)), 0, 6.2832); g.stroke();
      } else {
        var y = cy - cell * 1.05 - cell * 2.2 * easeOutCubic(k);
        g.save(); g.globalAlpha = Math.max(0, k < 0.12 ? k / 0.12 : 1 - (k - 0.12) / 0.88);
        g.font = '800 ' + Math.max(11, Math.round(cell * 0.62)) + 'px ui-monospace,Consolas,monospace';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.lineWidth = 3.5; g.strokeStyle = 'rgba(6,7,10,0.9)'; g.strokeText(f.text, cx, y);
        g.fillStyle = f.kind === 'down' ? 'rgb(248,113,113)' : rgba(col, 1); g.fillText(f.text, cx, y);
        g.restore();
      }
    }
    return live;
  }

  function fxRun(ondone) {
    var g = R.ctx.entities;
    if (R.reduced || !root.requestAnimationFrame) {
      fxClear(); if (R._entArgs) drawEntities(R._entArgs[0], R._entArgs[1], R._entArgs[2]);
      if (ondone) ondone(); return;
    }
    if (R._anim.fx) { root.cancelAnimationFrame(R._anim.fx); R._anim.fx = null; }
    function frame(ts) {
      var live = glideStep(ts);
      if (R._entArgs) drawEntities(R._entArgs[0], R._entArgs[1], R._entArgs[2]);
      if (fxPaint(ts, g)) live = true;
      if (live) R._anim.fx = root.requestAnimationFrame(frame);
      else {
        R._anim.fx = null; R.fx.length = 0;
        if (R._entArgs) drawEntities(R._entArgs[0], R._entArgs[1], R._entArgs[2]);
        if (ondone) ondone();
      }
    }
    R._anim.fx = root.requestAnimationFrame(frame);
  }

  // ---------- customer / scooter flow (restrained, opt-in) ----------
  function flow(town, state, result, ondone) {
    if (R.reduced || !root.requestAnimationFrame || !result || !result._cellFrac) {
      fxClear(); if (R._entArgs) drawEntities(R._entArgs[0], R._entArgs[1], R._entArgs[2]);
      if (ondone) ondone(); return;
    }
    if (R._anim.flow) { root.cancelAnimationFrame(R._anim.flow); R._anim.flow = null; }
    if (R._anim.fx) { root.cancelAnimationFrame(R._anim.fx); R._anim.fx = null; }   // one loop owns the layer
    var W = town.W, N = town.N, STRIDE = Engine.STRIDE, cell = R.cell, dots = [];
    var step = Math.max(1, Math.floor(N / 260));   // sample ~260 origins for perf
    for (var c = 0; c < N; c += step) {
      if (town.water[c] || town.base[c] <= 0) continue;
      var own = -1, bv = 0;
      for (var k = 0; k < state.players.length; k++) { var fr = result._cellFrac[c * STRIDE + k]; if (fr > bv) { bv = fr; own = k; } }
      if (own < 0 || bv < 0.12) continue;
      var pl = state.players[own];
      dots.push({ x0: c % W, y0: (c / W) | 0, x1: pl.x, y1: pl.y, own: own, sp: 0.6 + (bv), delay: (c % 7) * 0.05 });
    }
    var g = R.ctx.entities, dur = 1500, start = null;
    function frame(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / dur), live = glideStep(ts);
      if (R._entArgs) drawEntities(R._entArgs[0], R._entArgs[1], R._entArgs[2]);
      for (var i = 0; i < dots.length; i++) {
        var dt = dots[i], lt = Math.max(0, Math.min(1, (t - dt.delay) * dt.sp));
        if (lt <= 0) continue;
        var e = easeInOut(lt), px = P(dt.x0 + (dt.x1 - dt.x0) * e) + cell / 2, py = P(dt.y0 + (dt.y1 - dt.y0) * e) + cell / 2;
        g.fillStyle = rgba(PLAYER_RGB[dt.own % 3], 0.85 * (1 - lt * 0.4));
        g.beginPath(); g.arc(px, py, Math.max(1.6, cell * 0.1), 0, 6.2832); g.fill();
      }
      if (fxPaint(ts, g)) live = true;
      if (t < 1 || live) R._anim.flow = root.requestAnimationFrame(frame);
      else {
        R._anim.flow = null; R.fx.length = 0;
        if (R._entArgs) drawEntities(R._entArgs[0], R._entArgs[1], R._entArgs[2]);
        if (ondone) ondone();
      }
    }
    R._anim.flow = root.requestAnimationFrame(frame);
  }

  // ---------- capture (composite all layers) for report figures ----------
  function capturePNG() {
    if (typeof document === 'undefined') return null;
    var tmp = document.createElement('canvas'); tmp.width = R.cvs.terrain.width; tmp.height = R.cvs.terrain.height;
    var g = tmp.getContext('2d');
    ['terrain', 'demand', 'territory', 'entities'].forEach(function (k) { if (R.cvs[k]) g.drawImage(R.cvs[k], 0, 0); });
    return tmp.toDataURL('image/png');
  }

  // pointer helper: css-pixel offset within a layer -> {x,y} cell or null
  function cellFromPoint(px, py) {
    var x = Math.floor(px / R.cell), y = Math.floor(py / R.cell);
    if (!R.town || x < 0 || y < 0 || x >= R.town.W || y >= R.town.H) return null;
    return { x: x, y: y };
  }
  function metrics() { return { cell: R.cell, cw: R.cw, ch: R.ch, W: R.town ? R.town.W : 0, H: R.town ? R.town.H : 0 }; }

  return {
    init: init, setReducedMotion: setReducedMotion, drawTown: drawTown, drawDemand: drawDemand,
    animateTerritory: animateTerritory, paintTerritory: paintTerritory, drawEntities: drawEntities, flow: flow,
    fxClear: fxClear, fxFloat: fxFloat, fxRing: fxRing, fxGlide: fxGlide, fxRun: fxRun,
    capturePNG: capturePNG, cellFromPoint: cellFromPoint, metrics: metrics, colorFor: colorFor, resize: resize
  };
});
