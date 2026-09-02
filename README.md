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

Status: **2D map working end-to-end**, now validated against real,
much larger data (2026-08-26): a real 800-record weekly 12d services
export, and a real IFC design with a georeferencing pattern not seen
before (no `IFCMAPCONVERSION` at all — see "IFC 2D footprint"). **3D
scene has a known rendering issue** — see "Known issues" — currently
lower priority since 2D is now the primary shell, but not forgotten.
Underlying data/logic (CRS, IFC georeferencing, 12d parsing) is shared by
both views and is solid — see the phase-by-phase detail further down.
(Mapbox Terrain-RGB elevation, previously also in this list, was removed
2026-08-26 as not relevant enough to keep — see "Terrain.")

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
  Services** (a real nested tree matching 12d `model` paths, e.g.
  Power → High Voltage / Low Voltage — see "Nested model tree" below).
  Unchecking a group actually hides everything in it (not just greys out
  its rows) — see `src/layer-tree.js`. "3D View →" button top-right of
  the sidebar header. A floating toolbar on the map itself (top-left)
  provides **Distance**/**Area** measurement and a **Section** (cross-
  section/profile) tool — see "Measurement & section tools" below.
- **`3d.html`** — the original Three.js excavation/clash scene: a flat
  satellite-imagery ground plane (no elevation data — see "Terrain"),
  IFC design loading + georeferencing, 12d services extruded into 3D
  pipes, a test surface above them. "← 2D Map" link back. See "Known
  issues" before relying on this rendering visibly.

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

### Nested model tree (`src/model-tree.js`, `src/layer-tree.js` `addSubgroup()`)

Per Cameron's request (2026-08-26): a real nested tree for Underground
Services, not the flat "last two path segments" list from before.
`model-tree.js` compacts real 12d `model` paths (path-like strings,
e.g. `04 K2 Power Station/Services/Loc/Power/High Voltage`) into a tree
the way a file explorer does — single-child chains collapse into one
node, so the long shared prefix most models in one export share doesn't
turn into several pointless nested folders before reaching anything
that actually branches. `layer-tree.js` groups can now nest to
arbitrary depth (`addSubgroup()`), with checkbox toggles cascading
through every descendant (not just direct children) — unchecking
"Power" hides both voltage levels beneath it; each leaf still remembers
its own checked state independently, so re-checking a parent restores
whatever a child was individually set to rather than force-enabling it.

Verified against the real 800-record file: renders as one branch
"04 K2 Power Station/Services/Loc" (Sewer, Communications, Drainage,
Earthing, Fuel Line, Gas, Unknown, a "Power" sub-branch with High/Low
Voltage, Water) plus one standalone leaf for the odd
"Services/260812 CG PU Earthing Points" survey model — and cascading
actually empties/restores the Mapbox filter correctly at both the
sub-branch and whole-tree level, not just visually.

The tree rebuilds from scratch whenever a genuinely new `model` path
shows up, rather than patching an existing tree in place — simpler and
correct, at the cost of resetting any checkboxes the user had unticked.
Acceptable for now since this only fires once or twice a session in
practice (one services file load, maybe a second with new models).

### Measurement & section tools (`src/draw-tools.js`, `src/section-intersect.js`, `src/profile-chart.js`)

Per Cameron's request (2026-08-24), referencing Civillo's layout
(civillo.com) as the pattern to match — read as inspiration for the
*structure* (a floating map toolbar, a splittable profile pane), not a
pixel clone of their branding/icon set.

- **Distance / Area**: standard `mapbox-gl-draw` line/polygon drawing +
  `turf.length()`/`turf.area()`, geodesic (WGS84) — same caveat as CSBP:
  this is ground/great-circle distance, not MGA50 grid distance. Flag if
  Cameron needs grid-exact numbers later.
- **Section**: draw a line, and the view splits — a profile pane opens
  **tiled across the bottom** of the map, full width, defaulting to half
  the page height, with an "Expand" toggle to grow it to most of the
  screen for a closer look (2026-08-27, per Cameron). **Originally
  guessed as a side-by-side split** (map | profile, like Civil3D) since
  "tiles the screen vertically" was genuinely ambiguous in English —
  Cameron confirmed he meant the horizontal/bottom-docked layout, so this
  flipped `#map-area` from a row to a column (`index.html`) and added the
  expand toggle (`#profile-expand`, `main-2d.js`).
- **No terrain elevation any more** (removed 2026-08-26, per Cameron:
  "the mapbox terrain should be removed, it doesn't really do anything
  relevant" — see "Terrain" below). Originally sampled Mapbox
  Terrain-RGB the same way the 3D scene's terrain did; now the chart only
  ever shows real design/service data.
- **Services/design linework/design surfaces shown on the section view**
  (added 2026-08-26, per Cameron: "need to be able to see these layers on
  the section view as well") — see "Section view now shows crossing
  layers" below, including a live drag-to-compare surface↔service delta-
  height snap. **IFC design geometry is NOT included** — the 2D page only
  tracks an axis-aligned bounding-box footprint for IFC, not its real
  mesh, so there's no true geometry to intersect yet.
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
   fresh id per call. **Confirmed fixed 2026-08-26** — specifically
   re-tested loading two different real IFC files (GT11's + a new
   design, "Sample IFC.ifc") in one session; no recurrence.

### IFC files with no `IFCMAPCONVERSION` at all (`ifc.js resolveCoordinationOffset()`)

A third georeferencing pattern, found 2026-08-26 in a real design file
("Sample IFC.ifc", GT11 Stack Foundation) — different from both GT11's
own `IfcMapConversion`-offset approach and the "K2 Plant Grid" local-CRS
case above: **no `IFCMAPCONVERSION` entity at all**, with real MGA50
coordinates baked directly into the geometry's `IFCCARTESIANPOINT`
values instead. Handled by leaning on `@thatopen/components`' own answer
to the same large-coordinate precision problem as bug #1 above:
`IfcLoader` defaults `settings.webIfc.COORDINATE_TO_ORIGIN` to `true`
(confirmed by reading the installed package source — docs on this
specific setting were thin), which re-centres large coordinates near the
origin internally during parsing and exposes what it subtracted via
`model.getCoordinationMatrix()`.

**Real wrinkle, not theoretical**: `@thatopen/components`' own
`getCoordinationMatrix()` wrapper does NOT put `[easting, northing,
height]` in `matrix.elements[12,13,14]` the way web-ifc's own examples
would suggest — tested against this file's known real coordinates
(~E384928, ~N6434079, ~H5.55) and got back `(-easting, -height,
northing)`. The extraction in `resolveCoordinationOffset()` is
documented as empirically-derived from that test, not from docs/source,
since it may not generalise to every axis/rotation configuration.
**Verified working**: placed at MGA50 E384928.653 N6434079.441 — an
exact match to the file's own first vertex — with a footprint outline
computing out to a plausible ~30m × 9m for a multi-footing stack
foundation.

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

**Update 2026-08-26 — designs partially loading, "pipes cut off"**:
Cameron hit a real bug loading a bigger design (`Sample_IFC.ifc`, 10
footings, not the 3 originally tested) — `loadIfcFile()`'s wait-for-
geometry check only waited for "at least one mesh has vertex data,"
which worked for GT11 (a small file whose geometry lands in one shot)
but grabbed a partial snapshot for anything whose geometry streams in
over multiple waves, silently cutting off elements that arrived after
the check passed. Fixed: now waits for the total vertex count across
every mesh to hold stable across several consecutive polls, not just
be non-zero once. Verified directly against the real file: load took a
genuine 4.1 seconds (confirming this file does stream over time, unlike
GT11), settled at 682 vertices across 2 meshes, and the resulting
footprint (29.62 × 9.05 m) matches an independent ground-truth
measurement taken straight from the raw IFC coordinates across all 10
footings.

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
  `depthAccuracy: "surveyed"`, ready for a future `"assumed"` tag to sit
  alongside it once that path exists, per the brief's request that the
  two be visually distinguishable.

**Update 2026-08-26 — two real bugs, reported by Cameron as "pits seem
to be joining up and the colours aren't coming through," both confirmed
and fixed**:

- **Colours**: the line layer was hardcoded to one flat colour for
  every service, ignoring the real 12d `colour` field entirely. Fixing
  that surfaced real colour values aren't all valid CSS on their own —
  AutoCAD Color Index codes (`"acad 095"`), 12d's own `"<name> <number>"`
  convention (`"blue 192"`), and at least one genuinely unrecognisable
  value (`"vis rock3"`). `src/service-colour.js` `normalizeColour()`
  handles all of these — see its header for exactly how, and where the
  real ACI RGB values came from (looked up, not guessed). Verified live:
  16 distinct real colours resolved from the real file, only 1 record
  fell back to a neutral default.
- **Pits joining up**: traced to records like `"power mh"` (205 points)
  — not one continuous outline, but ~30 physically separate manhole rim
  outlines (each ~8 points, <1m across) concatenated into one `data_3d`
  array by the export, with no marker between them. Rendered as one
  line, this draws long spurious lines connecting unrelated manholes.
  `twelve-d.js` `splitOnGaps()` splits a record wherever a gap qualifies
  as a split point — see the correction below for what that actually
  means; the version below was wrong.

**Correction, same day**: the first `splitOnGaps()` split on ANY gap
over a flat 3m threshold, validated only against the giant concatenated
-pit records. Cameron compared the 3D scene against the same file
opened in real 12d and found a dense, continuous network there vs.
scattered disconnected fragments in ours — correctly called out as
wrong, not a framing/zoom difference. Checked against ordinary
pipe/cable records this time (`"COMMS UG PIPE 100"`, `"earth ug line"`)
and found their normal, legitimate vertex spacing is 3–25m — well past
3m, so real continuous alignments were being shattered into isolated
single points and vanishing from the map entirely. Worse, the two cases
genuinely overlap in absolute distance (one legitimate alignment's
largest real gap, 17.4m, is bigger than one concatenated-manhole
record's smallest between-cluster jump, 16.2m) — no fixed distance
cutoff can separate them.

Fixed with a **relative** test instead: a gap only counts as a split
point if it's both more than an absolute floor (3m) **and** more than
8× that record's own median gap (median, not mean, so the handful of
huge jumps it's trying to detect don't drag it around). This works
because the two cases differ in *shape*, not scale — concatenated-pit
records have many tiny (<1m) gaps and a few extreme outlier jumps;
genuine alignments have fairly uniform, moderate gaps throughout.
Verified against every case that mattered: `"COMMS UG PIPE 100"` and
`"earth ug line"` now correctly stay as one segment each; `"power mh"`
(205 pts), `"comms manhole"` (29 pts), `"drain sidepit"` (16 pts) still
correctly split into their real separate clusters. Across the whole
file, renderable segments went from 448 (broken flat-threshold version)
to **737** — meaning ~289 real segments were being destroyed by the
earlier over-splitting. Swept the whole file afterward for any
remaining suspiciously long single segment (would indicate an
undetected concatenation still slipping through) — longest is a
plausible 201m, 6-point earthing run at an industrial site, not a red
flag.

**Second correction, later the same day**: Cameron still saw "a few
rogue pits joining up." One global median per record wasn't always
enough — a record with more than one genuine scale of internal
clustering could end up with a record-wide median that didn't cleanly
separate every jump from every cluster's own spacing. Fixed by finding
and splitting at the single WORST outlier gap first, then recursing
into each half with its own freshly-computed local median, rather than
measuring every gap against one global baseline in a single pass.
Re-verified every case above plus a broader sweep this time — checked
every resulting segment across the whole file for any remaining
internal outlier, not just the specific records already known about:
zero remaining. Some records resolved more precisely than before (e.g.
a 16-point "drain sidepit" was `[8,8]` under the single-pass version,
missing an internal split, and is now correctly `[8,4,4]`).

Applied to both the 2D map and the 3D scene's `services.js` (same
underlying bug there too) — the 3D fix hasn't been re-verified live
given its separate known rendering issue (see "Known issues").

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

**Update 2026-08-26, tested against a real 800-record weekly export**
("260826 Service Upload.12daz") — much bigger and richer than the
original 2-record sample, and it broke the parser in three new ways,
all fixed generically rather than special-cased (none of this data is
actually read, it just needs to not crash on it):
- `text "name" "value"` / `real "name" 0` / `integer "name" 5` — 3-token
  "typed attribute" statements inside `attributes`/`group` blocks.
- `point_data { "0013" "0014" ... }` — a flat list of quoted strings,
  not key/value pairs.
- `data_2d { E N }` — 2D-only points (symbol/survey pickups, no
  elevation) alongside `data_3d`. Records with only `data_2d` have <2
  centreline points and get filtered out before building map features
  (would otherwise be an invalid GeoJSON LineString) — 136/800 in the
  real file, logged rather than silently dropped.

**Also found**: `model "path"` is a bare top-level statement, not a
block — every `string` that follows belongs to whichever `model` was
last declared, until the next one. The original generic parser's
unordered accumulation lost this association entirely; the top-level
loop now preserves document order and tracks it (`parse12da()`). This
mattered more than expected: in the real file, `style` is nearly
useless for grouping (734/800 records are just `style: "1"`), while
`model` gives real discipline categories (Sewer, Water, Power/High
Voltage, Power/Low Voltage, Drainage, Communications, Earthing, Gas,
Fuel Line). **The 2D sidebar now groups services by `model`, not
`style`.** Verified: both the small sample and the 800-record file
parse correctly, with the model breakdown summing to exactly 800.

### Design upload broadened to linework + IFC + surfaces — `src/main-2d.js`, `src/twelve-d.js`

Same message as the "rogue pits" report, Cameron added: **"the design
upload probably needs to be able to support linework, .ifc (3d
trimesh), and surfaces."** Previously the "Design" upload slot
(`#ifc-input`) only accepted `.ifc`. Broadened to a single
`#design-input` (`.ifc,.12da,.12daz`) that routes by extension:

- **`.ifc`** → `handleIfcDesignFile()` — the original IFC-loading logic,
  unchanged, just unwrapped from its inline file-input event listener
  into a standalone function so it can be called from the new router.
- **`.12da` / `.12daz`** → `handleDesign12dFile()` — a single `.12da`
  file can contain linework (`string` records), surfaces (`full_tin`
  records — see below), both, or neither; each kind is handled
  independently if present:
  - **Linework** reuses the exact same 12d parsing/gap-splitting/colour
    pipeline already proven against real data for Underground Services
    (`splitOnGaps()`, `normalizeColour()`, `buildModelTree()`), rendered
    into a new **Design → Linework** sidebar subgroup instead of
    Underground Services. Factored the shared logic (feature-building
    from parsed records, the nested model-tree sidebar controller,
    map-fit-to-bounds) out of the old services-only code into
    `buildLineFeaturesFrom12d()` and a generic
    `createLineFeatureController({ sourceId, layerId, group,
    popupHtml })` — Services and Design Linework are now two
    independent instances of the same controller, not two copies of the
    same logic.
  - **Surfaces**: at the time this upload slot was first broadened,
    Cameron had confirmed (via question) these would also be
    `.12da`/`.12daz`, same as services, but there was no real sample yet
    to verify the block structure against — so `parse12da()` tracked any
    unrecognised top-level block key (`unrecognizedTopLevelKeys`) and
    surfaced it honestly ("might be a surface/TIN export, not supported
    yet") rather than silently showing nothing. A real sample arrived
    the same day — see "Design surfaces (`full_tin`) implemented" below
    for the actual format and how it's now parsed and rendered.

**Verified live** against both real sample files through the actual
`#design-input` element (dispatched a real `change` event with a real
`File`, not just a unit test of the parsing logic): loading
`260826 Service Upload.12daz` produced the same dense, connected
800-string network as Underground Services (rendered under **Design →
Linework → 04 K2 Power Station/Services/Loc**, correctly grouped by
`model` into Sewer/Communications/Drainage/Earthing/Fuel
Line/Gas/Unknown/Power (High/Low Voltage)/Water), while Underground
Services' own tree correctly stayed empty ("Nothing loaded yet") —
confirming the two controller instances don't share state. Then loaded
`GT11_Foundation_Reference_Model.ifc` through the same input and
confirmed no regression from unwrapping `handleIfcDesignFile()` out of
its old event-listener closure: placed at the correct MGA50 base point
(E384899.031 N6434081.091, GDA2020 MGA Zone 50) with a real
geometry-derived footprint landing on the actual GT11 site.

### Design surfaces (`full_tin`) implemented — first real sample, "FL Surface.12daz" (2026-08-26)

Cameron sent a real 12d surface export ("FL Surface.12daz", a "12d Quick
Tin" test file) — the sample the "Open items" list had been waiting on.
Its structure is completely different from a `string`:

- A top-level `full_tin { ... }` block (not a bare statement like
  `model`), containing `points { }` (one E/N/Z per point), `triangles { }`
  (one 1-based point-index triple per triangle), `neighbours { }`
  (adjacent-triangle indices, unused), and `nulling { }` (one flag per
  triangle, a flat list — not grouped in 3s like the others).
- **Coordinates are C99 hex-float literals** (`0x1.7593eff21e508p+18`),
  not decimal — this export had `output_tin_hex_floats true` set.
  Confirmed this is C's exact-base-2 `%a` printf format, NOT JavaScript's
  `0x`-hex-INTEGER syntax (`Number()` silently mis-parses it, truncating
  at the first `.`) — added a dedicated decoder,
  `parseHexOrDecimalNumber()`, rather than extending the existing integer
  parser. Verified by hand-decoding a few values against what the
  filename/context implied (a K2-site point cluster) before trusting the
  parser's output: they came back as real MGA50 coordinates right at the
  K2 site (E384882-384965, N6433964-6434113) with plausible AHD
  elevations (6.33-7.53m) — not garbage, and not coincidentally close to
  a totally different place.
- **The `nulling` flag's meaning isn't documented anywhere I could
  find — its use here is inferred from this one file's geometry, not
  from a 12d spec.** This sample has 8 points: 4 form a ~4.5km rectangle
  at flat RL 0 (12d's automatic "quick tin" bounding box, added because
  the real data was too sparse to triangulate alone — standard 12d
  behaviour, not real design data) and 4 cluster tightly at the real K2
  site with real elevations. Of the file's 10 triangles, exactly the 2
  built ONLY from the 4 real points have `nulling: 2`; all 8 touching a
  bounding-rectangle corner have `nulling: 1` — a clean split. Reading
  this as "1 = auto-bounding scaffold, exclude / 2 = real design data,
  keep" and filtering accordingly (`buildSurfaceFeaturesFrom12d()` in
  `main-2d.js`) produces exactly the small 2-triangle quad sitting at the
  real site — the geometrically sensible result — rather than the
  useless flat 4.5km rectangle. **This interpretation needs Cameron's
  confirmation before trusting it on a second, differently-shaped
  surface** — if a future export's nulling values don't split this
  cleanly, the inference doesn't generalise. See "Open items."

Rendered as a new **Design → Surfaces** sidebar subgroup (one row per
named surface, not the nested model-tree used for linework — a design
typically has a handful of named surfaces, not hundreds of records, so a
flat list is enough), one Mapbox fill+outline layer per triangle. This is
a first-pass triangle mesh, not interpolated contours — good enough to
confirm the format parses and places correctly; a proper hypsometric/
contour rendering is future work if surfaces become a bigger part of the
platform.

**Verified**: parsed correctly against the real file both in Node and
live in-browser (dynamic-imported `twelve-d.js`/`crs.js`/
`service-colour.js` directly and ran the same feature-building logic
`buildSurfaceFeaturesFrom12d()` uses — the Mapbox render loop itself was
unavailable for a full end-to-end screenshot this session, since my test
browser was backgrounded and suspends rendering/networking while not
displayed, see "Known issues"). Output: 1 surface, 10 triangles
parsed, 8 correctly excluded as scaffold, 2 kept — real MGA50
coordinates at the K2 site, RL 6.33-7.53m, converted to valid WGS84
polygon rings.

**Update, same day — surfaces keyed by upload, not internal name.**
Cameron: "we will need the actual geometry on that 2d page as the idea
will be upload surfaces to compare e.g monthly drone flights." The
intended workflow is uploading multiple dated surfaces (e.g. one per
month's drone flight) and comparing them — which means every upload
needs to stay independently identifiable in the sidebar, even though the
one real sample is literally named "12d Quick Tin," 12d's own generic
default. Keying the sidebar row/toggle/filter on the surface's own
internal `name` alone would silently MERGE two different months' data
into one indistinguishable entry the moment 12d gave them the same (or
any duplicate) name. Fixed by introducing `surfaceId` — the uploaded
file's name plus the surface's internal name (`buildSurfaceFeaturesFrom12d()`,
`createSurfaceFeatureController()`) — as the actual grouping/filter key
everywhere (sidebar rows, map filter, section-view chord labelling),
while still displaying the internal name and source file separately in
popups. Verified: simulated uploading the same real sample file twice
under two different names (as if "August_DTM.12daz" and
"September_DTM.12daz") — both internally named "12d Quick Tin" — and
confirmed they now produce two distinct, independently toggleable
surface entries rather than merging into one.

**Update, same day — simple A/B compare control (`src/surface-compare.js`).**
Asked Cameron what "compare" should actually do first: a simple toggle/
swipe between two, an elevation-difference map, or full cut/fill
volumes — he chose the simple toggle (the other two are real, bigger
features, deliberately not built yet — see "Open items"). Added a small
control that appears in the **Design → Surfaces** sidebar group once 2+
surfaces are loaded: two dropdowns (Surface A / Surface B, defaulting to
the two most-recently-uploaded — the likeliest "this month vs last
month" pairing) and a 3-way `[Show A | Both | B]` toggle. Deliberately
narrow in scope — it only ever touches the two surfaces picked; any
other loaded surface keeps whatever its own sidebar checkbox says. Drives
the exact same visibility state as the individual per-surface checkboxes
(`setSurfaceVisible()`, which updates the real checkbox element too) so
the two controls can never disagree about what's actually showing.

No elevation math in this at all — it's pure visibility, the "simple
toggle" end of the spectrum Cameron chose. An actual elevation-difference
map or cut/fill volume calculation between two surfaces is real,
meaningfully bigger future work — see "Open items."

**Verified**: `createSurfaceCompareControl()` tested directly (live
in-browser) against a fake controller recording every `setSurfaceVisible`
call — confirmed it stays hidden with only 1 surface, appears and
defaults to "both visible" with 2 (least-surprising default: nothing
hides the moment the control appears), and that clicking "Show A"/
"Show B" toggles exactly the two selected surfaces' visibility and
nothing else. The full `main-2d.js` module (including this control's
wiring into `createSurfaceFeatureController`) was also re-imported
directly to confirm no runtime errors — but as with the section-view
work above, a full on-screen interaction test through the actual sidebar
wasn't possible this session (suspended render loop).

### Section view now shows crossing layers (`src/section-intersect.js`) (2026-08-26)

Per Cameron: **"need to be able to see these layers on the section view
as well."** Previously the section/profile tool only sampled terrain —
now it also shows where the cut line crosses Underground Services,
Design Linework, and Design Surfaces, at their own real elevation. (The
terrain sampling itself was removed entirely a little later the same
day — see "Terrain" below — so this is now the ONLY thing the section
view plots.)

- Each 12d-sourced feature now keeps its real elevation as a 3rd GeoJSON
  coordinate value (`[lon, lat, elevationAhd]`) all the way from
  `twelve-d.js`'s parsed points through to the map features — Mapbox's 2D
  layers ignore the extra value (confirmed: no rendering change), but
  `section-intersect.js` needs it to plot real depth/elevation instead of
  just plan-view position.
- **Services/design linework**: `computeSectionCrossings()` finds every
  point where the cut line crosses a loaded line feature (2D segment-
  segment intersection, standard "two points on each line" formula — the
  site is small enough that treating lon/lat as a flat plane introduces
  negligible error, the same approximation `draw-tools.js`'s geodesic
  measurement already makes), then interpolates that feature's own real
  Z at the exact crossing point. Rendered as a coloured dot (each
  feature's own real, normalised 12d colour) with a hover tooltip
  (name/model/RL) and a faint drop-line to the axis so a deeply-buried
  crossing is still easy to spot.
- **Design surfaces**: same idea, per-triangle — where the cut line
  crosses a triangle's edges, its elevation is interpolated (linearly,
  in 2D-plan terms) between that edge's two real vertices. Each triangle
  crossed contributes one independent line segment ("chord"); triangles
  become deliberately *not* explicitly stitched together — chords from
  adjacent triangles naturally line up into what reads as one continuous
  surface profile, since they share the exact crossing point on their
  common edge.
- **Deliberately excludes IFC design geometry.** The 2D page only tracks
  an axis-aligned bounding-box footprint for IFC (see "IFC 2D footprint"
  above), not real mesh data — there's no true geometry to intersect, and
  faking a flat "footprint height" crossing would be exactly the kind of
  invented-looking-like-real-data result this project's data-fidelity
  standard rules out. Revisit if/when the 2D page keeps the real loaded
  IFC mesh around for this rather than just a footprint.
- Chart Y-axis range spans every crossing/chord actually present (no
  terrain line to also span any more — see "Terrain" below).

**Verified**: the segment-intersection math against a synthetic
known-answer case first (Node — a line crossing dead-centre of another
line, and a section line grazing straight through a triangle's apex
vertex, confirming the expected duplicate-hit-at-a-vertex edge case
rather than a wrong one), then the full real pipeline — parse real
services + real surface files, build 3D-coordinate features, run
`computeSectionCrossings()` against a real ~230m cut line through the
K2 site (live in-browser, dynamic-imported modules, same workaround as
"Design surfaces" above for the suspended render loop): 19 real service/
linework crossings found (elevations 5.9-6.9m AHD, consistent with the
site's known ~6.29m average), 1 real surface chord found (7.17-7.53m AHD
over ~63m, consistent with the surface's known 6.33-7.53m range). Also
rendered a synthetic profile through the actual `renderProfileChart()`
into a detached DOM node to confirm the SVG/legend markup builds without
error (2 crossing dots, 2 paths, correct legend text) — a full on-screen
screenshot of the real chart wasn't possible this session (see "Design
surfaces" above for why).

**Update, same day — live surface↔service delta-height snap
(`src/profile-chart.js`).** Cameron: *"it should have a live snap
displaying difference in between a surface or ifc object, and the
services model so when you drag your mouse across the section it is
locked to the surface with one snap and then snaps to the nearest
[service] with the other snap giving a delta height."* Dragging the
mouse across the profile chart now shows two live snap markers and the
vertical distance between them — e.g. checking cover depth between a
proposed pad surface and the nearest pipe, continuously as you scan
across the section, instead of having to read two RL values off the
chart and subtract them by eye.

- **Surface snap**: follows the cursor's exact X position, interpolated
  along whichever loaded surface chord covers that point (piecewise-
  linear between the chord's own real vertices — same data
  `computeSectionCrossings()` already produces, no new geometry work).
- **Service snap**: the NEAREST service/design-linework crossing to the
  cursor's current position (not interpolated — crossings are discrete
  point events, so "nearest" is literally the closest one by distance
  along the line). The readout also shows how far that nearest crossing
  actually is from the cursor, so it's clear when "nearest" isn't
  "directly under the cursor."
- Delta height = the absolute difference between the two snapped
  elevations, shown live in a text readout below the chart alongside
  both RL values and names, plus a dashed connector line between the two
  points on the chart itself and a vertical guide line at the cursor.
- **IFC is NOT included in the surface snap** — same limitation as
  `computeSectionCrossings()` itself (see above): the 2D page only has an
  IFC bounding-box footprint, not real geometry, so there's nothing
  genuine to snap to yet. The surface snap only reads from
  `surfaceChords` (12d `full_tin` data), which is real.
- If more than one surface is loaded and they overlap at the same cut-
  line position, the snap currently just takes whichever chord it finds
  first — no UI yet to pick "which surface" the snap should prefer at an
  overlap. Not addressed since the sample data never overlaps this way;
  flag if this comes up with real multi-surface data.

**Verified live in-browser**: rendered a synthetic chart (a surface chord
from RL 8.0 at 50m to RL 9.0 at 150m, a service crossing at RL 5.0 at
100m) and dispatched a real `mousemove` at the chart's exact midpoint
(distance = 100m): got surface RL correctly interpolated to **8.5**
(halfway between 8.0 and 9.0), service RL correctly read as **5.0** at
**0.0m** away (the crossing sits exactly there), and the delta readout
correctly showed **Δ 3.500 m** — matching the expected numbers exactly,
not just "something rendered." Also confirmed `mouseleave` correctly
hides the live overlay and clears the readout.

**Bug, found by Cameron in real use, fixed same day: "Failed to build
profile: Maximum call stack size exceeded."** The chart's Y-axis range
was built with `Math.min(...allElevations)` / `Math.max(...allElevations)`
— spreading an array into a function call, which has an engine-specific
argument-count ceiling (confirmed in this exact environment: `Math.min()`
on a 200,000-element spread throws this exact `RangeError`, the same
class and message Cameron saw). This was invisible against the tiny
2-triangle "Quick Tin" test sample every prior surface verification used
— it only shows up once a real, much denser surface (a genuine drone-
flight TIN can have thousands of triangles) gets cut, and enough of them
cross the section line to build a large enough `allElevations` array.
Fixed by building the min/max with a plain manual loop instead (`for...
if` — no spread, no argument-count limit, correct regardless of size).
**Verified the fix directly against the actual failure mode**: confirmed
`Math.min(...)` really does throw `RangeError: Maximum call stack size
exceeded` at 200,000 elements in this environment (root cause proven, not
assumed), then re-ran `renderProfileChart()` with a synthetic 100,000-
point surface chord and 50,000 line crossings — built the chart
correctly with no error.

**Same bug, found again — Cameron: "same error."** The fix above wasn't
the only spread of its kind: `createLineFeatureController()` and
`createSurfaceFeatureController()` (`main-2d.js`) both accumulated newly-
loaded features with `allFeatures.push(...newFeatures)` — the exact same
argument-count-ceiling problem, just one step earlier in the pipeline
(at upload time, accumulating ALL of a surface's triangle features into
one array) rather than at chart-build time. For a real dense drone-
flight surface (many thousands of triangles in one upload) this is
actually the MORE likely place to hit the ceiling than the chart itself.
Fixed the same way — a plain `for...of` loop instead of a spread.

**Verified with a stress test closer to a genuine dense drone-flight
TIN than any prior sample**: built a synthetic 500,000-triangle surface
(a 500×500 vertex grid, not the 2-triangle "Quick Tin" file every
earlier check used) and ran it through the ENTIRE real pipeline —
`buildSurfaceFeaturesFrom12d()`-equivalent feature building, the fixed
accumulation loop, `computeSectionCrossings()`, and `renderProfileChart()`
— with a section line cut straight across the whole grid. All four
stages completed with no error (feature build ~5.3s — noticeably slow at
this size, a possible future optimisation target if real surfaces turn
out this dense, but not a crash; accumulation ~6ms; crossings ~91ms;
chart ~5ms), correctly finding 1,000 real triangle crossings along the
cut. Also swept the rest of the codebase for the same `...arrayVariable)`
spread-into-call pattern — the only remaining instances are all fixed-
size-3 arrays (a triangle's 3 vertices, an `[x,y,z]` position), which
can't hit this ceiling regardless of how much data is loaded.

**Performance fix, found while stress-testing the above**
(`buildSurfaceFeaturesFrom12d()`, `main-2d.js`): building that
500,000-triangle test surface took **5.26 seconds** — slow enough to be
worth fixing, not just tolerating, for anyone actually loading real
drone-flight-density surfaces. Root cause: `surfaceId`/`surfaceName`/
`normalizeColour(surf.colour, ...)` (real work — `CSS.supports()` +
regex matching, not a cheap lookup) were being recomputed **per
triangle**, even though they're identical for every triangle in a given
surface; and `mga50ToWgs84()` was projecting each point **once per
triangle that references it** rather than once per point — a real
mesh's interior vertices are typically shared by ~6 triangles each, so
this was ~3-6x more coordinate transforms than necessary. Hoisted all of
these out of the per-triangle loop (computed once per surface / once per
point instead). **Verified**: re-ran the identical 500,000-triangle
stress test — build time dropped to **0.84 seconds (6.3x faster)**, and
spot-checked the output is byte-identical to before (same properties,
same projected ring coordinates) — this is a pure speed fix, not a
behaviour change.

### CORRECTION: "Failed to build profile: Maximum call stack size exceeded" — actual root cause (2026-08-27)

The two "fixes" above (`Math.min(...)`/`Math.max(...)` spreads, `allFeatures.push(...)` spreads) were REAL bugs, genuinely fixed, and worth keeping — but neither was actually causing Cameron's crash. He kept hitting the identical error after both landed, with trivially small real data (6-7 line crossings, 0 surface chords) that could never approach any argument-count ceiling. Two more rounds of increasingly granular error-reporting (a stage label in `main-2d.js`, then a per-sub-step label inside `renderProfileChart()` itself) narrowed it down to "building line-crossing SVG," which — on inspection — is just `.toFixed()`, template strings, and a simple character-escaping regex. Nothing that should ever recurse.

**Cameron opened real devtools and sent the actual stack trace, which is what actually solved this.** It showed something the status-bar message alone could never reveal: a SECOND, separate uncaught error immediately following the first, with a stack trace repeating the exact same 8-frame cycle hundreds of times:

```
(anonymous) @ draw-tools.js:62         ← draw.changeMode("simple_select")
Evented.fire → ... → DrawLineString.onStop → object_to_mode.stop
→ mode_handler.stop → changeMode → api.changeMode
→ (anonymous) @ draw-tools.js:62       ← back to the start
```

**The real bug, in `src/draw-tools.js`'s `handleChange()`**: finishing a section line called `onSectionLine(...)` then `draw.changeMode("simple_select")`, without ever resetting the closure's own `mode` variable back to `null`. `draw.changeMode()` calls the CURRENT mode's `onStop()`, which is how mapbox-gl-draw finalises a just-drawn feature — and finalising it re-fires `draw.create`/`draw.update` **synchronously**. Since `map.on("draw.create", handleChange)` is still registered and `mode` was still `"section"`, that re-fire called `handleChange()` again, which matched the `mode === "section"` branch AGAIN, calling `onSectionLine()` and `draw.changeMode()` AGAIN — real, unbounded mutual recursion between this file and mapbox-gl-draw's own internals, not a bug in the section-building logic at all. Whatever function happened to be executing once the call stack was finally exhausted got blamed — in this case `escapeXml()`'s `String.replace()`, purely by coincidence of how deep each recursive lap went.

**Why this was already-latent but only surfaced now**: this exact `handleChange()` code has been there since the section tool was first built, and `onSectionLine` used to be `async` (it originally `await`ed a Mapbox Terrain-RGB fetch). That `await` deferred the actual profile-building work onto the microtask queue, decoupling it from `draw.changeMode()`'s synchronous call stack — so even though the same re-entrant `handleChange()` call was almost certainly *always* happening, it landed in a fresh, shallow stack each time rather than a nested one, and never grew unbounded. Removing that `await` when Mapbox Terrain-RGB was dropped (2026-08-26, same day, see "Terrain") made `onSectionLine` fully synchronous — nesting its ENTIRE body, including chart rendering, directly inside the same call stack as the recursive `changeMode`/`onStop` cycle, which is what finally exhausted it. **A real regression introduced by an earlier fix in this same session**, not a pre-existing bug newly discovered.

**Fix**: reset `mode = null` in `handleChange()` *before* calling `draw.changeMode("simple_select")`, not after. The re-entrant call (if `draw.changeMode()` does synchronously re-fire, as observed) now sees `mode !== "section"` and does nothing, breaking the cycle at its source regardless of whether `onSectionLine` is sync or async.

**Lesson for next time this class of bug shows up**: three rounds of "fix a real bug, re-verify with bigger synthetic data, still doesn't reproduce" should have been a stronger signal to ask for the actual browser stack trace sooner rather than guessing a third/fourth time — synthetic stress-testing this session's own sandboxed tool calls could reproduce (large arrays) was never going to surface a re-entrancy bug that has nothing to do with data size. The stack trace made this a five-minute fix once available; the two prior "fixes," while independently valid, cost several rounds of back-and-forth chasing the wrong theory first.

### Clicking a loaded surface while drawing a section didn't register a cut point (2026-08-27)

Cameron: *"if i have the tin surface on, clicking on it doesn't register
as a cut point when trying to cut a section, it just give me the tin
details, i have to click off the tin to make it load."* A real
interaction conflict: every clickable layer (IFC point/footprint,
services, design linework, design surfaces) has its own `map.on("click",
layerId, ...)` popup handler, and a click landing on one of those
features while a draw tool (distance/area/section) is active was being
consumed by that popup instead of reaching `mapbox-gl-draw`'s own
vertex-placement handling.

**Fix, not a fully root-caused diagnosis**: rather than chase
`mapbox-gl-draw`'s exact internal interaction with feature-click queries
— Mapbox's own docs don't describe layer-specific click listeners as
blocking other click handlers, so the precise mechanism isn't something
I could pin down with confidence, and confirming it properly needs real
mouse-driven interaction against an actually-rendered map, which this
session's sandboxed browser can't do (render loop suspended while not
displayed — see "Known issues") — this applies the standard, safe fix
real Mapbox apps use for this exact class of conflict: suppress custom
feature popups while a draw tool is active. A new shared `drawToolState.active`
flag (set by `wireMapToolbar()`'s `setActiveTool()`, which already fires
at exactly the right moments — tool start, section finish, Clear,
profile-pane close) is checked at the top of all four popup handlers;
each just returns early instead of opening a popup, letting the click
through to whatever `mapbox-gl-draw` does with it.

**Not independently verified against real click interaction** — traced
the logic by hand (confirmed `drawToolState.active` is true for the
entire window from starting a tool through to the line/polygon actually
finishing, covering every click in between, and false again immediately
after) and confirmed the app still imports/runs with no errors, but
couldn't test the actual "does clicking the TIN now place a vertex"
behaviour live in this environment. Please confirm this fixes it — if
not, the more likely next step is adding `e.originalEvent.stopPropagation()`
awareness or investigating whichever layer/control is really consuming
the event, with a devtools session actually reproducing the click.

**Confirmed fixed** — Cameron: "the click worked and generated a section." No further action needed here.

### Section pane layout: bottom-docked, half-page default, expandable (2026-08-27)

Cameron, after the recursion fix landed: *"just need to be able to expand it or have it default to half the page, probably across the bottom actually (tiled horizontally)."* Two changes to `index.html`/`main-2d.js`:

- `#map-area` flipped from `flex-direction: row` to `column` — the map and the section-profile pane now stack vertically (map on top, profile pane along the bottom, full width) instead of sitting side-by-side. This also resolves the "Guessed at the split orientation" caveat noted in "Measurement & section tools" above — Cameron confirmed the horizontal/bottom-docked reading was the one he meant.
- `#profile-pane` defaults to `flex-basis: 50%` (half the page) instead of a fixed 420px sidebar-like width, plus a new **Expand** button (`#profile-expand`) in the pane's header that toggles a `.expanded` class (`flex-basis: 85%`) for a closer look at the chart, and collapses back to 50% automatically the next time the pane is opened fresh (`resetProfileExpansion()`).

A full-width bottom pane also means the chart itself renders noticeably wider than before (previously constrained to a ~420px-wide sidebar) — no code change needed there since `profile-chart.js`'s SVG already scales to `width:100%` of its container.

**Not independently verified live** — the click handlers this depends on (`#profile-expand`'s listener) only get wired up after Mapbox's real `map.on("load", ...)` fires, which doesn't happen in this session's sandboxed browser (suspended render loop, see "Known issues") — confirmed via DOM inspection that `#map-area`'s computed `flex-direction` is now `column` and that all the new elements exist with the right ids, but couldn't click-test the Expand toggle itself. Simple enough (`classList.toggle("expanded")`) that it should just work, but flag if it doesn't.

### Surface not appearing in the section view — real bug found: edge-only crossing detection (2026-08-27)

Cameron: *"still not showing the surface"* (in the section/profile chart). First investigation tested the crossing logic against a section line drawn through the surface's real extent and found it worked — concluding (wrongly, see below) that the code was correct and the issue was just the test surface's small real coverage area not being crossed.

Cameron then looked at the actual screenshot and called it: *"reckon its only trying to hit the edge of the triangles only for the surface and not the actual plane and that the problem?"* — exactly right. `crossingsForTriangle()` only checked where the section line crosses one of a triangle's 3 **edges**. A section line short enough to start AND end entirely inside one triangle — never crossing back out through an edge — produced **zero** edge-crossings and silently vanished from the chart, even though the whole line legitimately sat on that triangle's surface (real screenshot: a ~12m section line drawn inside a visibly much-larger rendered surface patch, correctly showing service crossings but no surface line at all).

**Fix** (`section-intersect.js`): in addition to edge crossings, now also checks every section-line VERTEX for whether it falls INSIDE the triangle (`barycentric2D()` — standard 2D barycentric-coordinate point-in-triangle test), and if so, barycentric-interpolates the real elevation there as an additional hit. A short line entirely inside one triangle now correctly produces a 2-point chord (its own two endpoints, each with their own interpolated elevation) instead of nothing.

**Verified**: three synthetic cases against a hand-built triangle — (A) a short line entirely inside it now correctly finds 2 points with sensible interpolated elevations (previously found 0 — this is the exact bug); (B) a long line crossing straight through via its edges still finds exactly the same 2 edge-crossing hits as before (no regression); (C) a line entirely outside still correctly finds nothing (no false positives introduced). Then re-verified against the REAL `FL Surface.12daz` file: a tiny ~3.8m line placed at one real triangle's centroid — small enough to plausibly sit entirely inside it, mirroring Cameron's actual 12m-line-inside-a-bigger-patch scenario — now correctly finds elevations 7.12m → 7.14m AHD (within the surface's known 6.33–7.53m range), where it previously would have found nothing.

### Live snap: Surface↔Pipe / Pipe↔Pipe mode toggle, plus 2D/3D distance (2026-08-28)

Cameron, once the layout/surface fixes above landed: *"enable the option to switch between snapping depths to a surface or a point to point, eg if we want to know the depth between 2 pipes. infact as well as depths give 2d and 3d distance between pipes."* Two additions to the live snap tool (`profile-chart.js`):

- **Mode toggle** — two small buttons above the readout, "Surface ↔ Pipe" (the original behaviour: one snap follows the design surface under the cursor, the other snaps to the nearest service crossing) and "Pipe ↔ Pipe" (new: BOTH snaps go to services — specifically the **two nearest crossings to the cursor**, so hovering near two close-together pipes compares those two directly, e.g. clearance between two crossing services, rather than either against the surface). Both modes reuse the same drag-to-follow interaction and the same two on-chart dots/connector line — only which data feeds them changes.
- **2D and 3D distance**, alongside the existing vertical delta (height/depth) — both points snapped to always lie ON the section line by construction (surface interpolation happens exactly at the cursor's position; service crossings are by definition where a service crosses that line), so the horizontal separation between their positions along the line IS the real 2D distance, not an approximation. 3D distance is the straight-line `hypot()` of the 2D and vertical components. Readout now reads e.g. `Δheight 1.500 m · 2D 20.000 m · 3D 20.056 m — Pipe A (RL 3.000) ↔ Pipe B (RL 4.500)`.

**Verified**: rendered a synthetic chart with 3 service crossings and 1 surface chord, then dispatched real `mousemove` events and hand-checked every number against the input data — default (Surface↔Pipe) mode at one position, Pipe↔Pipe mode at two different positions (confirming it correctly re-picks whichever 2 crossings are nearest as the cursor moves, e.g. correctly switching from "Pipe A ↔ Pipe B" to "Pipe C ↔ Pipe B" when hovering near a third, more distant pipe). Every Δheight/2D/3D figure matched hand-calculated expected values exactly (e.g. `hypot(20, 1.5) = 20.056`). Also confirmed the mode buttons' active/inactive styling updates correctly on click, and that `mouseleave` still resets everything (including back to whichever mode was last selected — deliberately not reset on leave, only on a fresh chart render).

### 2D → 3D file carry-over (`src/shared-design-store.js`) (2026-08-28)

Cameron: *"can we now have the models that are input into the 2d view carry over to the 3d view?"* Previously true — the 2D and 3D pages are two separate full HTML documents (`index.html`/`3d.html`), reached via a normal link navigation, not a single-page app, so there was no live JS state to share and every file had to be uploaded twice.

**New shared module, `shared-design-store.js`**, using **IndexedDB** (not `localStorage` — its ~5-10MB string-only limit is too small for real IFC/12d file blobs; IndexedDB has no such practical limit and is built for exactly this) to stash the raw bytes of every successfully-loaded file, tagged with which upload slot it came from ("design" for IFC, "services" for 12d services). Both pages read from and write to the same store, so this works in **either direction** — whichever page a file gets uploaded in, the other picks it up next time it loads.

- `main-2d.js`: after a successful IFC or services load, calls `stashDesignFile(slot, file)` (fire-and-forget — a storage failure should never break the upload the user's actually watching happen).
- `main.js`: `wireIfcInput()`/`wireServicesInput()`'s inline logic was unwrapped into standalone `handleIfcFile()`/`handleServicesFile()` functions (same refactor pattern used for `main-2d.js`'s design input earlier this session), so a fresh page load can call `replayStashedFiles()` — which fetches everything stashed (oldest first) and replays each through the exact same handler a live upload uses, sequentially (not in parallel, since e.g. the services handler mutates shared `terrainState`).
- **Scope**: only "design" (IFC) and "services" (12d) are carried over — the only two the 3D page can currently render anything for. Design **linework** and **surfaces** (`full_tin`) are 2D-only features with no 3D rendering counterpart at all yet; stashing them would silently do nothing useful once replayed on the 3D side, so they're deliberately left out until that 3D rendering work exists (see "Open items").

**Verified end-to-end against real files, through a real page navigation** (not just a simulated function call): stashed the real `260826 Service Upload.12daz` and `GT11_Foundation_Reference_Model.ifc`, then actually navigated the browser from the 2D page to `/3d.html` and confirmed the console showed `"Loading 2 file(s) carried over from the 2D view…"` immediately on load, with **zero manual action** — followed by both files loading successfully: 800 real service strings added, and the IFC georeferenced with a post-placement bounding box of **21.37 × 4.04 × 7.50 m**, exactly matching this same file's independently-verified ground-truth measurement from earlier in this project (see "IFC georeferencing — implemented and verified"). Also confirmed the failure path is graceful: stashing deliberately-corrupt file content first and replaying it produced the same clean per-file error handling a live bad-file upload would show, with no crash.

### Deployment brush-up: legend colours, multi-file IFC, rename/delete (2026-08-31)

Three requests in one message, aimed at getting closer to deployable: *"the legend of the services isnt reflecting the actual line colours"*, *"is it at a point where we can import multiple files now instead of the 2 we have been testing (as in does it overwrite what is currently imported everytime we import again)"*, and *"we also need to be able to rename, edit and delete layers/groups."*

**1. Sidebar legend colours were hardcoded** (`main-2d.js` `createLineFeatureController`'s `renderTree()`) — every services/design-linework leaf row's colour swatch was a flat `#2fa3ff` blue regardless of what colour that discipline's lines actually draw as on the map. Fixed with `colourForModel()`: scans all accumulated features for a given `model` path and picks the **most common** real colour among them (not just the first found — a `model` group can in principle mix colours, 12d doesn't enforce one colour per discipline) as the representative swatch. **Verified against the real 800-record file**: all 11 real model groups now show their own distinct real colour (Sewer=brown, Communications=pink/`rgb(255,0,192)`, Water=blue, Power/High Voltage=`rgb(255,66,0)`, etc.) — confirmed none still fall back to the old flat blue.

**2. IFC uploads silently overwrote each other** — genuinely true, and the one upload type that did. Services, design linework, and design surfaces all already accumulate correctly (each keeps its own `Map`/array of everything loaded and only ever adds to it — surfaces in particular were built this way specifically to support multiple dated uploads, see "surfaces keyed by upload, not internal name" above). IFC was the exception: `state.ifcFeature`/`ifcFootprintFeature` were single slots, and the sidebar row was created once and never again, so a second `.ifc` upload replaced the first design's marker/footprint entirely with no way to see both. Rewrote as `createIfcFeatureController()`, matching the same accumulator pattern as the others — keyed on the uploaded filename (`ifcId`, good enough here since one IFC upload is always exactly one design, unlike surfaces' internal-name collision risk), one Mapbox source holding every design's point+footprint tagged with its own `ifcId`, filtered by a `checkedIds` set, one sidebar row per design. **Verified mechanically** (real map interaction isn't testable in this sandboxed session — see "Known issues") by copying the exact function body into a test harness with a mocked `map`/`group` recording every call: uploading design "A" then "B" correctly kept both (2 sidebar rows, both features present in the source data simultaneously), and re-uploading "A" again correctly updated its entry in place rather than creating a duplicate row.

**3. Rename and delete, for every layer/group.** Added generically in `layer-tree.js` rather than per-controller:
- **Rename** needs no cooperation from any controller at all — it's purely a display-text change (a ✎ button turns the label into an editable text field on click; Enter/blur commits, Escape cancels), since the underlying filter key a controller actually uses (a `model` path, a `surfaceId`, an `ifcId`) never changes. Works identically for rows and for group/subgroup headers.
- **Delete** does need cooperation: a row or group only gets a 🗑 button at all if its caller passed an `onDelete` callback (so e.g. the Base Map group and its Satellite/Streets radio rows — not user-uploaded data — simply have none). Clicking it calls the caller's `onDelete()` (to actually strip that data out of the controller's state and the Mapbox source) and then removes the row/group's own DOM node. Wired up: every services/design-linework model-tree leaf (`removeModel()`), the Linework/Surfaces/Underground-Services **groups themselves** (`removeAll()`, deleting everything in that group at once), every surface (`removeSurface()`), and every IFC design (`removeDesign()`).
- **Real bug caught by testing, not shipped**: initial rows were `<label>` elements (so clicking anywhere toggled the checkbox, standard HTML behaviour) — clicking the new rename button on a row turned out to ALSO fire a spurious `change` event on that row's checkbox, a real browser quirk (a nested `<button>`'s `preventDefault()`/`stopPropagation()` doesn't reliably suppress a `<label>`'s own click-forwarding to its associated control). Harmless in effect here since it fired with the *same* checked value, but exactly the kind of thing that could bite a future non-idempotent `onChange`. Fixed properly rather than left as a known quirk: rows are now a plain `<div>` with explicit click-forwarding (clicking the swatch/label text toggles the checkbox; the checkbox and icon buttons handle their own clicks) — same UX, no native forwarding involved at all.
- **Verified thoroughly** (pure DOM, no Mapbox involved, so fully testable in this sandboxed session): a row without `onDelete` correctly gets no delete button; renaming correctly updates the label and fires **zero** extra `change` events (re-checked after first catching my own test mis-measuring this — see commit history); the row-click-to-toggle behaviour still works and fires `onChange` exactly once; deleting correctly invokes the callback, removes the DOM node, and doesn't fire a stray `change`; clearing a group correctly restores the "Nothing loaded yet" placeholder; and group-level rename/delete both work without also toggling that group's collapsed state.

### Live snap: pick which surface, and Surface↔Surface comparison (2026-08-31)

Cameron, after the deployment brush-up above: *"in the section view can you switch between surfaces for the heights? can you also add another option of comparing the 2 surfaces?"* Two related gaps in the live snap tool (`profile-chart.js`):

- **No way to pick which surface** — with 2+ surfaces loaded and overlapping at the same cut-line position, the "Surface ↔ Pipe" mode's surface snap silently used whichever loaded surface's chord happened to come first in the list. Fine with one surface, ambiguous with more. Fixed with an explicit **"Surface:" dropdown**, populated from every distinct surface name actually present in the crossings — shown in both surface-driven modes, hidden in Pipe↔Pipe (which doesn't need it).
- **New "Surface ↔ Surface" mode** — a third button alongside Surface↔Pipe and Pipe↔Pipe. Both snap points now each follow a SEPARATELY selected surface's own elevation under the cursor (a second "vs:" dropdown appears only in this mode, defaulting to the second surface found). This is a precise, per-point elevation-difference reading as you drag along the cut — e.g. comparing this month's vs last month's drone-flight surface at any exact spot — distinct from `surface-compare.js`'s existing whole-map A/B visibility toggle (see "simple A/B compare control" above), which only shows/hides, doesn't measure a difference.

Both surface-driven modes report the same Δheight/2D/3D numbers the other modes already do (2D is 0 in Surface↔Surface specifically, since both points are read at the exact same cursor position along the line — only elevation differs).

**Verified**: rendered a synthetic chart with two real-shaped surfaces (a straight 8.0→9.0m chord and a straight 8.5→10.5m chord over the same 0–200m range) and confirmed, via real `mousemove` dispatches: (1) picking each surface from the dropdown in Surface↔Pipe mode changes the reported height (8.5 vs 9.5 at the midpoint) while everything else stays consistent; (2) switching to Surface↔Surface mode correctly reveals the second dropdown, defaults it to the other surface, and at the same midpoint correctly reports **Δheight 1.000 m, 2D 0.000 m, 3D 1.000 m** between them — exact expected values, not approximations. Also confirmed the "doesn't cover this point" fallback message correctly names whichever specific surface (A or B) is the one missing coverage at the cursor, tested with a surface that only partially covers the line.

### Multi-file layer import: subgroups at upload time (2026-08-31)

Cameron, on the multi-file import work above: *"the multifile layer import will be handy though, would be great to upload them and put them into subgroups from the import phase."* IFC designs and design surfaces were the two upload types that were genuinely flat — one row per upload, no structure at all (unlike services/design-linework, which already organise themselves into a real nested tree from each 12d record's own `model` path — that stays as-is, this doesn't touch it).

Added a **"Subgroup (optional)"** text field next to the Design file picker (`index.html`). Leave it blank and uploads behave exactly as before (flat, under Design). Type a name — e.g. "Structural" — before choosing a file, and that upload (IFC or surface) lands inside a subgroup with that name instead; upload another file into the same name later and it joins the same subgroup rather than creating a second one.

Shared logic, `resolveTargetGroup()` (`main-2d.js`), used by both `createIfcFeatureController` and `createSurfaceFeatureController`: lazily creates and caches a named subgroup inside the controller's base group, or just returns the base group itself if no name was given.

**Real correctness issue caught before shipping, not left as a known gap**: `layer-tree.js`'s own group-delete button only removes sidebar DOM/bookkeeping — it has no idea a controller's actual map features exist. Deleting a subgroup naively would have hidden every design/surface inside it from the sidebar while leaving their real features still rendered on the map with no way to toggle or remove them again — orphaned data, not just a cosmetic gap. Fixed by having each controller track which of its own IDs went into which subgroup (`subgroupMembers`), and pass a real cleanup callback into `resolveTargetGroup()` that calls the controller's own `removeDesign()`/`removeSurface()` for every member when that subgroup is deleted — the exact same removal path a normal row-level delete already uses, not a second one to keep in sync.

**Verified** against the real `layer-tree.js` module (no Mapbox involved, so fully testable here): two uploads into the same subgroup name correctly share one subgroup rather than creating two; an upload with no subgroup name correctly lands as a flat row in the base group; and — the case that actually matters — deleting a subgroup containing two designs correctly triggered real removal for **both** of them (confirmed via a recording stand-in for `removeDesign`), and the subgroup cache correctly forgot the deleted name afterward (so re-using that name later would build a fresh subgroup, not reference a removed one).

### Pre-deployment fix: `3d.html` was missing entirely from production builds (`vite.config.js`) (2026-08-31)

Getting ready to actually push this repo and deploy it (Cameron: "can we look at pushing to git hub" → clarified the real need is people without GitHub accounts using the deployed app, not browsing code — so it needs a real production build, not just `npm run dev`). No `vite.config.js` existed at all — Vite's default `vite build` only bundles the root `index.html` as its entry point. This app has had two real pages since the very start (`index.html` the 2D map, `3d.html` the Three.js scene, cross-linked via "3D View →" / "← 2D Map") — completely invisible during `npm run dev`, since Vite's dev server serves any file by path whether it's a configured build entry or not.

**Confirmed for real, not just reasoned about**: ran an actual `npm run build` before writing any config — `dist/` came out with only `index.html`; `3d.html` was entirely absent. The "3D View" link would have 404'd the instant this was deployed anywhere.

**Fix**: added `vite.config.js` with `build.rollupOptions.input` listing both `index.html` and `3d.html` as entry points (using `import.meta.url`-derived `__dirname`, since this package is `"type": "module"` — Node ESM has no `__dirname` global, unlike CommonJS).

**Verified**: rebuilt from a clean `dist/` — both `dist/index.html` and `dist/3d.html` now present. Served the real production build (`npm run preview`, not the dev server) and loaded both pages: the 3D page reached "Ready" with a clean console (CRS round-trip check passed, ground-imagery loaded, IFC loader set up, zero errors), the 2D page loaded cleanly too, and its "3D View →" link correctly resolves to `/3d.html`, which is now a real page in the build rather than a dev-server-only convenience.

### Custodian model + shared storage (`api/`, `src/server/shared-storage.js`, `src/shared-remote-store.js`) (2026-08-31)

Mid-deployment-planning, Cameron caught something important: *"people wont have files to load themselves, i will be the sole custodian of the import data, so i imagine that changes things."* Correct — a deployed K2 with only per-browser storage (the IndexedDB-based 2D↔3D carry-over, `shared-design-store.js`) would show every visitor OTHER than Cameron an empty map, since nobody else ever uploads anything. That's only useful as Cameron's own remote-access tool, not as something to actually show other people. First instinct was to route this to `progressive-spatial-platform` instead (see that project's own memory/README) since it already has a real backend planned for exactly this — but once it was clear this isn't a nice-to-have, it's what makes deploying K2 actually achieve its point, Cameron chose to build a lightweight version here instead of waiting.

**Architecture**: Vercel (the chosen deploy host) + **Vercel Blob** for file storage (same account/dashboard, no separate storage provider needed) + three small serverless functions under `api/` providing a real custodian/public-read split:
- `GET /api/shared-files` — public, no auth. Lists every shared file's metadata. Every visitor's browser calls this on load and auto-replays each entry through the *exact same* `handleIfcDesignFile()`/`handleDesign12dFile()`/`handleServicesFile()` functions a live upload uses (a `{ skipSharing: true }` flag stops it re-uploading what it just downloaded) — no separate "load from server" code path to drift out of sync with a real upload.
- `POST /api/shared-upload` — custodian-gated. Rejects anything that doesn't carry the correct secret, checked against `CUSTODIAN_SECRET` (a Vercel environment variable, never shipped to the browser — this is the actual enforcement; a client-side-only "hide the button" was explicitly ruled out earlier as not real security).
- `POST /api/shared-delete` — same gate, removes both the blob and its metadata entry.
- Plain JSON + base64 request bodies, not Vercel Blob's more elaborate "client upload token" pattern (browser uploads straight to Blob storage, server only issues a token + gets a completion webhook) — that pattern exists to route around serverless function body-size limits for BIG files. This tool's actual files (IFC/12d exports) are small — real samples seen so far are 16KB/69KB — so the simpler approach is sufficient and much easier to reason about. Point clouds, which genuinely would need that, were explicitly routed to `progressive-spatial-platform` instead (see project memory) — not a concern here.
- Metadata for all shared files lives in one small JSON "index" blob, read-modified-written on each change — no separate database. Fine given Cameron is the sole, sequential custodian; not safe under concurrent writers, which never happens here.

**New sidebar section, "Shared Data"** (`index.html`) — always visible to everyone, listing whatever's currently shared (name + slot + subgroup). A **"🔒 Unlock custodian mode"** button prompts for the secret and remembers it in *that browser's* `localStorage` (`shared-remote-store.js`) so Cameron doesn't retype it every visit — this is convenience only, not the security boundary; a visitor with dev tools open learns nothing that lets them write, since the real secret value never ships in the app bundle regardless. The existing "Add Data" upload section is now **hidden by default** and only appears once unlocked — showing upload controls to visitors who have nothing to upload and no way to actually use them would just be confusing.

**Deliberately did NOT wire every existing local delete button (per-model-leaf, per-surface, per-IFC-design, whole-group) to also delete from shared storage.** A single 12d services upload can produce dozens of local rows (one per `model` path) with no clean 1:1 mapping back to "the one shared file that produced these" for a leaf-level delete. Instead, the Shared Data panel has its **own** delete button per shared entry, operating at the level that actually maps cleanly: one upload. Deleting there stops that file loading for future visitors; it does **not** retroactively remove what's already rendered in the current session (the existing local layer-tree controls still do that, unchanged) — documented plainly in the delete button's own tooltip rather than left to be discovered as a surprise.

**Verified as far as possible without an actual deployment** (this genuinely needs Vercel's real runtime + a linked Blob store — `@vercel/blob` calls, `CUSTODIAN_SECRET`, and the whole point of the exercise, cross-browser shared state, can't be faked locally): confirmed `main-2d.js` still imports without error after all the wiring; confirmed the custodian secret's `localStorage` round-trip works correctly (set → read back → clear → reads `null`); confirmed `listSharedFiles()` fails *gracefully* (a caught, readable error, not a crash) against this session's plain Vite dev server, which has no real `/api` routes to answer it — exactly the state the app should handle cleanly before a real deployment exists. Full verification (upload → appears in Shared Data → visible to a second, unrelated browser session → delete → gone next reload) is the first thing to do once this is actually deployed.

**What Cameron needs to do, that I can't do for him**: create/log into a Vercel account, create a project linked to the GitHub repo, connect a Blob store to it (a few clicks in Vercel's dashboard), and set `CUSTODIAN_SECRET` to a real secret value of his choosing as a Vercel environment variable — I generate code, not his credentials or account setup. Once that exists, the actual `vercel --prod` deploy (or GitHub-push-triggered auto-deploy) is straightforward from there.

### Terrain (`src/terrain.js`) — Mapbox Terrain-RGB REMOVED 2026-08-26, imagery kept

**Cameron: "the mapbox terrain should be removed, it doesn't really do
anything relevant, images to stay."** Originally (2026-08-24, when no K2
drone flight existed yet) this used Mapbox's Terrain-RGB DEM tileset as
the default elevation source — real, if coarse (global data, zoom-15
max), not synthetic. Once real design/service/surface elevation data (12d
surfaces, services, IFC) was actually loadable and comparable, that
coarse global heightfield stopped earning its keep — it never lined up
meaningfully with the real, much more precise data actually being worked
with, and was just visual noise/a false sense of "real ground."
**Removed entirely, everywhere it was used**:

- **2D section/profile view**: no longer samples or plots a terrain
  elevation line at all — see "Section view now shows crossing layers"
  below. `elevation-profile.js` (the module that did this sampling) is
  deleted; `section-intersect.js`'s own crossing logic never depended on
  it and is unaffected.
- **3D scene**: `getCurrentTerrain()` (`terrain.js`) no longer builds a
  Terrain-RGB heightfield mesh. `mapbox-terrain.js` (the old
  implementation) is deleted, replaced by `ground-imagery.js` —
  **imagery stays, per Cameron ("images to stay")**: a FLAT plane
  textured with the same stitched Mapbox satellite imagery, just with no
  elevation draped onto it (every vertex sits at the scene origin's own
  AHD, not a real ground shape). `terrain-rgb.js` (shared tile-fetch/
  decode logic) is renamed to `mapbox-tiles.js` and stripped of its now-
  unused elevation-decoding exports (`decodeTerrainRgbHeight`,
  `fetchTerrainRgbCoverage`) — it's now just generic Mapbox raster-tile
  fetching, used only for the imagery plane.
- **Unaffected**: `buildTestSurfaceAbovePipes()` (`terrain.js`) — the
  test "~0.9m above the pipe" cover-depth surface used for the future
  excavation-cut view. This was never Mapbox-sourced (built from real
  service pipe elevations), so it's a completely separate concept from
  the terrain that got removed, and still works exactly as before.

**Verified**: re-imported `terrain.js`/`ground-imagery.js`/
`mapbox-tiles.js` live in-browser and called `getCurrentTerrain()`
against the real GT11 site origin — confirmed it returns a flat plane
(source `"mapbox-satellite-flat"`) with a real satellite-imagery texture
attached (`mesh.material.map` present) and every vertex at the scene's
own datum height (Y ≈ 0 to within floating-point noise, ~1e-15 —
negligible at any real scale, not a residual heightfield). Also
confirmed `main-2d.js` and the whole `terrain.js` import chain still
load without error after the rename/deletions.

## Suggested Build Phases (from project brief)

- **Phase A — Foundations**: ✅ Three.js scene up; ✅ real IFC file loads,
  renders, and georeferences correctly against MGA50 (verified via
  bounding-box check); ❌ real drone DSM/DTM (blocked on a K2 flight
  happening — no elevation fallback in the meantime any more either,
  since Mapbox Terrain-RGB was removed 2026-08-26 as not relevant enough
  to keep; see "Terrain" — a flat satellite-imagery-textured ground
  plane is the current interim default instead, imagery only, no
  elevation).
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
  - `ifc/Sample_IFC.ifc` — a different, real K2 design (GT11 Stack
    Foundation, 12d Model-exported), notable for having no
    `IFCMAPCONVERSION` at all — see "IFC files with no IFCMAPCONVERSION."
  - `12d/Sample 12d Pipe.12daz` (+ `12d/extracted/` — unzipped for
    inspection) — the original small (2-record) sample export.
  - `12d/weekly-260826/260826 Service Upload.12daz` — a real, much
    larger (800-record) weekly services export — see "12d services
    import" for what parsing this against real data surfaced.
  - `12d/surfaces/FL Surface.12daz` (+ `extracted/` — unzipped for
    inspection) — a real "12d Quick Tin" surface/TIN export, the first
    surface sample — see "Design surfaces (`full_tin`) implemented."
  Never commit real client data to this repo's git history, even
  privately — treat it the same as the "never store or log client data
  outside the local stack" rule from the wider platform work.

## Open items — need Cameron

1. ~~**Repo destination**~~ — **Done (2026-08-31).** Pushed to
   `https://github.com/ProgressiveSpatial01/K2-power-station-3d` (private
   repo — real client/site details are in the code and commit history
   even though real survey data itself stays gitignored either way).
   Verified the push landed completely: remote `HEAD` matches local
   exactly, all 45 commits present. Deployment (so people without GitHub
   accounts can use the actual app) is a separate next step — see "Open
   items" below.
2. **A real drone DSM/DTM**, whenever a K2 flight happens — will replace
   the current flat satellite-imagery ground plane (`ground-imagery.js`)
   as the 3D scene's default per the swap-point design in `terrain.js`
   (Mapbox Terrain-RGB elevation itself was removed 2026-08-26, see
   "Terrain" — it's not the fallback any more, just the interim imagery).
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
6. **Confirm the `full_tin` "nulling" flag's meaning** — a real surface
   sample arrived and is now parsed and rendered (see "Design surfaces
   (`full_tin`) implemented"), but the per-triangle `nulling` flag that
   decides which triangles are real design data vs. auto-generated
   bounding-box scaffold is inferred from this one file's geometry, not
   from any 12d documentation. Worth Cameron confirming the reading (1 =
   scaffold/exclude, 2 = real/keep) is right, and ideally testing against
   a second, differently-shaped surface (a real design pad/finished-grade
   surface, not a "Quick Tin" test file) to see if it generalises.
7. **The 0.9m test cover-depth surface is explicitly a placeholder** —
   worth confirming with Cameron whether that's a reasonable assumption
   to keep using for further testing, or whether he'd rather it use a
   different default (or per-service-type default) once more services
   are loaded.
8. **"K2 Plant Grid" transform to GDA2020/MGA50** — see "CRS handling"
   above. Needed before `K2_FW_Combined_ISO_Reference_Model.ifc` (or
   any other plant-grid-authored file) can be placed on the map or in
   the 3D scene at all.
9. **3D scene blank-render issue** — see "Known issues." A screenshot or
   a devtools report from Cameron's own browser (console errors, canvas
   presence/size, WebGL context status) would help pin this down faster
   than further remote guessing.
10. **IFC design geometry isn't included in the section view yet** — see
    "Section view now shows crossing layers." Only worth doing if the 2D
    page starts keeping the actual loaded IFC mesh around (it currently
    only tracks a bounding-box footprint) — flag if this matters enough
    to prioritise.
11. **Surface elevation-difference / cut-fill volume comparison** —
    Cameron confirmed the simple A/B visibility toggle (see "simple A/B
    compare control") as the right first step for comparing dated
    surfaces (e.g. monthly drone flights); a real elevation-delta map or
    cut/fill volume calculation between two surfaces is still open,
    meaningfully bigger future work (needs interpolating one surface's
    elevation at arbitrary points of another, since two independent
    drone-flight TINs won't share a triangulation) — revisit once the
    simple toggle has been used for a while and its limits are clearer.
12. **Design linework and surfaces have no 3D rendering yet** — the
    2D → 3D carry-over (see that section above) only replays IFC and
    services, since those are the only two the 3D scene actually knows
    how to draw. Building 3D support for `full_tin` surfaces (a real
    triangle mesh, not the 2D page's flat-polygon-per-triangle rendering)
    and for design linework (extruded/drawn similarly to services) would
    let the carry-over cover everything the 2D page can load — worth
    doing if the 3D scene becomes more than a deprioritised POC again.
13. **Deployment** — the repo is pushed (private), but not deployed
    anywhere yet. Cameron's stated real need is people without GitHub
    accounts being able to open and use the app directly (not browse the
    code), so the plan is a separate hosted deployment (Netlify/Vercel/
    Cloudflare Pages all support this: connect to the private GitHub
    repo, build with `npm run build` — now correctly outputs both
    `index.html` and `3d.html`, see the pre-deployment `vite.config.js`
    fix above — set `VITE_MAPBOX_TOKEN` as a build-time environment
    variable there instead of `.env.local`, serve `dist/`), giving a
    plain URL anyone can open. Not yet done — next step once Cameron
    picks a host.

    **Known limit of deploying as-is (confirmed 2026-08-31)**: uploaded
    design/services/surface data lives only in the browser that uploaded
    it (in-memory on the 2D page, and in that same browser's own
    IndexedDB for the 2D→3D carry-over — see that section above) — it is
    NOT shared between different people or devices. Cameron confirmed
    the intended model is "one custodian uploads (him), everyone else
    just views/interrogates, no one else can upload" — real shared
    storage with enforced write permissions needs at least a minimal
    backend, which K2 doesn't have. **Decided (2026-08-31) to build that
    in the separate `progressive-spatial-platform` repo instead**
    (which already plans per-site client access / read-only share links
    as its own phase), not by adding a backend to K2. Practical effect: a
    deployed K2, for
    now, works as a single-operator tool — whoever's browser it's
    running in sees only what THAT browser has uploaded, refreshed or
    not; it does not yet do "I upload once, anyone with the link sees
    it."
