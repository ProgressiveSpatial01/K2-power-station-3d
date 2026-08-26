// mapbox-tiles.js — shared Mapbox raster tile fetching + tile/pixel math,
// no Three.js dependency. Originally "terrain-rgb.js" (2026-08-24), which
// also decoded Mapbox's Terrain-RGB elevation encoding — removed
// 2026-08-26 per Cameron ("the mapbox terrain should be removed, it
// doesn't really do anything relevant, images to stay"): the coarse
// global Terrain-RGB heightfield wasn't earning its keep now that real
// design/service/surface elevation data exists to compare against
// instead (see "Terrain" in the README and ground-imagery.js). Renamed
// since this file is now genuinely just generic raster-tile plumbing,
// not terrain-specific — the satellite IMAGERY fetching (ground-
// imagery.js) still needs it.
//
// API details verified against Mapbox's own docs (2026-08-24):
//   - Tile URL: https://api.mapbox.com/v4/{tileset}/{z}/{x}/{y}.{format}?access_token=...

export const TILE_SIZE = 256;
export const ZOOM = 15; // matches Terrain-RGB's old real max — kept as a reasonable fixed imagery zoom too

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
