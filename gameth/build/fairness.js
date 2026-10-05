// BUILD ARTEFACT — campaign fairness probe. Not part of the submission.
// Plays full campaigns with A driven by a realistic (non-optimal) human policy
// against the real AI, and reports who comes out ahead.
var Core = require('../src/core.js');
var Engine = require('../src/engine.js');
var Nash = require('../src/nash.js');

function byId(st, id) { return st.players.filter(function (p) { return p.id === id; })[0]; }

// A "human-like" A: takes a good-but-not-perfect pitch from a coarse grid, and
// tunes price/tier the way a player does — by feel, landing near but not on the
// optimum. Deliberately NOT a best response, to model a real player.
function humanMove(town, state, pid) {
  var p = byId(state, pid);
  var cands = Nash.CANDIDATES(town);
  var save = { x: p.x, y: p.y, price: p.price, tier: p.tier };
  var scored = [];
  for (var i = 0; i < cands.length; i += 3) {
    p.x = cands[i].x; p.y = cands[i].y;
    scored.push({ c: cands[i], v: Engine.profitOf(town, state, pid) });
  }
  p.x = save.x; p.y = save.y;
  scored.sort(function (a, b) { return b.v - a.v; });
  // pick from the top 15%, but not the single best — models imperfect play
  var pick = scored[Math.min(scored.length - 1, Math.floor(scored.length * 0.12))];

  // Now feel out price and tier from that pitch, on a coarse ladder, and settle
  // one notch short of the best — a player tunes, but never exactly.
  p.x = pick.c.x; p.y = pick.c.y;
  var pl = Nash.priceLevels(), combos = [];
  for (var t = 0; t < 3; t++)
    for (var k = 0; k < pl.length; k += 2) {
      p.price = pl[k]; p.tier = t;
      combos.push({ price: pl[k], tier: t, v: Engine.profitOf(town, state, pid) });
    }
  p.x = save.x; p.y = save.y; p.price = save.price; p.tier = save.tier;
  combos.sort(function (a, b) { return b.v - a.v; });
  var cp = combos[Math.min(combos.length - 1, 1)];        // second-best, not best
  return { x: pick.c.x, y: pick.c.y, price: cp.price, tier: cp.tier };
}

function run(seed, persona, days) {
  var town = Core.generateTown(seed);
  var st = Engine.makeState(town);
  st.mods = { demand2d: true, priceQuality: true, delivery: true, roads: true, agglomRent: true, loyalty: true, entry: true };
  var cum = { A: 0, B: 0, C: 0 }, chainDays = 0;
  var sepSum = 0, sepN = 0;
  for (var d = 0; d < days; d++) {
    // Simultaneous commitment — exactly the shipped order. BOTH sides decide
    // against the morning board, then both moves land. Neither gets a last look.
    var A = byId(st, 'A'), B = byId(st, 'B');
    var hm = humanMove(town, st, 'A');          // A plans vs B's opening pitch
    var ai = Nash.aiMove(town, st, 'B', persona); // B plans vs A's opening pitch
    A.x = hm.x; A.y = hm.y; A.price = hm.price; A.tier = hm.tier;
    B.x = ai.x; B.y = ai.y; B.price = ai.price; B.tier = ai.tier;
    var res = Engine.evaluate(town, st);
    var entry = Engine.checkEntry(town, st, res);
    if (entry) { Engine.spawnChain(st, entry); chainDays++; }
    res.perPlayer.forEach(function (pp) { cum[pp.id] = (cum[pp.id] || 0) + pp.profit; });
    if (!st.players.filter(function (p) { return p.isChain; }).length) {
      sepSum += Math.abs(A.x - B.x) + Math.abs(A.y - B.y); sepN++;
    }
    Engine.stepLoyalty(st, res);
    st.round++;
  }
  return { cum: cum, chainDays: chainDays, sep: sepN ? sepSum / sepN : 0 };
}

var SEEDS = ['hotplate', 'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf',
             'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar'];
var PERSONAS = ['optimizer', 'undercutter', 'snob', 'mimic'];
var DAYS = 14;
var rows = [];
for (var pi = 0; pi < PERSONAS.length; pi++) {
  var winA = 0, winB = 0, sumA = 0, sumB = 0, sumSep = 0, sumChain = 0;
  for (var si = 0; si < SEEDS.length; si++) {
    var r = run(SEEDS[si], PERSONAS[pi], DAYS);
    sumA += r.cum.A; sumB += r.cum.B; sumSep += r.sep; sumChain += r.chainDays;
    if (r.cum.A > r.cum.B) winA++; else if (r.cum.B > r.cum.A) winB++;
  }
  rows.push({
    persona: PERSONAS[pi],
    A: sumA / SEEDS.length, B: sumB / SEEDS.length,
    winA: winA, winB: winB, ties: SEEDS.length - winA - winB,
    sep: sumSep / SEEDS.length, chain: sumChain / SEEDS.length
  });
}

console.log('campaign fairness — human-like A vs real AI B, ' + DAYS + ' days, ' + SEEDS.length + ' towns\n');
console.log('persona        A/town      B/town     A-B       wins A/B   separation');
rows.forEach(function (r) {
  var d = r.A - r.B;
  console.log(
    r.persona.padEnd(14) +
    ('$' + Math.round(r.A)).padEnd(12) +
    ('$' + Math.round(r.B)).padEnd(11) +
    ('$' + Math.round(d)).padEnd(10) +
    (r.winA + '/' + r.winB).padEnd(11) +
    r.sep.toFixed(1));
});
var gA = rows.reduce(function (s, r) { return s + r.A; }, 0) / rows.length;
var gB = rows.reduce(function (s, r) { return s + r.B; }, 0) / rows.length;
console.log('\noverall: A $' + Math.round(gA) + ' vs B $' + Math.round(gB) +
            '  ->  B leads by $' + Math.round(gB - gA) +
            ' (' + (100 * (gB - gA) / gA).toFixed(1) + '%)');
