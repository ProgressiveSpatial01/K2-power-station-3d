// mapbox-terrain.js — Terrain-RGB DEM + satellite imagery as the default
// terrain fallback when no drone DSM exists (see terrain.js). Real global
// elevation data, coarse (source data only goes to z15 — Mapbox docs:
// "Data up to zoom 15... higher zoom levels will not increase data
// resolution") but genuinely surveyed/sourced, not synthetic.
//
// API details verified against Mapbox's own docs before writing this
// (2026-08-24), not guessed:
//   - Tile URL: https://api.mapbox.com/v4/{tileset}/{z}/{x}/{y}.{format}?access_token=...
//   - Terrain-RGB tileset id: mapbox.terrain-rgb, format: .pngraw (the
//     raw/undecorated encoding — plain .png can be re-styled).
//   - Satellite tileset id: mapbox.satellite, format: .jpg90 (Mapbox
//     always serves satellite as JPEG regardless of requested format).
//   - Max zoom for real Terrain-RGB data: 15. Requesting higher just
//     gets you the z15 data upsampled server-side, not more resolution
//     — so this module fixes zoom at 15 rather than exposing it as a
//     "quality" knob that would be misleading.
//   - Height decode: metres = -10000 + (R*256*256 + G*256 + B) * 0.1

import * as THREE from "three";
import { mga50ToWgs84 } from "./crs.js";

const TILE_SIZE = 256;
const ZOOM = 15; // fixed — see comment above, this is Terrain-RGB's real max

function lonLatToGlobalPixel(lon, lat, zoom) {
  const n = 2 ** zoom;
  const x = ((lon + 180) / 360) * n * TILE_SIZE;
  const latRad = (lat * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    n *
    TILE_SIZE;
  return [x, y];
}

function globalPixelToTile(px, py) {
  return [Math.floor(px / TILE_SIZE), Math.floor(py / TILE_SIZE)];
}

async function fetchTileCanvas(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Mapbox tile fetch failed (HTTP ${resp.status}): ${url.replace(/access_token=[^&]+/, "access_token=***")}`);
  }
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  return { canvas, ctx, imageData: ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE) };
}

function decodeTerrainRgbHeight(imageData, px, py) {
  const i = (py * TILE_SIZE + px) * 4;
  const r = imageData.data[i];
  const g = imageData.data[i + 1];
  const b = imageData.data[i + 2];
  return -10000 + (r * 256 * 256 + g * 256 + b) * 0.1;
}

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

  const globalPixels = corners.map(([lon, lat]) => lonLatToGlobalPixel(lon, lat, ZOOM));
  const minPx = Math.min(...globalPixels.map((p) => p[0]));
  const maxPx = Math.max(...globalPixels.map((p) => p[0]));
  const minPy = Math.min(...globalPixels.map((p) => p[1]));
  const maxPy = Math.max(...globalPixels.map((p) => p[1]));

  const [minTx, minTy] = globalPixelToTile(minPx, minPy);
  const [maxTx, maxTy] = globalPixelToTile(maxPx, maxPy);

  const terrainTiles = new Map();
  const satelliteTiles = new Map();
  const fetches = [];
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) {
      const key = `${tx},${ty}`;
      fetches.push(
        fetchTileCanvas(
          `https://api.mapbox.com/v4/mapbox.terrain-rgb/${ZOOM}/${tx}/${ty}.pngraw?access_token=${token}`
        ).then((t) => terrainTiles.set(key, t))
      );
      fetches.push(
        fetchTileCanvas(
          `https://api.mapbox.com/v4/mapbox.satellite/${ZOOM}/${tx}/${ty}.jpg90?access_token=${token}`
        ).then((t) => satelliteTiles.set(key, t))
      );
    }
  }
  await Promise.all(fetches);

  // Stitch satellite tiles into one texture. Note: this lays tiles out
  // on a uniform mercator pixel grid, then the geometry loop below maps
  // each vertex's true lon/lat into that same pixel space — so imagery
  // alignment follows the real mercator projection, not an approximation
  // across the small site extent (safe either way at this scale, but
  // doing it properly costs nothing extra here).
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

  function sampleHeight(lon, lat) {
    const [px, py] = lonLatToGlobalPixel(lon, lat, ZOOM);
    const [tx, ty] = globalPixelToTile(px, py);
    const tile = terrainTiles.get(`${tx},${ty}`);
    if (!tile) return null;
    const localX = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(px - tx * TILE_SIZE)));
    const localY = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(py - ty * TILE_SIZE)));
    return decodeTerrainRgbHeight(tile.imageData, localX, localY);
  }

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
