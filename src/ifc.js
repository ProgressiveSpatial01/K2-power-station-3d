// ifc.js — IFC loading via @thatopen/components.
//
// NOTE ON LIBRARY CHOICE: the project brief suggested `web-ifc-three`.
// As of writing (2026-08-24) that package is deprecated by its own
// maintainers ("THIS LIBRARY IS DEPRECATED. USE COMPONENTS INSTEAD" —
// github.com/ThatOpen/web-ifc-three). The same org's actively
// maintained successor is `@thatopen/components`, still built on the
// core `web-ifc` WASM parser, so the "lightweight, direct Three.js
// integration" reasoning in the brief still applies — just via the
// current package. Flagging this substitution explicitly per Cameron's
// working-style note to confirm APIs before writing implementation code.
//
// IFC georeferencing (project base point / true north) is read from
// IfcMapConversion (IFC4) where present — see extractGeoreference().
// Validated against a real K2 file: GT11_Foundation_Reference_Model.ifc
// (Kwinana K2 / GT11 foundation) carries a genuine IFCMAPCONVERSION
// entity — E 384899.031, N 6434081.091, RL(AHD) 5.55, no rotation
// (XAxisAbscissa=1, XAxisOrdinate=0), scale 1. Cameron has confirmed
// K2 IFC files will be authored in GDA2020/MGA Zone 50, matching the
// working CRS in crs.js.

import * as OBC from "@thatopen/components";
import * as THREE from "three";
import { mgaToScene } from "./crs.js";

/**
 * Set up an IfcLoader + FragmentsManager wired into the given world/scene.
 * Call once per app lifetime.
 */
export async function setupIfcLoader(components, world) {
  const ifcLoader = components.get(OBC.IfcLoader);
  await ifcLoader.setup({
    autoSetWasm: false,
    wasm: {
      // Pinned to match @thatopen/components@3.4.8's own "web-ifc"
      // dependency (checked via registry.npmjs.org 2026-08-24). If you
      // bump @thatopen/components, re-check this pin — a mismatched
      // WASM build is a common source of confusing parse failures.
      path: "https://unpkg.com/web-ifc@0.0.77/",
      absolute: true,
    },
  });

  const workerUrl = await OBC.FragmentsManager.getWorker();
  const fragments = components.get(OBC.FragmentsManager);
  fragments.init(workerUrl);

  fragments.list.onItemSet.add(({ value: model }) => {
    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
    fragments.core.update(true);
  });

  return { ifcLoader, fragments };
}

/**
 * Load an IFC File (from an <input type=file>) into the scene, and wait
 * until the resulting model's geometry has actually landed in the scene
 * graph before resolving.
 *
 * IMPORTANT — two separate async gaps found empirically, not from docs:
 *  1. `ifcLoader.load()`'s own promise resolves BEFORE the model is even
 *     added to the scene — you have to wait for the
 *     `fragments.list.onItemSet` event instead (same event
 *     setupIfcLoader() uses to add the model to the scene).
 *  2. `onItemSet` itself fires BEFORE the model's mesh geometry is
 *     actually populated (`model.object` exists with the right name, but
 *     its child mesh's geometry has zero vertices at that instant) —
 *     confirmed by inspecting the live scene graph: a Box3 computed
 *     right after onItemSet still came back zero-size, while the same
 *     check ~1.5s later (after that mesh had 600 verts and a bounding
 *     box exactly matching the IFC's own OverallLength/OverallWidth
 *     property values) was correct. So we additionally poll for real
 *     geometry to appear before resolving.
 *
 * Any caller that needs to measure/position the model (as
 * computeIfcPlacement() below does) MUST go through this function, not
 * call ifcLoader.load() directly.
 *
 * `modelId` defaults to a fresh id per call (not a fixed "design"
 * string) — found by hitting it directly: loading a second IFC file in
 * the same page session under a REUSED id corrupted the FragmentsManager
 * /scene graph (some prior model's object ended up parented into a
 * cycle), which surfaced as a `RangeError: Maximum call stack size
 * exceeded` inside `Box3.setFromObject`'s recursive traversal — a
 * generic-looking error that took some digging to trace back to this.
 * If you ever need a *stable* id across reloads of the same design
 * (e.g. to explicitly replace/dispose a specific model), pass one
 * explicitly and make sure to dispose the old model first.
 */
let modelIdCounter = 0;
export async function loadIfcFile(components, ifcLoader, file, modelId = `design-${Date.now()}-${modelIdCounter++}`) {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const fragments = components.get(OBC.FragmentsManager);

  const modelReady = new Promise((resolve) => {
    const handler = (event) => {
      fragments.list.onItemSet.remove(handler);
      resolve(event.value);
    };
    fragments.list.onItemSet.add(handler);
  });

  await ifcLoader.load(buffer, false, modelId);
  const model = await modelReady;
  await waitForGeometry(model.object);
  return { model, buffer };
}

/** Poll until `object3d` contains at least one mesh with vertex data. */
function waitForGeometry(object3d, { timeoutMs = 8000, pollMs = 50 } = {}) {
  const hasGeometry = () => {
    let found = false;
    object3d.traverse((child) => {
      if (child.isMesh && child.geometry?.attributes?.position?.count > 0) {
        found = true;
      }
    });
    return found;
  };

  return new Promise((resolve, reject) => {
    if (hasGeometry()) return resolve();
    const start = performance.now();
    const interval = setInterval(() => {
      if (hasGeometry()) {
        clearInterval(interval);
        resolve();
      } else if (performance.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`Timed out waiting for IFC geometry to populate (>${timeoutMs}ms).`));
      }
    }, pollMs);
  });
}

/**
 * Does an IfcProjectedCRS name look like real GDA2020/MGA Zone 50, as
 * opposed to some other CRS entirely or (seen in real K2 data,
 * 2026-08-24) a project-local "Plant Grid"? A `IFCMAPCONVERSION` entity
 * is only safe to feed straight into crs.js's MGA50 functions if this
 * is true — see the loud caveat on extractGeoreference() below. Kept
 * deliberately narrow (must actually say "GDA2020" and "MGA" and "50")
 * rather than trying to guess-normalise every possible spelling.
 */
export function looksLikeGda2020Mga50(crsName) {
  if (!crsName) return false;
  const s = crsName.toLowerCase();
  return s.includes("gda2020") && s.includes("mga") && /(?:^|\D)50(?:\D|$)/.test(s);
}

/**
 * Extract IfcMapConversion (+ IfcProjectedCRS name) from raw IFC STEP text
 * via a small targeted regex scan, rather than a full STEP parse — IFC
 * STEP files are plain ASCII/UTF-8 and these entities have a flat,
 * predictable argument list, so this is proportionate for a POC. If it
 * ever misses real-world variation (line-wrapped entities, alternate
 * whitespace), prefer fixing the regex over silently falling back to an
 * un-georeferenced placement.
 *
 * *** DO NOT ASSUME THE OFFSETS ARE REAL GDA2020/MGA50 COORDINATES ***
 * Found in real K2 data (2026-08-24, a different/larger IFC file than
 * the GT11 sample this module was originally validated against): an
 * `IFCMAPCONVERSION` whose target `IfcProjectedCRS` is named
 * **"K2 Plant Grid"**, with eastingOffset/northingOffset of (0, 0) — a
 * project-local plant grid, not a real survey coordinate system. Every
 * caller MUST check `isKnownMga50` (from `looksLikeGda2020Mga50()`)
 * before feeding `eastingOffset`/`northingOffset` through crs.js's
 * MGA50 functions or treating them as real-world coordinates — doing
 * so for a plant-grid file would silently place the design at MGA50
 * (0,0), nowhere near WA. If a K2 file uses a local plant grid, ask
 * Cameron whether a known transform (offset + rotation, presumably
 * tied to real survey control) exists from that grid to GDA2020/MGA50
 * — don't invent one.
 *
 * @param {Uint8Array} buffer - raw IFC file bytes
 * @returns {null | {
 *   eastingOffset: number, northingOffset: number, heightOffset: number,
 *   xAxisAbscissa: number, xAxisOrdinate: number, scale: number,
 *   crsName: string | null, isKnownMga50: boolean
 * }}
 */
export function extractGeoreference(buffer) {
  const text = new TextDecoder("utf-8").decode(buffer);

  // #20=IFCMAPCONVERSION(#16,#19,384899.031,6434081.091,5.55,1.,0.,1.);
  const mapConvMatch = text.match(
    /IFCMAPCONVERSION\(\s*#\d+\s*,\s*#(\d+)\s*,\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+)(?:,\s*([^),]+))?\s*\)/
  );
  if (!mapConvMatch) return null;

  const [, crsRef, eastings, northings, height, xAbscissa, xOrdinate, scale] =
    mapConvMatch;

  let crsName = null;
  const crsEntityRe = new RegExp(
    `#${crsRef}=IFCPROJECTEDCRS\\('([^']*)'`
  );
  const crsMatch = text.match(crsEntityRe);
  if (crsMatch) crsName = crsMatch[1];

  const isKnownMga50 = looksLikeGda2020Mga50(crsName);
  if (!isKnownMga50) {
    console.warn(
      `[ifc] IFCMAPCONVERSION target CRS is "${crsName}", not recognised as ` +
        "GDA2020/MGA Zone 50 — its eastingOffset/northingOffset are NOT being " +
        "treated as real-world coordinates. See extractGeoreference() in ifc.js."
    );
  }

  return {
    eastingOffset: Number(eastings),
    northingOffset: Number(northings),
    heightOffset: Number(height),
    xAxisAbscissa: Number(xAbscissa),
    xAxisOrdinate: Number(xOrdinate),
    scale: scale !== undefined ? Number(scale) : 1,
    crsName,
    isKnownMga50,
  };
}

/**
 * Turn an extractGeoreference() result into a rigid placement
 * (position + Y-axis rotation) for the loaded model's root object
 * (`model.object`), in scene metres relative to `sceneOriginMga`.
 *
 * Derivation: IfcMapConversion maps a model-local point (x,y,z) to
 * map coordinates via a 2D rotation + scale in the XY plane:
 *   E = E0 + s*(x*a - y*b)
 *   N = N0 + s*(x*b + y*a)
 *   H = H0 + z
 * (buildingSMART IfcMapConversion spec; a,b = XAxisAbscissa/Ordinate,
 * typically a unit vector so theta = atan2(b, a)).
 *
 * *** AXIS-SWAP ASSUMPTION — VERIFIED 2026-08-24 ***
 * This assumes the Components/Fragments loader places model-local
 * (x, y, z) into Three.js scene space as (x, z, -y) — i.e. the
 * conventional IFC Z-up -> Three.js Y-up swap used by most IFC-in-
 * Three.js loaders. Not documented anywhere I could find in
 * @thatopen's docs, so confirmed empirically instead: loaded the real
 * GT11_Foundation_Reference_Model.ifc, read the resulting mesh's
 * bounding box directly out of the live Three.js scene graph, and got
 * 21.37 x 4.04 x 7.50 m (X x Y x Z) — X and Z match the IFC's own
 * Pset_GT11_MainFoundation.OverallLength (21.37) and OverallWidth (7.5)
 * exactly, Y matches the model's known top-to-bottom extent (blinding
 * underside at local Z=-0.05 to motor plinth top at local Z=3.99).
 * Re-verify this the same way (see git history around this comment, or
 * the README's "IFC georeferencing" section) if @thatopen/components
 * is upgraded across a major version — an internal convention like this
 * is exactly the kind of thing that could change without being called
 * out as a breaking change.
 *
 * @param {ReturnType<typeof extractGeoreference>} georef
 * @param {[number, number, number]} sceneOriginMga
 * @returns {{ position: [number, number, number], rotationY: number }}
 */
export function computeIfcPlacement(georef, sceneOriginMga) {
  const { eastingOffset, northingOffset, heightOffset, xAxisAbscissa, xAxisOrdinate, scale, isKnownMga50, crsName } =
    georef;

  if (!isKnownMga50) {
    throw new Error(
      `Refusing to place this model: its IfcMapConversion target CRS ("${crsName}") ` +
        "is not recognised as GDA2020/MGA Zone 50, so its offset is not a trustworthy " +
        "real-world coordinate (see extractGeoreference() in ifc.js). Confirm the " +
        "correct transform with Cameron before placing this design."
    );
  }

  // Position of the model's local (0,0,0) in scene space.
  const position = mgaToScene(
    [eastingOffset, northingOffset, heightOffset],
    sceneOriginMga
  );

  // Rotation of the model's local XY axes relative to true E/N, applied
  // as a Three.js Y-axis rotation post the loader's own Z-up->Y-up swap
  // (see derivation note above — the two rotations are equivalent under
  // that swap).
  const rotationY = Math.atan2(xAxisOrdinate, xAxisAbscissa);

  if (Math.abs(scale - 1) > 1e-6) {
    console.warn(
      `[K2-3D] IfcMapConversion scale is ${scale}, not 1 — this function ` +
        "does not apply it to the model's own geometry (only to the " +
        "origin offset), so scaled models will be positioned but not " +
        "resized. Uncommon in practice; flagging rather than guessing."
    );
  }

  return { position, rotationY };
}

/**
 * Fallback georeference for IFC files with NO `IFCMAPCONVERSION` at all,
 * whose raw geometry coordinates are themselves already real-world MGA50
 * values — found 2026-08-26 in a real K2 IFC export ("Sample IFC.ifc",
 * GT11 Stack Foundation): every `IFCCARTESIANPOINT` in its geometry is a
 * real easting/northing (e.g. `384928.653, 6434079.441, 5.55`) directly,
 * with the placement hierarchy chaining to local (0,0,0) — a third
 * pattern, different from both GT11's own IfcMapConversion-offset
 * approach and the "K2 Plant Grid" local-CRS case already handled above.
 *
 * Loading large real-world coordinates directly as mesh geometry risks
 * exactly the float32 precision problem documented on
 * computeFootprintCornersScene() above (that one was from a position
 * *transform* I applied; this is the same class of problem but baked
 * into the parsed geometry itself). Rather than build a workaround,
 * this uses `@thatopen/components`' own answer to it: `IfcLoader`
 * defaults `settings.webIfc.COORDINATE_TO_ORIGIN` to `true` (confirmed
 * by reading the installed package source directly, not guessed —
 * docs on this specific setting were thin) — web-ifc detects large
 * coordinates during parsing and re-centres the model near the origin
 * internally, exposing what it subtracted via
 * `model.getCoordinationMatrix()`. This function reads that back.
 *
 * @param {*} model - loaded model from loadIfcFile()
 * @returns {Promise<{ easting: number, northing: number, height: number, isPlausibleMga50: boolean }>}
 */
export async function resolveCoordinationOffset(model) {
  const matrix = await model.getCoordinationMatrix(); // THREE.Matrix4
  // Axis mapping below is EMPIRICAL, not derived from docs or source —
  // @thatopen/components' own CoordinatesManager.getCoordinationMatrix()
  // (a wrapper around the raw web-ifc API, not the same thing as
  // web-ifc's own GetCoordinationMatrix()) does NOT simply put
  // [easting, northing, height] in elements[12,13,14] as the naive
  // reading of web-ifc's own docs/examples would suggest. Tested against
  // Sample_IFC.ifc (real known coordinates ~E384928, ~N6434079, ~H5.55):
  // got back {elements[12]: -384928.653, elements[13]: -5.55,
  // elements[14]: 6434079.441} — i.e. (-E, -H, N), not (E, N, H). Verify
  // again with a second real no-IfcMapConversion file if one shows up;
  // don't assume this generalises beyond what's been tested.
  const easting = -matrix.elements[12];
  const height = -matrix.elements[13];
  const northing = matrix.elements[14];
  // Sanity range for GDA2020/MGA Zone 50 in WA — cheap guard against
  // misreading a coordination matrix that's actually near-identity
  // (e.g. a file whose own geometry was already small/local) as if it
  // were a real offset. Not a CRS-name check like looksLikeGda2020Mga50()
  // (there's no CRS name available here at all) — just a plausibility
  // range check.
  const isPlausibleMga50 =
    easting > 200000 && easting < 900000 && northing > 6000000 && northing < 8000000;
  return { easting, northing, height, isPlausibleMga50 };
}

/**
 * Compute a real (if approximate) 2D footprint for an already-placed
 * model, as an axis-aligned bounding-box outline in scene XZ — i.e. the
 * horizontal-plane bounding box of the model's world-space geometry
 * (which, after computeIfcPlacement() has positioned/rotated it, is a
 * real MGA-relative axis-aligned rectangle, not a local-space one).
 *
 * Used for the 2D map, which previously only had a single project-base-
 * point marker (see README "2D IFC footprint") — a bounding rectangle is
 * a much better outline than a point, and reuses the exact bounding-box
 * logic already verified against GT11 (its rectangle matches
 * Pset_GT11_MainFoundation.OverallLength/OverallWidth exactly). It's
 * NOT a true footprint polygon for non-rectangular or rotated designs —
 * an axis-aligned box around a rotated building would be looser than
 * the building's actual outline. Worth upgrading to a real 2D convex
 * hull (or the actual plan profile) if that gap matters in practice;
 * flagged rather than silently treated as exact.
 *
 * @param {*} model - the loaded model from loadIfcFile(), already
 *   positioned/rotated via computeIfcPlacement()
 * @returns {Array<[number, number]>} 4 corners [x, z] in scene metres,
 *   winding order: (minX,minZ) (maxX,minZ) (maxX,maxZ) (minX,maxZ)
 */
export function computeFootprintCornersScene(model) {
  const box = new THREE.Box3().setFromObject(model.object);
  return [
    [box.min.x, box.min.z],
    [box.max.x, box.min.z],
    [box.max.x, box.max.z],
    [box.min.x, box.max.z],
  ];
}
