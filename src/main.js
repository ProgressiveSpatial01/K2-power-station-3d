// main.js — Phase A scaffold: one Three.js scene holding terrain + an
// IFC design + 12d-sourced underground services + 12d surfaces + (new
// 2026-09-10) 12d design linework, all sharing a common local-metres
// coordinate space anchored to a GDA2020/MGA50 scene origin. This is
// deliberately minimal — the point of Phase A/early Phase B is proving
// these can live in one correctly-georeferenced scene, not UI polish.

import * as OBC from "@thatopen/components";
import * as THREE from "three";
import { getCurrentTerrain, buildTestSurfaceAbovePipes } from "./terrain.js";
import {
  setupIfcLoader,
  loadIfcFile,
  extractGeoreference,
  computeIfcPlacement,
  resolveCoordinationOffset,
} from "./ifc.js";
import { loadTwelveDaFile } from "./twelve-d.js";
import { buildServiceMeshes } from "./services.js";
import { buildSurfaceMeshes } from "./surfaces-3d.js";
import { buildDesignLineworkMeshes } from "./design-linework-3d.js";
import { roundTripCheck, mgaToScene } from "./crs.js";
import {
  getCustodianSecret,
  setCustodianSecret,
  listSharedFiles,
  fetchSharedFile,
  uploadSharedFile,
  deleteSharedFile,
} from "./shared-remote-store.js";

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
  setStatus("Ready — choose a design (.ifc/.12da/.12daz) and/or a .12da/.12daz services file.");

  const ctx = { components, ifcLoader, world, terrainState, layers: [] };
  wireDesignInput(ctx);
  wireServicesInput(ctx);
  wireCustodianMode();
  await loadSharedFiles(ctx);
}

// --- Layers panel (2026-09-10) --------------------------------------
//
// Per Cameron: "probably need the ability to toggle layers on and off
// in the 3d view" — previously everything loaded just piled into the
// scene with no way to isolate anything. One row per loaded FILE (not
// a full nested per-model-path tree like the 2D sidebar's — that's a
// materially bigger feature; this is the useful middle ground: hide
// "that one services upload" or "that one surface" without digging
// through the whole scene). A design file that contains BOTH surfaces
// and linework registers as two separate rows, since they're toggled
// independently.
//
// `objects` holds whatever THREE.Object3D(s) this layer's checkbox
// should show/hide — for a services/surfaces/linework Group, `.visible`
// cascades to every descendant automatically; for an IFC model there's
// no wrapping group (see ifc.js's onItemSet — it adds model.object
// straight to the scene), so the model's own object goes in the array
// directly. No terrain toggle: terrainState.mesh gets fully replaced
// (old one disposed) whenever a services file loads — see
// handleServicesFile() — so a captured reference to it would go stale
// the moment that happens.

function registerLayer(ctx, { label, kind, objects }) {
  ctx.layers.push({ label, kind, objects, visible: true });
  renderLayersList(ctx);
}

function renderLayersList(ctx) {
  const container = document.getElementById("layers-list");
  if (ctx.layers.length === 0) {
    container.innerHTML = `<p class="shared-files-empty">Nothing loaded yet.</p>`;
    return;
  }
  container.innerHTML = "";
  for (const layer of ctx.layers) {
    const row = document.createElement("label");
    row.className = "layer-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = layer.visible;
    checkbox.addEventListener("change", () => {
      layer.visible = checkbox.checked;
      for (const obj of layer.objects) obj.visible = layer.visible;
    });
    const nameEl = document.createElement("span");
    nameEl.className = "layer-row-label";
    nameEl.textContent = layer.label;
    nameEl.title = layer.label;
    row.append(checkbox, nameEl);
    container.appendChild(row);
  }
}

/**
 * Handles one .ifc File regardless of where it came from — a real file-
 * picker change event, or a shared-storage replay (see loadSharedFiles()).
 * Unwrapped from wireIfcInput()'s event listener into a standalone
 * function (2026-08-28) so both paths call the exact same logic; no
 * separate "load from storage" code path to drift out of sync with a
 * live upload.
 * @param {{ skipSharing?: boolean }} [opts] - `skipSharing: true` when replaying a file we just DOWNLOADED from shared storage — otherwise it'd immediately try to re-upload the same file back to shared storage.
 */
async function handleIfcFile(file, ctx, opts = {}) {
  setStatus(`Loading ${file.name}…`);
  try {
    const { model, buffer } = await loadIfcFile(ctx.components, ctx.ifcLoader, file);

    const georef = extractGeoreference(buffer);

    if (georef && !georef.isKnownMga50) {
      // "K2 Plant Grid" and friends — the offset isn't a real-world
      // coordinate (see ifc.js extractGeoreference()). The 2D page
      // already refuses this case; 3D used to fall through to the "no
      // georef" branch below and silently leave the model at the scene
      // origin. Take it out of the scene rather than show it somewhere
      // wrong. (onItemSet in ifc.js has already added it.)
      model.object.removeFromParent();
      console.warn("[K2-3D] Untrusted IfcMapConversion CRS, model not placed:", georef);
      setStatus(
        `${file.name}'s IfcMapConversion target CRS is "${georef.crsName}", not GDA2020/MGA50 — ` +
          "not placing it without a known transform from that grid. Ask Cameron. See console."
      );
      return;
    }

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
      // No IFCMAPCONVERSION. Real K2 exports have been seen (e.g.
      // "Sample IFC.ifc", GT11 Stack Foundation) with real GDA2020/MGA50
      // coordinates baked straight into the geometry instead — web-ifc's
      // COORDINATE_TO_ORIGIN re-centres those near the origin on load and
      // exposes what it subtracted via the coordination matrix. The 2D
      // page has always handled this (resolveCoordinationOffset); 3D
      // didn't, so these files just sat at the scene origin — nowhere
      // near their real location. That's the bug Cameron hit: "the .ifc
      // in the 3d view is defaulting to a place away from its actual
      // location ... loads in the correct place on the 2d view".
      const offset = await resolveCoordinationOffset(model);
      if (!offset.isPlausibleMga50) {
        model.object.removeFromParent();
        console.warn("[K2-3D] Coordination offset outside plausible MGA50 range, model not placed:", offset);
        setStatus(
          `${file.name} has no IFCMAPCONVERSION and its geometry's own coordinates don't look ` +
            "like GDA2020/MGA50 either — not placing it. See console."
        );
        return;
      }
      const position = mgaToScene([offset.easting, offset.northing, offset.height], SCENE_ORIGIN_MGA);
      model.object.position.set(...position);

      const box = new THREE.Box3().setFromObject(model.object);
      const size = new THREE.Vector3();
      box.getSize(size);
      console.log(
        "[K2-3D] IFC placed from geometry coordinates (no IFCMAPCONVERSION):",
        { offset, position },
        "post-placement bounding box size (X,Y,Z):",
        size.toArray()
      );
      setStatus(
        `Loaded ${file.name}. No IFCMAPCONVERSION — placed from its geometry's own real-world ` +
          `coordinates (web-ifc COORDINATE_TO_ORIGIN) at MGA50 E${offset.easting.toFixed(3)} ` +
          `N${offset.northing.toFixed(3)}. Bounding box ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ` +
          `${size.z.toFixed(2)} m — check it lines up with the 2D view.`
      );
    }
    registerLayer(ctx, { label: file.name, kind: "ifc", objects: [model.object] });
    if (!opts.skipSharing) await shareIfCustodian("design", file, null);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load ${file.name}: ${err.message}`);
  }
}

/**
 * "Design" 12d files (.12da/.12daz) can contain surfaces (`full_tin`
 * records) and/or design linework (`string` records) — see twelve-d.js.
 * Both render in 3D: surfaces via surfaces-3d.js, linework via
 * design-linework-3d.js (added 2026-09-10, per Cameron: "can we go with
 * the 3d linework as well, it will be handy i think" — surfaces landed
 * first, this closes the gap).
 * @param {{ skipSharing?: boolean }} [opts]
 */
async function handleDesign12dFile(file, ctx, opts = {}) {
  setStatus(`Loading ${file.name}…`);
  try {
    const records = await loadTwelveDaFile(file);
    console.log("[K2-3D] Parsed design 12d records:", records);

    const hasSurfaces = records.surfaces.length > 0;
    const hasLinework = records.length > 0;

    if (!hasSurfaces && !hasLinework) {
      const unrecognized = [...records.unrecognizedTopLevelKeys].filter((k) => k !== "null");
      setStatus(
        unrecognized.length > 0
          ? `${file.name} has no linework or surface data — found unrecognised block(s): ${unrecognized.join(", ")}. See console.`
          : `${file.name} has no linework or surface data in it — nothing to show.`
      );
      return;
    }

    const messages = [];
    if (hasSurfaces) {
      const { group, excludedScaffold } = buildSurfaceMeshes(records.surfaces, SCENE_ORIGIN_MGA, file.name);
      ctx.world.scene.three.add(group);
      registerLayer(ctx, { label: `${file.name} — surfaces`, kind: "surfaces", objects: [group] });
      messages.push(
        `${records.surfaces.length} surface(s) added` +
          (excludedScaffold > 0 ? ` (${excludedScaffold} scaffold triangle(s) excluded, see console)` : "")
      );
    }
    if (hasLinework) {
      const { group, skippedShort } = buildDesignLineworkMeshes(records, SCENE_ORIGIN_MGA);
      ctx.world.scene.three.add(group);
      registerLayer(ctx, { label: `${file.name} — linework`, kind: "linework", objects: [group] });
      messages.push(
        `${records.length - skippedShort} design linework string(s) added` +
          (skippedShort > 0 ? ` (${skippedShort} point/symbol record(s) skipped)` : "")
      );
    }
    setStatus(`Loaded ${file.name}: ${messages.join("; ")}.`);
    if (!opts.skipSharing) await shareIfCustodian("design", file, null);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load ${file.name}: ${err.message}`);
  }
}

/**
 * The "Design" upload slot accepts more than one format, same as the 2D
 * page — routes by extension.
 */
function wireDesignInput(ctx) {
  const fileInput = document.getElementById("design-input");
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (/\.ifc$/i.test(file.name)) {
      await handleIfcFile(file, ctx);
    } else if (/\.12daz?$/i.test(file.name)) {
      await handleDesign12dFile(file, ctx);
    } else {
      setStatus(`Unrecognised design file type: ${file.name} — expected .ifc, .12da, or .12daz.`);
    }
  });
}

/**
 * Handles one 12d services File regardless of where it came from — see
 * handleIfcFile()'s docstring, same reasoning.
 * @param {{ skipSharing?: boolean }} [opts]
 */
async function handleServicesFile(file, ctx, opts = {}) {
  setStatus(`Loading ${file.name}…`);
  try {
    const records = await loadTwelveDaFile(file);
    console.log("[K2-3D] Parsed 12d records:", records);
    const group = buildServiceMeshes(records, SCENE_ORIGIN_MGA);
    ctx.world.scene.three.add(group);
    registerLayer(ctx, { label: file.name, kind: "services", objects: [group] });

    // TEST-ONLY, per Cameron (2026-08-24): swap the terrain reference
    // plane for one sitting ~0.9m above the loaded pipes' top-of-pipe
    // elevation, purely as a plausible stand-in surface until real
    // terrain exists — see terrain.js buildTestSurfaceAbovePipes().
    ctx.world.scene.three.remove(ctx.terrainState.mesh);
    ctx.terrainState.mesh.geometry.dispose();
    ctx.terrainState.mesh.material.dispose();
    ctx.terrainState.mesh = buildTestSurfaceAbovePipes(records, SCENE_ORIGIN_MGA);
    ctx.world.scene.three.add(ctx.terrainState.mesh);
    const { coverDepthM, surfaceAhd } = ctx.terrainState.mesh.userData;

    setStatus(
      `Loaded ${file.name}: ${records.length} service string(s) added ` +
        `(surveyed depth, justify-corrected). Terrain replaced with a TEST ` +
        `surface ${coverDepthM}m above the pipes (RL ${surfaceAhd.toFixed(2)} AHD) — ` +
        "not real terrain, see terrain.js."
    );
    if (!opts.skipSharing) await shareIfCustodian("services", file, null);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load ${file.name}: ${err.message}`);
  }
}

function wireServicesInput(ctx) {
  const fileInput = document.getElementById("services-input");
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await handleServicesFile(file, ctx);
  });
}

// --- Custodian mode / shared storage (2026-09-10) ------------------------
//
// Brings the 3D page up to parity with the 2D page's custodian model
// (main-2d.js, 2026-08-31 — see its own header for the full reasoning):
// one shared backend store (api/shared-*.js + shared-remote-store.js),
// everyone's browser auto-loads whatever's in it on startup, only
// someone who knows CUSTODIAN_SECRET can add or remove from it. The 2D
// and 3D pages talk to the exact SAME backend — a file shared from
// either page shows up on both; this file is deliberately near-identical
// to main-2d.js's equivalent section rather than inventing a different
// shape for the same job.
//
// Replaces the old shared-design-store.js (IndexedDB) local-stash
// replay that used to carry files from the 2D page to the 3D page
// within one browser — now fully superseded by this remote store for
// that same purpose (and safer: replaying BOTH the local stash and the
// remote store here would double-load anything shared via 2D in the
// same browser).

function isCustodianUnlocked() {
  return !!getCustodianSecret();
}

function wireCustodianMode() {
  const toggleBtn = document.getElementById("custodian-toggle");
  const addDataSection = document.getElementById("add-data-section");

  function applyUnlockedState() {
    const unlocked = isCustodianUnlocked();
    addDataSection.style.display = unlocked ? "block" : "none";
    toggleBtn.textContent = unlocked ? "🔓 Custodian mode (unlocked)" : "🔒 Unlock custodian mode";
    toggleBtn.classList.toggle("unlocked", unlocked);
    renderSharedFilesList(lastKnownSharedFiles); // delete buttons only show once unlocked
  }

  toggleBtn.addEventListener("click", () => {
    if (isCustodianUnlocked()) {
      if (confirm("Lock custodian mode again? You can re-enter the key later to unlock it.")) {
        setCustodianSecret(null);
        applyUnlockedState();
      }
      return;
    }
    const entered = prompt("Enter the custodian key (set as CUSTODIAN_SECRET on the server):");
    if (entered) {
      setCustodianSecret(entered);
      applyUnlockedState();
    }
  });

  applyUnlockedState();
}

// Kept so re-rendering the Shared Data list (e.g. right after unlocking,
// before any new fetch) doesn't need to re-fetch from the server.
let lastKnownSharedFiles = [];

function renderSharedFilesList(entries) {
  lastKnownSharedFiles = entries;
  const container = document.getElementById("shared-files-list");
  if (entries.length === 0) {
    container.innerHTML = `<p class="shared-files-empty">Nothing shared yet.</p>`;
    return;
  }
  const unlocked = isCustodianUnlocked();
  container.innerHTML = "";
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "shared-file-row";
    const nameEl = document.createElement("span");
    nameEl.className = "shared-file-name";
    nameEl.textContent = entry.name;
    nameEl.title = entry.name;
    const metaEl = document.createElement("span");
    metaEl.className = "shared-file-meta";
    metaEl.textContent = entry.slot + (entry.subgroupName ? ` · ${entry.subgroupName}` : "");
    row.append(nameEl, metaEl);
    if (unlocked) {
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "shared-file-delete";
      deleteBtn.textContent = "🗑";
      deleteBtn.title =
        "Remove from shared storage — stops loading for future visitors (does not affect what's currently on your own screen)";
      deleteBtn.addEventListener("click", async () => {
        deleteBtn.disabled = true;
        try {
          await deleteSharedFile(entry.id);
          renderSharedFilesList(lastKnownSharedFiles.filter((f) => f.id !== entry.id));
        } catch (err) {
          console.error(err);
          alert(`Failed to remove "${entry.name}" from shared storage: ${err.message}`);
          deleteBtn.disabled = false;
        }
      });
      row.appendChild(deleteBtn);
    }
    container.appendChild(row);
  }
}

/**
 * Fetches the current shared-file manifest and replays every entry
 * through the SAME handlers a live upload uses — so every visitor's
 * scene populates automatically with whatever the custodian has shared,
 * no upload of their own needed or offered. Runs sequentially, not in
 * parallel — several handlers mutate shared scene state (e.g.
 * ctx.terrainState.mesh), so they need to happen one at a time.
 */
async function loadSharedFiles(ctx) {
  let entries;
  try {
    entries = await listSharedFiles();
  } catch (err) {
    console.error("[K2-3D] Failed to load shared files:", err);
    renderSharedFilesList([]);
    return;
  }
  renderSharedFilesList(entries);
  if (entries.length === 0) return;

  setStatus(`Loading ${entries.length} shared file(s)…`);
  for (const entry of entries) {
    try {
      const file = await fetchSharedFile(entry);
      if (entry.slot === "design") {
        if (/\.ifc$/i.test(file.name)) {
          await handleIfcFile(file, ctx, { skipSharing: true });
        } else {
          await handleDesign12dFile(file, ctx, { skipSharing: true });
        }
      } else if (entry.slot === "services") {
        await handleServicesFile(file, ctx, { skipSharing: true });
      }
    } catch (err) {
      console.error(`[K2-3D] Failed to load shared file "${entry.name}":`, err);
    }
  }
}

/**
 * Pushes a just-successfully-loaded file to shared storage, if custodian
 * mode is unlocked — silently skipped otherwise. Never throws — a failed
 * share shouldn't undo the successful LOCAL load the user is already
 * looking at.
 */
async function shareIfCustodian(slot, file, subgroupName) {
  if (!isCustodianUnlocked()) return;
  try {
    await uploadSharedFile({ slot, subgroupName, file });
    const entries = await listSharedFiles();
    renderSharedFilesList(entries);
  } catch (err) {
    console.error("[K2-3D] Failed to share to backend:", err);
    setStatus(`Loaded locally, but failed to share "${file.name}" for other visitors: ${err.message}`);
  }
}

main().catch((err) => {
  console.error(err);
  setStatus(`Fatal error: ${err.message}`);
});
