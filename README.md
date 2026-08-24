# K2 — 3D Excavation & Clash Visualization POC

Proof-of-concept for Kwinana Power Plant K2: import an IFC design, reference
a drone-derived terrain surface, and (eventually) generate a 1:1-battered
excavation cut down to the underside of the design with underground
services shown in 3D for clash assessment.

**Separate, standalone repo** — not merged with or forked from the CSBP
underground-services repo (`CSBP-UG-Services`). Different client, site,
and data. That repo is referenced only for UI/workflow patterns (layer
control structure, KML upload flow).

Status: **Phase A scaffold** (see "Suggested Build Phases" below). Not
functional against real K2 data yet — everything is placeholder/synthetic
pending real inputs from Cameron. See "Open items" at the bottom.

## Quick start

```bash
npm install
npm run dev
```

Opens a Three.js scene with a synthetic placeholder terrain surface and
an `.ifc` file picker. Loading a real IFC file will render it, but **it
is not yet georeferenced** — see `src/ifc.js`.

## Architecture

- **Three.js** — the 3D scene (terrain, IFC design, eventually services
  and the excavation cut). Chosen over extending Mapbox GL JS's own
  terrain support because the excavation-cut geometry (CSG/battering) and
  IFC rendering are much more naturally a custom Three.js scene than
  something bolted onto Mapbox's terrain pipeline. The existing 2D Mapbox
  map (pattern borrowed from CSBP) stays as a separate "overview" view —
  this 3D tool is deliberately its own page for now (`index.html`),
  matching the brief's "doesn't need to be merged into the 2D map yet."
- **`@thatopen/components`** for IFC loading — see deviation note below.
- **`proj4`** for GDA2020/MGA50 ↔ WGS84 transforms (`src/crs.js`).
- **`vite`** — plain dev server/bundler, no framework. Kept intentionally
  boring (matches the "boring/mainstream dependencies only" preference
  from the wider Progressive Spatial platform work).

### Deviation from brief: `web-ifc-three` → `@thatopen/components`

The brief suggested `web-ifc-three` for IFC loading. Checked its repo
before writing any code (per the "confirm APIs before implementing"
preference): **it's deprecated by its own maintainers** — the README
says "THIS LIBRARY IS DEPRECATED. USE COMPONENTS INSTEAD," last published
~2 years ago. The same org (ThatOpen, formerly IFC.js) maintains
`@thatopen/components` as the active successor, still built on the same
`web-ifc` WASM parser, so the original reasoning ("lighter weight, direct
Three.js integration, good since we're building a custom scene anyway")
still holds — it's just the current package name. `xeokit-sdk` was not
chosen, per the brief's own reasoning: it brings its own scene graph that
would fight a custom Three.js excavation scene.

One real consequence: `@thatopen/components`' `IfcLoader` converts IFC to
its own "Fragments" format rather than exposing raw Three.js meshes
directly. That's actually useful for the excavation-cut phase (Fragments
are the format their own sectioning/clipping tools operate on), but means
CSG operations against the design geometry (Phase C) will need to go
through `model.object` (a `THREE.Group`) rather than assuming a single
`THREE.Mesh` — flagging now so Phase C isn't surprised by it.

### CRS handling (`src/crs.js`)

GDA2020/MGA Zone 50 (EPSG:7850) is used as the working CRS —
**provisional**, based on Kwinana's longitude falling inside zone 50's
range, not yet confirmed against K2 survey control. Every function in
`crs.js` says so in its comments; `roundTripCheck()` is provided as a
cheap sanity check to run against any new control point before trusting
it. Treat this exactly like the CRS handling on the wider Progressive
Spatial platform: never silently assume, always label outputs, verify
empirically rather than trusting a single scraped source for parameters.

The proj4 string was verified against epsg.io/7850, not guessed:
```
+proj=utm +zone=50 +south +ellps=GRS80 +units=m +no_defs +type=crs
```

### Swappable terrain source (`src/terrain.js`)

Per the brief's medium-term goal, terrain loading is isolated behind a
single function, `getCurrentTerrain(siteId, originMga)`. Right now it
returns a synthetic undulating placeholder mesh and logs a loud warning.
When either a real DEM/DSM GeoTIFF or the WebODM-based delivery platform
(see separate Progressive Spatial platform project) becomes available,
only this function needs to change — the rest of the scene doesn't know
or care where the heightfield came from. This is the flagged "regularly
updated surface" swap point from the brief.

### IFC georeferencing — not yet implemented

`src/ifc.js` has a stubbed `extractGeoreference()` that throws rather
than guessing. IFC georeferencing (via `IfcMapConversion` / project base
point / true north) varies a lot between how different authoring tools
export it, and a silently-wrong transform is worse than a loud TODO here.
Needs a real K2 IFC file to implement against — see "Open items."

## Suggested Build Phases (from project brief)

- **Phase A — Foundations** *(this scaffold, partially done)*: Three.js
  scene up, placeholder terrain + IFC loader wired, CRS module in place.
  Not done: loading a *real* IFC file and confirming it renders
  correctly; georeferencing IFC against MGA50; loading a real DEM.
- **Phase B — Services in 3D**: depth attribute on service layers, 12d
  pipe network import path, extrude services into 3D.
- **Phase C — The Cut**: 1:1 battered excavation cut, CSG against
  terrain.
- **Phase D — Clash Flagging**: intersection test + visual flag.
- **Phase E — Polish/Integration**: tie back into the 2D Mapbox map.

## Data

- `/data-sample/` (tracked in git) — synthetic/placeholder files only.
- `/data-private/` (gitignored, see `.gitignore`) — real K2 survey/design
  data goes here once supplied. Never commit real client data to this
  repo's git history, even privately — treat it the same as the "never
  store or log client data outside the local stack" rule from the wider
  platform work.

## Open items — need Cameron

These are blocking real progress past the placeholder scaffold, listed
in the brief's own "Sample Data Needed" section:

1. **Repo destination** — currently local-only at
   `C:\Users\camer\K2-Power-Station-3D`, not pushed anywhere. Confirm
   name and whether/where it should be pushed (GitHub, private/public).
2. **A sample IFC file** for a real or representative K2 footing/foundation.
3. **A sample drone DEM/DSM** (GeoTIFF) for the relevant K2 area, or
   confirmation of what the existing K2 drawing-review work already
   produced that could be reused.
4. **MGA zone confirmation** — Zone 50 is a provisional assumption (see
   `src/crs.js`), not checked against K2 survey control.
5. **IFC project base point survey coordinate**, if known — needed to
   georeference the design even if the IFC file itself has no
   `IfcMapConversion` data.
6. **A sample 12d pipe network export** (12da string file, LandXML, or a
   12dPL-macro-driven CSV) for at least one service with real invert
   levels, to validate the Phase B depth-import path.
7. Whether the existing K2 drawing-review work (IFC-status setout
   coordinate drawings, mentioned in the brief) has anything reusable
   here before treating this as a blank slate.
