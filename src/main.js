// main.js — Phase A scaffold: one Three.js scene holding placeholder
// terrain + (optionally) a user-loaded IFC model, sharing a common
// local-metres coordinate space anchored to a GDA2020/MGA50 scene origin.
//
// This is deliberately minimal — the point of Phase A is proving IFC
// and terrain can live in the same georeferenced scene, not UI polish.

import * as OBC from "@thatopen/components";
import { getCurrentTerrain } from "./terrain.js";
import { setupIfcLoader, loadIfcFile } from "./ifc.js";
import { CRS, roundTripCheck } from "./crs.js";

const statusEl = document.getElementById("status");
function setStatus(msg) {
  statusEl.textContent = msg;
  console.log("[K2-3D]", msg);
}

// Scene origin in GDA2020/MGA50 — PLACEHOLDER coordinate, not a real K2
// site point. Replace with the actual project base point / a sensible
// site centroid once known (see brief's "Sample Data Needed" list).
const SCENE_ORIGIN_MGA = [400000, 6444000, 5]; // [easting, northing, AHD] — placeholder
{
  const check = roundTripCheck([SCENE_ORIGIN_MGA[0], SCENE_ORIGIN_MGA[1]]);
  console.log("[K2-3D] CRS round-trip check on scene origin:", check);
  if (!check.ok) {
    console.error("[K2-3D] CRS round-trip check FAILED — do not trust transforms:", check);
  }
}

async function main() {
  const container = document.getElementById("app");

  const components = new OBC.Components();
  const worlds = components.get(OBC.Worlds);
  const world = worlds.create();

  world.scene = new OBC.SimpleScene(components);
  world.renderer = new OBC.SimpleRenderer(components, container);
  world.camera = new OBC.OrthoPerspectiveCamera(components);

  components.init();
  world.scene.setup();
  world.scene.three.background = null;

  await world.camera.controls.setLookAt(120, 90, 120, 0, 0, 0);

  // Basic ground-plane grid for scale reference while there's no real terrain.
  const grid = components.get(OBC.Grids);
  grid.create(world);

  setStatus("Loading placeholder terrain…");
  const { mesh: terrainMesh, warning } = await getCurrentTerrain("K2", SCENE_ORIGIN_MGA);
  world.scene.three.add(terrainMesh);
  setStatus(warning ?? "Terrain loaded.");

  setStatus("Setting up IFC loader…");
  const { ifcLoader } = await setupIfcLoader(components, world);
  setStatus("Ready — placeholder terrain loaded. Choose an .ifc file to load a design.");

  const fileInput = document.getElementById("file-input");
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus(`Loading ${file.name}…`);
    try {
      await loadIfcFile(ifcLoader, file);
      setStatus(
        `Loaded ${file.name}. NOTE: not yet georeferenced against ` +
          `${CRS.GDA2020_MGA50} — model sits at the scene origin using ` +
          "its own local IFC coordinates until extractGeoreference() " +
          "(src/ifc.js) is implemented against a real K2 file."
      );
    } catch (err) {
      console.error(err);
      setStatus(`Failed to load ${file.name}: ${err.message}`);
    }
  });
}

main().catch((err) => {
  console.error(err);
  setStatus(`Fatal error: ${err.message}`);
});
