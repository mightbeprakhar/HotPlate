/* HOTPLATE — measure.js  (BUILD ARTEFACT, not part of the submission)
 * Runs real experiments against the shipped engine and emits:
 *   build/results.json   — every number quoted in the report
 *   build/fig-diff.svg   — differentiation vs outside option
 *   build/fig-centre.svg — profit vs distance from downtown (the rent trade-off)
 * Run: node build/measure.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Core = require('../src/core.js');
const Engine = require('../src/engine.js');
const Nash = require('../src/nash.js');

const OUT = __dirname;
const log = (...a) => console.log(...a);
const r2 = n => Math.round(n * 100) / 100;
const r3 = n => Math.round(n * 1000) / 1000;
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

function baseState(town) {
  const st = Engine.makeState(town);
  Object.keys(st.mods).forEach(k => st.mods[k] = false);
  return st;
}
function cheb(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }

// ---------------------------------------------------------------- E1
// Hotelling's central prediction, and the condition under which it breaks.
// U0 is the utility of the outside option (cooking at home). Very negative =>
// demand is effectively inelastic => textbook minimum differentiation.
function e1() {
  const U0s = [-12, -10, -8, -7, -6, -5, -4, -3, -2];
  const seeds = ['h1', 'h2', 'h3', 'h4', 'h5'];
  const save = Engine.CONFIG.U0;
  const rows = [];
  for (const U0 of U0s) {
    Engine.CONFIG.U0 = U0;
    const seps = [], shares = [], servs = [];
    for (const s of seeds) {
      const town = Core.generateTown(s), st = baseState(town);
      const res = Nash.iterate(town, st, 30);
      const fin = Engine.evaluate(town, res.state);
      seps.push(cheb(res.state.players[0], res.state.players[1]));
      shares.push(fin.perPlayer[0].share);
      servs.push(fin.demandTotal > 0 ? fin.marketTotal / fin.demandTotal : 0);
    }
    rows.push({ U0, sep: r2(mean(seps)), shareA: r3(mean(shares)), served: r3(mean(servs)) });
    log(`  U0=${U0}  separation=${r2(mean(seps))}  servedMarket=${r3(mean(servs))}`);
  }
  Engine.CONFIG.U0 = save;
  return rows;
}

// ---------------------------------------------------------------- E2
// Modification 3: is downtown a genuine volume-vs-margin trade-off, or a trap?
// Sweep A over every legal pitch with B held fixed, bin by road distance to the
// mall, and report mean/best profit per band.
function e2(seed) {
  const town = Core.generateTown(seed);
  const st = Engine.makeState(town);             // all modifications ON — rent is live
  const hm = Nash.heatmap(town, st, 'A');
  const mallCell = town.mall.y * town.W + town.mall.x;
  const df = Core.distanceField(town, mallCell);
  const pts = [];
  for (let i = 0; i < town.N; i++) {
    if (!isFinite(hm[i]) || hm[i] === -Infinity) continue;
    if (!isFinite(df[i])) continue;
    pts.push({ d: df[i], profit: hm[i] });
  }
  pts.sort((a, b) => a.d - b.d);
  const maxD = pts[pts.length - 1].d, BANDS = 10, w = maxD / BANDS;
  const bands = [];
  for (let b = 0; b < BANDS; b++) {
    const sel = pts.filter(p => p.d >= b * w && (b === BANDS - 1 ? p.d <= maxD : p.d < (b + 1) * w));
    if (!sel.length) continue;
    bands.push({
      band: b, dLo: r2(b * w), dHi: r2((b + 1) * w),
      n: sel.length, meanProfit: r2(mean(sel.map(p => p.profit))),
      bestProfit: r2(Math.max(...sel.map(p => p.profit)))
    });
  }
  const best = pts.reduce((m, p) => p.profit > m.profit ? p : m, pts[0]);
  const centre = pts.reduce((m, p) => p.d < m.d ? p : m, pts[0]);
  log(`  best pitch: profit=${r2(best.profit)} at road-distance ${r2(best.d)} from downtown`);
  log(`  downtown pitch: profit=${r2(centre.profit)} (${r2(100 * centre.profit / best.profit)}% of best)`);
  return {
    seed, town: town.name, layout: town.layout, bands,
    best: { profit: r2(best.profit), d: r2(best.d) },
    centre: { profit: r2(centre.profit), d: r2(centre.d) },
    centreRatio: r3(centre.profit / best.profit)
  };
}

// ---------------------------------------------------------------- E3
// Does a pure-strategy equilibrium exist once the modifications are switched on?
function e3(n) {
  let stable = 0, cyc = 0, fixed = 0, iters = [];
  const seps = [];
  for (let i = 0; i < n; i++) {
    const town = Core.generateTown('nash' + i);
    const st = Engine.makeState(town);
    const res = Nash.iterate(town, st, 24);
    const chk = Nash.check(town, res.state);
    if (chk.stable) stable++;
    if (res.cycle) cyc++; else fixed++;
    if (typeof res.iters === 'number') iters.push(res.iters);
    seps.push(cheb(res.state.players[0], res.state.players[1]));
  }
  const out = {
    n, stable, stablePct: r3(stable / n), cycles: cyc, fixedPoints: fixed,
    meanSeparation: r2(mean(seps))
  };
  log(`  ${stable}/${n} converged to a verified pure-strategy equilibrium; ${cyc} cycled`);
  return out;
}

// ---------------------------------------------------------------- E4
// Each modification's marginal effect, toggled on alone against the bare model.
function e4() {
  const seeds = ['m1', 'm2', 'm3', 'm4'];
  const mods = Object.keys(Engine.makeState(Core.generateTown('m1')).mods);
  const runs = [];
  const measure = (toggle) => {
    const sep = [], cs = [], sv = [], tv = [], pr = [];
    for (const s of seeds) {
      const town = Core.generateTown(s), st = baseState(town);
      if (toggle) st.mods[toggle] = true;
      const res = Nash.iterate(town, st, 24);
      const fin = Engine.evaluate(town, res.state);
      sep.push(cheb(res.state.players[0], res.state.players[1]));
      cs.push(fin.welfare.consumerSurplus);
      sv.push(fin.demandTotal > 0 ? fin.marketTotal / fin.demandTotal : 0);
      tv.push(fin.welfare.avgTravel);
      pr.push(res.state.players[0].price);
    }
    return { sep: r2(mean(sep)), cs: r2(mean(cs)), served: r3(mean(sv)), travel: r2(mean(tv)), price: r2(mean(pr)) };
  };
  const base = measure(null);
  log(`  base model: separation=${base.sep} served=${base.served} price=${base.price}`);
  for (const m of mods) {
    const r = measure(m);
    runs.push({ mod: m, ...r, dSep: r2(r.sep - base.sep), dServed: r3(r.served - base.served), dPrice: r2(r.price - base.price) });
    log(`  +${m}: separation ${base.sep}->${r.sep}, served ${base.served}->${r.served}, price ${base.price}->${r.price}`);
  }
  return { base, mods: runs };
}

// ---------------------------------------------------------------- E5
// Procedural variety: layout mix, size of the legal action set, water fraction.
function e5(n) {
  const tally = {}, cands = [], land = [];
  for (const L of Core.LAYOUTS) tally[L] = 0;
  for (let i = 0; i < n; i++) {
    const t = Core.generateTown('v' + i);
    tally[t.layout]++;
    cands.push(t.candidates.length);
    let wet = 0; for (let k = 0; k < t.N; k++) if (t.water[k]) wet++;
    land.push(1 - wet / t.N);
    if (Core.components(t).length !== 1) throw new Error('disconnected town at seed v' + i);
  }
  const out = {
    n, tally,
    candMin: Math.min(...cands), candMax: Math.max(...cands), candMean: Math.round(mean(cands)),
    landMin: r3(Math.min(...land)), landMax: r3(Math.max(...land)), landMean: r3(mean(land)),
    allConnected: true
  };
  log(`  ${n} towns, every one connected; ${out.candMin}-${out.candMax} legal pitches (mean ${out.candMean})`);
  return out;
}


// ---------------------------------------------------------------- E6
// Loyalty and entry are multi-day mechanisms: prevFrac starts empty (so loyalty
// is inert on day 1) and entry needs a run of consecutive desert days. Measure
// them across a real campaign, not a one-shot best response.
function e6(days) {
  const seeds = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
  function play(loyaltyOn, entryOn) {
    const rows = [];
    for (const s of seeds) {
      const town = Core.generateTown(s);
      const st = Engine.makeState(town);
      st.mods.loyalty = loyaltyOn; st.mods.entry = entryOn;
      let ret = 0;
      for (let d = 1; d <= days; d++) {
        st.round = d;
        const res = Nash.iterate(town, st, 8);
        const fin = Engine.evaluate(town, res.state);
        ret += fin.perPlayer[0].profit;
        Engine.stepLoyalty(st, fin);
        const spot = Engine.checkEntry(town, st, fin);
        if (spot) Engine.spawnChain(st, spot);
      }
      const fin = Engine.evaluate(town, st);
      rows.push({ ret, chain: st.players.length > 2, served: fin.demandTotal > 0 ? fin.marketTotal / fin.demandTotal : 0 });
    }
    return {
      ret: r2(mean(rows.map(r => r.ret))),
      chainRate: r3(rows.filter(r => r.chain).length / rows.length),
      served: r3(mean(rows.map(r => r.served)))
    };
  }
  const off = play(false, false), on = play(true, true), onlyLoyal = play(true, false);
  const out = { days, loyaltyOff: off, all: on, onlyLoyalty: onlyLoyal };
  log(`  ${days} days, loyalty+entry OFF: A banks $${off.ret}, chain in ${(off.chainRate * 100).toFixed(0)}% of towns`);
  log(`  ${days} days, both ON          : A banks $${on.ret}, chain in ${(on.chainRate * 100).toFixed(0)}% of towns`);
  log(`  loyalty alone               : A banks $${onlyLoyal.ret}`);
  return out;
}

// ---------------------------------------------------------------- SVG
function svgChart(o) {
  const W = 760, H = 380, m = { t: 34, r: 24, b: 56, l: 68 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const xs = o.pts.map(p => p.x), ys = o.pts.flatMap(p => o.series.map(s => p[s.key]));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = o.yMin != null ? o.yMin : Math.min(...ys), y1 = o.yMax != null ? o.yMax : Math.max(...ys);
  y1 += (y1 - y0) * 0.12;
  const PX = v => m.l + (v - x0) / (x1 - x0 || 1) * iw;
  const PY = v => m.t + ih - (v - y0) / (y1 - y0 || 1) * ih;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Segoe UI, Arial, sans-serif">`;
  s += `<rect width="${W}" height="${H}" fill="#fbfbfd"/>`;
  // grid + y ticks
  for (let i = 0; i <= 5; i++) {
    const v = y0 + (y1 - y0) * i / 5, y = PY(v);
    s += `<line x1="${m.l}" y1="${y.toFixed(1)}" x2="${W - m.r}" y2="${y.toFixed(1)}" stroke="#e3e3ea" stroke-width="1"/>`;
    s += `<text x="${m.l - 10}" y="${(y + 4).toFixed(1)}" font-size="12" fill="#6b6b78" text-anchor="end">${o.yFmt ? o.yFmt(v) : r2(v)}</text>`;
  }
  // x ticks
  for (const p of o.pts) {
    if (o.xEvery && o.pts.indexOf(p) % o.xEvery !== 0) continue;
    s += `<text x="${PX(p.x).toFixed(1)}" y="${H - m.b + 20}" font-size="12" fill="#6b6b78" text-anchor="middle">${o.xFmt ? o.xFmt(p.x) : p.x}</text>`;
  }
  // bands
  if (o.bandLabel) {
    const bx = PX(o.bandLabel.at);
    s += `<line x1="${bx.toFixed(1)}" y1="${m.t}" x2="${bx.toFixed(1)}" y2="${m.t + ih}" stroke="#f5a623" stroke-width="1.6" stroke-dasharray="5 4"/>`;
    s += `<text x="${(bx + 7).toFixed(1)}" y="${m.t + 15}" font-size="12" fill="#b4770f">${o.bandLabel.text}</text>`;
  }
  for (const ser of o.series) {
    const d = o.pts.map((p, i) => `${i ? 'L' : 'M'}${PX(p.x).toFixed(1)} ${PY(p[ser.key]).toFixed(1)}`).join(' ');
    if (ser.bars) {
      const bw = iw / o.pts.length * 0.62;
      for (const p of o.pts) {
        const h = Math.max(0, m.t + ih - PY(p[ser.key]));
        s += `<rect x="${(PX(p.x) - bw / 2).toFixed(1)}" y="${PY(p[ser.key]).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${ser.color}" opacity="${ser.opacity || 0.85}"/>`;
      }
    } else {
      s += `<path d="${d}" fill="none" stroke="${ser.color}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"${ser.dash ? ` stroke-dasharray="${ser.dash}"` : ''}/>`;
      for (const p of o.pts) s += `<circle cx="${PX(p.x).toFixed(1)}" cy="${PY(p[ser.key]).toFixed(1)}" r="3.4" fill="${ser.color}"/>`;
    }
  }
  // axes
  s += `<line x1="${m.l}" y1="${m.t + ih}" x2="${W - m.r}" y2="${m.t + ih}" stroke="#9a9aa6" stroke-width="1.2"/>`;
  s += `<line x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${m.t + ih}" stroke="#9a9aa6" stroke-width="1.2"/>`;
  s += `<text x="${m.l + iw / 2}" y="${H - 12}" font-size="13" fill="#3a3a44" text-anchor="middle">${o.xLabel}</text>`;
  s += `<text x="16" y="${m.t + ih / 2}" font-size="13" fill="#3a3a44" text-anchor="middle" transform="rotate(-90 16 ${m.t + ih / 2})">${o.yLabel}</text>`;
  // legend
  let lx = m.l + 4;
  for (const ser of o.series) {
    s += `<rect x="${lx}" y="${m.t - 24}" width="13" height="4" rx="2" fill="${ser.color}"/>`;
    s += `<text x="${lx + 19}" y="${m.t - 17}" font-size="12.5" fill="#3a3a44">${ser.label}</text>`;
    lx += 26 + ser.label.length * 7.1;
  }
  return s + '</svg>';
}

// ---------------------------------------------------------------- main
log('E1  differentiation vs the outside option');
const E1 = e1();
log('E2  the downtown rent trade-off');
const E2 = e2('report-centre');
log('E3  equilibrium existence with all modifications live');
const E3 = e3(40);
log('E4  marginal effect of each modification');
const E4 = e4();
log('E6  multi-day mechanisms: loyalty and chain entry');
const E6 = e6(12);
log('E5  procedural variety');
const E5 = e5(300);

fs.writeFileSync(path.join(OUT, 'fig-diff.svg'), svgChart({
  pts: E1.map(r => ({ x: r.U0, sep: r.sep, served: r.served * 12 })),
  series: [
    { key: 'sep', color: '#c2410c', label: 'Separating distance (cells)' },
    { key: 'served', color: '#0f766e', label: 'Share of demand served (×12)', dash: '6 4' }
  ],
  xLabel: 'Utility of the outside option  U₀   (left = cooking at home is unattractive)',
  yLabel: 'Cells / served ×12', yMin: 0,
  bandLabel: { at: -7, text: 'demand turns elastic' }
}));

fs.writeFileSync(path.join(OUT, 'fig-centre.svg'), svgChart({
  pts: E2.bands.map(b => ({ x: b.dLo, mean: b.meanProfit, best: b.bestProfit })),
  series: [
    { key: 'best', color: '#f5a623', label: 'Best profit in band', bars: true, opacity: 0.9 },
    { key: 'mean', color: '#1e3a8a', label: 'Mean profit in band' }
  ],
  xLabel: 'Road distance from downtown  (0 = on the mall)',
  yLabel: 'Daily profit  ($)', xFmt: v => r2(v).toFixed(0), yMin: 0
}));

const all = { E1, E2, E3, E4, E5, generatedWith: 'node ' + process.version };
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(all, null, 2));
log('\nwrote results.json, fig-diff.svg, fig-centre.svg');
