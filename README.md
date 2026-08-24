# K2 — 3D Excavation & Clash Visualization POC

Proof-of-concept for Kwinana Power Plant K2: import an IFC design, reference
a drone-derived terrain surface, and (eventually) generate a 1:1-battered
excavation cut down to the underside of the design with underground
services shown in 3D for clash assessment.

**Separate, standalone repo** — not merged with or forked from the CSBP
underground-services repo (`CSBP-UG-Services`). Different client, site,
and data. That repo is referenced only for UI/workflow patterns (layer
control structure, KML upload flow).

Status: **Phase A working end-to-end against real K2 data** (GT11
foundation IFC, loads + georeferences correctly — verified, see below).
Early **Phase B** started opportunistically: a real 12d services export
parses and renders as 3D pipe geometry with justify-corrected depth.
Terrain is still a flat reference plane (no drone flight exists yet for
K2 — see "Terrain" below). See "Open items" at the bottom for what's
still needed.

## Quick start

```bash
npm install
npm run dev
```

Opens a Three.js scene with:
- a flat reference plane (no real terrain yet — see below),
- an `.ifc` file picker — loads and georeferences a design against
  GDA2020/MGA50 if the file has an `IFCMAPCONVERSION` entity,
- a `.12da`/`.12daz` file picker — loads a 12d Model services export as
  3D pipe/conduit geometry with real surveyed depth.

Real K2 sample files (gitignored, not in this repo — see "Data" below)
live in `data-private/ifc/` and `data-private/12d/`.

## Architecture

- **Three.js** — the 3D scene (terrain, IFC design, services, eventually
  the excavation cut). Chosen over extending Mapbox GL JS's own terrain
  support because the excavation-cut geometry (CSG/battering) and IFC
  rendering are much more naturally a custom Three.js scene than
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

**Async gotcha found while testing (see `src/ifc.js` for full detail):**
`ifcLoader.load()`'s own promise resolves before the model is added to
the scene, and the `onItemSet` event that adds it fires before the
mesh's geometry is actually populated. `loadIfcFile()` now waits out both
gaps (event + a geometry poll) before returning — found by loading the
real GT11 file and seeing a bounding-box check come back zero-size until
this was fixed. Any future caller measuring/positioning a loaded model
must go through `loadIfcFile()`, not call `ifcLoader.load()` directly.

### CRS handling (`src/crs.js`)

GDA2020/MGA Zone 50 (EPSG:7850) — **confirmed by Cameron 2026-08-24**
against K2 survey control, no longer provisional. The proj4 string was
verified against epsg.io/7850, not guessed:
```
+proj=utm +zone=50 +south +ellps=GRS80 +units=m +no_defs +type=crs
```
`roundTripCheck()` remains available as a cheap sanity check for any new
control point. `mgaToScene()`/`sceneToMga()` are the single canonical
MGA50/AHD ↔ scene-local-metres conversion, used by every module that
places geometry (terrain, IFC, services) — see the convention comment in
`crs.js` for the axis mapping (scene X=east, Y=up, Z=south).

### IFC georeferencing — implemented and verified

`src/ifc.js`'s `extractGeoreference()` parses `IFCMAPCONVERSION` (+
`IFCPROJECTEDCRS` name) out of raw IFC STEP text via a targeted regex —
proportionate for a POC given these entities have a flat, predictable
argument list; not a full STEP parser. Validated against a real file:

**`GT11_Foundation_Reference_Model.ifc`** (Kwinana K2, GT11 gas turbine
foundation — Cameron confirmed K2 IFC files will be authored in
GDA2020/MGA50) carries a genuine `IFCMAPCONVERSION`: E 384899.031,
N 6434081.091, RL(AHD) 5.55, no rotation, scale 1. This is now used
directly as the scene origin (`SCENE_ORIGIN_MGA` in `main.js`) so
everything loaded sits at small, readable coordinates near (0,0,0).

`computeIfcPlacement()` turns that into a position + Y-rotation for
`model.object`, on the assumption that the Fragments loader applies the
conventional IFC Z-up → Three.js Y-up axis swap. **This was empirically
verified**, not just assumed: loaded the real file, read the resulting
mesh's bounding box straight out of the live scene graph, and got
21.37 × 4.04 × 7.50 m — X and Z match the IFC's own
`Pset_GT11_MainFoundation.OverallLength`/`OverallWidth` (21.37 / 7.5)
exactly. Re-verify the same way if `@thatopen/components` gets a major
version bump (see comment block above `computeIfcPlacement()`).

The dev UI logs this bounding box on every IFC load specifically so this
check stays easy to repeat by eye.

### 12d services import (`src/twelve-d.js`, `src/services.js`) — Phase B, started early

Cameron supplied a real sample: `Sample 12d Pipe.12daz`, a K2 Power
Station Services export (12d Model 15.0C1v). Worth documenting what was
actually in it, since it changes the Phase B plan from what the brief
assumed:

- **File format**: `.12daz` is a plain ZIP (confirmed by its `PK` magic
  bytes) wrapping one `.12da` entry. The `.12da` itself is **UTF-16
  text**, not UTF-8/ASCII — reading it naively produces garbled output
  (every character interleaved with a null byte). `twelve-d.js` handles
  both: a small hand-rolled ZIP reader (stored/deflate only, via the
  browser's native `DecompressionStream`) for `.12daz`, then
  `TextDecoder("utf-16le")` either way.
- **Depth model is richer than assumed, in a good way**: the brief
  expected to need upstream/downstream invert levels plus a
  diameter/grade to reconstruct 3D pipe geometry. This sample instead
  gives **real per-vertex 3D coordinates** (`data_3d { E N Z ... }`) —
  actual surveyed elevation at every chainage point, not just two end
  inverts — plus a `pipe_value { diameter }` attribute. That's *more*
  accurate than the assumed model, not a fallback case of it, and is
  simpler to extrude (no grade interpolation needed, the Z values already
  encode it).
- **`justify` matters and is easy to get wrong**: the sample uses
  `justify top`, meaning the given Z is the TOP of the pipe/conduit, not
  its centreline or invert. `parse12da()` applies the correct
  ± diameter/2 correction per `justify` value before building geometry —
  get this backwards and every service ends up rendered half a diameter
  too shallow or deep. No real invert level was available in this sample
  to cross-check the correction against; flag this to Cameron before
  trusting absolute depths for anything beyond this POC.
- **Validated end-to-end**: parsed the real file (2 "power ug lv line"
  strings, diameter 0.15 m), converted to scene coordinates via the same
  `mgaToScene()` used everywhere else, and confirmed the output lands a
  sane ~18 m from the GT11 IFC's own origin at a plausible depth
  (0.67 m above the site AHD datum) — consistent with a shallow LV
  cable near the foundation.
- **Not yet implemented**: the brief's flat/assumed-depth *fallback* path
  (for DBYD-sourced GeoJSON with no invert data) — only the
  real-depth-from-12d path exists so far. `services.js` tags every mesh
  `depthAccuracy: "surveyed"` and uses a distinct colour, ready for a
  future `"assumed"` styling to sit alongside it, per the brief's request
  that the two be visually distinguishable.
- **Scope caveat**: this module only implements what the one sample
  needed (name/style/colour/closed/justify/diameter/data_3d). If a real
  K2 export has richer pipe attributes (material, node IL, grade) not
  seen here, the generic block parser should already capture them as
  plain key/value data — extend the mapping in `parse12da()`, not the
  tokenizer.
- **Fallback plan from Cameron**: if a fuller 12d pipe-network export
  (nodes/pits, upstream-downstream structure) proves too awkward to
  parse, he'll convert affected services to a trimesh and export as IFC
  instead — i.e. reuse the IFC path already working above rather than
  extending the 12d parser further. Worth keeping in mind before
  over-investing in 12d parser generality.

### Terrain (`src/terrain.js`) — no real source yet, Mapbox planned as default

Cameron confirmed (2026-08-24): **no drone flight exists yet for K2**,
so Mapbox imagery is meant to be the default fallback, not a one-off
placeholder. Concretely, the plan is Mapbox's public Terrain-RGB DEM
tileset (real, if coarse, global elevation) draped with Mapbox satellite
imagery, via the same Mapbox account/token already used for the CSBP
viewer. **Not wired up yet** — needs Cameron's actual Mapbox token
handed over explicitly (not something to guess or borrow from another
repo). Until then, `getCurrentTerrain()` returns a flat wireframe
reference plane at the site's own AHD datum height — deliberately not a
fake bumpy surface, since with real IFC/services geometry now in the
same scene, a synthetic undulation risks being mistaken for real ground
shape. The function signature/swap-point design is unchanged from the
original plan: Mapbox Terrain-RGB → (later) a real drone DSM/DTM → 
(eventually) the WebODM-based delivery platform, each swapped in without
the rest of the scene changing.

## Suggested Build Phases (from project brief)

- **Phase A — Foundations**: ✅ Three.js scene up; ✅ real IFC file loads,
  renders, and georeferences correctly against MGA50 (verified via
  bounding-box check); ❌ real DEM (blocked on drone flight — Mapbox
  Terrain-RGB fallback planned but needs a token).
- **Phase B — Services in 3D**: ✅ real 12d pipe export parses and
  extrudes into 3D geometry with justify-corrected surveyed depth; ❌
  flat/assumed-depth fallback path for non-12d sources not implemented;
  ❌ richer 12d pipe-network (node/IL) structure untested beyond this
  one simple sample.
- **Phase C — The Cut**: not started. 1:1 battered excavation cut, CSG
  against terrain.
- **Phase D — Clash Flagging**: not started.
- **Phase E — Polish/Integration**: not started.

## Data

- `/data-sample/` (tracked in git) — synthetic/placeholder files only.
  Currently empty; nothing synthetic has been needed since real sample
  data arrived quickly.
- `/data-private/` (gitignored, see `.gitignore`) — real K2 survey/design
  data. Currently holds:
  - `ifc/GT11_Foundation_Reference_Model.ifc` — GT11 foundation reference
    geometry (marked in its own metadata as AI-generated from supplied
    drawings, "reference only," not for construction/fabrication —
    treat as a stand-in for a real design export, not the real thing).
  - `12d/Sample 12d Pipe.12daz` (+ `12d/extracted/` — unzipped for
    inspection) — real K2 Power Station Services export.
  Never commit real client data to this repo's git history, even
  privately — treat it the same as the "never store or log client data
  outside the local stack" rule from the wider platform work.

## Open items — need Cameron

1. **Repo destination** — currently local-only at
   `C:\Users\camer\K2-Power-Station-3D`, not pushed anywhere, per
   Cameron's instruction to push everything at once later.
2. **Mapbox access token** — needed to wire up the Terrain-RGB +
   satellite default terrain fallback (see "Terrain" above).
3. **A real drone DSM/DTM**, whenever a K2 flight happens — will replace
   the Mapbox Terrain-RGB fallback per the swap-point design.
4. **Cross-check on the 12d `justify top` depth correction** — no known
   invert level was available to validate the ± diameter/2 offset
   against; worth a sanity check against a drawing or as-built if one's
   handy, before trusting absolute depths beyond this POC.
5. **A richer 12d pipe-network export** (with node/pit structure, IL,
   grade), if/when convenient — to test the parser against something
   less simple than the one two-string LV cable sample. Not urgent per
   Cameron's stated fallback (convert to trimesh → IFC if 12d parsing
   gets too involved).
6. Whether the existing K2 drawing-review work (IFC-status setout
   coordinate drawings, mentioned in the brief) has anything else
   reusable here.
