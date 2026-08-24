// terrain.js — the ONE place terrain is loaded from.
//
// Design intent (per project brief): the drone-processing platform
// (WebODM-backed) doesn't exist yet, so for now this returns a synthetic
// placeholder surface. When the real pipeline exists, only
// `getCurrentTerrain()` needs to change (swap the placeholder branch for
// a fetch against the processing API) — the rest of the 3D scene
// (IFC design, services, excavation cut) should not care where the
// heightfield came from.
//
// TODO(swap point): replace the placeholder branch with a real DEM
// loader once either (a) a GeoTIFF DSM/DTM is supplied for K2, or
// (b) the WebODM-based delivery platform (see project memory) exposes
// a "latest terrain for site" endpoint. Flagging here as requested in
// the brief: this surface is meant to be periodically re-flighted and
// swapped, not a one-off static asset.
//
// All returned vertex coordinates are in local scene metres, already
// transformed from GDA2020/MGA50 by the caller-supplied `origin` — see
// crs.js. This module does not know about WGS84/Mapbox at all.

import * as THREE from "three";

const PLACEHOLDER_SIZE_M = 200; // ~200m square test pad
const PLACEHOLDER_SEGMENTS = 80;

/**
 * Get the current terrain surface for a site as a Three.js mesh, in local
 * scene metres relative to `originMga` (an [easting, northing, ahd] point
 * used as the scene's (0,0,0)).
 *
 * @param {string} siteId - e.g. "K2"
 * @param {[number, number, number]} originMga - GDA2020/MGA50 [E, N, AHD] scene origin
 * @returns {Promise<{ mesh: THREE.Mesh, source: "placeholder"|"geotiff"|"webodm", warning?: string }>}
 */
export async function getCurrentTerrain(siteId, originMga) {
  // No real DEM wired up yet — synthetic undulating pad centred on origin.
  // Replace this branch first; leave the function signature stable.
  return {
    mesh: buildPlaceholderMesh(),
    source: "placeholder",
    warning:
      "PLACEHOLDER TERRAIN — synthetic test surface, not derived from " +
      "drone data. Do not use for any real excavation/clash assessment.",
  };
}

function buildPlaceholderMesh() {
  const geometry = new THREE.PlaneGeometry(
    PLACEHOLDER_SIZE_M,
    PLACEHOLDER_SIZE_M,
    PLACEHOLDER_SEGMENTS,
    PLACEHOLDER_SEGMENTS
  );
  geometry.rotateX(-Math.PI / 2); // XZ ground plane, Y up

  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // Gentle synthetic undulation, purely to make "peeling the surface"
    // visually meaningful later — not survey data.
    const y =
      2.5 * Math.sin(x / 25) * Math.cos(z / 30) +
      0.5 * Math.sin(x / 6 + z / 4);
    pos.setY(i, y);
  }
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: 0x8a7a5c,
    wireframe: false,
    flatShading: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "terrain-placeholder";
  mesh.receiveShadow = true;
  return mesh;
}
