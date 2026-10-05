/* HOTPLATE — nash.js
 * Exact pure-strategy Nash detection (no-profitable-deviation), iterated best
 * response with cycle detection, best-response heatmaps, and AI personalities.
 * Consumes HP.Core + HP.Engine. UMD (browser + Node).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'), require('./engine.js'));
  else { root.HP = root.HP || {}; root.HP.Nash = factory(root.HP.Core, root.HP.Engine); }
})(typeof self !== 'undefined' ? self : this, function (Core, Engine) {
  'use strict';
  var CFG = Engine.CONFIG;

  // Pruned candidate locations: coarse non-water lattice keeps sweeps tractable.
  function CANDIDATES(town) {
    if (town._cands) return town._cands;
    var out = [];
    for (var y = 0; y < town.H; y += 2)
      for (var x = 0; x < town.W; x += 2)
        if (!town.water[y * town.W + x]) out.push({ x: x, y: y });
    town._cands = out; return out;
  }

  function priceLevels() {
    var out = [], n = CFG.priceSteps;
    for (var i = 0; i < n; i++) out.push(CFG.pmin + (CFG.pmax - CFG.pmin) * i / (n - 1));
    return out;
  }

  function byId(state, id) { for (var i = 0; i < state.players.length; i++) if (state.players[i].id === id) return state.players[i]; return null; }

  function cloneState(state) {
    return {
      town: state.town, round: state.round,
      players: state.players.map(function (p) { return { id: p.id, x: p.x, y: p.y, price: p.price, tier: p.tier, radius: p.radius, isChain: p.isChain }; }),
      mods: Object.assign({}, state.mods),
      loyaltyW: state.loyaltyW,
      prevFrac: state.prevFrac, entryStreak: state.entryStreak
    };
  }

  function hashState(state) {
    return state.players.map(function (p) { return p.x + ',' + p.y + ',' + p.price.toFixed(1) + ',' + p.tier; }).join('|');
  }

  // Best profitable deviation for one player, others held fixed.
  function bestResponse(town, state, pid, opt) {
    opt = opt || {};
    var p = byId(state, pid);
    var prices, tiers;
    if (!state.mods.priceQuality) { prices = [p.price]; tiers = [p.tier]; }
    else { prices = opt.prices || priceLevels(); tiers = opt.tiers || [0, 1, 2]; }
    var cands = opt.locations || CANDIDATES(town);
    var save = { x: p.x, y: p.y, price: p.price, tier: p.tier };
    var cur = Engine.profitOf(town, state, pid);
    var best = { x: save.x, y: save.y, price: save.price, tier: save.tier, profit: cur };
    for (var l = 0; l < cands.length; l++)
      for (var pr = 0; pr < prices.length; pr++)
        for (var ti = 0; ti < tiers.length; ti++) {
          p.x = cands[l].x; p.y = cands[l].y; p.price = prices[pr]; p.tier = tiers[ti];
          var prof = Engine.profitOf(town, state, pid);
          if (prof > best.profit + 1e-9) best = { x: p.x, y: p.y, price: p.price, tier: p.tier, profit: prof };
        }
    p.x = save.x; p.y = save.y; p.price = save.price; p.tier = save.tier;
    best.gain = best.profit - cur;
    return best;
  }

  // Exact Nash check: stable iff no active player has a profitable deviation.
  function check(town, state) {
    var devs = [];
    for (var i = 0; i < state.players.length; i++) {
      var pid = state.players[i].id;
      var cur = Engine.profitOf(town, state, pid);
      var eps = Math.max(0.5, 0.01 * Math.abs(cur));
      var br = bestResponse(town, state, pid);
      if (br.gain > eps) devs.push({ pid: pid, gain: br.gain, x: br.x, y: br.y, price: br.price, tier: br.tier });
    }
    devs.sort(function (a, b) { return b.gain - a.gain; });
    return { stable: devs.length === 0, deviations: devs };
  }

  // Iterated best response from the current state; detects fixed point vs cycle.
  function iterate(town, state, maxIters) {
    maxIters = maxIters || 20;
    var sim = cloneState(state);
    var seen = {}, path = [snapshot(sim)];
    seen[hashState(sim)] = 0;
    for (var it = 0; it < maxIters; it++) {
      var movedThisRound = false;
      for (var pi = 0; pi < sim.players.length; pi++) {
        var pid = sim.players[pi].id;
        var eps = Math.max(0.5, 0.01 * Math.abs(Engine.profitOf(town, sim, pid)));
        var br = bestResponse(town, sim, pid);
        if (br.gain > eps) {
          var p = byId(sim, pid); p.x = br.x; p.y = br.y; p.price = br.price; p.tier = br.tier;
          movedThisRound = true;
        }
      }
      path.push(snapshot(sim));
      if (!movedThisRound) return { outcome: 'converged', path: path, cycleAt: -1, state: sim };
      var h = hashState(sim);
      if (h in seen) return { outcome: 'cycling', path: path, cycleAt: seen[h], state: sim };
      seen[h] = path.length - 1;
    }
    return { outcome: 'budget', path: path, cycleAt: -1, state: sim };
  }

  function snapshot(state) {
    return state.players.map(function (p) { return { id: p.id, x: p.x, y: p.y, price: p.price, tier: p.tier }; });
  }

  // Profit if `pid` relocated to each candidate cell (price/tier fixed). For the heatmap.
  function heatmap(town, state, pid) {
    var p = byId(state, pid), save = { x: p.x, y: p.y };
    var out = new Float32Array(town.N); for (var i = 0; i < town.N; i++) out[i] = -Infinity;
    var cands = CANDIDATES(town);
    for (var l = 0; l < cands.length; l++) { p.x = cands[l].x; p.y = cands[l].y; out[cands[l].y * town.W + cands[l].x] = Engine.profitOf(town, state, pid); }
    p.x = save.x; p.y = save.y; return out;
  }

  // AI personalities — each returns a target {x,y,price,tier}.
  function aiMove(town, state, pid, persona) {
    var me = byId(state, pid);
    var opp = null;
    for (var i = 0; i < state.players.length; i++) if (state.players[i].id !== pid && !state.players[i].isChain) { opp = state.players[i]; break; }
    opp = opp || state.players[0];
    var pl = priceLevels();
    if (persona === 'mimic') {
      var t = Engine.snap(town, (me.x + opp.x) / 2, (me.y + opp.y) / 2);
      return { x: t.x, y: t.y, price: opp.price, tier: opp.tier };
    }
    var opt = {};
    if (persona === 'undercutter') { opt.prices = [pl[0], pl[1]]; opt.tiers = [0, 1]; }
    else if (persona === 'snob') { opt.prices = [pl[pl.length - 1], pl[pl.length - 2]]; opt.tiers = [2]; }
    // 'optimizer' uses full sets (opt empty)
    var br = bestResponse(town, state, pid, opt);
    return { x: br.x, y: br.y, price: br.price, tier: br.tier };
  }

  // ---------------------------------------------------------------------------
  // Coaching: WHY a player is ahead/behind, and WHAT to try next.
  // Causes are structural comparisons; hints are real counterfactuals (each one
  // is actually evaluated), so a hint never promises a gain the model won't pay.
  // ---------------------------------------------------------------------------
  function probe(town, state, p, change) {
    var save = { x: p.x, y: p.y, price: p.price, tier: p.tier, radius: p.radius };
    for (var k in change) p[k] = change[k];
    if (change.x != null) { var s = Engine.snap(town, p.x, p.y); p.x = s.x; p.y = s.y; }
    var prof = Engine.profitOf(town, state, p.id);
    p.x = save.x; p.y = save.y; p.price = save.price; p.tier = save.tier; p.radius = save.radius;
    return prof;
  }

  function explain(town, state, result, pid) {
    var me = byId(state, pid); if (!me) return null;
    var mine = null, rivals = [];
    result.perPlayer.forEach(function (pp) { if (pp.id === pid) mine = pp; else rivals.push(pp); });
    if (!mine) return null;
    rivals.sort(function (a, b) { return b.profit - a.profit; });
    var top = rivals[0] || null;
    var rivalP = top ? byId(state, top.id) : null;
    var gap = top ? mine.profit - top.profit : mine.profit;

    var causes = [];
    function cause(w, title, detail) { causes.push({ w: w, title: title, detail: detail }); }

    // --- price positioning ---
    if (top && state.mods.priceQuality && rivalP) {
      var dp = me.price - rivalP.price;
      if (dp > 1.5 && mine.share < top.share)
        cause(Math.abs(dp) * 9, 'You are the expensive option',
          'You charge $' + me.price.toFixed(1) + ' against ' + top.id + '’s $' + rivalP.price.toFixed(1) +
          ' at the same quality tier, so price-sensitive diners drift away.');
      else if (dp < -1.5 && mine.profit < (top ? top.profit : 0))
        cause(Math.abs(dp) * 7, 'You are leaving money on the table',
          'You undercut ' + top.id + ' by $' + Math.abs(dp).toFixed(1) + ' but still earn less — the extra covers aren’t paying for the lost margin.');
    }
    // --- reach / location ---
    if (top && mine.volume < top.volume * 0.85)
      cause((top.volume - mine.volume) * 0.6, 'Your pitch reaches fewer people',
        'You serve ' + Math.round(mine.volume) + ' covers against ' + Math.round(top.volume) +
        '. Hungry blocks are closer to ' + top.id + ' than to you.');
    // --- rent burden ---
    var overhead = mine.rent + mine.fixed;
    if (mine.revenue > 0 && overhead / mine.revenue > 0.22)
      cause(overhead * 1.4, 'Overhead is eating the day',
        'Rent and kitchen cost $' + Math.round(overhead) + ' — ' +
        Math.round(overhead / mine.revenue * 100) + '% of revenue. That spot is dear for the traffic it brings.');
    // --- delivery drag ---
    if (state.mods.delivery && me.radius > 0) {
      var logi = CFG.delivLogistics * me.radius * me.radius * 0.25;
      if (logi > mine.revenue * 0.1 && mine.deliveryShare < 0.35)
        cause(logi * 1.6, 'Your delivery ring is too wide',
          'Running a ' + Math.round(me.radius) + '-block radius costs $' + Math.round(logi) +
          '/day but only ' + Math.round(mine.deliveryShare * 100) + '% of your covers are delivered.');
      else if (mine.deliveryShare > 0.5)
        cause(mine.revenue * mine.deliveryShare * CFG.commission * 0.5, 'Aggregator commission is thinning margins',
          Math.round(mine.deliveryShare * 100) + '% of your covers arrive by scooter, and the platform takes ' +
          Math.round(CFG.commission * 100) + '% of that margin.');
    }
    // --- loyalty ---
    if (state.mods.loyalty && top && mine.loyaltyShare < top.loyaltyShare - 0.05)
      cause((top.loyaltyShare - mine.loyaltyShare) * 400, 'Your regulars are thinner',
        'Only ' + Math.round(mine.loyaltyShare * 100) + '% of your covers are repeat customers against ' +
        Math.round(top.loyaltyShare * 100) + '% for ' + top.id + '. Habits are compounding against you.');
    // --- untapped town ---
    if (result.outsideShare > 0.45)
      cause(result.outsideShare * 260, 'Most of the town still cooks at home',
        Math.round(result.outsideShare * 100) + '% of demand buys from nobody. Whoever reaches it first wins it.');

    causes.sort(function (a, b) { return b.w - a.w; });

    // --- hints: evaluated counterfactuals, strongest first ---
    // Baseline must be measured in the SAME state the probes run in. The result
    // on the scoreboard was computed before the day's loyalty step advanced, so
    // trusting mine.profit here compares each probe against a stale baseline and
    // can flip a hint's sign. Re-measure now so gains are honest.
    var cur = Engine.profitOf(town, state, pid), tries = [];
    function tryIt(label, detail, change) {
      var prof = probe(town, state, me, change);
      if (prof > cur + Math.max(1, Math.abs(cur) * 0.02)) tries.push({ title: label, detail: detail, gain: prof - cur, apply: change });
    }
    if (state.mods.priceQuality) {
      tryIt('Cut your price', 'Drop to $' + Math.max(CFG.pmin, me.price - 2).toFixed(1) + ' to win back price-sensitive diners.', { price: Math.max(CFG.pmin, me.price - 2) });
      tryIt('Raise your price', 'Push to $' + Math.min(CFG.pmax, me.price + 2).toFixed(1) + ' — your pitch can carry the margin.', { price: Math.min(CFG.pmax, me.price + 2) });
      if (me.tier < 2) tryIt('Trade up the menu', 'Go ' + CFG.tierNames[me.tier + 1] + ' — pickier districts will pay for it.', { tier: me.tier + 1 });
      if (me.tier > 0) tryIt('Simplify the menu', 'Drop to ' + CFG.tierNames[me.tier - 1] + ' to cut kitchen overhead.', { tier: me.tier - 1 });
    }
    if (state.mods.delivery) {
      if (me.radius > 1) tryIt('Tighten delivery', 'Pull the ring in to ' + Math.max(0, Math.round(me.radius - 3)) + ' blocks and save on logistics.', { radius: Math.max(0, me.radius - 3) });
      if (me.radius < CFG.maxRadius) tryIt('Widen delivery', 'Push the ring out to ' + Math.min(CFG.maxRadius, Math.round(me.radius + 3)) + ' blocks to reach more homes.', { radius: Math.min(CFG.maxRadius, me.radius + 3) });
    }
    // relocation probes: downtown, and the fattest food desert
    if (town.mall) tryIt('Move downtown', 'Park by the mall — rent is steep but the footfall is relentless.', { x: town.mall.x, y: town.mall.y });
    var des = result.welfare.underserved, bestD = -1, bestB = -1;
    for (var u = 0; u < des.length; u++) if (town.base[des[u]] > bestB) { bestB = town.base[des[u]]; bestD = des[u]; }
    if (bestD >= 0) tryIt('Claim the food desert', 'A hungry block at (' + (bestD % town.W) + ',' + ((bestD / town.W) | 0) + ') is buying from nobody.', { x: bestD % town.W, y: (bestD / town.W) | 0 });

    tries.sort(function (a, b) { return b.gain - a.gain; });

    return {
      standing: top ? (gap > Math.max(1, Math.abs(top.profit) * 0.02) ? 'leading' : (gap < -Math.max(1, Math.abs(top.profit) * 0.02) ? 'trailing' : 'tied')) : 'leading',
      gap: gap, rivalId: top ? top.id : null,
      causes: causes.slice(0, 3),
      hints: tries.slice(0, 3)
    };
  }

  return { CANDIDATES: CANDIDATES, priceLevels: priceLevels, bestResponse: bestResponse, check: check, iterate: iterate, heatmap: heatmap, aiMove: aiMove, cloneState: cloneState, hashState: hashState, explain: explain };
});
