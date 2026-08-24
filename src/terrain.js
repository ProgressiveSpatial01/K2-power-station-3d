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
// Mapbox imagery/terrain is the DEFAULT fallback rather than a one-off
// placeholder — Mapbox's public Terrain-RGB DEM tileset (real, if
// coarse, global elevation data — see mapbox-terrain.js) draped with
// Mapbox satellite imagery, via the same Mapbox account/token already
// used for the CSBP 2D viewer. Wired up 2026-08-24 once Cameron supplied
// the token. If VITE_MAPBOX_TOKEN isn't configured (see .env.local),
// this falls back to a flat reference plane instead of failing outright
// — deliberately NOT a fake undulating surface, since a synthetic bump
// risks being mistaken for real ground shape once real IFC/services
// geometry is in the same scene.
//
// TODO(later swap point): once the WebODM-based delivery platform (see
// project memory) exposes a "latest terrain for site" endpoint, that
// becomes the preferred source ahead of Mapbox Terrain-RGB (genuine
// drone DSM/DTM beats coarse global data) — this surface is meant to be
// periodically re-flighted and swapped, not a one-off static asset.

import * as THREE from "three";
import { getMapboxTerrain } from "./mapbox-terrain.js";

const REFERENCE_PLANE_SIZE_M = 200; // ~200m square, just for scale/orientation
const TEST_COVER_DEPTH_M = 0.9; // Cameron, 2026-08-24: "~0.9m above the pipe" as a test default

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
  const token = import.meta.env.VITE_MAPBOX_TOKEN;
  if (token) {
    try {
      const { mesh, minAhd, maxAhd, zoom } = await getMapboxTerrain(originMga, token);
      return {
        mesh,
        source: "mapbox-terrain-rgb",
        warning:
          `Mapbox Terrain-RGB (zoom ${zoom}), elevation range ${minAhd.toFixed(1)}–` +
          `${maxAhd.toFixed(1)}m AHD. COARSE GLOBAL DATA, not a drone survey — ` +
          "swap for a real DSM/DTM before any real excavation/clash assessment.",
      };
    } catch (err) {
      console.error("[terrain] Mapbox terrain fetch failed, falling back to flat plane:", err);
      // fall through to the flat-plane fallback below
    }
  }

  return {
    mesh: buildReferencePlane(),
    source: "placeholder",
    warning: token
      ? "NO TERRAIN DATA — Mapbox fetch failed (see console), flat reference " +
        "plane at site datum only."
      : "NO TERRAIN DATA — flat reference plane at site datum only. " +
        "No drone flight yet; VITE_MAPBOX_TOKEN not configured (see .env.local). " +
        "Do not use for any real excavation/clash assessment.",
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

/**
 * TEST-ONLY stand-in surface: flat plane at a fixed assumed cover depth
 * above the top of a set of loaded 12d service strings (see
 * twelve-d.js). Requested by Cameron (2026-08-24) purely to have
 * *something* plausible sitting above the pipe to test the future
 * "peel away the surface to reveal the service" excavation-cut view
 * against — this is NOT a real ground surface, has no relationship to
 * actual K2 topography, and must not be used for anything beyond that.
 *
 * Depth reference: uses each service record's raw `points` (i.e. the
 * un-justify-corrected data_3d values) rather than `centrelinePoints`,
 * because for `justify: "top"` data (the only case seen so far — see
 * README) the raw points ARE already the top-of-pipe elevation, which
 * is what "cover depth above the pipe" should be measured from. If a
 * future service uses a different justify, this still reads the top-
 * of-pipe surface correctly since parse12da() only adjusts
 * centrelinePoints, never the raw points.
 *
 * @param {ReturnType<typeof import("./twelve-d.js").parse12da>} serviceRecords
 * @param {[number, number, number]} originMga
 * @param {number} coverDepthM - default 0.9m, per Cameron's test request
 * @returns {THREE.Mesh}
 */
export function buildTestSurfaceAbovePipes(
  serviceRecords,
  originMga,
  coverDepthM = TEST_COVER_DEPTH_M
) {
  const topOfPipeElevations = serviceRecords.flatMap((r) =>
    r.points.map(([, , z]) => z)
  );
  if (topOfPipeElevations.length === 0) {
    throw new Error(
      "buildTestSurfaceAbovePipes(): no service points to derive a surface from."
    );
  }
  const avgTopOfPipeAhd =
    topOfPipeElevations.reduce((a, b) => a + b, 0) / topOfPipeElevations.length;
  const surfaceAhd = avgTopOfPipeAhd + coverDepthM;

  const geometry = new THREE.PlaneGeometry(
    REFERENCE_PLANE_SIZE_M,
    REFERENCE_PLANE_SIZE_M
  );
  geometry.rotateX(-Math.PI / 2);
  // scene Y = AHD offset from origin, per crs.js's mgaToScene() convention.
  const sceneY = surfaceAhd - originMga[2];
  geometry.translate(0, sceneY, 0);

  const material = new THREE.MeshStandardMaterial({
    color: 0x776633,
    wireframe: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "terrain-test-surface-above-pipes";
  mesh.userData = {
    source: "test-offset-above-pipes",
    coverDepthM,
    avgTopOfPipeAhd,
    surfaceAhd,
  };
  return mesh;
}
