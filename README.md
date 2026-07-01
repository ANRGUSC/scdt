# Supply Chain Digital Twin (SCDT)

An interactive, offline-capable PWA for classroom use in an emerging-technologies-in-supply-chain course. Students explore what-if scenarios on a small supply chain — 1 Factory → 2 Warehouses → 4 Retail stores — by triggering **shocks** (demand spikes/drops, disruptions, delays) and applying **response** decisions (production rate, delivery frequencies, split fractions, rerouting, capacity purchases), watching flows, inventories, stockouts, waste, and costs react in real time on an animated network diagram.

**Status: planning.** See [plan.md](plan.md) for the full implementation design (simulation model, defaults, scenarios, UI layout, animation approach, PWA setup, verification plan). Implementation has not started yet.

## Planned files

| File | Purpose |
|---|---|
| `index.html` | The entire app — embedded CSS/JS, SVG network diagram, simulation engine |
| `sw.js` | Cache-first service worker for offline use |
| `manifest.json` | PWA manifest |
| `icon.svg` | App icon |

No build step, no external dependencies.

## Running locally (once implemented)

```
py -m http.server 8000
```

Then open http://localhost:8000. The app also works by double-clicking `index.html` (PWA/offline features just won't activate over `file://`).
