// mapbox-terrain.js — Terrain-RGB DEM + satellite imagery as the default
// terrain fallback when no drone DSM exists (see terrain.js). Real global
// elevation data, coarse (source data only goes to z15) but genuinely
// surveyed/sourced, not synthetic.
//
// Shared tile-fetch/decode logic lives in terrain-rgb.js (no Three.js
// dependency, so the 2D page's elevation-profile tool can reuse it
// without pulling in Three.js) — this file adds the Three.js-specific
// mesh-building on top, plus the satellite imagery texture (which the
// profile tool doesn't need).

import * as THREE from "three";
import { mga50ToWgs84 } from "./crs.js";
import { TILE_SIZE, ZOOM, lonLatToGlobalPixel, fetchTileCanvas, fetchTerrainRgbCoverage } from "./terrain-rgb.js";

/**
 * Build a real (if coarse) terrain mesh from Mapbox Terrain-RGB + Satellite
 * imagery, covering an `extentM`-wide square centred on `originMga`.
 *
 * @param {[number, number, number]} originMga - GDA2020/MGA50 [E, N, AHD] scene origin
 * @param {string} token - Mapbox public access token (pk.*)
 * @param {{ extentM?: number, segments?: number }} [opts]
 * @returns {Promise<{ mesh: THREE.Mesh, minAhd: number, maxAhd: number, zoom: number }>}
 */
export async function getMapboxTerrain(originMga, token, opts = {}) {
  const { extentM = 200, segments = 96 } = opts;
  if (!token) throw new Error("getMapboxTerrain() called without a token.");

  const half = extentM / 2;
  const corners = [
    [originMga[0] - half, originMga[1] - half],
    [originMga[0] + half, originMga[1] - half],
    [originMga[0] - half, originMga[1] + half],
    [originMga[0] + half, originMga[1] + half],
  ].map(([e, n]) => mga50ToWgs84([e, n]));

  const { sampleHeight, tileRange } = await fetchTerrainRgbCoverage(corners, token);
  const { minTx, maxTx, minTy, maxTy } = tileRange;

  // Satellite imagery, fetched and stitched separately from the
  // elevation tiles above (different tileset, same tile grid).
  const satelliteTiles = new Map();
  const satFetches = [];
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) {
      const key = `${tx},${ty}`;
      satFetches.push(
        fetchTileCanvas(
          `https://api.mapbox.com/v4/mapbox.satellite/${ZOOM}/${tx}/${ty}.jpg90?access_token=${token}`
        ).then((t) => satelliteTiles.set(key, t))
      );
    }
  }
  await Promise.all(satFetches);

  // Stitch satellite tiles into one texture. This lays tiles out on a
  // uniform mercator pixel grid, then the geometry loop below maps each
  // vertex's true lon/lat into that same pixel space — so imagery
  // alignment follows the real mercator projection, not an approximation.
  const tilesX = maxTx - minTx + 1;
  const tilesY = maxTy - minTy + 1;
  const stitched = document.createElement("canvas");
  stitched.width = tilesX * TILE_SIZE;
  stitched.height = tilesY * TILE_SIZE;
  const sctx = stitched.getContext("2d");
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) {
      const tile = satelliteTiles.get(`${tx},${ty}`);
      sctx.drawImage(tile.canvas, (tx - minTx) * TILE_SIZE, (ty - minTy) * TILE_SIZE);
    }
  }
  const texture = new THREE.CanvasTexture(stitched);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  const geometry = new THREE.PlaneGeometry(extentM, extentM, segments, segments);
  geometry.rotateX(-Math.PI / 2); // XZ ground plane, Y up — matches crs.js mgaToScene()

  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  let minAhd = Infinity;
  let maxAhd = -Infinity;
  let missCount = 0;

  for (let i = 0; i < pos.count; i++) {
    // Un-rotated PlaneGeometry XY spans [-extentM/2, extentM/2]; after
    // rotateX(-90deg) that's now scene X (east offset) and scene Z
    // (negative-north offset, per crs.js's mgaToScene convention).
    const eastOffset = pos.getX(i);
    const southOffset = pos.getZ(i); // scene Z = -(northing offset), so north offset = -southOffset
    const easting = originMga[0] + eastOffset;
    const northing = originMga[1] - southOffset;
    const [lon, lat] = mga50ToWgs84([easting, northing]);

    const heightAhd = sampleHeight(lon, lat);
    if (heightAhd == null) {
      missCount++;
      pos.setY(i, 0); // fall back to origin's own AHD (scene y=0)
    } else {
      pos.setY(i, heightAhd - originMga[2]);
      minAhd = Math.min(minAhd, heightAhd);
      maxAhd = Math.max(maxAhd, heightAhd);
    }

    const [px, py] = lonLatToGlobalPixel(lon, lat, ZOOM);
    uv.setXY(
      i,
      (px - minTx * TILE_SIZE) / stitched.width,
      1 - (py - minTy * TILE_SIZE) / stitched.height // flip V: canvas Y grows downward, UV V grows upward
    );
  }
  geometry.attributes.uv.needsUpdate = true;
  geometry.computeVertexNormals();

  if (missCount > 0) {
    console.warn(`[mapbox-terrain] ${missCount}/${pos.count} vertices fell outside fetched tile coverage.`);
  }

  const material = new THREE.MeshStandardMaterial({ map: texture });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "terrain-mapbox";
  mesh.userData = { source: "mapbox-terrain-rgb", zoom: ZOOM, minAhd, maxAhd };

  return { mesh, minAhd, maxAhd, zoom: ZOOM };
}
