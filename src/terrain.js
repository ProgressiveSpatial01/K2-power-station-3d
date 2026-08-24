// terrain.js — the ONE place terrain is loaded from.
//
// Design intent (per project brief): the drone-processing platform
// (WebODM-backed) doesn't exist yet, so for now this returns a flat
// reference plane. When a real terrain source exists, only
// `getCurrentTerrain()` needs to change — the rest of the 3D scene
// (IFC design, services, excavation cut) should not care where the
// heightfield came from.
//
// Cameron confirmed (2026-08-24): no drone flight exists yet for K2, so
// Mapbox imagery/terrain is the intended DEFAULT fallback rather than a
// one-off placeholder — specifically Mapbox's public Terrain-RGB DEM
// tileset (real, if coarse, global elevation data) draped with Mapbox
// satellite imagery, via the same Mapbox account/token already used for
// the CSBP 2D viewer (see brief). NOT WIRED UP YET: doing so needs
// Cameron's Mapbox access token, which isn't something to guess or
// reuse from another repo without being handed it explicitly. Until
// then this returns a flat reference plane (deliberately NOT a fake
// undulating surface — now that real IFC/services data is loaded
// alongside it, a synthetic bumpy surface risks being mistaken for real
// ground shape, which a flat "no data" plane doesn't).
//
// TODO(swap point, needs Mapbox token): fetch Terrain-RGB tiles
// (api.mapbox.com/v4/mapbox.terrain-rgb/{z}/{x}/{y}.pngraw) covering the
// site extent, decode elevation per the Mapbox RGB encoding
// (height = -10000 + (R*256*256 + G*256 + B) * 0.1), build a heightfield
// mesh from it in the same mgaToScene() space as everything else, and
// texture it with the corresponding satellite tile layer
// (api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}.jpg90). Swap this
// branch out for a real drone DSM/DTM the same way once one exists.
//
// TODO(later swap point): once the WebODM-based delivery platform (see
// project memory) exposes a "latest terrain for site" endpoint, that
// becomes the preferred source ahead of Mapbox Terrain-RGB — this
// surface is meant to be periodically re-flighted and swapped, not a
// one-off static asset.

import * as THREE from "three";

const REFERENCE_PLANE_SIZE_M = 200; // ~200m square, just for scale/orientation

/**
 * Get the current terrain surface for a site as a Three.js mesh, in local
 * scene metres relative to `originMga` (an [easting, northing, ahd] point
 * used as the scene's (0,0,0)).
 *
 * @param {string} siteId - e.g. "K2"
 * @param {[number, number, number]} originMga - GDA2020/MGA50 [E, N, AHD] scene origin
 * @returns {Promise<{ mesh: THREE.Mesh, source: "placeholder"|"mapbox-terrain-rgb"|"geotiff"|"webodm", warning?: string }>}
 */
export async function getCurrentTerrain(siteId, originMga) {
  // No drone DSM, and no Mapbox token supplied yet — flat reference plane
  // at the scene's own datum height. Replace this branch first, in this
  // order: (1) Mapbox Terrain-RGB once a token is available, (2) a real
  // drone DSM/DTM GeoTIFF once one exists. Leave the function signature
  // stable either way.
  return {
    mesh: buildReferencePlane(),
    source: "placeholder",
    warning:
      "NO TERRAIN DATA — flat reference plane at site datum only. " +
      "No drone flight yet; Mapbox Terrain-RGB fallback not wired up " +
      "(needs a Mapbox access token). Do not use for any real " +
      "excavation/clash assessment.",
  };
}

function buildReferencePlane() {
  const geometry = new THREE.PlaneGeometry(
    REFERENCE_PLANE_SIZE_M,
    REFERENCE_PLANE_SIZE_M
  );
  geometry.rotateX(-Math.PI / 2); // XZ ground plane, Y up
  // Flat at y=0, which by definition of mgaToScene() (crs.js) IS
  // originMga's own AHD height — nothing further to do here.

  const material = new THREE.MeshStandardMaterial({
    color: 0x555555,
    wireframe: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "terrain-reference-plane";
  return mesh;
}
