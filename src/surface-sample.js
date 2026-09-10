// surface-sample.js — point-based sampling against a triangulated 12d
// surface (full_tin), shared by the spot-elevation tool and the volume
// (cut/fill) tool (both added 2026-09-11, per Cameron: "is there some
// simple inspection tools we can add... volumes... click around a
// stockpile or excavation with a polygon and do surface to surface
// within similar to propeller").
//
// barycentric2D() moved here from section-intersect.js (2026-09-11) so
// both modules share one implementation instead of two copies that
// could drift apart — section-intersect.js now imports it from here.

/**
 * Barycentric weights of 2D point `p` in triangle `(a, b, c)`, or `null`
 * if `p` is outside it (a small negative tolerance treats the boundary
 * itself as "inside", so a point sitting exactly on an edge doesn't get
 * dropped by float rounding).
 */
export function barycentric2D(p, a, b, c) {
  const v0x = b[0] - a[0], v0y = b[1] - a[1];
  const v1x = c[0] - a[0], v1y = c[1] - a[1];
  const v2x = p[0] - a[0], v2y = p[1] - a[1];
  const den = v0x * v1y - v1x * v0y;
  if (Math.abs(den) < 1e-14) return null; // degenerate triangle
  const v = (v2x * v1y - v1x * v2y) / den;
  const w = (v0x * v2y - v2x * v0y) / den;
  const u = 1 - v - w;
  const eps = -1e-9;
  if (u < eps || v < eps || w < eps) return null;
  return { u, v, w };
}

/**
 * Interpolated elevation of 2D point `p` within a 3D triangle ring
 * `[v0, v1, v2, v0]` (Mapbox Polygon ring convention — see
 * buildSurfaceFeaturesFrom12d()), or `null` if `p` falls outside it.
 */
function elevationAtPointInTriangleRing(p, ring) {
  const [v0, v1, v2] = ring;
  const bary = barycentric2D(p, v0, v1, v2);
  if (!bary) return null;
  return bary.u * v0[2] + bary.v * v1[2] + bary.w * v2[2];
}

/**
 * Elevation of 2D point `p` on a surface (a list of triangle Polygon
 * features, e.g. designSurfaceController.getFeaturesForSurface()), or
 * `null` if the point falls outside every triangle (off the surveyed
 * extent). AABB-checked before the full barycentric test — cheap
 * rejection of triangles nowhere near `p`, worth doing since a real
 * surface here can have several thousand triangles (one real sample:
 * 6558) and both the spot-elevation tool and the volume tool call this
 * once per sampled point.
 * @param {[number, number]} p - [lon, lat]
 * @param {GeoJSON.Feature[]} triangleFeatures - Polygon features, 3D rings
 * @returns {number | null}
 */
export function elevationOnSurfaceAtPoint(p, triangleFeatures) {
  const [px, py] = p;
  for (const f of triangleFeatures) {
    const ring = f.geometry.coordinates[0];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < 3; i++) {
      const [x, y] = ring[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (px < minX || px > maxX || py < minY || py > maxY) continue;
    const z = elevationAtPointInTriangleRing(p, ring);
    if (z != null) return z;
  }
  return null;
}
