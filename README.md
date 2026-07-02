# Supply Chain Digital Twin (SCDT)

An interactive, offline-capable PWA for classroom use in an emerging-technologies-in-supply-chain course. Students explore what-if scenarios on a small supply chain — 1 Factory → 2 Warehouses → 4 Retail stores — by triggering **shocks** (demand spikes/drops, disruptions, delays) and applying **response** decisions (production rate, delivery frequencies, split fractions, rerouting, capacity purchases), watching flows, inventories, stockouts, waste, and costs react in real time on an animated network diagram.

**Status: implemented.** See [plan.md](plan.md) for the full design (simulation model, defaults, scenarios, UI layout, animation approach, PWA setup, verification plan).

## Files

| File | Purpose |
|---|---|
| `index.html` | The entire app — embedded CSS/JS, SVG network diagram, simulation engine |
| `sw.js` | Cache-first service worker for offline use |
| `manifest.json` | PWA manifest |
| `icon.svg` | App icon |
| `tests/engine.test.js` | Headless simulation-engine verification (Node, no dependencies) |
| `tests/browser.test.js` | Full in-browser verification (Playwright) |

No build step, no external dependencies.

## Running locally

```
py -m http.server 8000
```

(or `python3 -m http.server 8000`), then open http://localhost:8000. The app also works by double-clicking `index.html` (PWA/offline features just won't activate over `file://`).

## Using it in class

- **One tick = one simulated day.** Use ▶/⏸, **Step** (advance exactly one day), **Reset** (deterministic — reproduces the same baseline run every time), and the speed selector.
- The **Scenarios** tab has 7 presets (demand spike, demand drop, factory capacity cut, warehouse outage, warehouse capacity crunch, delivery frequency too low, overproduction). Triggering one applies it on top of the running sim and shows a banner with hints.
- The **Shocks** tab lets you compose your own disruptions; the **Responses** tab holds the mitigation levers; the **Metrics** tab breaks down cost buckets, delays, and the event log.
- **Clear shocks** removes all shocks without touching inventories — unlike Reset.
- Every control, KPI, and diagram node has a hover/focus tooltip explaining what it does.

## Verification

Headless engine tests (baseline stability over 300 days, exact-reset determinism, all 7 scenario failure signatures, mitigation effectiveness, NaN guard rails):

```
node tests/engine.test.js
```

Browser tests (UI smoke, node state classes, reroute edges, tooltips, service worker/offline, screenshots — requires `npm i playwright` and a served app on :8000):

```
python3 -m http.server 8000 &
node tests/browser.test.js
```

Set `CHROMIUM_PATH` to point the browser test at a pre-installed Chromium if Playwright's own download isn't available.

## Dev console hook

The sim is scriptable from DevTools via `window.__sim`:

```js
__sim.runDays(300); __sim.metrics();      // fast-forward and inspect
__sim.applyScenario(4);                   // trigger scenario by id
__sim.snapshot();                          // deterministic state snapshot
__sim.reset();
```
