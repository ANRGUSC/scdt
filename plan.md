# Supply Chain Digital Twin (SCDT) — Implementation Plan

An interactive PWA for an "Emerging Technologies in Supply Chain" class: a small digital twin (1 Factory → 2 Warehouses → 4 Retail stores) where students trigger **shocks** (demand spikes/drops, factory/warehouse disruptions, delivery delays) and apply **response** decisions (production rate, delivery frequencies, split fractions, rerouting, capacity purchases), watching flows, inventories, stockouts, waste, and costs update in real time on an animated network diagram. Discrete-time (1 tick = 1 simulated day), pause/step/reset/speed controls, 7 preset scenarios, tabbed UI so students aren't overwhelmed.

**Stack decisions:** Vanilla single-file app — `index.html` (embedded CSS/JS) + `sw.js` + `manifest.json` + `icon.svg`. No build step, no CDN dependencies, SVG diagram. Runs locally; PWA features activate over localhost/https. Node naming: "Factory", "Warehouse", "Retail".

## 1. Simulation Model

### 1.1 Topology and units

- Nodes: `Factory` → `Warehouse 1`, `Warehouse 2` → `Retail 1..4`. Home assignment: R1,R2→W1; R3,R4→W2.
- **One tick = one simulated day.** All rates are units/day; shipments are `{units, daysRemaining}` with integer-day lead times. Quantities float internally, displayed rounded.
- Deterministic seeded PRNG (**mulberry32**, seed 12345, re-seeded on every reset) so Reset reproduces the baseline exactly and tests can diff state snapshots.

### 1.2 State variables

```js
state = {
  day: 0,
  rng: mulberry32(12345),
  running: true, tickPeriodMs: 1000,

  factory: {
    baseCapacity: 60,          // units/day, fixed
    capMult: 1.0,              // SHOCK: 0..1 disruption multiplier
    setpoint: 40,              // RESPONSE: production slider 0..60
    buffer: 0,                 // finished goods awaiting shipment (unbounded, holding cost applies)
    producedToday: 0,
  },
  warehouses: [ // index 0 = W1, 1 = W2
    { baseCapacity: 120, purchasedCapacity: 0,  // RESPONSE: +20 per $500 purchase, max +80
      capMult: 1.0,            // SHOCK: 0..1
      outage: false,           // SHOCK: no receive, no ship
      inv: 60,
      overflowQueue: 0,        // units waiting "on trucks" under Delay policy
      premiumInv: 0,           // units in overflow storage under Premium policy
    }, { /* same */ inv: 60 } ],
  stores: [ // R1..R4
    { baseDemand: 10, demandMult: 1.0,          // SHOCK per-store
      onHand: 10, shelfCapacity: 50,
      assignedWh: 0, homeWh: 0,                  // RESPONSE: assignedWh may differ from homeWh
      avgDemand7: 10,          // rolling 7-day mean of REALIZED demand (not sales!)
      demandToday: 0, fulfilledToday: 0, unmetToday: 0,
      state: 'healthy',        // healthy | low | stockout | overstock (derived)
    }, /* x4 */ ],
  shocks: { globalDemandMult: 1.0, delayF2W: 0, delayW2R: 0 },   // extra days added to NEW shipments
  responses: { fShipEvery: 2, rShipEvery: 1, splitToW1: 0.5,
               overflowPolicy: 'delay' },        // delay | redirect | premium | waste
  shipments: [ /* {from:'F'|'W1'|'W2', to:'W1'|'W2'|'R1'..'R4', units, daysRemaining, leadTotal, costPerUnit} */ ],
  costs: { production:0, holding:0, transport:0, reroute:0, capacityPurchase:0,
           stockoutPenalty:0, waste:0, total:0 },                 // cumulative buckets
  counters: { stockoutEvents:0, overstockEvents:0, wastedUnits:0, unmetUnits:0, demandUnits:0, fulfilledUnits:0 },
  history: { /* ring buffers, length 60: serviceLevel, costPerDay, sysInventory, perStoreDemand, whInv, delays */ },
  eventLog: [],                // [{day, text, severity}], capped at 50
  activeScenario: null,
}
```

Effective values (computed, never stored):
- `factory.effCap = baseCapacity * capMult`
- `wh.effCap = (baseCapacity + purchasedCapacity) * capMult` (0 if `outage`)
- `wh.util = wh.effCap > 0 ? wh.inv / wh.effCap : null` → **display "OUT" when null; never divide by zero**.

### 1.3 Per-tick update order (the core of `tick()`)

```
1. AGE shipments:      for each shipment, daysRemaining -= 1  (do NOT deliver yet)
2. PRODUCE:            produced = min(setpoint, factory.effCap); factory.buffer += produced
3. RECEIVE @ WH:       deliver shipments to W1/W2 with daysRemaining <= 0, via overflow policy;
                       also retry each wh.overflowQueue (Delay policy) before new arrivals
4. SHIP F→WH:          if day % fShipEvery == 0 and buffer > 0:
                       qty1 = buffer * splitToW1; qty2 = buffer - qty1; buffer = 0;
                       create shipments leadTotal = 2 + shocks.delayF2W (skip a WH if its share is 0)
5. ORDER & SHIP WH→R:  if day % rShipEvery == 0: for each store r,
                       S = 3 * max(r.avgDemand7, 0.5)                       // adaptive order-up-to
                       pipeline = sum of in-transit units destined for r     // INCLUDES today's undelivered arrivals
                       orderQty = max(0, S - r.onHand - pipeline)
                       group orders by CURRENT assignedWh; if wh.outage → ship nothing;
                       if sum(orders) <= wh.inv ship all, else PROPORTIONAL allocation;
                       lead = (assignedWh == homeWh ? 1 : 2) + shocks.delayW2R;
                       perUnit transport = (home ? 0.30 : 0.60); deduct wh.inv
6. RECEIVE @ RETAIL:   deliver shipments with daysRemaining <= 0; clamp to shelfCapacity (50);
                       excess → wastedUnits (rare by construction)
7. DEMAND:             d = max(0, baseDemand * demandMult * globalDemandMult * (1 + U(-0.15, +0.15)))
                       fulfilled = min(d, onHand); onHand -= fulfilled; unmet = d - fulfilled (LOST sales, no backorders)
                       update avgDemand7 with d (realized demand, incl. unmet)
8. COSTS:              accrue (see 1.6); production & transport tallied at steps 2/4/5, holding on
                       end-of-tick inventories, penalties on today's unmet/waste
9. METRICS/EVENTS:     recompute node states, push history ring buffers, log state TRANSITIONS
                       (stockoutEvents++ only on ENTERING stockout, not per day)
```

**Why this order avoids artifacts:**
- Aging first, delivering inside receive steps → a shipment created this tick can never arrive this tick even with lead 1.
- Receiving at WH (3) *before* shipping WH→R (5) allows same-day cross-docking — total F→store latency still ≥ 3 days, no teleporting; prevents a spurious extra stockout day when a factory batch lands exactly when stores are starving.
- Ordering (5) *before* retail receive (6): order quantity uses **inventory position = onHand + pipeline**, and today's arriving-but-undelivered shipments are still in the pipeline sum, so nothing double-counts. Position accounting invariant → **no order oscillation / bullwhip artifact**.
- Demand last: "morning logistics, daytime sales" — goods arriving today can serve today's demand, so a perfectly-timed replenishment does not register a phantom stockout.
- `avgDemand7` averages **realized demand, not fulfilled sales** — averaging sales during a stockout would shrink S and cause a death spiral.

### 1.4 Shipments in transit

Single flat `shipments[]` array. Delivery frequency = "ship every N days in one batch" (`day % N == 0`). Lead times: F→WH = 2 days; WH→R home = 1 day; rerouted = 2 days. Delay shocks (`delayF2W`, `delayW2R`, each 0–4 extra days) apply **to newly created shipments only** (in-transit unaffected — say so in the tooltip). Rerouting correctness: step 5 groups store orders by `assignedWh` and deducts that warehouse's `inv` — the assignment map is the single source of truth for *which inventory depletes*; `homeWh` is only consulted for the cost/lead-time premium.

**Pipeline pre-seeding at reset** (eliminates cold-start transient; day 1 is already steady state):
- Per WH: one F→WH shipment of 40 units, `daysRemaining: 2`.
- Per store: one WH→R shipment of 10 units, `daysRemaining: 1`, from its home WH.
- `factory.buffer = 0`; WH inv 60 each; store onHand 10 each; `avgDemand7 = 10`.

### 1.5 Demand generation

`d = baseDemand(10) × perStoreMult × globalMult × (1 + noise)`, noise uniform in [−0.15, +0.15] from the seeded PRNG. Baseline total = 40/day.

### 1.6 Warehouse overflow policies (selectable, default **Delay**)

Applied in step 3 when `wh.inv + arriving > wh.effCap` (or when `outage`):

| Policy | Computation | Cost |
|---|---|---|
| **Delay** (default) | excess → `wh.overflowQueue`; retried at top of step 3 each day before new arrivals | demurrage $0.10/unit/day while queued |
| **Redirect** | excess shipped to the *other* WH: new shipment, 1 day lead, if that WH has projected room; else falls through to Waste | +$0.20/unit transport |
| **Premium** | excess accepted into `premiumInv` (drawn down first when shipping); node renders over-full/red | holding $0.20/unit/day (4× normal) |
| **Waste** | excess discarded, `wastedUnits +=` | $2.00/unit |

Baseline never triggers any policy. Each policy is a distinct cost/service tradeoff — deliberate teaching point in scenarios 2, 4, 7.

### 1.7 Default numbers (single frozen `DEFAULTS` object)

| Parameter | Value |
|---|---|
| Base demand per store | 10 units/day (total 40) |
| Demand noise | uniform ±15% |
| Factory max capacity / baseline setpoint | 60 / **40** units/day |
| Warehouse capacity | 120 each (purchasable +20/$500, max +80) |
| Retail shelf capacity | 50 |
| Order-up-to S | `3 × avgDemand7` (baseline = 30) |
| Lead times | F→WH 2d; WH→R home 1d; rerouted 2d |
| Delivery frequency | F→WH every **2** days; WH→R every **1** day |
| Starting inventory | WH 60 each; stores 10 each (+ pre-seeded pipelines, §1.4) |

**Cost coefficients:**

| Item | Value |
|---|---|
| Production | $1.00/unit |
| Holding: factory buffer / WH / retail | $0.05 / $0.05 / $0.10 per unit-day |
| Premium overflow holding / delay demurrage | $0.20 / $0.10 per unit-day |
| Transport per unit: F→WH / WH→R home / rerouted / redirect WH→WH | $0.20 / $0.30 / **$0.60** / $0.20 |
| Fixed dispatch: per F→WH shipping day / per WH per WH→R shipping day | $10 / $5 |
| Stockout penalty | $3.00/unit unmet |
| Waste | $2.00/unit |
| Capacity purchase | $500 per +20 units (one-time, `capacityPurchase` bucket) |

**Baseline arithmetic (hand-verified):**
- *Retail steady state* (freq 1, lead 1, S=30): position after ordering = 30; demand 10 → position 20 at next review → order 10/day. onHand cycles 10 → 20 (receive) → 10 (sell). Safety stock = 30 − (1+1)×10 = 10 vs. worst-case noise ±1.5/day over 2 days → **no stockouts possible**.
- *Warehouse steady state*: ships 20/day, receives 40 every 2 days → inv oscillates **40–80**; utilization 33–67% of 120 → peak 67%, just under the 70% yellow threshold → **stays green**.
- *Factory*: produces 40/day, buffer cycles 40→80→ship→0; ships 80 split 40/40.
- Overflow never triggers; waste = 0; stockouts = 0. Baseline cost ≈ **$86/day** (production $40 + holding ~$11 + transport variable $20 + fixed $15).
- System inventory ≈ 300 units ≈ 7.5 days of demand — shocks propagate over several visible days rather than instantly.

**Service level** = `Σ fulfilled / Σ demand` over a **rolling 20-day window** × 100% (return 100 if window demand is 0). Cumulative-since-reset version shown in the Metrics tab. **Average delivery delay** = unit-weighted mean `leadTotal` of shipments delivered in the last 20 days (baseline ≈ 1.5 days); per-leg breakdown in Metrics tab.

**Node color thresholds:**
- Warehouse: util < 70% green; 70–90% yellow; > 90% or `overflowQueue > 0` or `premiumInv > 0` red; outage = gray hatched + red border.
- Factory: effective ≥ setpoint green; capped (effCap < setpoint) yellow; capMult ≤ 0.2 red.
- Retail (cover = onHand / max(avgDemand7, 1)): stockout today → red; cover < 1.5 days → yellow "LOW"; cover > 5 days → orange "OVERSTOCK"; else green.
- Edges: gray at zero flow; green animated; yellow if a delay shock is active on that leg; **thickness = 1.5 + 8.5 × min(rate/30, 1)** px where rate = 7-day average units/day on that edge.

## 2. Scenario System

Each scenario is a plain object; **applying = setting parameter overrides at trigger time** (never editing inventories directly, except the outage flag):

```js
{ id: 4, name: "Warehouse 1 outage",
  description: "W1 goes offline: it cannot receive or ship.",
  watch: "R1/R2 stock out in 2–3 days; goods pile up at W1's gate.",
  hints: ["Set split fraction to send 100% to W2", "Reroute R1 and R2 to W2",
          "Buy +20 capacity at W2 (it now serves all four stores)"],
  apply(state) { state.warehouses[0].outage = true; },
  script: []   // optional: [{afterDays: 10, apply(state){...}}] — supported, unused by the 7 presets
}
```

Triggering: applies on top of the running sim (no reset), shows a persistent header banner with name + expandable hints, and **flash-highlights the control(s) the scenario changed**. A **"Clear shocks"** button restores all shock parameters (and scenario response-overrides) to defaults without touching inventories — distinct from Reset. Scenarios 6 and 7 are "mismanagement presets": they exceptionally override a *response* control to a bad value; document this in their descriptions.

| # | Scenario | Overrides | Verified failure mode & timing | Mitigation path |
|---|---|---|---|---|
| 1 | Demand spike, all stores | `globalDemandMult = 1.5` (60/day) | S lags demand (7-day avg) → under-ordering → stockouts in 2–4 days | Raise production to 60 (= new demand exactly — "running hot" with zero slack); service recovers as S adapts |
| 2 | Demand drop → overstock | `globalDemandMult = 0.4` (16/day) | Stores stop ordering; WHs gain ~20/day each; 60→120 cap in ~3 days → overflow policy engages day 4–6 | Cut production to ~16; compare overflow policies' costs |
| 3 | Factory capacity cut | `factory.capMult = 0.3` (cap 18 vs demand 40) | WHs drain ~11/day each → allocation shortfalls day 4–6, retail stockouts day 7–9 | Not fully mitigable (slider capped at 18) — lesson: buffers only *delay* supply shocks |
| 4 | Warehouse unavailable | `warehouses[0].outage = true` | R1/R2 stockout day 2–3; W1 gate queue grows (default Delay policy) | Split→0% W1, reroute R1/R2→W2 (note reroute cost/delay), buy W2 capacity (peak util 83% otherwise) |
| 5 | Stores must reroute | `warehouses[0].capMult = 0.3` (cap 36 < inv) | W1 can't receive until drained; 40-unit batches overflow by 4; R1/R2 flicker yellow/red | Reroute **only R2**→W2 and set split 30/70 — targeted rebalancing vs. scenario 4's full failover |
| 6 | Delivery frequency too low | `responses.rShipEvery = 3` (response override) | Protection-interval demand = (3+1)×10 = 40 > S = 30 → stockouts at cycle tails within one cycle | Restore freq 1 (or try 2 → marginal, noise still bites → safety-margin lesson); note dispatch fixed cost dropped meanwhile |
| 7 | Overproduction → congestion & waste | `factory.setpoint = 60` (response override) | WHs gain +20/day each → full in 3 days → queue/waste climbs | Lower production ≤ 40 (briefly below to drain); switch policy to Waste to compare waste counter vs. demurrage |

## 3. UI Layout (projector-friendly)

High-contrast **light theme**, base font 16px+, KPI numbers 28–32px, saturated status colors (`--green: #16a34a; --yellow: #d97706; --red: #dc2626; --gray: #94a3b8`). Every threshold color also gets a text/icon cue (OUT badge, ▲ overstock) so it survives projector washout.

```
┌──────────────────────────────────────────────────────────────┐
│ Supply Chain Twin   Day 42   [▶/⏸] [Step] [⟲ Reset] Speed ▾ │
│ [scenario banner: "Warehouse 1 outage — hints ▾"   ✕ clear]  │
├──────────────────────────────────────────────────────────────┤
│ KPI strip: Service 100% | Cost/day $86 | Sys inv 297 |       │
│            Stockouts 0  | Waste 0        (each + sparkline)  │
├───────────────────────────────────────┬──────────────────────┤
│  SVG network  (~70% width)            │ Tabs (~30%, min      │
│  viewBox 0 0 900 520                  │  320px):             │
│  F(90,260) → W1(400,150) → R1(760,60) │ [Shocks][Responses]  │
│                          → R2(760,180)│ [Scenarios][Metrics] │
│            → W2(400,370) → R3(760,320)│                      │
│                          → R4(760,440)│ scrollable content   │
└───────────────────────────────────────┴──────────────────────┘
```

- Left-to-right flow. Reroute edges (e.g., W2→R1) drawn only while active, dashed.
- Responsive: CSS grid; below 900px the tab panel stacks under the diagram; SVG scales via viewBox.
- Header: Play/Pause, **Step (advance exactly one day — essential for teaching)**, Reset, Speed select (2 / 1 / 0.5 / 0.25 s per day, default 1 s).
- **Shocks tab**: global demand slider 0.2–3.0; four per-store demand sliders; factory capMult 0–1; W1/W2 capMult 0–1; W1/W2 outage toggles; delay F→WH +0..4d; delay WH→R +0..4d; Clear-all-shocks button.
- **Responses tab**: production 0–60 (track shows a red "effective capacity" marker; slider visually clamps to it when disrupted); F→WH freq 1–4d; WH→R freq 1–3d; split-to-W1 0–100%; four store→warehouse toggles; Buy +20 capacity buttons per WH with running count and $500 label; overflow policy radio group. Constraint feedback is visual: disabled regions, cap markers, and a note "limited by disruption" rather than silently ignoring input.
- **Tooltips**: one reusable positioned `<div id="tooltip">`; every slider, button, metric card, and SVG node carries `data-tip="..."`; delegated `mouseover/focusin` (keyboard accessible) + tap-toggles on touch. All copy in one `TIPS` object.

## 4. SVG Animation Approach

Single `requestAnimationFrame` loop drives both sim cadence and rendering, decoupled by an accumulator:

```js
function frame(now) {
  const dt = now - last; last = now;
  if (running) { acc += dt; while (acc >= tickPeriodMs) { tick(state); acc -= tickPeriodMs; } }
  const alpha = running ? Math.min(acc / tickPeriodMs, 1) : 1;   // interpolation factor
  render(alpha);
  requestAnimationFrame(frame);
}
```

- After each `tick()`, copy display quantities into `{prev, curr}` pairs (WH fill, store fill, factory buffer, edge rates); `render(alpha)` lerps them → fills glide smoothly even at 2 s/day.
- **Flow lines**: each edge is a `<path>` with `stroke-dasharray: 3 9`; in `render`, `dashOffset -= flowRate × k × dt` via `setAttribute('stroke-dashoffset', ...)` — updating offset in rAF (not CSS animations) avoids restart jank on speed changes. Thickness per §1.7. On batch departure, spawn a one-shot pulse dot animated along the path via precomputed `getTotalLength()` + `getPointAtLength()` (lengths cached at startup).
- **Fill levels**: clipped `<rect>` inside each warehouse/retail node; set `height`/`y` from lerped fraction. Color = node state class; state classes are plain `class` swaps (`node--ok/--warn/--bad/--out`) so tests assert on class names, not pixels.
- Rendering discipline: cache all element refs at startup (no per-frame `querySelector`); DOM panels re-render only on tick or input, never per frame; only SVG attributes mutate per frame. 7 nodes, ~10 edges → trivially 60 fps.

## 5. PWA Bits

- **manifest.json**: `{ "name": "Supply Chain Digital Twin", "short_name": "SC Twin", "start_url": "./index.html", "scope": "./", "display": "standalone", "background_color": "#f8fafc", "theme_color": "#0f172a", "icons": [{ "src": "icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" }] }`. Hand-written `icon.svg` (simple factory/boxes glyph); SVG manifest icons work in Chromium — fine for classroom.
- **sw.js**: cache-first. `CACHE = 'scdt-v1'`; `install` → `cache.addAll(['./', './index.html', './manifest.json', './icon.svg'])` + `skipWaiting()`; `activate` → delete old caches + `clients.claim()`; `fetch` → `caches.match(req).then(hit => hit || fetch(req))`.
- Registration guard: `if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost','127.0.0.1'].includes(location.hostname))) navigator.serviceWorker.register('./sw.js')`. On `file://` it silently no-ops and **the app still fully works by double-clicking index.html**.
- Run locally: `py -m http.server 8000` in the project directory → http://localhost:8000 for PWA/offline features.

## 6. File Structure & Code Organization

`index.html` estimated ~2,400–2,800 lines / ~100–120 KB, banner-commented sections:

1. Head: meta viewport, title, manifest link, theme-color.
2. `<style>` (~450 lines): CSS variables → layout grid → header/KPI cards → tabs → sliders/toggles → SVG node/edge classes → tooltip → responsive breakpoints.
3. Body (~150 lines): header controls, KPI strip, main grid with inline `<svg>` skeleton (node groups + edge paths with ids), four empty tab panels (controls injected by JS).
4. `<script>` (~1,800 lines), in order:
   - `DEFAULTS` (every number from §1.7, `Object.freeze`d) and `TIPS` (all tooltip copy)
   - `mulberry32(seed)`
   - `makeInitialState()` — incl. pipeline pre-seed (§1.4)
   - **`tick(state)`** — steps 1–9, with helpers `computeDemand`, `placeRetailOrders`, `allocateProportional`, `applyOverflow(wh, units)`, `accrueCosts`, `updateNodeStates`, `pushHistory`, `logEvent`
   - `SCENARIOS = [...7 objects]`, `applyScenario(s)`, `clearShocks()`
   - `CONTROLS` spec array + `buildControls()` (generates sliders/toggles with tooltips uniformly; single delegated `input` handler writes into `state.shocks/responses` with clamping)
   - Rendering: `initSvgRefs()`, `renderNetwork(alpha)`, `renderKPIs()`, `renderMetricsTab()`, `renderScenarioBanner()`, sparkline helper
   - rAF loop (§4), Play/Pause/Step/Reset/Speed wiring, tab switching, tooltip engine
   - Dev/test hook: `window.__sim = { get state(){...}, tick, runDays(n), reset, applyScenario, snapshot() }` (snapshot = deterministic JSON of state minus rng internals plus rng call count)
   - Service worker registration guard
5. `sw.js` ~30 lines; `manifest.json` ~15; `icon.svg` ~15.

**Implementation sequence**: (1) HTML/CSS skeleton + tabs; (2) sim core + `__sim` hook, console-verify 300-day baseline before any graphics; (3) scenarios; (4) static SVG render + node states; (5) rAF animation/interpolation; (6) controls + constraint UX; (7) KPIs/sparklines/Metrics tab; (8) tooltips; (9) PWA files; (10) verification pass.

## 7. Verification Plan

Use Playwright against `py -m http.server 8000`, driving the sim synchronously via `page.evaluate(() => __sim.runDays(n))` — no waiting on wall-clock ticks.

1. **Baseline stability**: fresh load → `runDays(300)` → assert `stockoutEvents === 0`, `wastedUnits === 0`, service level 100%, every WH util sample in [25%, 70%], cost/day in [$75, $95], every store onHand > 5.
2. **Determinism / exact reset**: `runDays(50)` → `snap1 = snapshot()` → `reset()` → `runDays(50)` → `snapshot() === snap1` (string equality). Reset also restores every slider to `DEFAULTS`.
3. **Each scenario's failure signature**: for each of the 7 — `reset(); runDays(30); applyScenario(i); runDays(40)`, assert: S1 unmet > 0 and service < 95%; S2 max WH util ≥ 95% or overflowQueue > 0 by +15 days; S3 production === 18 ± 0.01 and stockoutEvents > 0 by +40; S4 R1&R2 stockout by +5 while R3/R4 healthy; S5 W1 overflow > 0 and R1/R2 service dips; S6 stockoutEvents > 0 with factory production still 40; S7 (policy=waste variant) wastedUnits > 0 by +10. Also assert the correct SVG node carries `node--bad`/`node--out`.
4. **Each response measurably mitigates**: scripted pairs — S4 → split 0 + reroute R1/R2 → `runDays(25)` → rolling service ≥ 98% and reroute cost bucket > 0; S1 → production 60 → service ≥ 97%; S6 → freq 1 → no new stockouts over 20 days; S2 → production 16 → WH util < 70%. Rerouting pitfall test: reroute R1→W2 during baseline, `runDays(5)`, assert W2 inv decreases on R1's ship days and W1 stops supplying R1 (inspect shipment origins).
5. **Guard rails**: `warehouses[0].capMult = 0` + outage → no NaN/Infinity anywhere in rendered text; production slider with `capMult=0` yields produced 0.
6. **UI smoke**: tabs switch; every `data-tip` element shows tooltip; speed select changes day-advance rate; pause freezes day counter; Step advances exactly 1. Screenshot at 1280×720 for projector legibility.
7. **PWA**: over localhost, `navigator.serviceWorker.controller` present after reload; stop server, reload → page still renders. Separately confirm full functionality via `file://` without SW.
