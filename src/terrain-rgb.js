// terrain-rgb.js — shared Mapbox Terrain-RGB / raster tile fetching and
// decoding, with no Three.js dependency. Factored out of mapbox-terrain.js
// (2026-08-24) so the 2D page's elevation-profile tool doesn't need to
// pull in Three.js just to sample heights — mapbox-terrain.js (3D mesh
// builder) and elevation-profile.js (2D section tool) both build on this.
//
// API details verified against Mapbox's own docs (2026-08-24):
//   - Tile URL: https://api.mapbox.com/v4/{tileset}/{z}/{x}/{y}.{format}?access_token=...
//   - Terrain-RGB tileset id: mapbox.terrain-rgb, format: .pngraw
//   - Max zoom for real Terrain-RGB data: 15 (higher just upsamples).
//   - Height decode: metres = -10000 + (R*256*256 + G*256 + B) * 0.1

export const TILE_SIZE = 256;
export const ZOOM = 15; // fixed — Terrain-RGB's real max, see comment above

export function lonLatToGlobalPixel(lon, lat, zoom = ZOOM) {
  const n = 2 ** zoom;
  const x = ((lon + 180) / 360) * n * TILE_SIZE;
  const latRad = (lat * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    n *
    TILE_SIZE;
  return [x, y];
}

export function globalPixelToTile(px, py) {
  return [Math.floor(px / TILE_SIZE), Math.floor(py / TILE_SIZE)];
}

export async function fetchTileCanvas(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `Mapbox tile fetch failed (HTTP ${resp.status}): ${url.replace(/access_token=[^&]+/, "access_token=***")}`
    );
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

export function decodeTerrainRgbHeight(imageData, px, py) {
  const i = (py * TILE_SIZE + px) * 4;
  const r = imageData.data[i];
  const g = imageData.data[i + 1];
  const b = imageData.data[i + 2];
  return -10000 + (r * 256 * 256 + g * 256 + b) * 0.1;
}

/**
 * Fetch every Terrain-RGB tile covering a set of [lon, lat] points, and
 * return a sampler function over them.
 *
 * @param {Array<[number, number]>} lonLatPoints - points the sampler must cover
 * @param {string} token - Mapbox access token
 * @returns {Promise<{ sampleHeight: (lon: number, lat: number) => number | null }>}
 */
export async function fetchTerrainRgbCoverage(lonLatPoints, token) {
  const pixels = lonLatPoints.map(([lon, lat]) => lonLatToGlobalPixel(lon, lat));
  const minPx = Math.min(...pixels.map((p) => p[0]));
  const maxPx = Math.max(...pixels.map((p) => p[0]));
  const minPy = Math.min(...pixels.map((p) => p[1]));
  const maxPy = Math.max(...pixels.map((p) => p[1]));

  const [minTx, minTy] = globalPixelToTile(minPx, minPy);
  const [maxTx, maxTy] = globalPixelToTile(maxPx, maxPy);

  const tiles = new Map();
  const fetches = [];
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) {
      const key = `${tx},${ty}`;
      fetches.push(
        fetchTileCanvas(
          `https://api.mapbox.com/v4/mapbox.terrain-rgb/${ZOOM}/${tx}/${ty}.pngraw?access_token=${token}`
        ).then((t) => tiles.set(key, t))
      );
    }
  }
  await Promise.all(fetches);

  function sampleHeight(lon, lat) {
    const [px, py] = lonLatToGlobalPixel(lon, lat);
    const [tx, ty] = globalPixelToTile(px, py);
    const tile = tiles.get(`${tx},${ty}`);
    if (!tile) return null;
    const localX = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(px - tx * TILE_SIZE)));
    const localY = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(py - ty * TILE_SIZE)));
    return decodeTerrainRgbHeight(tile.imageData, localX, localY);
  }

  return { sampleHeight, tileRange: { minTx, maxTx, minTy, maxTy } };
}
