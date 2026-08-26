# K2 — Site Platform (2D map + 3D excavation/clash POC)

Kwinana Power Plant K2 platform, aimed at Cameron's stated goal
(2026-08-24) of a **Civil3D/Propeller-hybrid**: a drone-delivery-style 2D
map as the primary shell (à la Propeller Aero), with a 3D view toggled in
for the things 2D can't show — excavation cuts, clash assessment against
underground services, design-vs-terrain review (closer to what Civil3D
gives you for earthworks). The 3D excavation/clash tool was the original
brief; the 2D shell was added around it once real data started surfacing
things (like plant-grid vs survey-grid confusion, see "CRS handling"
below) that are much easier to sanity-check on a map first.

**Separate, standalone repo** — not merged with or forked from the CSBP
underground-services repo (`CSBP-UG-Services`). Different client, site,
and data. That repo is referenced only for UI/workflow patterns (layer
control structure, KML upload flow) and is the direct visual/UX
inspiration for the 2D shell here.

Status: **2D map working end-to-end** (real IFC base point + real 12d
services both plot correctly on real Mapbox imagery — verified). **3D
scene has a known rendering issue** — see "Known issues" — currently
lower priority since 2D is now the primary shell, but not forgotten.
Underlying data/logic (CRS, IFC georeferencing, 12d parsing, Mapbox
terrain) is shared by both views and is solid — see the phase-by-phase
detail further down.

## Quick start

```bash
npm install
npm run dev
```

Requires a `.env.local` with `VITE_MAPBOX_TOKEN=pk.…` (Cameron's Mapbox
public token, supplied 2026-08-24 — gitignored, ask him if you don't
have it) — needed by both pages (the 2D base map, and the 3D scene's
terrain).

- **`index.html`** (default) — 2D Mapbox map with a real sidebar (fixed
  300px panel, not an overlay), CSBP-style: an "Add Data" section (file
  pickers for `.ifc` and `.12da`/`.12daz`) and a "Layers" section with
  collapsible, checkbox-driven groups — **Base Map** (satellite/streets),
  **Design** (the loaded IFC's base point AND a real bounding-box
  footprint outline — see "IFC 2D footprint" below), **Underground
  Services** (one row per distinct 12d `style` value seen so far, e.g.
  `POWER_LV`).
  Unchecking a group actually hides everything in it (not just greys out
  its rows) — see `src/layer-tree.js`. "3D View →" button top-right of
  the sidebar header. A floating toolbar on the map itself (top-left)
  provides **Distance**/**Area** measurement and a **Section** (cross-
  section/profile) tool — see "Measurement & section tools" below.
- **`3d.html`** — the original Three.js excavation/clash scene: real
  Mapbox terrain, IFC design loading + georeferencing, 12d services
  extruded into 3D pipes, a test surface above them. "← 2D Map" link
  back. See "Known issues" before relying on this rendering visibly.

Real K2 sample files (gitignored, not in this repo — see "Data" below)
live in `data-private/ifc/` and `data-private/12d/`.

## Known issues

**3D scene (`3d.html`) is slow to load and may appear blank** —
confirmed directly by Cameron (2026-08-24) in his own browser, not just
in my own test environment (a separate, inconclusive finding from
earlier the same day — my sandboxed test browser turned out to fully
suspend rendering/networking while not displayed, which had been
muddying this; see git history on this section for that dead end).
**Deprioritised at Cameron's direction** — 2D is the primary shell for
now, this can wait. Not yet root-caused; worth revisiting with real
devtools access (console errors, canvas presence/size, WebGL context
status) when it's back in scope, rather than more remote guessing.

## Architecture

- **Mapbox GL JS** — the 2D shell (`index.html`/`main-2d.js`), same
  library/pattern as CSBP, fresh code for K2.
- **Three.js** — the 3D scene (`3d.html`/`main.js`): terrain, IFC design,
  services, eventually the excavation cut. Chosen over extending Mapbox
  GL JS's own terrain support because the excavation-cut geometry
  (CSG/battering) and IFC rendering are much more naturally a custom
  Three.js scene than something bolted onto Mapbox's terrain pipeline.
- **`@thatopen/components`** for IFC loading — see deviation note below.
- **`proj4`** for GDA2020/MGA50 ↔ WGS84 transforms (`src/crs.js`), shared
  by both pages.
- **`vite`** — plain dev server/bundler, no framework. Kept intentionally
  boring (matches the "boring/mainstream dependencies only" preference
  from the wider Progressive Spatial platform work).
- Two static pages rather than an in-page SPA toggle, for now — simpler
  and more robust to build first; no shared *state* between them yet
  (loading a file on one page doesn't carry over to the other) — a nice
  follow-up once both views are solid, not core to proving this out.
- **`@mapbox/mapbox-gl-draw` + `@turf/turf`** for measurement and the
  section tool — the same combination CSBP already uses (per the brief)
  for its distance/area tools, reused rather than reinvented.

### Measurement & section tools (`src/draw-tools.js`, `src/elevation-profile.js`, `src/profile-chart.js`)

Per Cameron's request (2026-08-24), referencing Civillo's layout
(civillo.com) as the pattern to match — read as inspiration for the
*structure* (a floating map toolbar, a splittable profile pane), not a
pixel clone of their branding/icon set.

- **Distance / Area**: standard `mapbox-gl-draw` line/polygon drawing +
  `turf.length()`/`turf.area()`, geodesic (WGS84) — same caveat as CSBP:
  this is ground/great-circle distance, not MGA50 grid distance. Flag if
  Cameron needs grid-exact numbers later.
- **Section**: draw a line, and the view splits — a profile pane opens
  **side-by-side** with the map (not stacked top/bottom) showing an
  elevation-vs-distance chart along that line. **Guessed at the split
  orientation** since "tiles the screen vertically" is genuinely
  ambiguous in English (side-by-side columns vs. stacked rows both fit
  that phrase) — picked side-by-side to match how Civil3D pairs a plan
  view with a profile view, but this is a one-line CSS/layout change to
  flip if Cameron meant the other one.
- Elevation comes from the **same Mapbox Terrain-RGB source** as the 3D
  scene's terrain (`src/terrain-rgb.js`, factored out of
  `mapbox-terrain.js` so this doesn't need to pull in Three.js) — same
  "coarse global data, not survey-grade" caveat applies.
- **Not yet implemented**: intersecting the cut line with the loaded IFC
  design or 12d services — the profile currently shows terrain only.
  Natural next step once this is validated.
- One shared `mapbox-gl-draw` instance backs both tools (`draw-tools.js`)
  — it doesn't expect two independent instances managing the same map's
  drawing layer, so a single "current mode" dispatches `draw.create` to
  whichever tool is active.
- **Bug caught before committing, not cosmetic**: the toolbar/measure-
  result overlay elements were initially nested directly inside `#map` —
  Mapbox's own container div, which it manages internally and explicitly
  warns should stay empty ("the map container element should be empty,
  otherwise the map's interactivity will be negatively impacted"). Fixed
  with a `#map-wrapper` sibling layout; verified via DOM inspection that
  `#map`'s only children are now Mapbox's own internal elements.

### IFC 2D footprint (`index.html` `#ifc-offscreen`, `ifc.js computeFootprintCornersScene()`)

Originally the 2D page only ever plotted the IFC's project base point —
a single dot, not its actual extent (Cameron asked "is there any reason
the IFC model isn't showing up" — this was why). Fixed by loading the
IFC's real geometry on the 2D page too, via the same
`@thatopen/components` pipeline the 3D page uses, run headlessly into a
1x1 offscreen div (`#ifc-offscreen`) — we only need the geometry to
measure a bounding box, never to display it, so nothing is actually
rendered there. The result is an axis-aligned bounding-box outline
(filled + outlined polygon), not a true footprint polygon — exact for a
rectangular, unrotated design like GT11 (verified: computed footprint
at the correct location with dimensions matching GT11's known
21.37 × 7.5 m almost exactly), looser for anything rotated or
non-rectangular. Worth upgrading to a real convex hull/plan profile if
that gap matters in practice.

**Two real bugs found and fixed while building this** (not theoretical —
both reproduced, one confirmed fixed, one not yet re-confirmed, see below):

1. **Large-world-coordinate float32 precision loss.** First attempt
   positioned the Three.js model directly at its raw MGA coordinates
   (~384899, ~6434081) on the theory that doing so would make "scene"
   coordinates just equal true MGA. Wrong in practice — a translation
   that large blows past float32 precision for the ~10m-scale local
   geometry sitting on top of it. Caught by checking the actual output:
   came back near Antarctica instead of Kwinana. Fixed by using the
   georef's own offset as a small local origin (mirroring `main.js`'s
   `SCENE_ORIGIN_MGA` pattern, which already did this correctly) and
   only converting back to real MGA at the very end. **Confirmed fixed**
   — re-checked the actual output coordinates after the fix.
2. **`loadIfcFile()`'s `modelId` always defaulted to the fixed string
   `"design"`.** Loading a second IFC file in the same page session
   (which happened while testing #1's fix) reused that id without
   disposing the first model, corrupting the FragmentsManager/scene
   graph — surfaced as a generic-looking `RangeError: Maximum call stack
   size exceeded` inside `Box3.setFromObject`'s recursive traversal, not
   an obviously-IFC-related error. Fixed: `modelId` now defaults to a
   fresh id per call. **NOT yet re-confirmed live** — hit the render-loop
   -suspension environment limitation (see "Known issues") right as I
   went to retest it. The fix is sound by inspection (JS default
   parameters re-evaluate per call, so uniqueness is guaranteed), but
   **needs Cameron to confirm**: load two different IFC files (or the
   same one twice) in one page session and check neither the console nor
   the map breaks.

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

**Not every IFC file's `IfcMapConversion` is real MGA50** — found while
testing (2026-08-24): a different, larger K2 IFC file
(`K2_FW_Combined_ISO_Reference_Model.ifc`) has an `IFCMAPCONVERSION`
whose target `IfcProjectedCRS` is named **"K2 Plant Grid"**, with
easting/northing offset `(0, 0)` — a project-local plant grid, not a
real survey coordinate system, unlike GT11's genuine GDA2020/MGA50.
`extractGeoreference()` (`src/ifc.js`) now checks the CRS name via
`looksLikeGda2020Mga50()` and sets `isKnownMga50: false` when it doesn't
recognise it; `computeIfcPlacement()` (3D) throws rather than placing
the model, and the 2D page refuses to plot it, rather than either one
silently treating a plant-grid offset as if it were a real MGA50
coordinate (which would place the design at MGA50 (0,0) — nowhere near
WA). **Needs Cameron**: does "K2 Plant Grid" have a known transform to
GDA2020/MGA50 (a Helmert transform tied to real survey control, which is
the usual way plant grids get related back to real coordinates)? Without
that, any file using this CRS can't be placed on either the 2D map or in
the 3D scene.

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

### Terrain (`src/terrain.js`, `src/mapbox-terrain.js`) — Mapbox live, real drone DSM still pending

Cameron confirmed (2026-08-24): **no drone flight exists yet for K2**,
so Mapbox imagery is the default fallback, not a one-off placeholder —
and supplied his Mapbox public token the same day, so this is now wired
up and working, not just planned.

**Implementation** (`mapbox-terrain.js`): fetches Mapbox Terrain-RGB (DEM)
and Satellite tiles covering a 200m square around the scene origin,
decodes elevation per pixel (`height = -10000 + (R·65536 + G·256 + B) × 0.1`),
builds a heightfield mesh from it, and textures it with the stitched
satellite imagery. API details (tile URL template, `.pngraw` format for
undistorted elevation data, `mapbox.satellite`/`mapbox.terrain-rgb`
tileset ids) were checked against Mapbox's own docs before writing this,
not guessed. **One correction to the original plan**: Terrain-RGB's real
data only goes to zoom 15 ("data up to zoom 15... higher zoom levels
will not increase data resolution" — Mapbox's own docs), not 16 as
originally assumed; zoom is fixed at 15 rather than exposed as a
misleading "quality" knob.

**Verified working**, not just assumed: ran it against the real GT11
site coordinates and got a plausible elevation range (**3.2–16.4m AHD**
over the 200m test extent) — sane for coastal industrial Kwinana and
consistent with GT11's own RL 5.55 AHD datum. No pixel-level check has
been done on the satellite image alignment (UV mapping follows the same
per-vertex lon/lat → mercator-pixel calculation as the elevation
sampling, so it should be correct, but hasn't been eyeballed) — the
elevation values are the part that actually matters for excavation-cut
work later, and those are the part that's been checked.

`getCurrentTerrain()` tries Mapbox first if `VITE_MAPBOX_TOKEN` is set
(`.env.local`, gitignored — Mapbox `pk.*` tokens are public/client-
embeddable by design, not secret keys, but kept out of git history
anyway so it's easy to rotate). Falls back to a flat wireframe reference
plane at the site's own AHD datum height if the token is missing or the
fetch fails — deliberately not a fake bumpy surface, since a synthetic
undulation next to real IFC/services geometry risks being mistaken for
real ground shape.

**Reminder this is still coarse global data, not survey-grade**: every
status message and the mesh's own `userData.source` say so. Swap point
design is unchanged: Mapbox Terrain-RGB → (later) a real drone DSM/DTM →
(eventually) the WebODM-based delivery platform, each swapped in without
the rest of the scene changing.

**Test surface override**: per Cameron's request (2026-08-24), loading a
12d services file replaces whatever terrain is showing (Mapbox or
placeholder) with a flat plane ~0.9m above the average top-of-pipe
elevation (`terrain.js buildTestSurfaceAbovePipes()`) — a deliberately
crude stand-in "cover depth" surface for testing the future excavation-
cut view, not a real terrain source. Verified: real sample pipes average
~6.29m AHD → test surface built at RL 7.19 AHD.

## Suggested Build Phases (from project brief)

- **Phase A — Foundations**: ✅ Three.js scene up; ✅ real IFC file loads,
  renders, and georeferences correctly against MGA50 (verified via
  bounding-box check); ✅ real (if coarse) terrain via Mapbox Terrain-RGB,
  verified against plausible site elevation; ❌ real drone DSM (blocked
  on a K2 flight happening — Mapbox is the interim default).
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
2. **A real drone DSM/DTM**, whenever a K2 flight happens — will replace
   the Mapbox Terrain-RGB fallback per the swap-point design.
3. **Cross-check on the 12d `justify top` depth correction** — no known
   invert level was available to validate the ± diameter/2 offset
   against; worth a sanity check against a drawing or as-built if one's
   handy, before trusting absolute depths beyond this POC.
4. **A richer 12d pipe-network export** (with node/pit structure, IL,
   grade), if/when convenient — to test the parser against something
   less simple than the one two-string LV cable sample. Not urgent per
   Cameron's stated fallback (convert to trimesh → IFC if 12d parsing
   gets too involved).
5. Whether the existing K2 drawing-review work (IFC-status setout
   coordinate drawings, mentioned in the brief) has anything else
   reusable here.
6. **The 0.9m test cover-depth surface is explicitly a placeholder** —
   worth confirming with Cameron whether that's a reasonable assumption
   to keep using for further testing, or whether he'd rather it use a
   different default (or per-service-type default) once more services
   are loaded.
7. **"K2 Plant Grid" transform to GDA2020/MGA50** — see "CRS handling"
   above. Needed before `K2_FW_Combined_ISO_Reference_Model.ifc` (or
   any other plant-grid-authored file) can be placed on the map or in
   the 3D scene at all.
8. **3D scene blank-render issue** — see "Known issues." A screenshot or
   a devtools report from Cameron's own browser (console errors, canvas
   presence/size, WebGL context status) would help pin this down faster
   than further remote guessing.
