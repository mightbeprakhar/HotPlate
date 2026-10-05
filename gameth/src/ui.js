/* HOTPLATE — ui.js
 * Boots the app, wires the menu and the three mode controllers (Campaign vs AI,
 * Duel hot-seat, Lab sandbox), and drives the render/eval loop: live editing,
 * territory morphs, a day-of-trading beat (customers stream in, the till rings),
 * scoreboard, coaching panel, day report, welfare strip, Nash verdict, chain
 * entry, capture & sound.
 * Consumes HP.Core + HP.Engine + HP.Nash + HP.Render. Browser only.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'), require('./engine.js'), require('./nash.js'), require('./render.js'));
  else { root.HP = root.HP || {}; root.HP.UI = factory(root.HP.Core, root.HP.Engine, root.HP.Nash, root.HP.Render); }
})(typeof self !== 'undefined' ? self : this, function (Core, Engine, Nash, Render) {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : self);
  var CFG = Engine.CONFIG, CANV;

  var MODS = [
    { k: 'demand2d', name: '2-D demand & time', desc: 'Non-uniform hunger; lunch / evening / late' },
    { k: 'priceQuality', name: 'Price & quality', desc: 'Pick a menu tier and set a price' },
    { k: 'delivery', name: 'Delivery radius', desc: 'Reach further, pay commission' },
    { k: 'roads', name: 'Road network', desc: 'River, bridges, one-way streets' },
    { k: 'agglomRent', name: 'Agglomeration & rent', desc: 'Clusters pull crowds; downtown rent bites' },
    { k: 'loyalty', name: 'Customer loyalty', desc: 'Habits harden over days' },
    { k: 'entry', name: 'Chain entry threat', desc: 'Persistent deserts invite a 3rd rival' }
  ];
  var TAGS = { A: 'You', B: 'Rival', C: 'The Chain' };

  var S = {
    mode: 'campaign', persona: 'optimizer', seed: 'hotplate', days: 14,
    town: null, state: null, result: null, prevResult: null,
    period: 'all', sel: 'A', turn: 0, busy: false,
    sound: false, reduced: false, hover: null, ghost: null, overlayHeatmap: null,
    pulse: 0.5, cum: { A: 0, B: 0, C: 0 }, explain: null, lastVerdict: null, over: false,
    openPos: null            // your pitch as the day opened — the rival decides against this
  };
  var D = {};

  // ---------- tiny helpers ----------
  function $(id) { return document.getElementById(id); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function byId(id) { for (var i = 0; i < S.state.players.length; i++) if (S.state.players[i].id === id) return S.state.players[i]; return null; }
  function money(v) { return '$' + Math.round(v).toLocaleString(); }
  function signed(v) { return (v >= 0 ? '+' : '−') + money(Math.abs(v)); }
  function pct(v) { return Math.round(v * 100) + '%'; }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // ---------- boot ----------
  function boot() {
    if (typeof document === 'undefined') return;
    ['menu', 'game', 'seedInput', 'shuffleSeed', 'personaSel', 'personaField', 'daysSel', 'playBtn',
      'backBtn', 'modeChip', 'seedChip', 'roundChip', 'turnChip', 'newMapBtn', 'captureBtn', 'soundBtn', 'motionBtn', 'helpBtn',
      'stageArea', 'stage', 'cTerrain', 'cDemand', 'cTerritory', 'cEntities', 'verdict', 'cellTip', 'tickText', 'legend',
      'scoreboard', 'playerCards', 'insights', 'periodSeg', 'modBlock', 'modToggles', 'actions',
      'loyaltySlider', 'loyaltyV', 'loyaltyHint',
      'statCS', 'statTravel', 'statDesert', 'statMarket',
      'dayModal', 'dayBody', 'dayClose', 'helpModal', 'helpClose'
    ].forEach(function (k) { D[k] = $(k); });
    CANV = { terrain: D.cTerrain, demand: D.cDemand, territory: D.cTerritory, entities: D.cEntities };
    Render.init(CANV, D.stageArea);
    S.reduced = detectReduced();
    D.motionBtn.classList.toggle('on', S.reduced);

    // menu
    $$('.mode-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.mode-btn').forEach(function (x) { x.classList.remove('sel'); });
        b.classList.add('sel'); S.mode = b.getAttribute('data-mode');
        D.personaField.style.display = S.mode === 'campaign' ? '' : 'none';
      });
    });
    $$('.mode-btn')[0].classList.add('sel'); S.mode = 'campaign';
    D.shuffleSeed.addEventListener('click', function () { D.seedInput.value = randSeed(); });
    D.playBtn.addEventListener('click', function () {
      S.seed = D.seedInput.value || 'hotplate';
      S.persona = D.personaSel.value;
      S.days = parseInt(D.daysSel.value, 10) || 0;
      startGame();
    });

    // topbar
    D.backBtn.addEventListener('click', toMenu);
    // Fresh town, same rules — reroll the seed and restart without a trip to the
    // menu. Blocked mid-animation so a resolving day can't be torn out from under.
    D.newMapBtn.addEventListener('click', function () {
      if (S.busy) return;
      S.seed = randSeed();
      if (D.seedInput) D.seedInput.value = S.seed;
      startGame();
    });
    D.captureBtn.addEventListener('click', capture);
    D.soundBtn.addEventListener('click', function () { S.sound = !S.sound; D.soundBtn.classList.toggle('on', S.sound); D.soundBtn.title = 'Sound: ' + (S.sound ? 'on' : 'off'); if (S.sound) beep(660, .09); });
    D.motionBtn.addEventListener('click', function () { S.reduced = !S.reduced; D.motionBtn.classList.toggle('on', S.reduced); Render.setReducedMotion(S.reduced); });
    D.helpBtn.addEventListener('click', function () { D.helpModal.classList.remove('hidden'); });
    D.helpClose.addEventListener('click', function () { D.helpModal.classList.add('hidden'); });
    D.helpModal.addEventListener('click', function (e) { if (e.target === D.helpModal) D.helpModal.classList.add('hidden'); });
    D.dayClose.addEventListener('click', closeDay);
    D.dayModal.addEventListener('click', function (e) { if (e.target === D.dayModal) closeDay(); });
    root.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!D.dayModal.classList.contains('hidden')) closeDay();
      else D.helpModal.classList.add('hidden');
    });

    // period view
    $$('#periodSeg button').forEach(function (b) {
      b.addEventListener('click', function () { $$('#periodSeg button').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on'); S.period = b.getAttribute('data-period'); if (S.town) Render.drawDemand(S.town, S.period); });
    });

    // loyalty control
    D.loyaltySlider.addEventListener('input', function () {
      var v = parseInt(D.loyaltySlider.value, 10);
      D.loyaltyV.textContent = v + '%';
      D.loyaltyHint.textContent = loyaltyCopy(v);
      if (!S.state) return;
      S.state.loyaltyW = v / 100;
      preview();
    });

    // canvas pointer
    D.cEntities.addEventListener('mousemove', onHover);
    D.cEntities.addEventListener('mouseleave', function () { S.hover = null; S.ghost = null; D.cellTip.classList.add('hidden'); drawEnt(); });
    D.cEntities.addEventListener('click', onClick);

    var rz; root.addEventListener('resize', function () {
      clearTimeout(rz); rz = setTimeout(function () {
        if (!S.town || D.game.classList.contains('hidden')) return;
        Render.drawTown(S.town); Render.drawDemand(S.town, S.period);
        if (S.result) { paintTerr(S.result); drawEnt(); }
      }, 160);
    });
    D.seedInput.value = 'hotplate';
  }

  function detectReduced() { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function randSeed() { var w = ['sunset', 'harbor', 'maple', 'cobalt', 'juniper', 'delta', 'ember', 'quartz', 'lyra', 'basil', 'onyx', 'saffron']; var a = w[Math.floor(Math.random() * w.length)], b = Math.floor(Math.random() * 900 + 100); return a + '-' + b; }

  // ---------- screens ----------
  function toMenu() { stopPulse(); Render.fxClear(); D.dayModal.classList.add('hidden'); D.game.classList.add('hidden'); D.menu.classList.remove('hidden'); }
  function stopPulse() { if (S._pulseRAF) { root.cancelAnimationFrame(S._pulseRAF); S._pulseRAF = null; } }

  function startGame() {
    stopPulse(); Render.fxClear();
    S.town = Core.generateTown(S.seed);
    S.state = Engine.makeState(S.town);
    S.result = null; S.prevResult = null; S.turn = 0; S.sel = 'A';
    S.overlayHeatmap = null; S.cum = { A: 0, B: 0, C: 0 }; S.explain = null; S.over = false; S.busy = false;
    S.state.round = 1;
    markOpen();
    Render.setReducedMotion(S.reduced);
    D.menu.classList.add('hidden'); D.game.classList.remove('hidden');
    D.dayModal.classList.add('hidden');
    D.modeChip.textContent = ({ campaign: 'Campaign · ' + personaName(S.persona), duel: 'Duel · hot-seat', lab: 'Lab · sandbox' })[S.mode];
    D.seedChip.textContent = S.town.name + ' · ' + S.seed;
    D.seedChip.title = S.town.name + ' — seed "' + S.seed + '"';
    D.modBlock.classList.toggle('hidden', S.mode !== 'lab');
    syncLoyalty();
    D.tickText.style.opacity = 1; D.tickText.textContent = townIntro();   // set now: nothing to fade from on a fresh town
    buildLegend(); buildMods(); buildScore(); buildCards(); buildActions();
    setTurn();
    // wait for layout, then draw
    root.requestAnimationFrame(function () {
      Render.drawTown(S.town); Render.drawDemand(S.town, S.period);
      refresh(false, function () { deferVerdict(); });
      beep(523, .08);
    });
  }
  function personaName(p) { return ({ optimizer: 'Optimizer', undercutter: 'Undercutter', snob: 'Snob', mimic: 'Copycat' })[p] || p; }

  // Announces the town's character so variety between seeds is legible at a glance.
  function townIntro() {
    var t = S.town, msg = t.name + ' — ' + t.blurb;
    if (t.notes && t.notes.length) msg += ' Today: ' + t.notes.slice(0, 2).join(' and ') + '.';
    return msg + ' ' + t.candidates.length + ' blocks to pitch in. Where do you set up?';
  }

  // ---------- loyalty control ----------
  function loyaltyCopy(v) {
    if (!S.state || !S.state.mods.loyalty) return 'Loyalty is switched off — the town re-chooses from scratch every day.';
    if (v === 0) return 'No habits. Every day the town re-chooses from scratch — textbook Hotelling.';
    if (v < 25) return 'Weak habits. Yesterday barely matters; position and price decide today.';
    if (v < 50) return v + '% of yesterday’s custom sticks regardless of today’s offer. First-mover advantage starts to bite.';
    if (v < 70) return 'Strong habits. Getting there first is worth more than being slightly better.';
    return 'Entrenched. ' + v + '% stays put whatever you do — incumbency is close to decisive.';
  }
  function syncLoyalty() {
    var on = !!(S.state && S.state.mods.loyalty);
    var v = Math.round(((S.state && S.state.loyaltyW != null) ? S.state.loyaltyW : CFG.lambda) * 100);
    D.loyaltySlider.value = v; D.loyaltySlider.disabled = !on;
    D.loyaltyV.textContent = v + '%';
    D.loyaltyHint.textContent = loyaltyCopy(v);
  }

  // ---------- controlled player / editability ----------
  function controlled() {
    if (S.mode === 'campaign') return byId('A');
    if (S.mode === 'duel') return S.state.players[S.turn];
    return byId(S.sel) || S.state.players[0];
  }
  function editable(pid) {
    if (S.over) return false;
    if (S.mode === 'lab') return true;
    if (S.mode === 'campaign') return pid === 'A';
    if (S.mode === 'duel') return S.state.players[S.turn] && S.state.players[S.turn].id === pid && pid !== 'C';
    return false;
  }

  // ---------- scoreboard ----------
  function buildScore() {
    D.scoreboard.innerHTML = S.state.players.map(function (p) {
      return '<div class="sb" data-pid="' + p.id + '">' +
        '<span class="sb-badge ' + p.id + '">' + (p.isChain ? 'C' : p.id) + '</span>' +
        '<div class="sb-col">' +
        '<div class="sb-top"><span class="sb-name">' + TAGS[p.id] + '</span>' +
        '<span class="sb-crown" title="Leading on banked profit"><svg class="ic"><use href="#i-trophy"/></svg></span></div>' +
        '<div class="sb-bar"><i class="' + p.id + '" id="sbar-' + p.id + '" style="width:0%"></i></div>' +
        '</div>' +
        '<div class="sb-num"><b class="mono" id="sbank-' + p.id + '">$0</b>' +
        '<s class="mono" id="sday-' + p.id + '">—</s></div>' +
        '</div>';
    }).join('');
    S.scoreBuilt = S.state.players.length;
  }
  function updateScore(r) {
    if (S.scoreBuilt !== S.state.players.length) buildScore();
    var lead = null, bestBank = -Infinity, multi = S.state.round > 1;
    S.state.players.forEach(function (p) { var b = S.cum[p.id] || 0; if (b > bestBank) { bestBank = b; lead = p.id; } });
    r.perPlayer.forEach(function (pp) {
      tween($('sbank-' + pp.id), S.cum[pp.id] || 0, money, 460);
      var dy = $('sday-' + pp.id);
      if (dy) { dy.textContent = signed(pp.profit) + '/day'; dy.className = 'mono ' + (pp.profit >= 0 ? 'up' : 'down'); }
      var bar = $('sbar-' + pp.id);
      if (bar) bar.style.width = Math.max(1, Math.round(pp.share * 100)) + '%';
    });
    $$('.sb').forEach(function (s) { s.classList.toggle('lead', multi && s.getAttribute('data-pid') === lead); });
  }

  // ---------- cards ----------
  function buildCards() {
    var html = '';
    S.state.players.forEach(function (p) {
      var ed = editable(p.id), pq = S.state.mods.priceQuality, dv = S.state.mods.delivery;
      html += '<div class="pcard ' + p.id + (p.id === controlled().id ? ' active' : '') + (ed ? '' : ' locked') + '" data-pid="' + p.id + '">' +
        '<div class="p-hd"><div class="p-badge">' + (p.isChain ? 'C' : p.id) + '</div>' +
        '<div><div class="p-name">' + (TAGS[p.id] || p.id) + '</div><div class="p-tag">' + CFG.tierNames[p.tier] + (p.isChain ? ' · entrant' : '') + '</div></div>' +
        '<div class="p-profit"><div class="pp-v mono" id="prof-' + p.id + '">$0</div><div class="pp-k">profit / day</div></div></div>' +
        '<div class="p-controls">' +
        '<div class="ctrl-row"><label>Price</label><input type="range" min="' + CFG.pmin + '" max="' + CFG.pmax + '" step="0.5" value="' + p.price + '" id="price-' + p.id + '" ' + (ed && pq ? '' : 'disabled') + '><span class="val" id="priceV-' + p.id + '">$' + p.price + '</span></div>' +
        '<div class="ctrl-row"><label>Quality</label><div class="tier-seg" id="tier-' + p.id + '">' +
        [0, 1, 2].map(function (t) { return '<button data-t="' + t + '" class="' + (p.tier === t ? 'on' : '') + '" ' + (ed && pq ? '' : 'disabled') + '>' + CFG.tierNames[t] + '</button>'; }).join('') +
        '</div><span></span></div>' +
        (dv ? '<div class="ctrl-row"><label>Delivery</label><input type="range" min="0" max="' + CFG.maxRadius + '" step="1" value="' + Math.round(p.radius) + '" id="rad-' + p.id + '" ' + (ed ? '' : 'disabled') + '><span class="val" id="radV-' + p.id + '">' + Math.round(p.radius) + '</span></div>' : '') +
        '</div>' +
        '<div class="p-stats">' +
        '<div><span>Share</span><b id="share-' + p.id + '">—</b></div>' +
        '<div><span>Covers</span><b id="vol-' + p.id + '">—</b></div>' +
        '<div><span>Revenue</span><b id="rev-' + p.id + '">—</b></div>' +
        '<div><span>Overhead</span><b id="rent-' + p.id + '">—</b></div>' +
        '<div><span>Regulars</span><b id="loy-' + p.id + '">—</b></div>' +
        '<div><span>Delivered</span><b id="deliv-' + p.id + '">—</b></div>' +
        '</div></div>';
    });
    D.playerCards.innerHTML = html;
    // wire
    S.state.players.forEach(function (p) {
      var pr = $('price-' + p.id); if (pr) pr.addEventListener('input', function () { p.price = parseFloat(pr.value); $('priceV-' + p.id).textContent = '$' + p.price; preview(); });
      var rd = $('rad-' + p.id); if (rd) rd.addEventListener('input', function () { p.radius = parseFloat(rd.value); $('radV-' + p.id).textContent = rd.value; preview(); });
      var seg = $('tier-' + p.id); if (seg) $$('button', seg).forEach(function (b) { b.addEventListener('click', function () { if (b.disabled) return; p.tier = parseInt(b.getAttribute('data-t'), 10); $$('button', seg).forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on'); preview(); }); });
      var card = D.playerCards.querySelector('.pcard[data-pid="' + p.id + '"]');
      if (card && S.mode === 'lab') card.addEventListener('click', function (e) { if (e.target.closest('input,button')) return; S.sel = p.id; setActive(); drawEnt(); updateInsights(); });
    });
    S.playerCardsBuilt = S.state.players.length;
    if (S.result) updateCards(S.result);
  }
  function setActive() { $$('.pcard').forEach(function (c) { c.classList.toggle('active', c.getAttribute('data-pid') === controlled().id); }); }

  function updateCards(r) {
    r.perPlayer.forEach(function (pp) {
      tween($('prof-' + pp.id), pp.profit, money, 520);
      var pv = $('prof-' + pp.id); if (pv) pv.classList.toggle('neg', pp.profit < 0);
      var sh = $('share-' + pp.id); if (sh) sh.textContent = pct(pp.share);
      var vo = $('vol-' + pp.id); if (vo) vo.textContent = Math.round(pp.volume).toLocaleString();
      var rv = $('rev-' + pp.id); if (rv) rv.textContent = money(pp.revenue);
      var rn = $('rent-' + pp.id); if (rn) rn.textContent = money(pp.rent + pp.fixed);
      var ly = $('loy-' + pp.id); if (ly) ly.textContent = S.state.mods.loyalty ? pct(pp.loyaltyShare) : 'off';
      var dl = $('deliv-' + pp.id); if (dl) dl.textContent = S.state.mods.delivery ? pct(pp.deliveryShare) : 'off';
    });
  }

  // ---------- coaching panel: why, and what next ----------
  function updateInsights() {
    if (!S.result) return;
    var cp = controlled(); var pid = (S.mode === 'campaign') ? 'A' : (cp ? cp.id : 'A');
    var ex = Nash.explain(S.town, S.state, S.result, pid);
    S.explain = ex;
    if (!ex) { D.insights.innerHTML = ''; return; }
    var cls = ex.standing === 'leading' ? 'up' : ex.standing === 'trailing' ? 'down' : 'flat';
    var word = ex.standing === 'leading' ? 'Ahead' : ex.standing === 'trailing' ? 'Behind' : 'Dead level';
    var h = '<div class="ins-head ' + cls + '"><span class="ins-standing">' + word + '</span>' +
      (ex.rivalId ? '<span class="ins-gap mono">' + signed(ex.gap) + '/day vs ' + TAGS[ex.rivalId] + '</span>' : '') + '</div>';

    h += '<div class="ins-sec">' + (ex.standing === 'trailing' ? 'Why you’re losing' : 'What’s driving this') + '</div>';
    h += ex.causes.length
      ? ex.causes.map(function (c) { return '<div class="cause"><div class="cause-t">' + esc(c.title) + '</div><div class="cause-d">' + esc(c.detail) + '</div></div>'; }).join('')
      : '<p class="hint-txt">Nothing is dragging you down — your pitch, price and reach are all pulling their weight.</p>';

    h += '<div class="ins-sec">Try this next <span class="sec-note">simulated, so the gain is real</span></div>';
    h += ex.hints.length
      ? ex.hints.map(function (t, i) {
        return '<button class="hint" data-h="' + i + '"' + (editable(pid) ? '' : ' disabled') + '>' +
          '<span class="hint-g mono">+' + money(t.gain) + '</span>' +
          '<span class="hint-b"><b>' + esc(t.title) + '</b><i>' + esc(t.detail) + '</i></span></button>';
      }).join('')
      : '<p class="hint-txt">No single move improves your day — you’re sitting on your best response.</p>';
    D.insights.innerHTML = h;
    $$('.hint', D.insights).forEach(function (b) {
      b.addEventListener('click', function () {
        var t = S.explain && S.explain.hints[parseInt(b.getAttribute('data-h'), 10)];
        if (t) applyHint(pid, t);
      });
    });
  }

  function applyHint(pid, t) {
    var p = byId(pid);
    if (!p || !editable(pid)) { tick('You can’t change that right now.'); return; }
    var from = { x: p.x, y: p.y };
    for (var k in t.apply) p[k] = t.apply[k];
    if (t.apply.x != null) { var sp = Engine.snap(S.town, p.x, p.y); p.x = sp.x; p.y = sp.y; }
    buildCards(); beep(587, .07);
    if (from.x !== p.x || from.y !== p.y) Render.fxGlide([{ id: pid, x0: from.x, y0: from.y, x1: p.x, y1: p.y }], 520);
    Render.fxRing(p.x, p.y, playerIdx(pid));
    preview(); drawEnt(); Render.fxRun();
    tick('Applied — ' + t.title.toLowerCase() + '.');
  }

  // ---------- mods (Lab) ----------
  function buildMods() {
    D.modToggles.innerHTML = MODS.map(function (m) {
      return '<div class="toggle ' + (S.state.mods[m.k] ? 'on' : '') + '" data-mod="' + m.k + '" role="switch" tabindex="0" aria-checked="' + !!S.state.mods[m.k] + '"><div class="sw"></div><div class="t-txt"><span class="t-name">' + m.name + '</span><span class="t-desc">' + m.desc + '</span></div></div>';
    }).join('');
    $$('#modToggles .toggle').forEach(function (t) {
      function flip() {
        var k = t.getAttribute('data-mod');
        S.state.mods[k] = !S.state.mods[k];
        t.classList.toggle('on', S.state.mods[k]); t.setAttribute('aria-checked', !!S.state.mods[k]);
        syncLoyalty(); buildCards(); setTurn(); Render.drawDemand(S.town, S.period); preview(); deferVerdict();
      }
      t.addEventListener('click', flip);
      t.addEventListener('keydown', function (e) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });
    });
  }

  // ---------- actions ----------
  function buildActions() {
    var h = '';
    if (S.mode === 'campaign') h = '<button class="btn go" id="aEnd">Open for the day <svg class="ic"><use href="#i-play"/></svg></button><button class="btn" id="aAuto">Fast-forward 3 days</button>';
    else if (S.mode === 'duel') h = '<button class="btn go" id="aCommit">Commit move <svg class="ic"><use href="#i-play"/></svg></button>';
    else h = '<button class="btn go" id="aIter">Iterate to Nash</button><button class="btn teal" id="aCheck">Test for equilibrium</button><button class="btn" id="aBR">Show profit landscape</button><button class="btn" id="aReset">Reset positions</button>';
    D.actions.innerHTML = h;
    if (S.mode === 'campaign') { $('aEnd').addEventListener('click', function () { endDay({}); }); $('aAuto').addEventListener('click', function () { autoDays(3); }); }
    else if (S.mode === 'duel') { $('aCommit').addEventListener('click', commit); }
    else { $('aIter').addEventListener('click', labIterate); $('aCheck').addEventListener('click', labCheck); $('aBR').addEventListener('click', labBR); $('aReset').addEventListener('click', labReset); }
  }
  function setBusy(b) {
    S.busy = b;
    $$('#actions .btn').forEach(function (x) { x.disabled = b; });
  }

  // ---------- turn handling ----------
  function setTurn() {
    if (S.mode === 'duel') {
      S.sel = S.state.players[S.turn].id;
      D.turnChip.classList.remove('hidden');
      D.turnChip.textContent = TAGS[S.sel] + ' to move';
      D.turnChip.style.color = Render.colorFor(S.turn);
    } else { D.turnChip.classList.add('hidden'); }
    // On the final day the round counter has already ticked past the limit
    // (round = days + 1). Clamp the display so the chip reads "Day 10 / 10 · done"
    // rather than the confusing "Day 11 / 10".
    if (S.over && S.days) D.roundChip.textContent = 'Day ' + S.days + ' / ' + S.days + ' · done';
    else D.roundChip.textContent = 'Day ' + S.state.round + (S.days ? ' / ' + S.days : '');
    if (S.playerCardsBuilt !== S.state.players.length || S.mode === 'duel') { buildCards(); S.playerCardsBuilt = S.state.players.length; }
    setActive();
  }

  // ---------- eval / render pipeline ----------
  function preview() { refresh(true); scheduleVerdict(); }
  function refresh(animate, done) {
    if (!S.town || !S.state) return;
    S.prevResult = S.result;
    S.result = Engine.evaluate(S.town, S.state);
    if (animate) Render.animateTerritory(S.prevResult, S.result, function () { drawEnt(); if (done) done(); });
    else { paintTerr(S.result); drawEnt(); if (done) done(); }
    updateCards(S.result); updateScore(S.result); updateWelfare(S.result); updateInsights(); managePulse();
  }
  function paintTerr(r) { Render.paintTerritory(r); }  // instant paint
  function drawEnt() {
    if (!S.result) return;
    Render.drawEntities(S.town, S.state, {
      result: S.result,                       // ownership borders
      selected: controlled() ? controlled().id : null,
      deserts: S.result.welfare.underserved,
      entryRisk: S.state.mods.entry ? Math.min(1, (S.state.entryStreak || 0) / CFG.entryPatience) : 0,
      showRadius: S.state.mods.delivery, hover: S.hover, ghost: S.ghost,
      heatmap: S.overlayHeatmap, pulse: S.pulse
    });
  }

  function desertFrac(r) {
    var pot = 0, des = 0;
    for (var i = 0; i < S.town.N; i++) if (!S.town.water[i]) pot += S.town.base[i];
    for (var u = 0; u < r.welfare.underserved.length; u++) des += S.town.base[r.welfare.underserved[u]];
    return pot > 0 ? des / pot : 0;
  }
  function updateWelfare(r) {
    tween(D.statCS, r.welfare.consumerSurplus, money, 520);
    D.statTravel.textContent = r.welfare.avgTravel.toFixed(1);
    var dP = desertFrac(r);
    D.statDesert.textContent = pct(dP); D.statDesert.className = 'stat-v mono' + (dP > 0.3 ? ' down' : '');
    var served = r.demandTotal > 0 ? r.marketTotal / r.demandTotal : 0;
    D.statMarket.textContent = pct(served); D.statMarket.className = 'stat-v mono' + (served > 0.6 ? ' up' : '');
  }

  // ---------- pointer ----------
  function onHover(e) {
    var c = evtCell(e);
    if (!c) { S.hover = null; S.ghost = null; D.cellTip.classList.add('hidden'); drawEnt(); return; }
    S.hover = c;
    var cp = controlled();
    S.ghost = (cp && editable(cp.id) && !onAnyPlayer(c)) ? { x: c.x, y: c.y, idx: playerIdx(cp.id) } : null;
    showTip(c); drawEnt();
  }
  function onClick(e) {
    var c = evtCell(e); if (!c || S.busy) return;
    if (S.mode === 'lab') { var hit = playerAt(c); if (hit) { S.sel = hit.id; setActive(); drawEnt(); updateInsights(); return; } }
    var cp = controlled(); if (!cp || !editable(cp.id)) return;
    var sp = Engine.snap(S.town, c.x, c.y);
    if (sp.x === cp.x && sp.y === cp.y) return;
    var from = { x: cp.x, y: cp.y };
    cp.x = sp.x; cp.y = sp.y;
    S.ghost = null; beep(440, .05);
    Render.fxGlide([{ id: cp.id, x0: from.x, y0: from.y, x1: cp.x, y1: cp.y }], 420);
    Render.fxRing(cp.x, cp.y, playerIdx(cp.id));
    preview(); drawEnt(); Render.fxRun();
  }
  function evtCell(e) { var r = D.cEntities.getBoundingClientRect(); return Render.cellFromPoint(e.clientX - r.left, e.clientY - r.top); }
  function playerAt(c) { for (var i = 0; i < S.state.players.length; i++) { var p = S.state.players[i]; if (p.x === c.x && p.y === c.y) return p; } return null; }
  function onAnyPlayer(c) { return !!playerAt(c); }
  function playerIdx(id) { for (var i = 0; i < S.state.players.length; i++) if (S.state.players[i].id === id) return i; return 0; }
  function applyMove(p, mv) { p.price = mv.price != null ? mv.price : p.price; if (mv.tier != null) p.tier = mv.tier; var sp = Engine.snap(S.town, mv.x, mv.y); p.x = sp.x; p.y = sp.y; }

  // ---------- per-cell tooltip: the numbers behind a block ----------
  function showTip(c) {
    if (!S.result || !S.result._cellFrac) { D.cellTip.classList.add('hidden'); return; }
    var i = c.y * S.town.W + c.x;
    if (S.town.water[i] || S.town.base[i] <= 0) { D.cellTip.classList.add('hidden'); return; }
    var STR = Engine.STRIDE, cf = S.result._cellFrac, out = 1, rows = '';
    S.state.players.forEach(function (p, k) {
      var fr = cf[i * STR + k] || 0; out -= fr;
      rows += '<div class="tip-r"><i class="' + p.id + '"></i><span>' + TAGS[p.id] + '</span><b class="mono">' + pct(fr) + '</b></div>';
    });
    rows += '<div class="tip-r out"><i></i><span>Cooks at home</span><b class="mono">' + pct(Math.max(0, out)) + '</b></div>';
    D.cellTip.innerHTML = '<div class="tip-h">' + esc(Core.ZONES[S.town.zone[i]]) + ' · (' + c.x + ',' + c.y + ')</div>' +
      '<div class="tip-d">Demand index <b class="mono">' + Math.round(S.town.base[i] * 100) + '</b></div>' + rows;
    var m = Render.metrics();
    D.cellTip.classList.remove('hidden');
    var tw = D.cellTip.offsetWidth, th = D.cellTip.offsetHeight;
    var px = (c.x + 1) * m.cell + 10, py = c.y * m.cell;
    if (px + tw > m.cw) px = c.x * m.cell - tw - 10;
    if (py + th > m.ch) py = m.ch - th - 4;
    D.cellTip.style.left = Math.max(2, px) + 'px';
    D.cellTip.style.top = Math.max(2, py) + 'px';
  }

  // ---------- the visible day of trading ----------
  // Customers physically stream to whoever won them, then each till rings with
  // the day's profit. This is the beat that makes a turn feel like a turn.
  function serviceBeat(done) {
    if (S.reduced) { drawEnt(); if (done) done(); return; }
    Render.flow(S.town, S.state, S.result, function () {
      S.result.perPlayer.forEach(function (pp) {
        var p = byId(pp.id); if (!p) return;
        Render.fxRing(p.x, p.y, playerIdx(pp.id));
        Render.fxFloat(p.x, p.y, playerIdx(pp.id), signed(pp.profit), pp.profit >= 0 ? 'up' : 'down');
      });
      beep(S.result.perPlayer[0] && S.result.perPlayer[0].profit >= 0 ? 698 : 294, .1);
      Render.fxRun(done);
    });
  }

  // ---------- CAMPAIGN ----------
  // Record your pitch as the trading day opens. The rival plans against *this*,
  // not against the move you finish on — otherwise it always gets the last look.
  function markOpen() {
    var a = byId('A');
    S.openPos = a ? { x: a.x, y: a.y, price: a.price, tier: a.tier } : null;
  }

  // One click must settle exactly one day. The render layer drives resolution
  // through chained RAF-completion callbacks (territory → flow → tills), and those
  // can fire their "done" more than once if a loop is restarted mid-flight. Left
  // unguarded, each extra fire ran another afterResolve → round++, so a single
  // "Open for the day" could skip several days and blow past the final bell. This
  // wrapper collapses any number of callback fires into a single resolution.
  function once(fn) { var called = false; return function () { if (called) return; called = true; return fn.apply(this, arguments); }; }

  function endDay(opts, cb) {
    opts = opts || {};
    if (S.busy || S.over) { if (cb) cb(); return; }
    setBusy(true);
    var B = byId('B'), from = { x: B.x, y: B.y };
    // Simultaneous commitment. Both of you choose from the same information:
    // the board as it stood this morning. We rewind your pitch to the day's
    // opening position, let the rival plan, then restore your real move. Without
    // this the rival best-responds to a locked-in target every single day, which
    // is a last-mover advantage you never get and the match becomes unwinnable.
    var A = byId('A');
    var live = A ? { x: A.x, y: A.y, price: A.price, tier: A.tier } : null;
    var op = S.openPos;
    if (A && op) { A.x = op.x; A.y = op.y; A.price = op.price; A.tier = op.tier; }
    var mv = Nash.aiMove(S.town, S.state, 'B', S.persona);
    if (A && live) { A.x = live.x; A.y = live.y; A.price = live.price; A.tier = live.tier; }
    applyMove(B, mv);
    buildCards();                                    // the AI may have repriced
    beep(392, .07);
    if (from.x !== B.x || from.y !== B.y) {
      Render.fxGlide([{ id: 'B', x0: from.x, y0: from.y, x1: B.x, y1: B.y }], 520);
      tick(TAGS.B + ' repositions to (' + B.x + ',' + B.y + ')…');
    } else { tick(TAGS.B + ' holds the pitch and adjusts the board.'); }
    // `go` is built once, outside the animation callback, so every path that can
    // reach it (and any stray re-fire) shares the same single-shot guard.
    var go = once(function () { afterResolve(function () { setBusy(false); if (!opts.quick) openDay(); if (cb) cb(); }); });
    refresh(true, function () {
      if (opts.quick) { drawEnt(); go(); } else serviceBeat(go);
    });
  }
  function autoDays(n) {
    if (S.busy || S.over) return;
    var left = n;
    (function go() {
      if (left-- <= 0 || S.over) { openDay(); return; }
      endDay({ quick: true }, function () { setTimeout(go, S.reduced ? 20 : 260); });
    })();
  }

  // ---------- DUEL ----------
  function commit() {
    if (S.busy) return;
    beep(440, .06);
    if (S.turn === 0) { S.turn = 1; setTurn(); refresh(true); tick(TAGS.B + ', your move. ' + TAGS.A + '’s pitch is locked in.'); return; }
    S.turn = 0; setBusy(true);
    var go = once(function () { afterResolve(function () { setBusy(false); setTurn(); openDay(); }); });
    refresh(true, function () {
      serviceBeat(go);
    });
  }

  // ---------- shared day resolution ----------
  function afterResolve(done) {
    var entry = Engine.checkEntry(S.town, S.state, S.result);
    // once(): the entry branch below runs a second territory animation whose
    // fxRun(finish) can re-fire; this keeps the day's books (loyalty, banking,
    // round++) to a single application no matter how the callbacks land.
    var finish = once(function () {
      Engine.stepLoyalty(S.state, S.result);
      S.dayNo = S.state.round;
      S.result.perPlayer.forEach(function (pp) { S.cum[pp.id] = (S.cum[pp.id] || 0) + pp.profit; });
      S.state.round++;
      markOpen();                                    // next day opens from here
      // Decide the final bell BEFORE setTurn() so the day counter can render its
      // "done" state instead of ticking one past the limit.
      if (S.days && S.state.round > S.days) S.over = true;
      setTurn(); updateScore(S.result);
      deferVerdict(); flavorTick(); if (done) done();
    });
    if (entry) {
      Engine.spawnChain(S.state, entry);
      beep(196, .22, 'sawtooth', .05);
      tick('A national chain smells opportunity — “' + TAGS.C + '” opens in your biggest desert.');
      buildScore(); buildCards(); setTurn();
      Render.fxRing(entry.x, entry.y, 2);
      refresh(true, function () { Render.fxRun(finish); });
    } else { finish(); }
  }

  // ---------- day report ----------
  function openDay() {
    if (!S.result) return;
    var r = S.result, mine = null, others = [];
    r.perPlayer.forEach(function (pp) { if (pp.id === 'A') mine = pp; else others.push(pp); });
    if (!mine) return;
    others.sort(function (a, b) { return b.profit - a.profit; });
    var top = others[0], gap = top ? mine.profit - top.profit : mine.profit;
    var won = gap > 0, level = top && Math.abs(gap) < Math.max(1, Math.abs(top.profit) * 0.02);
    var ex = Nash.explain(S.town, S.state, r, 'A');

    var head = S.over
      ? (function () {
        var bank = S.cum.A || 0, rivalBank = S.cum.B || 0;
        var champ = bank > rivalBank;
        return '<div class="rep-hd ' + (champ ? 'win' : 'lose') + '">' +
          '<div class="rep-k">Final bell · ' + S.days + ' days</div>' +
          '<div class="rep-t">' + (champ ? 'You out-earned the rival' : bank === rivalBank ? 'A dead heat' : 'The rival out-earned you') + '</div>' +
          '<div class="rep-s mono">' + money(bank) + ' banked vs ' + money(rivalBank) + '</div></div>';
      })()
      : '<div class="rep-hd ' + (level ? 'flat' : won ? 'win' : 'lose') + '">' +
      '<div class="rep-k">Day ' + (S.dayNo || 1) + ' · close of trade</div>' +
      '<div class="rep-t">' + (level ? 'Level day' : won ? 'You won the day' : 'You lost the day') + '</div>' +
      (top ? '<div class="rep-s mono">' + signed(gap) + ' against ' + TAGS[top.id] + '</div>' : '') + '</div>';

    var rows = r.perPlayer.map(function (pp) {
      return '<tr class="' + (pp.id === 'A' ? 'me' : '') + '"><td><span class="dotc ' + pp.id + '"></span>' + TAGS[pp.id] + '</td>' +
        '<td class="mono">' + Math.round(pp.volume).toLocaleString() + '</td>' +
        '<td class="mono">' + pct(pp.share) + '</td>' +
        '<td class="mono">' + money(pp.revenue) + '</td>' +
        '<td class="mono">' + money(pp.rent + pp.fixed) + '</td>' +
        '<td class="mono">' + (S.state.mods.loyalty ? pct(pp.loyaltyShare) : '—') + '</td>' +
        '<td class="mono ' + (pp.profit >= 0 ? 'up' : 'down') + '"><b>' + money(pp.profit) + '</b></td>' +
        '<td class="mono">' + money(S.cum[pp.id] || 0) + '</td></tr>';
    }).join('');

    var table = '<table class="rep-tbl"><thead><tr><th>Trader</th><th>Covers</th><th>Share</th><th>Revenue</th><th>Overhead</th><th>Regulars</th><th>Profit</th><th>Banked</th></tr></thead><tbody>' + rows + '</tbody></table>';

    var town = '<div class="rep-town">' +
      '<div><span>Town cooking at home</span><b class="mono">' + pct(r.outsideShare) + '</b></div>' +
      '<div><span>Consumer surplus</span><b class="mono">' + money(r.welfare.consumerSurplus) + '</b></div>' +
      '<div><span>Average travel</span><b class="mono">' + r.welfare.avgTravel.toFixed(1) + '</b></div>' +
      '<div><span>Food deserts</span><b class="mono">' + pct(desertFrac(r)) + '</b></div></div>';

    var why = '';
    if (ex && ex.causes.length) {
      why = '<div class="rep-sec">' + (won ? 'What won it' : 'Why you lost it') + '</div>' +
        ex.causes.map(function (c) { return '<div class="cause"><div class="cause-t">' + esc(c.title) + '</div><div class="cause-d">' + esc(c.detail) + '</div></div>'; }).join('');
    }
    var next = '';
    if (!S.over && ex && ex.hints.length) {
      next = '<div class="rep-sec">Best moves for tomorrow</div>' +
        ex.hints.map(function (t, i) {
          return '<button class="hint" data-rh="' + i + '"><span class="hint-g mono">+' + money(t.gain) + '</span>' +
            '<span class="hint-b"><b>' + esc(t.title) + '</b><i>' + esc(t.detail) + '</i></span></button>';
        }).join('');
    }
    var verdict = S.lastVerdict ? '<div class="rep-nash ' + S.lastVerdict.kind + '"><span class="dot"></span><b>' + S.lastVerdict.main + '</b><i>' + esc(S.lastVerdict.sub) + '</i></div>' : '';

    var foot = S.over
      ? '<div class="rep-foot"><button class="btn go" id="repAgain">Play another town</button><button class="btn" id="repStay">Keep trading anyway</button></div>'
      : '<div class="rep-foot"><button class="btn go" id="repGo">Next day</button></div>';

    D.dayBody.innerHTML = head + table + town + verdict + why + next + foot;
    D.dayModal.classList.remove('hidden');
    S.explain = ex;
    $$('.hint', D.dayBody).forEach(function (b) {
      b.addEventListener('click', function () {
        var t = S.explain && S.explain.hints[parseInt(b.getAttribute('data-rh'), 10)];
        if (t) { closeDay(); applyHint('A', t); }
      });
    });
    var g = $('repGo'); if (g) g.addEventListener('click', closeDay);
    // "Play another town" must actually land you on a DIFFERENT town. Returning
    // to the menu left the old seed in the box, so the next Play rebuilt the
    // identical map. Roll a fresh seed and start immediately.
    var ag = $('repAgain'); if (ag) ag.addEventListener('click', function () { closeDay(); S.seed = randSeed(); if (D.seedInput) D.seedInput.value = S.seed; startGame(); });
    var st = $('repStay'); if (st) st.addEventListener('click', function () { S.over = false; S.days = 0; D.roundChip.textContent = 'Day ' + S.state.round; buildCards(); updateInsights(); closeDay(); });
  }
  function closeDay() { D.dayModal.classList.add('hidden'); }

  // ---------- LAB ----------
  function labIterate() {
    if (S.busy) return; setBusy(true); S.overlayHeatmap = null;
    var res = Nash.iterate(S.town, S.state, 24);
    tick('Playing out best-response dynamics… ' + (res.path.length - 1) + ' rounds.');
    playPath(res.path, 0, function () {
      refresh(true, function () {
        var msg = res.outcome === 'converged' ? 'Converged to a fixed point — nobody wants to move.'
          : res.outcome === 'cycling' ? 'Best responses cycle — no pure-strategy resting point here.'
            : 'Stopped at the iteration budget.';
        tick(msg); deferVerdict(); setBusy(false);
      });
    });
  }
  function playPath(path, i, done) {
    if (i >= path.length) { done(); return; }
    var snap = path[i], tracks = [];
    snap.forEach(function (s) {
      var p = byId(s.id); if (!p) return;
      if (p.x !== s.x || p.y !== s.y) tracks.push({ id: s.id, x0: p.x, y0: p.y, x1: s.x, y1: s.y });
      p.x = s.x; p.y = s.y; p.price = s.price; p.tier = s.tier;
    });
    S.prevResult = S.result; S.result = Engine.evaluate(S.town, S.state);
    Render.animateTerritory(S.prevResult, S.result, function () { drawEnt(); });
    if (tracks.length) { Render.fxGlide(tracks, S.reduced ? 1 : 420); Render.fxRun(); }
    updateCards(S.result); updateScore(S.result); updateWelfare(S.result); updateInsights();
    setTimeout(function () { playPath(path, i + 1, done); }, S.reduced ? 40 : 560);
  }
  function labCheck() { deferVerdict(true); }
  function labBR() {
    var pid = controlled().id;
    S.overlayHeatmap = Nash.heatmap(S.town, S.state, pid); drawEnt();
    var br = Nash.bestResponse(S.town, S.state, pid);
    Render.fxRing(br.x, br.y, playerIdx(pid)); Render.fxRun();
    tick(TAGS[pid] + '’s best pitch: (' + br.x + ',' + br.y + ') · ' + CFG.tierNames[br.tier] + ' @ $' + br.price.toFixed(1) + ' — ' + signed(br.gain) + '/day. White-ringed cell is the peak.');
    beep(587, .08);
  }
  function labReset() {
    S.overlayHeatmap = null;
    var A = byId('A'), B = byId('B');
    var a = Engine.snap(S.town, S.town.W * 0.4, S.town.H * 0.5), b = Engine.snap(S.town, S.town.W * 0.6, S.town.H * 0.5);
    var tracks = [{ id: 'A', x0: A.x, y0: A.y, x1: a.x, y1: a.y }, { id: 'B', x0: B.x, y0: B.y, x1: b.x, y1: b.y }];
    A.x = a.x; A.y = a.y; A.price = CFG.defaultPrice; A.tier = 1;
    B.x = b.x; B.y = b.y; B.price = CFG.defaultPrice; B.tier = 1;
    buildCards(); Render.fxGlide(tracks, 460); preview(); drawEnt(); Render.fxRun(); deferVerdict();
  }

  // ---------- Nash verdict ----------
  var verdictTimer;
  function scheduleVerdict() { clearTimeout(verdictTimer); D.verdict.classList.remove('show'); }
  function deferVerdict(force) {
    clearTimeout(verdictTimer);
    setVerdictRaw('Checking the map…', '', '');
    verdictTimer = setTimeout(function () {
      var chk = Nash.check(S.town, S.state);
      if (chk.stable) { setVerdictRaw('NASH EQUILIBRIUM', 'nash', 'No player can profit by moving or repricing.'); beep(784, .1); }
      else {
        var d = chk.deviations[0];
        setVerdictRaw('NOT AT EQUILIBRIUM', 'unstable', TAGS[d.pid] + ' could gain ' + money(d.gain) + '/day by deviating.');
      }
    }, force ? 10 : 40);
  }
  function setVerdictRaw(main, kind, sub) {
    S.lastVerdict = kind ? { main: main, kind: kind, sub: sub } : S.lastVerdict;
    D.verdict.className = 'verdict show' + (kind ? ' ' + kind : '');
    D.verdict.innerHTML = (kind ? '<span class="dot"></span>' : '') + '<span>' + main + '</span>' + (sub ? '<small>' + sub + '</small>' : '');
  }

  // ---------- ticker flavor ----------
  function tick(msg) { D.tickText.style.opacity = 0; setTimeout(function () { D.tickText.textContent = msg; D.tickText.style.opacity = 1; }, S.reduced ? 0 : 150); }
  function flavorTick() {
    if (!S.result) return;
    var A = S.result.perPlayer[0], lines = [];
    if (A.share < 0.34) lines.push('You’re being out-muscled (' + pct(A.share) + ' share). Look for demand the rival ignores.');
    else if (A.share > 0.62) lines.push('You own the town (' + pct(A.share) + ' share). Watch the gaps for a chain.');
    if (S.state.mods.delivery && A.deliveryShare > 0.4) lines.push('Delivery is ' + pct(A.deliveryShare) + ' of your covers — commission is thinning the margin.');
    if (S.state.entryStreak > 0) lines.push('A big desert is festering (' + S.state.entryStreak + '/' + CFG.entryPatience + ' days) — a chain is circling.');
    lines.push('Day ' + S.state.round + ': you have banked ' + money(S.cum.A || 0) + '.');
    tick(lines[Math.floor((S.state.round + lines.length) % lines.length)] || 'A new day dawns.');
  }

  // ---------- entry pulse loop ----------
  function managePulse() {
    var risk = S.state.mods.entry && S.state.entryStreak > 0;
    if (!risk || S.reduced || !root.requestAnimationFrame) { stopPulse(); return; }
    if (S._pulseRAF) return;
    var t0 = null;
    (function loop(ts) {
      if (t0 === null) t0 = ts;
      S.pulse = 0.5 + 0.5 * Math.sin((ts - t0) / 420);
      if (!S.busy) drawEnt();
      S._pulseRAF = root.requestAnimationFrame(loop);
    })();
  }

  // ---------- number tween ----------
  function tween(el, to, fmt, dur) {
    if (!el) return;
    var from = parseFloat(el.getAttribute('data-v') || '0');
    el.setAttribute('data-v', to);
    if (S.reduced || !root.requestAnimationFrame || !isFinite(from)) { el.textContent = fmt(to); return; }
    var token = (el._tw || 0) + 1; el._tw = token;   // cancel any in-flight tween on this element
    var start = null;
    function step(ts) {
      if (el._tw !== token) return;
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / (dur || 500));
      el.textContent = fmt(from + (to - from) * easeOut(t));
      if (t < 1) root.requestAnimationFrame(step);
    }
    root.requestAnimationFrame(step);
  }

  // ---------- legend ----------
  function buildLegend() {
    D.legend.innerHTML =
      '<b><i style="background:' + Render.colorFor(0) + '"></i>You (A)</b>' +
      '<b><i style="background:' + Render.colorFor(1) + '"></i>Rival (B)</b>' +
      '<b><i style="background:' + Render.colorFor(2) + '"></i>Chain (C)</b>' +
      '<b><i style="background:linear-gradient(90deg,rgba(255,196,92,.15),rgba(255,150,60,.7))"></i>Demand</b>' +
      '<b><i style="border:1px dashed #9a97a2;background:transparent"></i>Food desert</b>';
  }

  // ---------- capture ----------
  function capture() {
    var url = Render.capturePNG(); if (!url) return;
    var a = document.createElement('a'); a.href = url; a.download = 'hotplate-' + String(S.seed).replace(/\W+/g, '_') + '-day' + S.state.round + '.png'; a.click();
    tick('Figure saved as PNG.'); beep(880, .07);
  }

  // ---------- sound ----------
  var actx = null;
  function beep(freq, dur, type, gain) {
    if (!S.sound) return;
    try {
      actx = actx || new (root.AudioContext || root.webkitAudioContext)();
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = type || 'sine'; o.frequency.value = freq; g.gain.value = gain || 0.045;
      o.connect(g); g.connect(actx.destination); o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + (dur || 0.12)); o.stop(actx.currentTime + (dur || 0.12));
    } catch (e) { }
  }

  return { boot: boot, _state: S };
});
