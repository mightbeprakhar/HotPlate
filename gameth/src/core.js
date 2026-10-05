/* HOTPLATE — core.js
 * Seeded RNG, procedural town generation, road graph, and cached Dijkstra
 * travel-time fields. No dependencies. UMD: window.HP.Core in the browser,
 * module.exports under Node (for headless tests).
 *
 * Towns are built from one of six LAYOUTS, then perturbed by independent
 * quirks, so two seeds give structurally different maps — not just jittered
 * copies of the same one. Each layout bends Hotelling a different way:
 * a gorge is near-1-D (minimum differentiation), twin cities reward splitting,
 * a single downtown core turns the game into a volume-vs-rent bet.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.HP = root.HP || {}; root.HP.Core = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var W = 32, H = 22;                       // town grid dimensions
  var ZONES = ['residential', 'mall', 'office', 'campus', 'park'];
  var Z = { residential: 0, mall: 1, office: 2, campus: 3, park: 4 };
  var LAYOUTS = ['riverfront', 'bay', 'twincities', 'downtown', 'gorge', 'archipelago'];

  // ---- seeded PRNG (mulberry32 over a hashed string/number seed) ----
  function hashSeed(seed) {
    var s = String(seed), h = 1779033703 ^ s.length;
    for (var i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return h >>> 0;
  }
  function rng(seed) {
    var a = hashSeed(seed);
    function next() {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return {
      next: next,
      int: function (n) { return Math.floor(next() * n); },
      range: function (lo, hi) { return lo + next() * (hi - lo); },
      chance: function (p) { return next() < p; },
      pick: function (arr) { return arr[Math.floor(next() * arr.length)]; }
    };
  }

  function idx(town, x, y) { return y * town.W + x; }
  function xy(town, i) { return { x: i % town.W, y: (i / town.W) | 0 }; }
  function inb(x, y) { return x >= 0 && x < W && y >= 0 && y < H; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // enter-cost per cell: arterial/bridge fast, park slow, water impassable
  var COST = { arterial: 0.40, bridge: 0.40, street: 1.0, park: 1.7, water: Infinity };
  var ONEWAY_PENALTY = 6.0;   // wrong-way travel forces a detour (cost), not impossibility

  // ---------------------------------------------------------------------------
  // Build helpers — every layout works through these, so the grid invariants
  // (water never carries road, zones never land on water) hold by construction.
  // ---------------------------------------------------------------------------
  function mk(T) {
    return {
      wet: function (x, y) { if (inb(x, y)) { var i = y * W + x; T.water[i] = 1; T.road[i] = 0; T.zone[i] = 0; } },
      dry: function (x, y) { if (inb(x, y)) T.water[y * W + x] = 0; },
      isWet: function (x, y) { return !inb(x, y) || T.water[y * W + x] === 1; },
      // roads never overwrite a stronger class: bridge(2) > arterial(1) > street(0)
      road: function (x, y, kind) {
        if (!inb(x, y)) return;
        var i = y * W + x; if (T.water[i]) return;
        if (kind >= T.road[i]) T.road[i] = kind;
      },
      block: function (zx, zy, bw, bh, zid) {
        for (var yy = zy; yy < zy + bh; yy++)
          for (var xx = zx; xx < zx + bw; xx++)
            if (inb(xx, yy) && !T.water[yy * W + xx]) T.zone[yy * W + xx] = zid;
      }
    };
  }

  // Bresenham: paint a road (and optionally dry the ground) along a line.
  function stroke(T, g, x0, y0, x1, y1, kind, carve) {
    var dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    var dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1, err = dx + dy;
    for (var guard = 0; guard < 4 * (W + H); guard++) {
      if (carve) g.dry(x0, y0);
      g.road(x0, y0, kind);
      if (x0 === x1 && y0 === y1) break;
      var e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  function rowRoad(T, g, y, kind) { for (var x = 0; x < W; x++) g.road(x, y, kind); }
  function colRoad(T, g, x, kind) { for (var y = 0; y < H; y++) g.road(x, y, kind); }

  // Nearest dry cell to (x,y) — anchors must never sit in the water.
  function nearestDry(T, x, y) {
    x = clamp(Math.round(x), 0, W - 1); y = clamp(Math.round(y), 0, H - 1);
    if (!T.water[y * W + x]) return { x: x, y: y };
    for (var rad = 1; rad < Math.max(W, H); rad++)
      for (var dy = -rad; dy <= rad; dy++)
        for (var dx = -rad; dx <= rad; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
          var nx = x + dx, ny = y + dy;
          if (inb(nx, ny) && !T.water[ny * W + nx]) return { x: nx, y: ny };
        }
    return { x: 0, y: 0 };
  }

  // ---------------------------------------------------------------------------
  // Layouts. Each fills water/road/zone, names its districts, and declares the
  // Gaussian demand centres that give the map its economic personality.
  // ---------------------------------------------------------------------------
  var BUILD = {

    // A river cuts the town in two; a handful of bridges carry everything.
    // Chokepoints matter more than raw distance.
    riverfront: function (c) {
      var T = c.T, g = c.g, r = c.r, vertical = r.chance(0.72);
      var amp = r.range(1.4, 3.2), phase = r.range(0, 6.28), wide = r.chance(0.35) ? 2 : 1;
      var axis = vertical ? 11 + r.int(10) : 8 + r.int(7);
      var span = vertical ? H : W;
      for (var t = 0; t < span; t++) {
        var off = Math.round(axis + amp * Math.sin(phase + t * 0.46));
        for (var d = 0; d <= wide; d++) {
          if (vertical) g.wet(off + d, t); else g.wet(t, off + d);
        }
      }
      // bridges: 2–3 crossings, carved clean through
      var nb = 2 + (r.chance(0.35) ? 1 : 0), cross = [];
      for (var b = 0; b < nb; b++) {
        var at = Math.round((span - 1) * (b + 0.5 + r.range(-0.22, 0.22)) / nb);
        at = clamp(at, 1, span - 2); cross.push(at);
        for (var k = 0; k < (vertical ? W : H); k++) {
          if (vertical) { g.dry(k, at); g.road(k, at, 2); }
          else { g.dry(at, k); g.road(at, k, 2); }
        }
      }
      // one arterial along a crossing, one perpendicular on the wider bank
      var main = cross[r.int(cross.length)];
      if (vertical) rowRoad(T, g, main, 1); else colRoad(T, g, main, 1);
      var far = (axis > (vertical ? W : H) / 2) ? 3 + r.int(4) : (vertical ? W : H) - 7 + r.int(4);
      if (vertical) colRoad(T, g, clamp(far, 1, W - 2), 1); else rowRoad(T, g, clamp(far, 1, H - 2), 1);
      c.arterials = vertical ? [{ row: main }] : [{ row: clamp(far, 1, H - 2) }];

      var mall = nearestDry(T, vertical ? far : main, vertical ? main : far);
      var otherSide = vertical ? (mall.x > axis ? axis - 7 : axis + 7) : mall.x;
      var office = nearestDry(T, vertical ? otherSide : 4 + r.int(5), vertical ? 3 + r.int(3) : (axis > H / 2 ? 3 : H - 5));
      var campus = nearestDry(T, vertical ? otherSide + r.int(5) - 2 : W - 8 + r.int(4), H - 5 + r.int(2));
      var park = nearestDry(T, r.int(W), r.int(H));
      c.anchors = { mall: mall, office: office, campus: campus, park: park };
      g.block(mall.x - 1, mall.y - 1, 3, 3, Z.mall);
      g.block(office.x - 1, office.y - 1, 4, 3, Z.office);
      g.block(campus.x - 2, campus.y - 1, 5, 3, Z.campus);
      g.block(park.x - 1, park.y - 1, 3, 3, Z.park);
      c.centers = [
        { x: mall.x, y: mall.y, a: 1.0, s: 3.3 },
        { x: office.x, y: office.y, a: 0.85, s: 2.7 },
        { x: campus.x, y: campus.y, a: 0.8, s: 3.0 }
      ];
      c.kind = ['Ford', 'Crossing', 'Banks', 'Quay', 'Mills'];
      c.blurb = 'A river splits the town — only the bridges carry trade across.';
    },

    // A bay bites a corner out of the map, leaving a crescent of land.
    // Demand hugs the shore, which flattens the town toward one dimension.
    bay: function (c) {
      var T = c.T, g = c.g, r = c.r;
      var corner = r.int(4);                                  // 0 NW 1 NE 2 SW 3 SE
      var ox = (corner === 1 || corner === 3) ? W - 1 : 0;
      var oy = (corner >= 2) ? H - 1 : 0;
      var R = r.range(12.5, 16.5), wob = r.range(1.2, 2.6), ph = r.range(0, 6.28);
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        var dx = x - ox, dy = (y - oy) * 1.35, a = Math.atan2(dy, dx);
        if (Math.sqrt(dx * dx + dy * dy) < R + wob * Math.sin(ph + a * 3)) g.wet(x, y);
      }
      // promenade: a road that traces just outside the waterline
      for (var yy = 0; yy < H; yy++) for (var xx = 0; xx < W; xx++) {
        if (g.isWet(xx, yy)) continue;
        if (g.isWet(xx + 1, yy) || g.isWet(xx - 1, yy) || g.isWet(xx, yy + 1) || g.isWet(xx, yy - 1)) g.road(xx, yy, 1);
      }
      var backRow = (corner >= 2) ? 1 + r.int(3) : H - 4 + r.int(3);
      var backCol = (corner === 1 || corner === 3) ? 1 + r.int(3) : W - 4 + r.int(3);
      rowRoad(T, g, backRow, 1); colRoad(T, g, backCol, 1);
      c.arterials = [{ row: backRow }];

      var mall = nearestDry(T, ox + (ox === 0 ? 1 : -1) * (R + 2), oy + (oy === 0 ? 1 : -1) * (R * 0.42));
      var office = nearestDry(T, backCol, backRow);
      var campus = nearestDry(T, ox + (ox === 0 ? 1 : -1) * (R * 0.4), oy + (oy === 0 ? 1 : -1) * (R + 3));
      var park = nearestDry(T, (mall.x + office.x) / 2, (mall.y + office.y) / 2);
      c.anchors = { mall: mall, office: office, campus: campus, park: park };
      g.block(mall.x - 1, mall.y - 1, 3, 3, Z.mall);
      g.block(office.x - 1, office.y - 1, 4, 3, Z.office);
      g.block(campus.x - 2, campus.y - 1, 5, 3, Z.campus);
      g.block(park.x - 1, park.y - 1, 3, 3, Z.park);
      c.centers = [
        { x: mall.x, y: mall.y, a: 1.0, s: 3.4 },
        { x: campus.x, y: campus.y, a: 0.9, s: 3.0 },
        { x: office.x, y: office.y, a: 0.7, s: 2.8 }
      ];
      c.kind = ['Bay', 'Harbour', 'Cove', 'Point', 'Strand'];
      c.blurb = 'The bay pins the town to a crescent — custom hugs the waterfront.';
    },

    // Two population centres with a thin belt between them. Splitting the map
    // beats crowding: this is the layout where maximum differentiation pays.
    twincities: function (c) {
      var T = c.T, g = c.g, r = c.r;
      var ax = Math.round(r.range(4, 9)), ay = Math.round(r.range(4, H - 5));
      var bx = Math.round(r.range(W - 10, W - 5)), by = Math.round(r.range(4, H - 5));
      if (r.chance(0.45)) {                                   // a lake in the gap
        var lx = (ax + bx) / 2 + r.range(-2, 2), ly = (ay + by) / 2 + r.range(-3, 3), lr = r.range(2.6, 4.4);
        for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
          var d = Math.hypot(x - lx, (y - ly) * 1.25);
          if (d < lr + 0.9 * Math.sin(x * 0.9 + y * 0.6)) g.wet(x, y);
        }
      }
      stroke(T, g, ax, ay, bx, by, 1, true);                  // the highway between them
      rowRoad(T, g, clamp(ay, 1, H - 2), 1);
      colRoad(T, g, clamp(bx, 1, W - 2), 1);
      c.arterials = [{ row: clamp(ay, 1, H - 2) }];

      var mall = nearestDry(T, ax, ay), office = nearestDry(T, bx, by);
      var campus = nearestDry(T, ax + r.range(-2, 3), ay + (ay < H / 2 ? 5 : -5));
      var park = nearestDry(T, (ax + bx) / 2, (ay + by) / 2 + r.range(-4, 4));
      c.anchors = { mall: mall, office: office, campus: campus, park: park };
      g.block(mall.x - 1, mall.y - 1, 3, 3, Z.mall);
      g.block(office.x - 1, office.y - 1, 4, 3, Z.office);
      g.block(campus.x - 2, campus.y - 1, 5, 3, Z.campus);
      g.block(park.x - 1, park.y - 1, 3, 3, Z.park);
      c.centers = [
        { x: mall.x, y: mall.y, a: 1.0, s: 3.1 },
        { x: office.x, y: office.y, a: 0.98, s: 3.1 },
        { x: campus.x, y: campus.y, a: 0.6, s: 2.5 }
      ];
      c.kind = ['Junction', 'Commons', 'Reach', 'Fields', 'Halt'];
      c.blurb = 'Two separate population centres. Crowding one leaves the other wide open.';
    },

    // One dense core, a ring road and radial spokes. Downtown is where the
    // volume is and where the rent hurts — the margin-versus-footfall bet.
    downtown: function (c) {
      var T = c.T, g = c.g, r = c.r;
      var cx = Math.round(W / 2 + r.range(-3, 3)), cy = Math.round(H / 2 + r.range(-2, 2));
      if (r.chance(0.4)) {                                    // an ornamental lake off-centre
        var lx = cx + r.range(-9, 9), ly = cy + r.range(-6, 6), lr = r.range(1.8, 3.2);
        for (var y = 0; y < H; y++) for (var x = 0; x < W; x++)
          if (Math.hypot(x - lx, (y - ly) * 1.3) < lr) g.wet(x, y);
      }
      var R = r.range(5.5, 8.0);                              // the ring road
      for (var yy = 0; yy < H; yy++) for (var xx = 0; xx < W; xx++) {
        var d = Math.hypot(xx - cx, (yy - cy) * 1.4);
        if (Math.abs(d - R) < 0.62) g.road(xx, yy, 1);
      }
      var spokes = 4 + (r.chance(0.5) ? 2 : 0);               // radials out to the edges
      for (var s = 0; s < spokes; s++) {
        var th = (s / spokes) * 6.2832 + r.range(-0.2, 0.2);
        stroke(T, g, cx, cy, clamp(Math.round(cx + Math.cos(th) * W), 0, W - 1), clamp(Math.round(cy + Math.sin(th) * H), 0, H - 1), 1, false);
      }
      rowRoad(T, g, cy, 1);
      c.arterials = [{ row: cy }];

      var mall = nearestDry(T, cx, cy);
      var ang = r.range(0, 6.28);
      var office = nearestDry(T, cx + Math.cos(ang) * R, cy + Math.sin(ang) * R * 0.72);
      var campus = nearestDry(T, cx + Math.cos(ang + 2.4) * (R + 3), cy + Math.sin(ang + 2.4) * (R + 2) * 0.72);
      var park = nearestDry(T, cx + Math.cos(ang + 4.3) * (R - 1), cy + Math.sin(ang + 4.3) * (R - 1) * 0.72);
      c.anchors = { mall: mall, office: office, campus: campus, park: park };
      g.block(mall.x - 2, mall.y - 1, 5, 3, Z.mall);
      g.block(office.x - 1, office.y - 1, 4, 3, Z.office);
      g.block(campus.x - 2, campus.y - 1, 5, 3, Z.campus);
      g.block(park.x - 1, park.y - 1, 3, 3, Z.park);
      c.centers = [
        { x: mall.x, y: mall.y, a: 1.0, s: 4.6 },
        { x: office.x, y: office.y, a: 0.55, s: 2.6 },
        { x: campus.x, y: campus.y, a: 0.5, s: 2.6 }
      ];
      c.kind = ['Central', 'Heights', 'Exchange', 'Circus', 'Core'];
      c.blurb = 'One dense core. The crowds are downtown — so is the rent.';
    },

    // Cliffs squeeze the town into a narrow east–west strip: the closest thing
    // to textbook 1-D Hotelling, where both trucks drift to the middle.
    gorge: function (c) {
      var T = c.T, g = c.g, r = c.r;
      var mid = Math.round(H / 2 + r.range(-2.5, 2.5)), half = r.range(3.0, 4.6);
      var amp = r.range(0.8, 2.0), ph = r.range(0, 6.28);
      for (var x = 0; x < W; x++) {
        var drift = amp * Math.sin(ph + x * 0.28);
        var top = Math.round(mid - half + drift), bot = Math.round(mid + half + drift);
        for (var y = 0; y < H; y++) if (y < top || y > bot) g.wet(x, y);
      }
      if (r.chance(0.45)) {                                   // a side valley off the strip
        var px = 5 + r.int(W - 10), up = r.chance(0.5);
        for (var k = 0; k < 5 + r.int(4); k++) {
          var yy2 = up ? mid - Math.round(half) - k : mid + Math.round(half) + k;
          for (var w2 = -1; w2 <= 1; w2++) g.dry(px + w2, yy2);
        }
      }
      rowRoad(T, g, mid, 1);
      c.arterials = [{ row: mid }];
      for (var sx = 4; sx < W; sx += 6 + r.int(3)) colRoad(T, g, sx, 0);

      var mall = nearestDry(T, W / 2 + r.range(-4, 4), mid);
      var office = nearestDry(T, 3 + r.int(4), mid + r.range(-2, 2));
      var campus = nearestDry(T, W - 6 + r.int(3), mid + r.range(-2, 2));
      var park = nearestDry(T, mall.x + r.range(-8, 8), mid + r.range(-2, 2));
      c.anchors = { mall: mall, office: office, campus: campus, park: park };
      g.block(mall.x - 1, mall.y - 1, 3, 3, Z.mall);
      g.block(office.x - 1, office.y - 1, 3, 3, Z.office);
      g.block(campus.x - 2, campus.y - 1, 4, 3, Z.campus);
      g.block(park.x - 1, park.y, 3, 2, Z.park);
      c.centers = [
        { x: mall.x, y: mall.y, a: 1.0, s: 4.0 },
        { x: office.x, y: office.y, a: 0.8, s: 3.0 },
        { x: campus.x, y: campus.y, a: 0.8, s: 3.0 }
      ];
      c.kind = ['Gorge', 'Narrows', 'Pass', 'Hollow', 'Ravine'];
      c.blurb = 'Cliffs squeeze the town into one long strip — a street with two ends.';
    },

    // Islands joined by causeways. Travel time dominates everything; each island
    // is a near-local monopoly until someone pays to reach across.
    archipelago: function (c) {
      var T = c.T, g = c.g, r = c.r;
      for (var y0 = 0; y0 < H; y0++) for (var x0 = 0; x0 < W; x0++) g.wet(x0, y0);
      var want = 3 + r.int(2), isles = [];
      for (var attempt = 0; attempt < 40 && isles.length < want; attempt++) {
        var ix = Math.round(r.range(5, W - 6)), iy = Math.round(r.range(4, H - 5));
        var rad = r.range(4.2, 5.6), clash = false;
        for (var q = 0; q < isles.length; q++)
          if (Math.hypot(ix - isles[q].x, (iy - isles[q].y) * 1.35) < (rad + isles[q].r) * 0.92) { clash = true; break; }
        if (clash) continue;
        isles.push({ x: ix, y: iy, r: rad });
      }
      for (var m = 0; m < isles.length; m++) {
        var s = isles[m], wob = r.range(0.6, 1.3), ph = r.range(0, 6.28);
        for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
          var dx = x - s.x, dy = (y - s.y) * 1.35, a = Math.atan2(dy, dx);
          if (Math.sqrt(dx * dx + dy * dy) < s.r + wob * Math.sin(ph + a * 2.5)) g.dry(x, y);
        }
      }
      isles.sort(function (p, q2) { return q2.r - p.r; });
      for (var m2 = 0; m2 < isles.length; m2++) {
        var c0 = nearestDry(T, isles[m2].x, isles[m2].y);
        rowRoad(T, g, c0.y, 1);
      }
      c.arterials = [{ row: nearestDry(T, isles[0].x, isles[0].y).y }];

      var mall = nearestDry(T, isles[0].x, isles[0].y);
      var office = nearestDry(T, isles[1 % isles.length].x, isles[1 % isles.length].y);
      var campus = nearestDry(T, isles[2 % isles.length].x, isles[2 % isles.length].y);
      var park = nearestDry(T, isles[(isles.length - 1)].x + 2, isles[isles.length - 1].y + 2);
      c.anchors = { mall: mall, office: office, campus: campus, park: park };
      g.block(mall.x - 1, mall.y - 1, 3, 3, Z.mall);
      g.block(office.x - 1, office.y - 1, 3, 3, Z.office);
      g.block(campus.x - 1, campus.y - 1, 4, 3, Z.campus);
      g.block(park.x - 1, park.y - 1, 2, 2, Z.park);
      c.centers = isles.map(function (s, i) { return { x: s.x, y: s.y, a: i === 0 ? 1.0 : r.range(0.6, 0.9), s: s.r * 0.85 }; });
      c.kind = ['Isles', 'Keys', 'Skerries', 'Shoals', 'Sound'];
      c.blurb = 'Islands and causeways. Every crossing costs time, so reach is everything.';
    }
  };

  // ---------------------------------------------------------------------------
  // Connectivity. Dijkstra over a disconnected map hands back Infinity, which
  // silently turns whole districts into permanent food deserts — so stitch every
  // orphaned landmass back to the mainland with a causeway.
  // ---------------------------------------------------------------------------
  function components(T) {
    var lab = new Int16Array(T.N).fill(-1), comps = [], q = new Int32Array(T.N);
    for (var s = 0; s < T.N; s++) {
      if (T.water[s] || lab[s] >= 0) continue;
      var id = comps.length, head = 0, tail = 0; q[tail++] = s; lab[s] = id;
      var cells = [];
      while (head < tail) {
        var u = q[head++]; cells.push(u);
        var ux = u % W, uy = (u / W) | 0;
        var nb = [[ux + 1, uy], [ux - 1, uy], [ux, uy - 1], [ux, uy + 1]];
        for (var n = 0; n < 4; n++) {
          var nx = nb[n][0], ny = nb[n][1];
          if (!inb(nx, ny)) continue;
          var v = ny * W + nx;
          if (T.water[v] || lab[v] >= 0) continue;
          lab[v] = id; q[tail++] = v;
        }
      }
      comps.push(cells);
    }
    return comps;
  }

  function connect(T, g) {
    for (var pass = 0; pass < 8; pass++) {
      var comps = components(T);
      if (comps.length <= 1) return;
      comps.sort(function (a, b) { return b.length - a.length; });
      var main = comps[0], other = comps[1];
      // shortest hop between the mainland and the next-largest island
      var best = null;
      for (var i = 0; i < other.length; i++) {
        var ox = other[i] % W, oy = (other[i] / W) | 0;
        for (var j = 0; j < main.length; j += 3) {
          var mx = main[j] % W, my = (main[j] / W) | 0;
          var d = (ox - mx) * (ox - mx) + (oy - my) * (oy - my);
          if (!best || d < best.d) best = { d: d, ox: ox, oy: oy, mx: mx, my: my };
        }
      }
      if (!best) return;
      stroke(T, g, best.ox, best.oy, best.mx, best.my, 2, true);   // causeway
    }
  }

  // ---------------------------------------------------------------------------
  // Quirks — independent coin-flips layered on top, so the same layout still
  // plays differently from seed to seed.
  // ---------------------------------------------------------------------------
  function quirks(c) {
    var T = c.T, g = c.g, r = c.r, notes = [];

    // one-way system on an arterial: the classic asymmetry that breaks ties
    if (r.chance(0.55) && c.arterials && c.arterials.length) {
      var row = c.arterials[r.int(c.arterials.length)].row;
      var a = 4 + r.int(W - 16), b = a + 6 + r.int(7);
      for (var x = a; x <= b && x < W; x++) if (!T.water[row * W + x]) T.owWest[row * W + x] = 1;
      notes.push('a one-way eastbound stretch');
    }
    // a diagonal boulevard that cheats the grid
    if (r.chance(0.42)) {
      var x0 = r.int(W), y0 = r.chance(0.5) ? 0 : H - 1;
      stroke(T, g, x0, y0, r.int(W), y0 === 0 ? H - 1 : 0, 1, false);
      notes.push('a diagonal boulevard');
    }
    // a green belt: pleasant, slow to cross, and it bends every catchment around it
    if (r.chance(0.5)) {
      var gx = r.int(W - 5), gy = r.int(H - 4), gw = 3 + r.int(4), gh = 2 + r.int(3);
      g.block(gx, gy, gw, gh, Z.park);
      notes.push('a green belt slowing traffic');
    }
    // a satellite shopping parade away from downtown
    if (r.chance(0.45)) {
      var p = nearestDry(T, r.int(W), r.int(H));
      if (Math.hypot(p.x - c.anchors.mall.x, p.y - c.anchors.mall.y) > 8) {
        g.block(p.x - 1, p.y - 1, 3, 2, Z.mall);
        c.centers.push({ x: p.x, y: p.y, a: r.range(0.55, 0.8), s: r.range(2.4, 3.4) });
        c.satellite = p;
        notes.push('an out-of-town retail park');
      }
    }
    // scattered neighbourhood demand, 2–4 blobs
    var extra = 2 + r.int(3);
    for (var e = 0; e < extra; e++)
      c.centers.push({ x: r.int(W), y: r.int(H), a: r.range(0.35, 0.72), s: r.range(2.4, 4.4) });

    c.notes = notes;
  }

  // ---------------------------------------------------------------------------
  function bakeDemand(c) {
    var T = c.T, r = c.r, max = 0, i;
    for (i = 0; i < T.N; i++) {
      if (T.water[i]) { T.base[i] = 0; continue; }
      var px = i % W, py = (i / W) | 0, v = 0.04 * r.next();
      for (var k = 0; k < c.centers.length; k++) {
        var ce = c.centers[k], d2 = (px - ce.x) * (px - ce.x) + (py - ce.y) * (py - ce.y);
        v += ce.a * Math.exp(-d2 / (2 * ce.s * ce.s));
      }
      T.base[i] = v; if (v > max) max = v;
    }
    if (max > 0) for (i = 0; i < T.N; i++) T.base[i] /= max;
  }

  var PREFIX = ['Ash', 'Brack', 'Cedar', 'Dun', 'Elm', 'Fenn', 'Gale', 'Haven', 'Iron', 'Juniper',
    'Kestrel', 'Larch', 'Marl', 'Norr', 'Oak', 'Pike', 'Quarry', 'Rook', 'Sable', 'Thistle',
    'Umber', 'Vale', 'Wren', 'Yarrow'];

  // One attempt at a complete town from a given RNG stream.
  function attempt(r, seed, N, forcedLayout) {
    var T = {
      W: W, H: H, N: N, seed: seed,
      zone: new Uint8Array(N), road: new Uint8Array(N), water: new Uint8Array(N),
      owWest: new Uint8Array(N), base: new Float32Array(N),
      _distCache: {}
    };
    var c = { T: T, r: r, g: mk(T), centers: [], anchors: {}, arterials: [] };
    var layout = forcedLayout || LAYOUTS[r.int(LAYOUTS.length)];

    BUILD[layout](c);
    quirks(c);          // quirks first — they can carve water too
    connect(T, c.g);    // then stitch whatever is left disconnected
    bakeDemand(c);

    // anchors may have been flooded by a later step — re-snap them to dry land
    ['mall', 'office', 'campus', 'park'].forEach(function (k) {
      c.anchors[k] = nearestDry(T, c.anchors[k].x, c.anchors[k].y);
    });

    var land = 0;
    for (var i = 0; i < N; i++) if (!T.water[i]) land++;

    T.layout = layout;
    T.name = r.pick(PREFIX) + ' ' + r.pick(c.kind);
    T.blurb = c.blurb;
    T.notes = c.notes || [];
    T.mall = c.anchors.mall; T.office = c.anchors.office;
    T.campus = c.anchors.campus; T.park = c.anchors.park;
    T.labels = [
      { p: T.mall, t: 'DOWNTOWN', w: 2.2, h: 1.5 },
      { p: T.office, t: 'OFFICE', w: 2, h: 1.5 },
      { p: T.campus, t: 'CAMPUS', w: 2.5, h: 2 },
      { p: T.park, t: 'PARK', w: 1.5, h: 1.5 }
    ];
    if (c.satellite) T.labels.push({ p: c.satellite, t: 'RETAIL PARK', w: 2.6, h: 1.5 });

    T.candidates = [];
    for (var k2 = 0; k2 < N; k2++) if (!T.water[k2]) T.candidates.push(k2);
    T._land = land;
    return T;
  }

  // A town is playable if it is one connected piece and mostly land. Water-heavy
  // layouts are judged on their own curve, so an archipelago isn't rejected for
  // being an archipelago — only for being a shredded one.
  function playable(T) {
    var frac = T._land / T.N;
    if (frac < 0.26) return false;                      // an archipelago runs ~29%; below this is a shred
    if (frac > 0.92) return false;                      // a totally dry map is boring
    var comps = components(T);
    if (comps.length > 1) return false;
    return true;
  }

  function generateTown(seed) {
    var N = W * H, layout = null, fallback = null;
    for (var i = 0; i < 24; i++) {
      var s = i === 0 ? seed : seed + '#' + i;
      var r = rng(s);
      // keep the layout stable across retries so the name still matches the play
      var T = attempt(r, seed, N, layout);
      if (layout === null) layout = T.layout;
      if (playable(T)) { delete T._land; return T; }
      if (!fallback || T._land > fallback._land) fallback = T;
    }
    delete fallback._land;
    return fallback;
  }

  function enterCost(town, i) {
    if (town.water[i]) return Infinity;
    if (town.road[i] === 1 || town.road[i] === 2) return COST.arterial;
    if (town.zone[i] === Z.park) return COST.park;
    return COST.street;
  }

  // Dijkstra travel-time field from a source cell, cached per town+source.
  function distanceField(town, src) {
    var cached = town._distCache[src];
    if (cached) return cached;
    var N = town.N, dist = new Float64Array(N);   // f64: heap keys must match stored dist exactly
    for (var i = 0; i < N; i++) dist[i] = Infinity;
    if (town.water[src]) { town._distCache[src] = dist; return dist; }
    dist[src] = 0;
    var heap = new MinHeap();
    heap.push(src, 0);
    var W_ = town.W;
    while (heap.size) {
      var top = heap.pop(), u = top.id, du = top.k;
      if (du > dist[u]) continue;
      var ux = u % W_, uy = (u / W_) | 0;
      // neighbours: E,W,N,S
      var nb = [[ux + 1, uy, 0], [ux - 1, uy, 1], [ux, uy - 1, 2], [ux, uy + 1, 3]];
      for (var n = 0; n < 4; n++) {
        var nx = nb[n][0], ny = nb[n][1], dir = nb[n][2];
        if (nx < 0 || nx >= W_ || ny < 0 || ny >= town.H) continue;
        var v = ny * W_ + nx;
        if (town.water[v]) continue;
        var w = enterCost(town, v);
        if (!isFinite(w)) continue;
        if (dir === 1 && town.owWest[v]) w += ONEWAY_PENALTY;   // wrong-way detour cost
        var nd = du + w;
        if (nd < dist[v]) { dist[v] = nd; heap.push(v, nd); }
      }
    }
    town._distCache[src] = dist;
    return dist;
  }

  // tiny binary min-heap keyed by numeric priority
  function MinHeap() { this.a = []; this.size = 0; }
  MinHeap.prototype.push = function (id, k) {
    var a = this.a; a[this.size] = { id: id, k: k }; var i = this.size++;
    while (i > 0) { var p = (i - 1) >> 1; if (a[p].k <= a[i].k) break; var t = a[p]; a[p] = a[i]; a[i] = t; i = p; }
  };
  MinHeap.prototype.pop = function () {
    var a = this.a, top = a[0], last = a[--this.size]; a.length = this.size;
    if (this.size > 0) {
      a[0] = last; var i = 0;
      for (;;) {
        var l = 2 * i + 1, rr = l + 1, sm = i;
        if (l < this.size && a[l].k < a[sm].k) sm = l;
        if (rr < this.size && a[rr].k < a[sm].k) sm = rr;
        if (sm === i) break; var t = a[sm]; a[sm] = a[i]; a[i] = t; i = sm;
      }
    }
    return top;
  };

  return {
    W: W, H: H, ZONES: ZONES, Z: Z, LAYOUTS: LAYOUTS,
    rng: rng, generateTown: generateTown, distanceField: distanceField,
    enterCost: enterCost, idx: idx, xy: xy, components: components
  };
});
