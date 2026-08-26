// elevation-profile.js — sample terrain elevation along a drawn line, for
// the 2D page's section/profile tool. Builds on terrain-rgb.js's shared
// Mapbox Terrain-RGB fetch/decode logic (same data source as the 3D
// scene's terrain, kept consistent rather than reinventing a second
// terrain source for one feature).
//
// Coarse global elevation data (Terrain-RGB, z15) — see terrain-rgb.js
// and the README "Terrain" section for the caveats that apply equally
// here: this is not survey-grade, and not a substitute for a real DSM
// once one exists for K2.

import * as turf from "@turf/turf";
import { fetchTerrainRgbCoverage } from "./terrain-rgb.js";

/**
 * Sample terrain elevation along a line, evenly spaced by distance.
 *
 * @param {Array<[number, number]>} lineCoordsWgs84 - the drawn line, [lon, lat] pairs
 * @param {string} token - Mapbox access token
 * @param {{ samples?: number }} [opts]
 * @returns {Promise<{
 *   points: Array<{ distanceM: number, lon: number, lat: number, elevationAhd: number | null }>,
 *   totalDistanceM: number
 * }>}
 */
export async function fetchElevationProfile(lineCoordsWgs84, token, opts = {}) {
  const { samples = 150 } = opts;
  if (lineCoordsWgs84.length < 2) {
    throw new Error("fetchElevationProfile() needs at least 2 points.");
  }

  const line = turf.lineString(lineCoordsWgs84);
  const totalDistanceKm = turf.length(line, { units: "kilometers" });
  const totalDistanceM = totalDistanceKm * 1000;

  const sampleLonLats = [];
  for (let i = 0; i < samples; i++) {
    const distanceKm = (i / (samples - 1)) * totalDistanceKm;
    const pt = turf.along(line, distanceKm, { units: "kilometers" });
    sampleLonLats.push(pt.geometry.coordinates);
  }

  // Cover the line's own vertices AND every sample point, in case the
  // line is long enough to span tiles the vertices alone wouldn't imply.
  const { sampleHeight } = await fetchTerrainRgbCoverage(
    [...lineCoordsWgs84, ...sampleLonLats],
    token
  );

  const points = sampleLonLats.map(([lon, lat], i) => ({
    distanceM: (i / (samples - 1)) * totalDistanceM,
    lon,
    lat,
    elevationAhd: sampleHeight(lon, lat),
  }));

  return { points, totalDistanceM };
}
