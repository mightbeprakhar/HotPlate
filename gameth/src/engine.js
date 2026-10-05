/* HOTPLATE — engine.js
 * The economic model: configurable coefficients, utility, logit market shares
 * with an outside option, profit, welfare (consumer surplus / travel burden /
 * food deserts), customer loyalty, and contestable-market entry.
 * Consumes HP.Core. UMD (browser + Node).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else { root.HP = root.HP || {}; root.HP.Engine = factory(root.HP.Core); }
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';
  var ZONES = Core.ZONES;

  // All tuned coefficients live here — nothing hard-coded at call sites.
  // Money is calibrated to a believable single-truck day: a few hundred covers,
  // with rent / menu commitment / delivery logistics all large enough to matter.
  var CONFIG = {
    pop: 2.6,                 // demand scale (customers per unit weight)
    beta: 0.9,                // logit sharpness
    U0: -3.0,                 // outside option: stay home and cook
    theta_q: 0.70,            // taste-for-quality weight
    theta_p: 0.22,            // price sensitivity
    theta_t: 0.62,            // travel-time sensitivity (dine-in)
    theta_f: 0.5,             // delivery-fee sensitivity
    theta_w: 0.4,             // delivery-wait sensitivity
    deliveryEase: 0.55,       // delivery is less onerous per unit distance than travelling
    deliveryFee: 3.0,
    commission: 0.25,         // aggregator platform cut on delivered margin
    delivLogistics: 9.0,      // fixed cost of running delivery to radius R (× R²)
    gamma: 0.45,              // agglomeration market expansion
    Dcluster: 6.0,            // clustering distance for agglomeration
    clusterS: 4.0,
    anchorScale: 1.1, anchorS: 4.5,   // mall foot-traffic visibility bonus
    c0: 4.0, c1: 1.8,         // unit cost = c0 + c1·(Q-1)
    f0: 60, f1: 56,           // fixed cost = f0 + f1·Q²  (menu tier is a real commitment)
    r0: 25, r1: 170, r2: 110, // rent = r0 + r1·density + r2·mallProximity
    lambda: 0.35, delta: 0.5, // loyalty strength; memory decay (EMA weight on current)
    entryThreshold: 0.30,     // underserved demand fraction that invites entry
    entryPatience: 3,         // consecutive rounds before the chain enters
    tiers: [1.0, 1.8, 3.0], tierNames: ['Fast', 'Casual', 'Fine'],
    pmin: 6, pmax: 20, priceSteps: 8, defaultPrice: 12,
    defaultRadius: 6.0, maxRadius: 14,
    eucScale: 0.62,           // travel scale when the road-network mod is off
    periods: ['lunch', 'evening', 'latenight'],
    periodShare: { lunch: 1.0, evening: 1.2, latenight: 0.7 },
    zoneMult: {
      residential: { lunch: 0.6, evening: 1.2, latenight: 0.5 },
      mall:        { lunch: 1.1, evening: 1.1, latenight: 0.6 },
      office:      { lunch: 1.7, evening: 0.4, latenight: 0.1 },
      campus:      { lunch: 0.7, evening: 1.0, latenight: 1.8 },
      park:        { lunch: 0.5, evening: 0.6, latenight: 0.3 }
    },
    taste: { residential: 1.0, mall: 1.1, office: 1.4, campus: 0.6, park: 0.9 },
    mods: { demand2d: true, priceQuality: true, delivery: true, roads: true, agglomRent: true, loyalty: true, entry: true }
  };

  var STRIDE = 3;             // per-cell player memory stride (A,B,Chain)

  function snap(town, x, y) { // nearest non-water cell
    x = Math.max(0, Math.min(town.W - 1, Math.round(x)));
    y = Math.max(0, Math.min(town.H - 1, Math.round(y)));
    if (!town.water[y * town.W + x]) return { x: x, y: y };
    for (var rad = 1; rad < 8; rad++)
      for (var dy = -rad; dy <= rad; dy++)
        for (var dx = -rad; dx <= rad; dx++) {
          var nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < town.W && ny >= 0 && ny < town.H && !town.water[ny * town.W + nx]) return { x: nx, y: ny };
        }
    return { x: x, y: y };
  }

  // Gravity score: how much demand a lone truck at `c` could realistically pull.
  // Cheap Euclidean proxy — used only to pick a fair opening, not for payoffs.
  function gravity(town, cx, cy) {
    var s = 0;
    for (var i = 0; i < town.N; i++) {
      var b = town.base[i]; if (b <= 0 || town.water[i]) continue;
      var dx = (i % town.W) - cx, dy = ((i / town.W) | 0) - cy;
      s += b / (1 + Math.sqrt(dx * dx + dy * dy) * 0.45);
    }
    return s;
  }

  // Two openings that are (near-)equally attractive and meaningfully apart, so
  // neither player starts stranded and the first move is a real decision.
  function fairOpening(town) {
    var cells = [];
    for (var i = 0; i < town.N; i++) {
      if (town.water[i] || town.base[i] <= 0) continue;
      var x = i % town.W, y = (i / town.W) | 0;
      cells.push({ x: x, y: y, s: gravity(town, x, y) });
    }
    if (cells.length < 2) {
      var m = snap(town, town.W * 0.4, town.H * 0.5), n = snap(town, town.W * 0.6, town.H * 0.5);
      return [m, n];
    }
    cells.sort(function (p, q) { return q.s - p.s; });
    var top = cells.slice(0, Math.min(44, cells.length));
    var minSep = Math.max(3, Math.round(town.W * 0.16));
    var best = null, bestScore = -Infinity;
    for (var a = 0; a < top.length; a++) for (var b = a + 1; b < top.length; b++) {
      var A = top[a], B = top[b];
      if (Math.hypot(A.x - B.x, A.y - B.y) < minSep) continue;
      // reward strong, near-equal pairs; punish imbalance hard
      var sc = (A.s + B.s) - 9 * Math.abs(A.s - B.s);
      if (sc > bestScore) { bestScore = sc; best = [A, B]; }
    }
    if (!best) best = [top[0], top[Math.min(1, top.length - 1)]];
    best.sort(function (p, q) { return (p.x - q.x) || (p.y - q.y); });   // deterministic A/B
    return [{ x: best[0].x, y: best[0].y }, { x: best[1].x, y: best[1].y }];
  }

  function makeState(town) {
    var open = fairOpening(town), a = open[0], b = open[1];
    return {
      town: town, round: 1,
      players: [
        { id: 'A', x: a.x, y: a.y, price: CONFIG.defaultPrice, tier: 1, radius: CONFIG.defaultRadius, isChain: false },
        { id: 'B', x: b.x, y: b.y, price: CONFIG.defaultPrice, tier: 1, radius: CONFIG.defaultRadius, isChain: false }
      ],
      mods: Object.assign({}, CONFIG.mods),
      loyaltyW: CONFIG.lambda,     // user-adjustable loyalty strength (λ)
      prevFrac: new Float32Array(town.N * STRIDE),
      entryStreak: 0
    };
  }

  function unitCost(tier) { return CONFIG.c0 + CONFIG.c1 * (CONFIG.tiers[tier] - 1); }
  function fixedCost(tier) { var Q = CONFIG.tiers[tier]; return CONFIG.f0 + CONFIG.f1 * Q * Q; }

  function travelField(town, state, p) {
    if (state.mods.roads) return Core.distanceField(town, p.y * town.W + p.x);
    var f = new Float32Array(town.N);
    for (var i = 0; i < town.N; i++) {
      var xx = i % town.W, yy = (i / town.W) | 0;
      f[i] = town.water[i] ? Infinity : Math.hypot(xx - p.x, yy - p.y) * CONFIG.eucScale;
    }
    return f;
  }

  // Core evaluation shared by evaluate() and profitOf().
  function _evalCore(town, state) {
    var cfg = CONFIG, mods = state.mods, players = state.players, P = players.length, N = town.N;
    var fields = players.map(function (p) { return travelField(town, state, p); });
    var anchor = [], rentv = [], fixv = [], unitv = [];
    for (var k = 0; k < P; k++) {
      var pk = players[k];
      var md2 = (pk.x - town.mall.x) * (pk.x - town.mall.x) + (pk.y - town.mall.y) * (pk.y - town.mall.y);
      var mallProx = Math.exp(-md2 / (2 * cfg.anchorS * cfg.anchorS));
      anchor[k] = mods.agglomRent ? cfg.anchorScale * mallProx : 0;
      rentv[k] = mods.agglomRent ? (cfg.r0 + cfg.r1 * town.base[pk.y * town.W + pk.x] + cfg.r2 * mallProx) : 0;
      fixv[k] = mods.priceQuality ? fixedCost(pk.tier) : 0;
      unitv[k] = unitCost(pk.tier);
    }
    var cluster = mods.agglomRent && P >= 2 &&
      (Math.hypot(players[0].x - players[1].x, players[0].y - players[1].y) <= cfg.Dcluster);

    var grossM = new Float64Array(P), shareAbs = new Float64Array(P),
        revAbs = new Float64Array(P), delivAbs = new Float64Array(P), loyalAbs = new Float64Array(P);
    var CS = 0, burdenNum = 0, burdenDen = 0, demandTotal = 0, outsideTotal = 0;
    var lam = (typeof state.loyaltyW === 'number') ? state.loyaltyW : cfg.lambda;
    var cellDemand = new Float64Array(N), outsideAbs = new Float64Array(N);
    var cellShare = new Float64Array(N * STRIDE);
    var periods = mods.demand2d ? cfg.periods : ['all'];

    for (var i = 0; i < N; i++) {
      if (town.water[i] || town.base[i] <= 0) continue;
      var zoneName = ZONES[town.zone[i]];
      var agg = 1;
      if (cluster) { var mdd = Math.min(fields[0][i], fields[1][i]); if (isFinite(mdd)) agg = 1 + cfg.gamma * Math.exp(-mdd * mdd / (2 * cfg.clusterS * cfg.clusterS)); }

      for (var t = 0; t < periods.length; t++) {
        var per = periods[t];
        var zmult = mods.demand2d ? (cfg.zoneMult[zoneName][per] * cfg.periodShare[per]) : 1;
        var d = cfg.pop * (mods.demand2d ? town.base[i] : 1) * zmult * agg;
        if (d <= 0) continue;

        var expOut = Math.exp(cfg.beta * cfg.U0), expSum = expOut;
        var eu = new Array(P), Tk = new Array(P), del = new Array(P);
        for (var m = 0; m < P; m++) {
          var T = fields[m][i]; Tk[m] = T; del[m] = false;
          if (!isFinite(T)) { eu[m] = 0; continue; }
          var dineIn = cfg.theta_t * T, access = dineIn;
          if (mods.delivery && T <= players[m].radius) {
            var dc = cfg.theta_f * cfg.deliveryFee + cfg.theta_w * cfg.deliveryEase * T;
            if (dc < dineIn) { access = dc; del[m] = true; }
          }
          var U = -access + anchor[m];
          if (mods.priceQuality) U += cfg.theta_q * cfg.tiers[players[m].tier] * cfg.taste[zoneName] - cfg.theta_p * players[m].price;
          var e = Math.exp(cfg.beta * U); eu[m] = e; expSum += e;
        }

        // logit fractions (players + outside sum to 1), then loyalty overlay
        var stickSum = 0, sticky = new Array(P);
        if (mods.loyalty) for (var s = 0; s < P; s++) { sticky[s] = lam * state.prevFrac[i * STRIDE + s]; stickSum += sticky[s]; }
        for (var q = 0; q < P; q++) {
          if (!isFinite(Tk[q])) continue;
          var logit = eu[q] / expSum;
          var frac = mods.loyalty ? (sticky[q] + (1 - stickSum) * logit) : logit;
          var dem = d * frac;
          shareAbs[q] += dem;
          if (mods.loyalty) loyalAbs[q] += d * sticky[q];
          grossM[q] += dem * (players[q].price - unitv[q]) * (1 - (del[q] ? cfg.commission : 0));
          revAbs[q] += dem * players[q].price;
          if (del[q]) delivAbs[q] += dem;
          cellShare[i * STRIDE + q] += dem;
          burdenNum += dem * Tk[q]; burdenDen += dem;
        }
        var outFrac = mods.loyalty ? (1 - stickSum) * (expOut / expSum) : (expOut / expSum);
        cellDemand[i] += d; outsideAbs[i] += d * outFrac; demandTotal += d; outsideTotal += d * outFrac;
        CS += d * (1 / cfg.beta) * Math.log(expSum);
      }
    }

    // territory (majority holder / desert) + winner-share field, + loyalty memory feed
    var territory = new Uint8Array(N); for (var z = 0; z < N; z++) territory[z] = 255;
    var shareField = new Float32Array(N), cellFrac = new Float32Array(N * STRIDE);
    var underserved = [];
    for (var c = 0; c < N; c++) {
      var cd = cellDemand[c]; if (cd <= 0) continue;
      var best = -1, bestVal = 0;
      for (var kk = 0; kk < P; kk++) {
        var fr = cellShare[c * STRIDE + kk] / cd; cellFrac[c * STRIDE + kk] = fr;
        if (fr > bestVal) { bestVal = fr; best = kk; }
      }
      var outF = outsideAbs[c] / cd;
      if (outF > 0.6) underserved.push(c);
      if (outF > 0.6 && outF >= bestVal) { territory[c] = 255; shareField[c] = outF; }
      else { territory[c] = best; shareField[c] = bestVal; }
    }

    var totalServed = 0; for (var g = 0; g < P; g++) totalServed += shareAbs[g];
    var perPlayer = players.map(function (p, k) {
      var prof = grossM[k] - rentv[k] - fixv[k];
      if (mods.delivery) prof -= cfg.delivLogistics * p.radius * p.radius * 0.25;
      return {
        id: p.id, profit: prof, share: totalServed > 0 ? shareAbs[k] / totalServed : 0,
        revenue: revAbs[k], deliveryShare: shareAbs[k] > 0 ? delivAbs[k] / shareAbs[k] : 0,
        rent: rentv[k], fixed: fixv[k], volume: shareAbs[k],
        loyaltyShare: shareAbs[k] > 0 ? loyalAbs[k] / shareAbs[k] : 0
      };
    });

    return {
      perPlayer: perPlayer, territory: territory, shareField: shareField,
      welfare: { consumerSurplus: CS, avgTravel: burdenDen > 0 ? burdenNum / burdenDen : 0, underserved: underserved },
      marketTotal: totalServed, demandTotal: demandTotal,
      outsideShare: demandTotal > 0 ? outsideTotal / demandTotal : 0, _cellFrac: cellFrac
    };
  }

  function evaluate(town, state) { return _evalCore(town, state); }
  function profitOf(town, state, id) {
    var r = _evalCore(town, state);
    for (var i = 0; i < r.perPlayer.length; i++) if (r.perPlayer[i].id === id) return r.perPlayer[i].profit;
    return 0;
  }

  // fold this round's outcome into loyalty memory (EMA toward current fractions)
  function stepLoyalty(state, result) {
    if (!state.mods.loyalty || !result._cellFrac) return;
    var d = CONFIG.delta, pf = state.prevFrac, cf = result._cellFrac;
    for (var i = 0; i < pf.length; i++) pf[i] = (1 - d) * pf[i] + d * cf[i];
  }

  // contestable market: returns {x,y,region} when a chain should enter, else null
  function checkEntry(town, state, result) {
    if (!state.mods.entry || state.players.length >= 3) return null;
    var under = result.welfare.underserved, regionDemand = 0, potential = 0;
    for (var i = 0; i < town.N; i++) if (!town.water[i]) potential += town.base[i];
    for (var u = 0; u < under.length; u++) regionDemand += town.base[under[u]];
    if (potential > 0 && regionDemand / potential > CONFIG.entryThreshold) state.entryStreak++;
    else state.entryStreak = 0;
    if (state.entryStreak >= CONFIG.entryPatience) {
      var bestCell = -1, bestBase = -1;
      for (var w = 0; w < under.length; w++) if (town.base[under[w]] > bestBase) { bestBase = town.base[under[w]]; bestCell = under[w]; }
      if (bestCell < 0) return null;
      return { x: bestCell % town.W, y: (bestCell / town.W) | 0, region: under };
    }
    return null;
  }

  function spawnChain(state, spot) {
    state.players.push({ id: 'C', x: spot.x, y: spot.y, price: CONFIG.pmin + 1, tier: 0, radius: CONFIG.maxRadius, isChain: true });
    state.entryStreak = 0;
  }

  return {
    CONFIG: CONFIG, makeState: makeState, evaluate: evaluate, profitOf: profitOf,
    stepLoyalty: stepLoyalty, checkEntry: checkEntry, spawnChain: spawnChain,
    unitCost: unitCost, fixedCost: fixedCost, snap: snap, STRIDE: STRIDE
  };
});
