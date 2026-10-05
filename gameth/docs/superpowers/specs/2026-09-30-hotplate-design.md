# HOTPLATE — Design Specification

**A spatial competition game based on Hotelling's Location Model**

Date: 2026-09-30
Status: Approved design, pending implementation plan
Course deliverable: Game Theory in the Real World — Spatial Location Game (Option B, Restaurant)

---

## 1. Purpose

Build a runnable, visually polished browser game that extends Hotelling's linear-city
model with seven real-world modifications, lets players compete over restaurant
placement and pricing, and identifies whether a Nash Equilibrium survives the
added realism.

The build serves three audiences at once:

1. **A grader** who must double-click one file and immediately understand the model.
2. **A player** who should find it genuinely fun and want a second run.
3. **A reader of the report**, who needs figures that make the equilibrium argument visible.

Priority order when these conflict: correctness of the model, then visual clarity,
then depth of analysis. This ordering was chosen explicitly — the project trades
analytical breadth for presentation quality.

---

## 2. Scope

### In scope

- Single-page web application, no build step, no dependencies, no network access.
- Procedurally generated 2D towns from a seed.
- Five real-world modifications to the base Hotelling model, plus two further
  mechanics of our own design (Section 4).
- Three play modes: Campaign, Duel, Lab.
- Exact Nash Equilibrium detection and best-response visualisation.
- Public welfare measurement (consumer surplus, travel burden, underserved districts).
- Engine self-test page.
- README.txt and a 3–4 page PDF analysis report with real screenshots.

### Out of scope

- Multiplayer over a network.
- Persistence beyond `localStorage` for settings and best scores.
- Mixed-strategy equilibrium computation. Where no pure equilibrium exists the game
  says so and shows the cycle; it does not solve for the mixed equilibrium.
- Mobile-first layout. The game targets desktop; it degrades gracefully but is not
  designed for phones.

---

## 3. Base model

A town contains consumers distributed over space. Two restaurants, **A** (the player)
and **B** (the rival), each choose a location. Consumers patronise whichever
restaurant gives them the highest utility. Each restaurant maximises profit.

Classic Hotelling predicts both competitors converge to the median of the
distribution — the principle of minimum differentiation. The base case is
reproduced exactly when all seven modifications are disabled, and this is asserted
by an automated test (Section 9).

---

## 4. The seven modifications

The assignment requires two. Seven are implemented, and the last three — the
volume-versus-margin trade-off, customer loyalty, and the entry threat — are the ones
not drawn from the assignment's suggested list.

### 4.1 Two-dimensional non-uniform demand

The town is a grid of cells. Each cell `c` carries a demand weight `d(c) ≥ 0` built
from a sum of Gaussian population blobs plus low-amplitude value noise, then
normalised. Zones layered on top — `residential`, `mall`, `office`, `campus`,
`park` — modulate both the weight and the taste parameters.

Demand also varies by **time of day**, with three periods: `lunch`, `evening`,
`latenight`. Each zone has a multiplier per period, so the office park dominates at
lunch and the campus dominates late at night:

```
d_t(c) = d(c) · zoneMultiplier[zone(c)][t]
```

A round evaluates all three periods and sums the results, so a location that is
excellent at one hour and dead at another scores differently from a consistently
mediocre one.

### 4.2 Price and quality differentiation

Each restaurant chooses a **price** `P ∈ [P_min, P_max]` (continuous, controlled by
a slider, quantised to 5 steps for the equilibrium solver) and a **quality tier**
`Q ∈ {fast, casual, fine}` with values `Q ∈ {1.0, 1.8, 3.0}`.

Quality raises utility, but it multiplies against a **zone-specific taste factor**
`τ(zone)`. Campus cells barely value fine dining; office cells value it highly at
lunch. So quality is not a strictly dominant investment — it is a bet on which
consumers you intend to capture.

Quality also raises unit cost and fixed cost:

```
unitCost(Q)  = c₀ + c₁·Q
fixedCost(Q) = f₀ + f₁·Q²
```

The quadratic fixed cost is what stops "always pick fine dining" from being correct.

### 4.3 Delivery radius and aggregator commission

Each restaurant has a delivery radius `R`, adjustable in every mode by a slider.
Widening it adds a fixed logistics cost proportional to `R²`, so reach is never free.
A consumer in cell `c` within `R` graph-distance of restaurant `r`
compares two access costs and takes the cheaper:

```
dineInCost(c,r)   = θ_t · T(c,r)
deliveryCost(c,r) = θ_f · deliveryFee + θ_w · waitTime(T(c,r))
access(c,r)       = min(dineInCost, deliveryCost)   if T(c,r) ≤ R
                  = dineInCost                       otherwise
```

Orders served by delivery pay a **25% platform commission** out of margin. Delivery
therefore buys reach — notably across the river, bypassing bridge congestion — at a
direct cost to profitability. The share of revenue arriving via delivery is surfaced
in the UI, because the trade-off is one of the more interesting things a player
discovers.

### 4.4 Asymmetric road network

Travel cost is **shortest-path time over a directed weighted graph**, not Euclidean
distance. The generator produces:

- **Arterials** — fast edges, low time cost.
- **Streets** — slow edges.
- **A river** cutting the town, crossed by exactly **two bridges**. Bridge edges
  carry a congestion penalty that scales with how much demand routes across them.
- **One-way segments** on a subset of arterials, making `T(a,b) ≠ T(b,a)`.

Travel times come from Dijkstra's algorithm run from each restaurant over the road
graph. Because access is graph distance, market territories emerge organic and
lopsided rather than as a clean perpendicular bisector — which is the visual
centrepiece of the game.

### 4.5 Agglomeration, rent, and the volume-versus-margin trade-off

The core tension of the design. Three forces act at once, and they do not all point
the same way.

**Agglomeration.** When A and B are within a clustering distance `D_cluster`, the
*total* market expands by a factor `(1 + γ)` in nearby cells: people travel to a
dining cluster because it offers choice. Both restaurants receive this. Sitting on
top of your rival grows the pie while splitting it.

**Rent.** Locating costs rent proportional to local desirability:

```
rent(x) = r₀ + r₁·localDensity(x) + r₂·mallProximity(x)
```

**Pricing power.** This is the force that makes the game balanced, and it is emergent
rather than coded as a special case. Because shares are logit over utilities, two
restaurants sitting close together are near-perfect substitutes: a small price rise
sheds share rapidly to the rival, so equilibrium prices near the centre are driven
down. A restaurant alone on the periphery competes mainly against the *outside
option*, which is far less elastic, so it sustains a much higher price.

The resulting trade-off:

| | Centre | Periphery |
|---|---|---|
| Demand density | High | Low |
| Agglomeration + anchor traffic | Yes | No |
| Rent | High | Cheap |
| Pricing power | Weak — head-to-head substitution | Strong — local spatial monopoly |
| Net | **Volume at thin margins** | **Fat margins on low volume** |

Since `π = volume × margin − rent`, **both strategies are viable and neither
dominates**. Which one wins depends on the town's density gradient, its rent slope,
and the strength of the outside option — all of which vary by seed. A centre rush is
often the right move; it is simply no longer automatic.

This also reproduces a genuine result from the literature. Hotelling's 1929
conclusion that competitors converge to the centre was overturned by d'Aspremont,
Gabszewicz and Thisse (1979), who showed that once firms choose prices as well as
locations they prefer to *differentiate* in order to soften price competition. Our
engine should exhibit both regimes depending on the generated town, and the report
will present that as its central finding.

### 4.6 Customer loyalty and habit formation

Dining is habitual. A fraction of each cell's demand is **locked in** to whichever
restaurant served it last round, decaying over time:

```
sticky(c,r) = λ · share_{prev}(c,r) · (1 − δ)^{roundsSinceServed}
share(c,r)  = sticky(c,r) + (1 − Σ_r sticky(c,r)) · logitShare(c,r)
```

`λ` is loyalty strength and `δ` the decay rate; both are `CONFIG` values and both are
exposed as Lab sliders.

Three consequences, all of them interesting:

- **Path dependence.** Where you opened matters long after you have moved. The game
  stops being memoryless, so identical final positions can yield different payoffs.
- **Defensive moats.** A periphery restaurant accumulates a captive base, which
  strengthens the differentiation strategy from 4.5 and further balances the map.
- **Stabilisation.** Loyalty damps best-response dynamics. A configuration that
  *cycles* with `λ = 0` may settle into a pure equilibrium at `λ > 0`. Being able to
  slide loyalty up in Lab mode and watch a cycling game snap into stability is the
  sharpest theoretical demonstration in the project, and it belongs in the report.

Rendered as a shimmering texture over held cells, so a player can see their moat.

### 4.7 Entry threat — a third competitor

The market is **contestable**. Each round the engine measures underserved demand,
using the outside-option share from 5.2. If any connected region holds more than
`entryThreshold` of unserved demand for `entryPatience` consecutive rounds, a
**chain restaurant** enters at the most profitable unclaimed location and becomes a
permanent third competitor with deep pockets — it prices aggressively and does not
care about short-run losses.

The UI shows an escalating warning well before it fires:

```
ENTRY RISK — Riverside  ▓▓▓▓▓▓▓░░░   2 rounds to entry
```

This is the mechanic that ties strategy to the public interest. Leaving a district
unserved is not merely antisocial, it is *strategically dangerous*: the food desert
you ignored becomes the beachhead your new competitor uses against you. Duopolists
who both rush the centre are exactly the ones who get punished.

It also changes the game structurally mid-run, converting a two-player game into a
three-player one. All the equilibrium machinery in Section 6 generalises: the Nash
check sweeps whichever players are currently active.

---

## 5. Consumer choice and payoffs

### 5.1 Utility

For cell `c`, restaurant `r`, period `t`:

```
U(c,r,t) = θ_q · Q_r · τ(zone(c), t)
         − θ_p · P_r
         − access(c,r)
         + anchorBonus(r)
         + agglomerationBonus(A,B)
```

`anchorBonus` rewards proximity to the mall for passing foot traffic.

### 5.2 Market shares — logit with an outside option

Demand splits softly rather than by hard territory. Let `N` be the set of currently
active restaurants — `{A, B}` normally, or `{A, B, Chain}` once entry has occurred
(4.7):

```
logitShare(c,r,t) = exp(β·U(c,r,t)) / ( Σ_{k∈N} exp(β·U(c,k,t)) + exp(β·U₀) )
```

`U₀` is the **outside option**: stay home and cook. It is the most important term in
the model. If all restaurants are distant, expensive, or poor, the cell's residents
simply do not eat out and **the market shrinks**. Without this term the players would
always split a fixed pie, welfare would be meaningless, and the entry-threat mechanic
would have nothing to measure.

Loyalty from 4.6 is then layered on top:

```
share(c,r,t) = sticky(c,r) + (1 − Σ_{k∈N} sticky(c,k)) · logitShare(c,r,t)
```

A soft logit split is chosen over a hard winner-takes-cell rule because the payoff
surface stays continuous, which makes best-response dynamics well-behaved and the
best-response heatmap readable. The UI still renders a crisp territory overlay by
colouring each cell by its majority holder, so the player loses no visual clarity.

### 5.3 Profit

```
π_r = Σ_t Σ_c d_t(c) · share(c,r,t) · margin(c,r) − rent(x_r) − fixedCost(Q_r)

margin(c,r) = (P_r − unitCost(Q_r)) · (1 − 0.25·isDelivery(c,r))
```

### 5.4 Welfare

Under a logit model, consumer surplus has a closed form — the log-sum-exp
("inclusive value") expression from discrete choice theory:

```
CS(c,t) = (1/β) · ln( exp(β·U(c,A,t)) + exp(β·U(c,B,t)) + exp(β·U₀) )
```

Three public-interest measures are reported:

| Measure | Definition |
|---|---|
| **Consumer surplus** | `Σ_t Σ_c d_t(c)·CS(c,t)` |
| **Average travel burden** | demand-weighted mean `T(c, chosen)` over cells that dine out |
| **Underserved districts** | cells where outside-option share exceeds 60% — rendered as pulsing red "food deserts", and the input to the entry threat in 4.7 |

These let the report place the profit-maximising equilibrium beside the
welfare-maximising placement and measure the gap directly. That comparison is the
substance of the Policy Implications section.

---

## 6. Equilibrium analysis

Full brute force over the joint strategy space is intractable: roughly 10⁴ strategies
each, so 10⁸ pairs, each requiring a shortest-path solve and a full grid sum. Three
tractable mechanisms are used instead.

### 6.1 Exact Nash check

Distance fields for every candidate location are precomputed once per town and
cached, which makes a single payoff evaluation a vectorised sum over the grid. Given
the current state, sweep each active player's entire strategy set (candidate
locations × 5 price steps × 3 tiers) holding all other players fixed, and record the
best available deviation.

The state is a pure-strategy Nash Equilibrium **iff no active player has a profitable
deviation**. This is the literal definition, evaluated exactly, in the low
milliseconds. It generalises unchanged to three players once the chain has entered
(4.7).

The verdict is always on screen:

- `STABLE — neither player can improve` , or
- `UNSTABLE — you gain +7.2% by moving to the north bridge`, with the suggested
  deviation highlighted on the map.

### 6.2 Iterated best response

Players alternate best responses from the current state. Each visited state is
hashed. Three outcomes are possible and all three are reported plainly:

- **Converged** — a fixed point, i.e. a pure Nash Equilibrium.
- **Cycling** — a previously visited state recurs, so **no pure Nash Equilibrium**
  exists along that path. The cycle is animated on the map.
- **Budget exhausted** — reported honestly as inconclusive, never as convergence.

### 6.3 Best-response heatmap

Holding the rival fixed, colour every candidate cell by the profit the player would
earn there. This is simultaneously the most useful analytical artefact and the most
attractive screen in the game, which is why it survives the "less depth, more polish"
trade-off intact. The argmax is ringed; the current position is marked so the
distance between them is immediately legible.

A reduced one-dimensional slice — prices fixed, both players confined to the main
arterial — is fully brute-forced and rendered as a compact payoff strip, giving the
report a direct textbook comparison.

---

## 7. Modes

**Campaign.** Eight rounds against an adaptive AI across escalating towns. Each round
the player may move, re-price, change tier, adjust delivery radius, or hold. The AI
responds according to its personality. City events fire between rounds. Objectives
("finish above 55% share", "stay solvent through the rent hike") give the run shape.

**Duel.** Hot-seat for two humans. Placements are entered privately then revealed
simultaneously, which makes the simultaneous-move structure of the game concrete
rather than theoretical.

**Lab.** Free sandbox. Drag any restaurant, scrub every parameter, toggle each of
the seven modifications independently on and off, and watch the verdict and heatmaps
update live. Toggling all seven off and watching both players converge to the centre
is the moment the classic model becomes intuitive. Sliding loyalty up until a cycling
game snaps into a stable equilibrium is the moment the extension justifies itself.
This mode produces most of the report figures.

---

## 8. Replayability

- **Seeded generation.** Towns come from a displayed seed; the same seed reproduces
  the same town exactly, which matters for reproducing report screenshots.
- **Path dependence.** Loyalty (4.6) means the order of moves changes the outcome, so
  even a repeated seed plays differently if you open somewhere else.
- **Entry.** Whether and where the chain enters (4.7) reshapes the second half of a
  campaign, and it is a consequence of the players' own neglect rather than a scripted
  event.
- **City events.** Festival, road closure, metro station opening, rent hike,
  aggregator commission change — each perturbs the board mid-campaign and tests
  whether an equilibrium was robust or merely lucky.
- **AI personalities.** Four distinct opponents:
  - *Undercutter* — competes on price, tolerates thin margins.
  - *Premium Snob* — fine dining, high price, targets office and mall demand.
  - *Mimic* — copies the player's position with a lag. Produces textbook clustering.
  - *Optimizer* — plays exact best responses. The hardest, and the one that
    demonstrates convergence or cycling most clearly.

---

## 9. Validation

`tests.html` runs the engine headlessly and asserts:

1. Logit shares plus the outside option sum to exactly 1 for every cell.
2. Dijkstra results match a brute-force Floyd–Warshall on a small fixture graph.
3. One-way edges produce asymmetric travel times.
4. Profit is monotone decreasing in own price when price is above the monopoly point.
5. Consumer surplus is monotone increasing as travel cost falls.
6. **Base-model reproduction** — with all seven modifications disabled, uniform
   demand, and equal prices, iterated best response converges to both players at the
   town centre with a 50/50 split, within tolerance.
7. **Loyalty conserves mass** — sticky and logit components of a cell's share sum to
   the cell's total demand for any `λ ∈ [0,1]`.
8. **Entry fires only when warranted** — on a fixture with no underserved region the
   chain never enters; on a fixture with a persistent desert it enters on exactly
   the `entryPatience`-th round.

Assertion 6 is the one that matters. It demonstrates the implementation is a faithful
extension of Hotelling rather than an unrelated simulation, and it earns a paragraph
in the report.

---

## 10. Visual design

The project explicitly favours presentation quality, so the visual system is
specified rather than left to implementation.

### 10.1 Rendering architecture

Four stacked canvases, each redrawn only when its own inputs change, all
`devicePixelRatio`-aware for crispness on high-DPI screens:

| Layer | Contents | Redraw trigger |
|---|---|---|
| `terrain` | river, roads, bridges, buildings, zone tints | town regeneration |
| `demand` | population heatmap | time-of-day change, event |
| `territory` | market share field, loyalty shimmer, food deserts, entry-risk regions | any strategy change (animated) |
| `entities` | restaurants, customers, scooters, overlays | every frame while animating |

Panels and controls are DOM and CSS, not canvas, so text stays selectable and
accessible.

### 10.2 Visual language

Dark editorial. Warm amber identifies the player, cool teal the rival, and the
neutral greys stay genuinely neutral so the two competitors read instantly at a
glance. Heatmaps use a single perceptually ordered ramp. Exact values are fixed
against the `dataviz` skill's validated palette during implementation rather than
invented here, so that charts, tiles, and map share one system and pass contrast
checks in both light and dark.

No web fonts — a system font stack, because the game must run offline from `file://`.

### 10.3 Motion

Motion is deliberate, never decorative. The full budget:

| Moment | Treatment |
|---|---|
| Restaurant moves | territory field morphs over ~600 ms with eased interpolation |
| Round resolves | a short customer/scooter flow along real shortest paths |
| Payoffs update | numbers tick, share bars ease |
| Equilibrium found | one restrained pulse and a verdict banner |
| Entry threat rising | the at-risk region breathes; a meter fills in the HUD |
| Chain enters | the screen desaturates for a beat, the chain drops in, territory re-splits |
| Mode change | crossfade, ~200 ms |
| City event | a card slides in, the affected region flashes once |

Everything respects `prefers-reduced-motion`, collapsing to instant state changes.

Optional subtle audio, **muted by default**, synthesised with the WebAudio API so no
asset files are needed and the offline guarantee holds.

### 10.4 Legibility of outcomes

Results must be readable without reading numbers. Every screen carries: a verdict
banner, two payoff cards, a share bar, a welfare strip, and a round history
sparkline. A **capture figure** button exports the current canvas as a PNG, which is
how the report's screenshots are produced.

---

## 11. Technical constraints

- **No ES modules.** Classic `<script>` tags on a single global namespace, because
  Chrome blocks module loading over `file://` and a grader double-clicking
  `index.html` must not hit a blank screen.
- **No dependencies, no build step, no network calls.**
- Target: current Chrome, Edge, and Firefox on desktop.
- Full recompute after any strategy change must stay under 16 ms so the game holds
  60 fps while dragging. The precomputed distance-field cache is what makes this
  achievable.
- **One configuration object.** Every tuned coefficient in this document — `θ_q`,
  `θ_p`, `θ_t`, `θ_f`, `θ_w`, `β`, `U₀`, `γ`, `c₀`, `c₁`, `f₀`, `f₁`, `r₀`, `r₁`,
  `r₂`, `D_cluster`, `λ`, `δ`, `entryThreshold`, `entryPatience`, zone multipliers,
  and taste factors — lives in a single exported `CONFIG` in `engine.js`. Nothing is
  hard-coded at a call site. This is what makes the Lab mode's modification toggles
  and the base-model reproduction test possible.

---

## 12. Deliverables

1. `index.html` and `src/` — the game.
2. `tests.html` — engine self-tests.
3. `README.txt` — how to run, with the live link as a fallback.
4. `report/Analysis_Report.pdf` — 3–4 pages: Model Description, Equilibrium Analysis
   with figures, Policy and Strategic Implications, Team Contributions. Author names
   are placeholders to be filled in before submission.
5. `figures/` — exported PNGs used in the report.
6. A single `.zip` containing all of the above.

---

## 13. Open questions

None blocking. Author names and roll numbers are placeholders and must be filled in
by the team before submission.
