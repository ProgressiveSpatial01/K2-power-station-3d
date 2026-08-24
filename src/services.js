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

const SURVEYED_DEPTH_COLOR = 0x2fa3ff; // distinct from IFC concrete grey / terrain

/**
 * Build a THREE.Group of tube meshes from parsed 12d service records.
 * @param {ReturnType<typeof import("./twelve-d.js").parse12da>} records
 * @param {[number, number, number]} sceneOriginMga
 * @returns {THREE.Group}
 */
export function buildServiceMeshes(records, sceneOriginMga) {
  const group = new THREE.Group();
  group.name = "services-12d";

  const material = new THREE.MeshStandardMaterial({
    color: SURVEYED_DEPTH_COLOR,
    metalness: 0.1,
    roughness: 0.6,
  });

  for (const record of records) {
    if (record.centrelinePoints.length < 2) continue;

    const scenePoints = record.centrelinePoints.map(
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
      style: record.style,
      diameter: record.diameter,
      justify: record.justify,
      depthAccuracy: "surveyed", // as opposed to a future "assumed" fallback
    };
    group.add(mesh);
  }

  return group;
}
