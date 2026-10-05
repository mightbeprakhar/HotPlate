/* HOTPLATE — engine.test.js
 * Headless correctness gate. Run: node --test test/
 * Validates the logic core independently of any rendering.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Core = require('../src/core.js');
const Engine = require('../src/engine.js');
const Nash = require('../src/nash.js');

// ---- fixture graph for exact shortest-path validation ----
function fixture() {
  const W = 5, H = 4, N = 20;
  const t = {
    W, H, N, seed: 'fx',
    base: new Float32Array(N).fill(1),
    zone: new Uint8Array(N), road: new Uint8Array(N),
    water: new Uint8Array(N), owWest: new Uint8Array(N),
    mall: { x: 2, y: 1 }, office: { x: 0, y: 0 }, campus: { x: 0, y: 0 }, park: { x: 0, y: 0 },
    bridges: [], riverX: 99, candidates: [], _distCache: {}
  };
  t.water[1 * W + 2] = 1; t.water[2 * W + 2] = 1;   // obstacle forcing detours
  t.owWest[0 * W + 3] = 1;                           // one-way: no westward entry into (3,0)
  for (let i = 0; i < N; i++) if (!t.water[i]) t.candidates.push(i);
  return t;
}

// independent all-pairs shortest path (Floyd–Warshall) using the same edge rules
function floyd(t) {
  const N = t.N, W = t.W, d = [];
  for (let i = 0; i < N; i++) { d[i] = new Array(N).fill(Infinity); d[i][i] = 0; }
  for (let u = 0; u < N; u++) {
    const ux = u % W, uy = (u / W) | 0;
    const nb = [[ux + 1, uy, 0], [ux - 1, uy, 1], [ux, uy - 1, 2], [ux, uy + 1, 3]];
    for (const [nx, ny, dir] of nb) {
      if (nx < 0 || nx >= W || ny < 0 || ny >= t.H) continue;
      const v = ny * W + nx;
      if (t.water[v]) continue;
      let w = Core.enterCost(t, v);
      if (dir === 1 && t.owWest[v]) w += 6.0;   // matches core ONEWAY_PENALTY
      d[u][v] = Math.min(d[u][v], w);
    }
  }
  for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++)
    if (d[i][k] + d[k][j] < d[i][j]) d[i][j] = d[i][k] + d[k][j];
  return d;
}

test('1. town generation is deterministic for a fixed seed', () => {
  const a = Core.generateTown(1234), b = Core.generateTown(1234);
  assert.deepStrictEqual(Array.from(a.base), Array.from(b.base));
  assert.deepStrictEqual(Array.from(a.zone), Array.from(b.zone));
  const c = Core.generateTown(9999);
  assert.notDeepStrictEqual(Array.from(a.base), Array.from(c.base));
});

test('2. Dijkstra matches Floyd–Warshall and respects one-way edges', () => {
  const t = fixture(), ref = floyd(t);
  for (let s = 0; s < t.N; s++) {
    if (t.water[s]) continue;
    const df = Core.distanceField(t, s);
    for (let j = 0; j < t.N; j++) {
      if (!isFinite(ref[s][j])) assert.ok(!isFinite(df[j]), `unreachable ${s}->${j}`);
      else assert.ok(Math.abs(df[j] - ref[s][j]) < 1e-6, `dist ${s}->${j}: ${df[j]} vs ${ref[s][j]}`);
    }
  }
  const eastbound = Core.distanceField(t, 0 * t.W + 0)[0 * t.W + 4]; // (0,0)->(4,0)
  const westbound = Core.distanceField(t, 0 * t.W + 4)[0 * t.W + 0]; // (4,0)->(0,0)
  assert.ok(westbound > eastbound, `one-way asymmetry: west ${westbound} should exceed east ${eastbound}`);
});

test('3. logit shares plus outside option sum to 1', () => {
  const town = Core.generateTown(42), st = Engine.makeState(town);
  st.mods.loyalty = false;
  const saveU0 = Engine.CONFIG.U0;
  Engine.CONFIG.U0 = -1000;                          // outside option negligible
  const r = Engine.evaluate(town, st);
  Engine.CONFIG.U0 = saveU0;
  let checked = 0;
  for (let c = 0; c < town.N; c++) {
    if (town.water[c] || town.base[c] <= 0) continue;
    const sum = r._cellFrac[c * Engine.STRIDE] + r._cellFrac[c * Engine.STRIDE + 1];
    if (r.shareField[c] > 0) { assert.ok(Math.abs(sum - 1) < 1e-4, `cell ${c} sum ${sum}`); checked++; }
  }
  assert.ok(checked > 20, 'enough cells validated');
});

test('4. profit is unimodal and falls above the monopoly price', () => {
  const town = Core.generateTown(7), st = Engine.makeState(town);
  const A = st.players[0];
  const levels = []; for (let i = 0; i < 9; i++) levels.push(Engine.CONFIG.pmin + (Engine.CONFIG.pmax - Engine.CONFIG.pmin) * i / 8);
  const prof = levels.map(p => { A.price = p; return Engine.profitOf(town, st, 'A'); });
  let arg = 0; for (let i = 1; i < prof.length; i++) if (prof[i] > prof[arg]) arg = i;
  for (let i = arg + 1; i < prof.length; i++) assert.ok(prof[i] <= prof[i - 1] + 1e-6, `not decreasing past peak at ${i}`);
  assert.ok(prof[prof.length - 1] < prof[arg], 'high price strictly worse than peak');
});

test('5. consumer surplus rises as travel cost falls', () => {
  const town = Core.generateTown(101), st = Engine.makeState(town);
  const save = Engine.CONFIG.theta_t;
  Engine.CONFIG.theta_t = 0.9; const csHigh = Engine.evaluate(town, st).welfare.consumerSurplus;
  Engine.CONFIG.theta_t = 0.2; const csLow = Engine.evaluate(town, st).welfare.consumerSurplus;
  Engine.CONFIG.theta_t = save;
  assert.ok(csLow > csHigh, `CS should rise: low ${csLow} vs high ${csHigh}`);
});

// With every modification stripped, the base logit model must span the two
// textbook regimes: inelastic demand (negligible outside option) reproduces
// Hotelling's MINIMUM differentiation (co-location, 50/50); the default elastic
// outside option flips it to MAXIMUM differentiation (firms cover separate
// catchments) — the well-known spreading result once consumers can opt out.
function baseModelSpread(seed, U0) {
  const town = Core.generateTown(seed), st = Engine.makeState(town);
  Object.keys(st.mods).forEach(k => st.mods[k] = false);   // strip every modification
  const save = Engine.CONFIG.U0;
  Engine.CONFIG.U0 = U0;
  const res = Nash.iterate(town, st, 30);
  const final = Engine.evaluate(town, res.state);
  Engine.CONFIG.U0 = save;
  const A = res.state.players[0], B = res.state.players[1];
  return { cheb: Math.max(Math.abs(A.x - B.x), Math.abs(A.y - B.y)), shareA: final.perPlayer[0].share };
}

test('6. base model reproduces Hotelling minimum differentiation (inelastic demand)', () => {
  const r = baseModelSpread(3, -12);                 // outside option negligible => full coverage
  assert.ok(r.cheb <= 3, `players should converge together, chebyshev ${r.cheb}`);
  assert.ok(Math.abs(r.shareA - 0.5) < 0.03, `split should be ~50/50, got ${r.shareA}`);
});

test('6b. elastic outside option flips to maximum differentiation (spreading)', () => {
  const r = baseModelSpread(3, -3);                  // default outside option => consumers can opt out
  assert.ok(r.cheb >= 6, `firms should separate to cover distinct catchments, chebyshev ${r.cheb}`);
  assert.ok(Math.abs(r.shareA - 0.5) < 0.06, `symmetric spread stays ~50/50, got ${r.shareA}`);
});

test('7. loyalty conserves mass (no cell over-served)', () => {
  const town = Core.generateTown(55), st = Engine.makeState(town);
  st.mods.loyalty = true;
  for (let c = 0; c < town.N; c++) { st.prevFrac[c * Engine.STRIDE] = 0.3; st.prevFrac[c * Engine.STRIDE + 1] = 0.25; }
  const r = Engine.evaluate(town, st);
  for (let c = 0; c < town.N; c++) {
    if (town.water[c] || town.base[c] <= 0) continue;
    const sum = r._cellFrac[c * Engine.STRIDE] + r._cellFrac[c * Engine.STRIDE + 1];
    assert.ok(sum >= -1e-9 && sum <= 1 + 1e-6, `cell ${c} served fraction ${sum} out of [0,1]`);
  }
});

test('8. entry fires only when a persistent desert exists', () => {
  const town = Core.generateTown(88);
  // desert: both players crammed into one corner, leaving most of town unserved
  const st = Engine.makeState(town);
  const corner = Engine.snap(town, 1, 1);
  st.players[0].x = corner.x; st.players[0].y = corner.y;
  st.players[1].x = corner.x; st.players[1].y = corner.y;
  st.players[0].radius = 1; st.players[1].radius = 1;
  let fired = null;
  for (let round = 1; round <= Engine.CONFIG.entryPatience; round++) {
    const r = Engine.evaluate(town, st);
    fired = Engine.checkEntry(town, st, r);
    if (round < Engine.CONFIG.entryPatience) assert.strictEqual(fired, null, `should not fire early on round ${round}`);
  }
  assert.ok(fired && typeof fired.x === 'number', 'chain should enter after patience elapses');

  // gate: entry disabled => never fires despite the same desert
  const st2 = Engine.makeState(town); st2.mods.entry = false;
  st2.players[0] = { id: 'A', x: corner.x, y: corner.y, price: 12, tier: 1, radius: 1, isChain: false };
  st2.players[1] = { id: 'B', x: corner.x, y: corner.y, price: 12, tier: 1, radius: 1, isChain: false };
  for (let round = 1; round <= Engine.CONFIG.entryPatience + 2; round++) {
    const r = Engine.evaluate(town, st2);
    assert.strictEqual(Engine.checkEntry(town, st2, r), null, 'disabled entry must never fire');
  }
});

test('9. evaluate produces finite, well-formed results on a live town', () => {
  const town = Core.generateTown('smoke'), st = Engine.makeState(town);
  const r = Engine.evaluate(town, st);
  r.perPlayer.forEach(p => {
    assert.ok(Number.isFinite(p.profit), 'finite profit');
    assert.ok(p.share >= 0 && p.share <= 1, 'share in range');
  });
  assert.ok(Number.isFinite(r.welfare.consumerSurplus), 'finite CS');
  const chk = Nash.check(town, st);
  assert.ok(typeof chk.stable === 'boolean', 'nash check returns a verdict');
});
