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
// Many IFC exports omit this or set it to identity; don't assume it's
// populated. When absent, the model must be manually aligned using a
// known survey coordinate for some reference point in the model
// (ask Cameron for the project base point survey coordinate — see
// brief's "Sample Data Needed" list).

import * as OBC from "@thatopen/components";

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
 * Load an IFC File (from an <input type=file>) into the scene.
 * Returns the raw buffer too, in case caller wants to re-parse headers
 * (e.g. for georeference extraction with a lower-level web-ifc API later).
 */
export async function loadIfcFile(ifcLoader, file, modelId = "design") {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const model = await ifcLoader.load(buffer, false, modelId);
  return { model, buffer };
}

/**
 * Placeholder for georeference extraction. web-ifc's high-level Components
 * API does not currently surface IfcMapConversion directly — pulling it
 * requires either the lower-level web-ifc property-query API or a
 * pre-pass with an IFC STEP parser (e.g. ifcopenshell, offline). Left
 * as a documented gap rather than a guessed implementation: verify the
 * exact API against a real K2 IFC file before writing this, since a
 * silently-wrong georeference transform is worse than an explicit TODO.
 */
export function extractGeoreference(_buffer) {
  throw new Error(
    "extractGeoreference() not implemented yet — needs a real IFC file " +
      "to test against (see brief's Sample Data list) before writing " +
      "the IfcMapConversion parsing logic."
  );
}
