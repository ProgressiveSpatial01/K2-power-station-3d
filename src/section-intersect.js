// section-intersect.js — find where the section/profile cut line crosses
// the currently-loaded design/services layers, so the profile chart can
// show real crossing depths/surface elevations. Per Cameron (2026-08-26):
// "need to be able to see these layers on the section view as well."
// (Originally alongside a Mapbox Terrain-RGB elevation line too — removed
// 2026-08-26, same day, per Cameron: "the mapbox terrain should be
// removed, it doesn't really do anything relevant" — see profile-chart.js
// and the README "Terrain" section. This module's own crossing/chord
// logic is unaffected; it never depended on terrain data.)
//
// Pure 2D-lon/lat-plane geometry (no turf dependency beyond distance
// calcs) — the site is small enough that treating lon/lat as a flat
// plane for segment-intersection math introduces negligible error, the
// same approximation the measure/section tools already make elsewhere
// (see draw-tools.js's geodesic-vs-grid note). Elevation (the actual
// point of this module) comes from each feature's own real Z data, kept
// as a third GeoJSON coordinate value ([lon, lat, elevationAhd]) all the
// way from twelve-d.js's parsed points through to these features — see
// main-2d.js buildLineFeaturesFrom12d()/buildSurfaceFeaturesFrom12d().
//
// Scope: services, design linework, and design surfaces (all 12d-sourced,
// all carry real per-vertex elevation). Deliberately does NOT include the
// IFC design layer — the 2D page only tracks an axis-aligned bounding-box
// footprint for IFC (see ifc.js computeFootprintCornersScene()), not its
// true 3D geometry, so any "crossing elevation" for it would be a guess
// dressed up as data. Revisit if/when the 2D page keeps real IFC mesh
// data around rather than just a footprint.

import * as turf from "@turf/turf";

/** Cumulative distance (metres) from the start of `coords2d` to each vertex. */
function cumulativeDistances(coords2d) {
  const cum = [0];
  for (let i = 1; i < coords2d.length; i++) {
    const d = turf.distance(turf.point(coords2d[i - 1]), turf.point(coords2d[i]), { units: "kilometers" });
    cum.push(cum[i - 1] + d * 1000);
  }
  return cum;
}

/**
 * Total length (metres) of a drawn line — used by main-2d.js for the
 * section chart's X-axis now that there's no terrain fetch to derive it
 * from as a side effect. Same distance basis as every crossing computed
 * below, so chart positions stay consistent.
 */
export function lineLengthM(coords2d) {
  const cum = cumulativeDistances(coords2d);
  return cum[cum.length - 1];
}

/**
 * Segment-segment intersection (2D), the standard "given two points on
 * each line" formula. Returns null if parallel/collinear or the
 * intersection falls outside either segment.
 * @returns {{t: number, u: number} | null} t is the fraction along
 *   [p1,p2], u is the fraction along [p3,p4].
 */
function segmentIntersection2D([x1, y1], [x2, y2], [x3, y3], [x4, y4]) {
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(d) < 1e-14) return null; // parallel or collinear
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
  const u = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

/**
 * Where a 3D-coordinate LineString feature (real elevation as each
 * point's 3rd value) crosses the section line, in section-line order.
 *
 * @param {Array<[number, number]>} sectionCoords2d - the drawn section line
 * @param {number[]} sectionCum - cumulativeDistances(sectionCoords2d)
 * @param {GeoJSON.Feature} feature - LineString, 3D coordinates
 * @returns {Array<{ distanceM: number, elevationAhd: number }>}
 */
function crossingsForLine(sectionCoords2d, sectionCum, feature) {
  const targetCoords = feature.geometry.coordinates;
  const hits = [];
  for (let i = 0; i < sectionCoords2d.length - 1; i++) {
    const a1 = sectionCoords2d[i];
    const a2 = sectionCoords2d[i + 1];
    for (let j = 0; j < targetCoords.length - 1; j++) {
      const b1 = targetCoords[j];
      const b2 = targetCoords[j + 1];
      const hit = segmentIntersection2D(a1, a2, [b1[0], b1[1]], [b2[0], b2[1]]);
      if (!hit) continue;
      const distanceM = sectionCum[i] + hit.t * (sectionCum[i + 1] - sectionCum[i]);
      const z1 = b1[2] ?? 0;
      const z2 = b2[2] ?? 0;
      const elevationAhd = z1 + hit.u * (z2 - z1);
      hits.push({ distanceM, elevationAhd });
    }
  }
  return hits;
}

/**
 * Where the section line crosses a triangulated surface, as a list of
 * chords (one per triangle actually crossed) — see this file's header
 * for why independent per-triangle chords, drawn in the surface's own
 * colour, naturally read as one continuous line where the cut crosses
 * several adjacent triangles (they share the crossing point on the
 * shared edge) without needing to explicitly stitch them together.
 *
 * @param {Array<[number, number]>} sectionCoords2d
 * @param {number[]} sectionCum
 * @param {GeoJSON.Feature} triangleFeature - Polygon, one triangle, 3D ring
 * @returns {Array<{ distanceM: number, elevationAhd: number }>} 0, 1 (rare,
 *   a vertex-only graze), or 2 points for this one triangle
 */
function crossingsForTriangle(sectionCoords2d, sectionCum, triangleFeature) {
  const ring = triangleFeature.geometry.coordinates[0]; // [v0, v1, v2, v0]
  const hits = [];
  for (let e = 0; e < ring.length - 1; e++) {
    const b1 = ring[e];
    const b2 = ring[e + 1];
    for (let i = 0; i < sectionCoords2d.length - 1; i++) {
      const a1 = sectionCoords2d[i];
      const a2 = sectionCoords2d[i + 1];
      const hit = segmentIntersection2D(a1, a2, [b1[0], b1[1]], [b2[0], b2[1]]);
      if (!hit) continue;
      const distanceM = sectionCum[i] + hit.t * (sectionCum[i + 1] - sectionCum[i]);
      const z1 = b1[2] ?? 0;
      const z2 = b2[2] ?? 0;
      const elevationAhd = z1 + hit.u * (z2 - z1);
      hits.push({ distanceM, elevationAhd });
    }
  }
  hits.sort((a, b) => a.distanceM - b.distanceM);
  return hits;
}

/**
 * @param {Array<[number, number]>} sectionCoordsWgs84 - the drawn section line
 * @param {{
 *   lineFeatures?: GeoJSON.Feature[],   // services + design linework, 3D LineStrings
 *   surfaceFeatures?: GeoJSON.Feature[], // design surfaces, 3D triangle Polygons
 * }} layers
 * @returns {{
 *   lineCrossings: Array<{ distanceM: number, elevationAhd: number, layerKind: string,
 *     name: string, model: string, colour: string }>,
 *   surfaceChords: Array<{ points: Array<{distanceM: number, elevationAhd: number}>,
 *     surfaceName: string, colour: string }>,
 * }}
 */
export function computeSectionCrossings(sectionCoordsWgs84, { lineFeatures = [], surfaceFeatures = [] } = {}) {
  const sectionCum = cumulativeDistances(sectionCoordsWgs84);

  const lineCrossings = lineFeatures.flatMap((f) =>
    crossingsForLine(sectionCoordsWgs84, sectionCum, f).map((hit) => ({
      ...hit,
      layerKind: f.properties.layerKind ?? "line",
      name: f.properties.name ?? "(unnamed)",
      model: f.properties.model ?? "(unlabelled)",
      colour: f.properties.colour,
    }))
  );

  const surfaceChords = surfaceFeatures
    .map((f) => ({
      points: crossingsForTriangle(sectionCoordsWgs84, sectionCum, f),
      // surfaceId (file name + internal name), not the bare internal
      // name — see createSurfaceFeatureController()'s docstring in
      // main-2d.js: two different uploaded surfaces (e.g. two different
      // months' drone flights) can share the same generic internal 12d
      // name, and the tooltip needs to actually distinguish them.
      surfaceName: f.properties.surfaceId ?? f.properties.surfaceName,
      colour: f.properties.colour,
    }))
    .filter((chord) => chord.points.length >= 2);

  return { lineCrossings, surfaceChords };
}
