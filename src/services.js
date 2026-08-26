// services.js — turn parsed 12d service strings (see twelve-d.js) into 3D
// pipe/conduit meshes in the shared scene.
//
// Phase B scope note: this module currently only handles the "12d export
// with real per-vertex depth" path, which is what's been validated so
// far. The brief's flat/assumed-depth FALLBACK path (for DBYD-sourced
// GeoJSON with no invert data) is not implemented yet — when it is, style
// it visibly differently (the brief explicitly asks for surveyed vs
// assumed depth to be distinguishable), e.g. solid vs dashed/translucent.

import * as THREE from "three";
import { mgaToScene } from "./crs.js";
import { splitOnGaps } from "./twelve-d.js";
import { normalizeColour } from "./service-colour.js";

const FALLBACK_COLOR = "#2fa3ff"; // used when a record's own colour can't be resolved (see service-colour.js)

/**
 * Build a THREE.Group of tube meshes from parsed 12d service records.
 * @param {ReturnType<typeof import("./twelve-d.js").parse12da>} records
 * @param {[number, number, number]} sceneOriginMga
 * @returns {THREE.Group}
 */
export function buildServiceMeshes(records, sceneOriginMga) {
  const group = new THREE.Group();
  group.name = "services-12d";

  for (const record of records) {
    // Split on large coordinate gaps before building geometry: some real
    // records bundle several physically separate features (e.g. multiple
    // distinct manhole rim outlines) into one `data_3d` array with no
    // marker between them — reported by Cameron as "pits seem to be
    // joining up" on the 2D map, and the same underlying data problem
    // would extrude as one spurious tube connecting unrelated pits here
    // too. See twelve-d.js splitOnGaps() for how the threshold was
    // chosen from real data, not guessed.
    const segments = splitOnGaps(record.centrelinePoints);

    const color = normalizeColour(record.colour, FALLBACK_COLOR);
    const material = new THREE.MeshStandardMaterial({
      color,
      metalness: 0.1,
      roughness: 0.6,
    });

    for (const scenePointsMga of segments) {
      if (scenePointsMga.length < 2) continue;

      const scenePoints = scenePointsMga.map(
        (p) => new THREE.Vector3(...mgaToScene(p, sceneOriginMga))
      );
      const curve = new THREE.CatmullRomCurve3(scenePoints, false, "catmullrom", 0);

      const radius = record.diameter ? record.diameter / 2 : 0.05; // 100mm fallback if no diameter given
      const tubeSegments = Math.max(8, scenePoints.length * 4);
      const geometry = new THREE.TubeGeometry(curve, tubeSegments, radius, 8, false);

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = record.name ?? "service";
      mesh.userData = {
        source: "12d",
        model: record.model,
        style: record.style,
        rawColour: record.colour,
        diameter: record.diameter,
        justify: record.justify,
        depthAccuracy: "surveyed", // as opposed to a future "assumed" fallback
      };
      group.add(mesh);
    }
  }

  return group;
}
