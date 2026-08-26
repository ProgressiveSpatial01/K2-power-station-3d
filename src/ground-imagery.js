// ground-imagery.js — a FLAT ground plane textured with real Mapbox
// satellite imagery, for visual context in the 3D scene. Replaces
// mapbox-terrain.js (2026-08-24), which draped the same imagery over a
// Terrain-RGB-derived heightfield — removed 2026-08-26 per Cameron ("the
// mapbox terrain should be removed, it doesn't really do anything
// relevant, images to stay"): the coarse global elevation data wasn't
// adding anything real now that actual design/service/surface elevation
// data exists to work with instead, but the satellite photo itself is
// still useful visual context, so it stays — just flat, not pretending
// to be real ground shape.

import * as THREE from "three";
import { mga50ToWgs84 } from "./crs.js";
import { TILE_SIZE, ZOOM, lonLatToGlobalPixel, fetchTileCanvas } from "./mapbox-tiles.js";

/**
 * Build a flat, satellite-imagery-textured ground plane, covering an
 * `extentM`-wide square centred on `originMga`. No elevation data at
 * all — every vertex sits at scene y=0 (i.e. originMga's own AHD).
 *
 * @param {[number, number, number]} originMga - GDA2020/MGA50 [E, N, AHD] scene origin
 * @param {string} token - Mapbox public access token (pk.*)
 * @param {{ extentM?: number }} [opts]
 * @returns {Promise<{ mesh: THREE.Mesh }>}
 */
export async function getGroundImageryPlane(originMga, token, opts = {}) {
  const { extentM = 200 } = opts;
  if (!token) throw new Error("getGroundImageryPlane() called without a token.");

  const half = extentM / 2;
  const corners = [
    [originMga[0] - half, originMga[1] - half],
    [originMga[0] + half, originMga[1] - half],
    [originMga[0] - half, originMga[1] + half],
    [originMga[0] + half, originMga[1] + half],
  ].map(([e, n]) => mga50ToWgs84([e, n]));

  const pixels = corners.map(([lon, lat]) => lonLatToGlobalPixel(lon, lat));
  const minTx = Math.min(...pixels.map(([px]) => Math.floor(px / TILE_SIZE)));
  const maxTx = Math.max(...pixels.map(([px]) => Math.floor(px / TILE_SIZE)));
  const minTy = Math.min(...pixels.map(([, py]) => Math.floor(py / TILE_SIZE)));
  const maxTy = Math.max(...pixels.map(([, py]) => Math.floor(py / TILE_SIZE)));

  const satelliteTiles = new Map();
  const fetches = [];
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) {
      const key = `${tx},${ty}`;
      fetches.push(
        fetchTileCanvas(
          `https://api.mapbox.com/v4/mapbox.satellite/${ZOOM}/${tx}/${ty}.jpg90?access_token=${token}`
        ).then((t) => satelliteTiles.set(key, t))
      );
    }
  }
  await Promise.all(fetches);

  // Stitch tiles into one texture on a uniform mercator pixel grid, then
  // map each vertex's true lon/lat into that same pixel space below — so
  // imagery alignment follows the real mercator projection, not an
  // approximation.
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

  const geometry = new THREE.PlaneGeometry(extentM, extentM);
  geometry.rotateX(-Math.PI / 2); // XZ ground plane, Y up — matches crs.js mgaToScene(); flat at y=0 throughout

  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const eastOffset = pos.getX(i);
    const southOffset = pos.getZ(i); // scene Z = -(northing offset)
    const easting = originMga[0] + eastOffset;
    const northing = originMga[1] - southOffset;
    const [lon, lat] = mga50ToWgs84([easting, northing]);
    const [px, py] = lonLatToGlobalPixel(lon, lat, ZOOM);
    uv.setXY(
      i,
      (px - minTx * TILE_SIZE) / stitched.width,
      1 - (py - minTy * TILE_SIZE) / stitched.height // flip V: canvas Y grows downward, UV V grows upward
    );
  }
  geometry.attributes.uv.needsUpdate = true;

  const material = new THREE.MeshStandardMaterial({ map: texture });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "ground-imagery";
  mesh.userData = { source: "mapbox-satellite-flat" };

  return { mesh };
}
