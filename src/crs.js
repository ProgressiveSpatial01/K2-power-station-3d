// crs.js — coordinate transforms for the K2 site.
//
// SAFETY-CRITICAL: never fudge or silently assume CRS parameters.
// Every function here must have its inputs/outputs labelled with CRS
// explicitly by the caller — do not let a bare [x, y] float around
// without knowing which system it's in.
//
// *** PROVISIONAL — NOT YET CONFIRMED AGAINST K2 SURVEY CONTROL ***
// GDA2020 / MGA Zone 50 (EPSG:7850) is the working assumption for
// Kwinana, based on its longitude (~115.8E, well within zone 50's
// 114-120E range). This has NOT been checked against K2's actual
// survey control marks. Do not treat any output of this module as
// survey-grade until Cameron confirms the zone (and ideally spot-checks
// one known control point transforms correctly).
//
// proj4 string verified against epsg.io/7850 (2026-08-24):
//   +proj=utm +zone=50 +south +ellps=GRS80 +units=m +no_defs +type=crs
// This is standard UTM-south form for GDA2020 MGA — false easting
// 500000, false northing 10000000, central meridian 117E, k0=0.9996
// are all implied by the zone/south UTM definition, not separately
// guessed.

import proj4 from "proj4";

export const CRS = {
  WGS84: "EPSG:4326",
  GDA2020_MGA50: "EPSG:7850",
};

proj4.defs(
  CRS.GDA2020_MGA50,
  "+proj=utm +zone=50 +south +ellps=GRS80 +units=m +no_defs +type=crs"
);

/**
 * Convert a GDA2020/MGA Zone 50 [easting, northing] pair to WGS84 [lon, lat].
 * @param {[number, number]} mga - [easting, northing] in metres.
 * @returns {[number, number]} [longitude, latitude] in degrees.
 */
export function mga50ToWgs84([easting, northing]) {
  return proj4(CRS.GDA2020_MGA50, CRS.WGS84, [easting, northing]);
}

/**
 * Convert a WGS84 [lon, lat] pair to GDA2020/MGA Zone 50 [easting, northing].
 * @param {[number, number]} lonLat - [longitude, latitude] in degrees.
 * @returns {[number, number]} [easting, northing] in metres.
 */
export function wgs84ToMga50([lon, lat]) {
  return proj4(CRS.WGS84, CRS.GDA2020_MGA50, [lon, lat]);
}

/**
 * Sanity-check a transform round-trips to within `toleranceM` metres.
 * Use this on any new control point before trusting it — cheap insurance
 * against a wrong zone or a typo'd coordinate.
 */
export function roundTripCheck(mgaPoint, toleranceM = 0.001) {
  const wgs = mga50ToWgs84(mgaPoint);
  const back = wgs84ToMga50(wgs);
  const dx = back[0] - mgaPoint[0];
  const dy = back[1] - mgaPoint[1];
  const errM = Math.hypot(dx, dy);
  return { ok: errM <= toleranceM, errM, wgs, back };
}
