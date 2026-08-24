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
 */
export async function loadIfcFile(components, ifcLoader, file, modelId = "design") {
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
 * Extract IfcMapConversion (+ IfcProjectedCRS name) from raw IFC STEP text
 * via a small targeted regex scan, rather than a full STEP parse — IFC
 * STEP files are plain ASCII/UTF-8 and these entities have a flat,
 * predictable argument list, so this is proportionate for a POC. If it
 * ever misses real-world variation (line-wrapped entities, alternate
 * whitespace), prefer fixing the regex over silently falling back to an
 * un-georeferenced placement.
 *
 * @param {Uint8Array} buffer - raw IFC file bytes
 * @returns {null | {
 *   eastingOffset: number, northingOffset: number, heightOffset: number,
 *   xAxisAbscissa: number, xAxisOrdinate: number, scale: number,
 *   crsName: string | null
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

  return {
    eastingOffset: Number(eastings),
    northingOffset: Number(northings),
    heightOffset: Number(height),
    xAxisAbscissa: Number(xAbscissa),
    xAxisOrdinate: Number(xOrdinate),
    scale: scale !== undefined ? Number(scale) : 1,
    crsName,
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
  const { eastingOffset, northingOffset, heightOffset, xAxisAbscissa, xAxisOrdinate, scale } =
    georef;

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
