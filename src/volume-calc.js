// volume-calc.js — grid-sampled cut/fill volume between two 12d
// surfaces within a drawn polygon boundary, similar to Propeller
// Aero's volume tool. Added 2026-09-11, per Cameron: "is there some
// simple inspection tools we can add in e.g. volumes (click around a
// stockpile or excavation with a polygon and do surface to surface
// within similar to propeller)."
//
// Numerical grid integration, not an analytic TIN-boolean — the
// industry-standard, much simpler approach: sample a regular grid of
// points across the polygon, look up each surface's interpolated
// elevation at each point (surface-sample.js), and sum
// (elevationB - elevationA) * cellArea over every point actually inside
// the polygon. Accurate to within the grid spacing; the coverage% this
// returns tells the caller how much of the polygon actually had data on
// BOTH surfaces at each sampled point — a stockpile survey rarely
// covers the exact same footprint on two different dates, and a volume
// computed over a large uncovered gap would be misleadingly wrong if
// not surfaced.
//
// Deliberately works in MGA50 (real projected metres — see crs.js),
// not WGS84 lon/lat: a grid spaced evenly in degrees is NOT evenly
// spaced in real metres at this latitude, which would silently distort
// both the sample spacing and the cell-area math. Every surface
// triangle and the drawn polygon are converted to MGA50 ONCE up front,
// not per sample point.

import * as turf from "@turf/turf";
import { wgs84ToMga50 } from "./crs.js";
import { elevationOnSurfaceAtPoint } from "./surface-sample.js";

/** Convert one [lon, lat, z] WGS84 point to [E, N, z] MGA50, keeping Z as-is. */
function toMga([lon, lat, z]) {
  const [e, n] = wgs84ToMga50([lon, lat]);
  return [e, n, z];
}

/** Convert a 3D triangle Polygon feature (WGS84) to one in MGA50. */
function triangleToMga(feature) {
  const ring = feature.geometry.coordinates[0];
  return { ...feature, geometry: { type: "Polygon", coordinates: [ring.map(toMga)] } };
}

/** Planar (shoelace) area of a closed 2D ring, in whatever units its coordinates are in. */
function ringArea2D(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/**
 * @param {Array<[number, number]>} polygonCoordsWgs84 - drawn polygon ring (closed, last === first). A user-drawn polygon has at most a handful-to-dozens of vertices, never thousands — safe to Math.min/max via spread below (unlike a real surface's point count elsewhere in this codebase, which explicitly is NOT safe that way).
 * @param {GeoJSON.Feature[]} surfaceATriangles - one surface's triangle features (WGS84), e.g. designSurfaceController.getFeaturesForSurface(idA)
 * @param {GeoJSON.Feature[]} surfaceBTriangles - another surface's triangle features (WGS84)
 * @param {{ gridSpacingM?: number, maxSamples?: number }} [opts]
 * @returns {{
 *   cutVolumeM3: number, fillVolumeM3: number, netVolumeM3: number,
 *   polygonAreaM2: number, sampledAreaM2: number, coveragePct: number,
 *   gridSpacingM: number, sampleCount: number, bothCoveredCount: number,
 * }}
 */
export function computeVolumeWithinPolygon(polygonCoordsWgs84, surfaceATriangles, surfaceBTriangles, opts = {}) {
  const polygonMga = polygonCoordsWgs84.map(([lon, lat]) => wgs84ToMga50([lon, lat]));
  const polygonAreaM2 = ringArea2D(polygonMga);

  // Auto-coarsen the grid for a very large polygon so this stays
  // responsive — a stockpile/excavation is typically tens of metres
  // across; this only kicks in for something dramatically bigger.
  let gridSpacingM = opts.gridSpacingM ?? 0.5;
  const maxSamples = opts.maxSamples ?? 40000;
  const roughSamples = polygonAreaM2 / (gridSpacingM * gridSpacingM);
  if (roughSamples > maxSamples) {
    gridSpacingM = Math.sqrt(polygonAreaM2 / maxSamples);
  }

  const surfaceAMga = surfaceATriangles.map(triangleToMga);
  const surfaceBMga = surfaceBTriangles.map(triangleToMga);

  const xs = polygonMga.map((p) => p[0]);
  const ys = polygonMga.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  const turfPolygon = turf.polygon([polygonMga.map(([x, y]) => [x, y])]);

  let sampleCount = 0;
  let bothCoveredCount = 0;
  let cutVolumeM3 = 0;
  let fillVolumeM3 = 0;
  const cellAreaM2 = gridSpacingM * gridSpacingM;

  for (let x = minX + gridSpacingM / 2; x < maxX; x += gridSpacingM) {
    for (let y = minY + gridSpacingM / 2; y < maxY; y += gridSpacingM) {
      if (!turf.booleanPointInPolygon(turf.point([x, y]), turfPolygon)) continue;
      sampleCount++;
      const zA = elevationOnSurfaceAtPoint([x, y], surfaceAMga);
      const zB = elevationOnSurfaceAtPoint([x, y], surfaceBMga);
      if (zA == null || zB == null) continue;
      bothCoveredCount++;
      const diff = zB - zA; // positive = B above A (fill), negative = B below A (cut)
      if (diff > 0) fillVolumeM3 += diff * cellAreaM2;
      else cutVolumeM3 += -diff * cellAreaM2;
    }
  }

  return {
    cutVolumeM3,
    fillVolumeM3,
    netVolumeM3: fillVolumeM3 - cutVolumeM3,
    polygonAreaM2,
    sampledAreaM2: bothCoveredCount * cellAreaM2,
    coveragePct: sampleCount > 0 ? (bothCoveredCount / sampleCount) * 100 : 0,
    gridSpacingM,
    sampleCount,
    bothCoveredCount,
  };
}
