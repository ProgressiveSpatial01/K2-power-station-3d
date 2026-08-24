// main.js — Phase A scaffold: one Three.js scene holding terrain + an
// IFC design + (new) 12d-sourced underground services, all sharing a
// common local-metres coordinate space anchored to a GDA2020/MGA50 scene
// origin. This is deliberately minimal — the point of Phase A/early
// Phase B is proving these can live in one correctly-georeferenced
// scene, not UI polish.

import * as OBC from "@thatopen/components";
import * as THREE from "three";
import { getCurrentTerrain, buildTestSurfaceAbovePipes } from "./terrain.js";
import { setupIfcLoader, loadIfcFile, extractGeoreference, computeIfcPlacement } from "./ifc.js";
import { loadTwelveDaFile } from "./twelve-d.js";
import { buildServiceMeshes } from "./services.js";
import { roundTripCheck } from "./crs.js";

const statusEl = document.getElementById("status");
function setStatus(msg) {
  statusEl.textContent = msg;
  console.log("[K2-3D]", msg);
}

// Scene origin in GDA2020/MGA50 — the real GT11 project base point
// ("SOP 1") read from GT11_Foundation_Reference_Model.ifc's own
// IFCMAPCONVERSION entity: E 384899.031, N 6434081.091, RL(AHD) 5.55.
// Using a real site point (rather than an arbitrary placeholder) means
// everything loaded so far — this IFC model, and the sample 12d
// services nearby — sits at sane, human-readable coordinates close to
// scene (0,0,0) instead of thousands of metres away.
const SCENE_ORIGIN_MGA = [384899.031, 6434081.091, 5.55]; // [easting, northing, AHD]
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

  await world.camera.controls.setLookAt(60, 45, 60, 0, 0, 0);

  // Basic ground-plane grid for scale reference.
  const grid = components.get(OBC.Grids);
  grid.create(world);

  setStatus("Loading terrain…");
  const terrainState = { mesh: null };
  const { mesh: initialTerrainMesh, warning } = await getCurrentTerrain("K2", SCENE_ORIGIN_MGA);
  terrainState.mesh = initialTerrainMesh;
  world.scene.three.add(terrainState.mesh);
  setStatus(warning ?? "Terrain loaded.");

  setStatus("Setting up IFC loader…");
  const { ifcLoader } = await setupIfcLoader(components, world);
  setStatus("Ready — choose an .ifc design and/or a .12da/.12daz services file.");

  wireIfcInput(components, ifcLoader);
  wireServicesInput(world, terrainState);
}

function wireIfcInput(components, ifcLoader) {
  const fileInput = document.getElementById("ifc-input");
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus(`Loading ${file.name}…`);
    try {
      const { model, buffer } = await loadIfcFile(components, ifcLoader, file);

      const georef = extractGeoreference(buffer);
      if (georef) {
        const { position, rotationY } = computeIfcPlacement(georef, SCENE_ORIGIN_MGA);
        model.object.position.set(...position);
        model.object.rotation.y = rotationY;

        const box = new THREE.Box3().setFromObject(model.object);
        const size = new THREE.Vector3();
        box.getSize(size);
        console.log(
          "[K2-3D] IFC georeferenced:",
          { georef, position, rotationYDeg: (rotationY * 180) / Math.PI },
          "post-placement bounding box size (X,Y,Z):",
          size.toArray()
        );
        setStatus(
          `Loaded ${file.name}, georeferenced (${georef.crsName ?? "CRS name not found"}) ` +
            `at MGA50 E${georef.eastingOffset} N${georef.northingOffset}. ` +
            `Bounding box ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} m — ` +
            "check console: verify X/Z roughly match the design's known plan dimensions " +
            "(see ifc.js computeIfcPlacement() caveat) before trusting this placement."
        );
      } else {
        setStatus(
          `Loaded ${file.name}. NO IfcMapConversion found — model sits at scene origin ` +
            "using its own local IFC coordinates, not georeferenced."
        );
      }
    } catch (err) {
      console.error(err);
      setStatus(`Failed to load ${file.name}: ${err.message}`);
    }
  });
}

function wireServicesInput(world, terrainState) {
  const fileInput = document.getElementById("services-input");
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus(`Loading ${file.name}…`);
    try {
      const records = await loadTwelveDaFile(file);
      console.log("[K2-3D] Parsed 12d records:", records);
      const group = buildServiceMeshes(records, SCENE_ORIGIN_MGA);
      world.scene.three.add(group);

      // TEST-ONLY, per Cameron (2026-08-24): swap the terrain reference
      // plane for one sitting ~0.9m above the loaded pipes' top-of-pipe
      // elevation, purely as a plausible stand-in surface until real
      // terrain exists — see terrain.js buildTestSurfaceAbovePipes().
      world.scene.three.remove(terrainState.mesh);
      terrainState.mesh.geometry.dispose();
      terrainState.mesh.material.dispose();
      terrainState.mesh = buildTestSurfaceAbovePipes(records, SCENE_ORIGIN_MGA);
      world.scene.three.add(terrainState.mesh);
      const { coverDepthM, surfaceAhd } = terrainState.mesh.userData;

      setStatus(
        `Loaded ${file.name}: ${records.length} service string(s) added ` +
          `(surveyed depth, justify-corrected). Terrain replaced with a TEST ` +
          `surface ${coverDepthM}m above the pipes (RL ${surfaceAhd.toFixed(2)} AHD) — ` +
          "not real terrain, see terrain.js."
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
