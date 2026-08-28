// draw-tools.js — one shared mapbox-gl-draw instance backing both the
// measure tool (distance/area) and the section/profile tool. One shared
// instance because mapbox-gl-draw doesn't expect two independent copies
// managing the same map's drawing layers; instead this tracks a single
// "current mode" and dispatches draw.create/update to the right handler.
//
// Measure tool: same mapbox-gl-draw + turf.js combination the CSBP
// reference viewer already uses (per the project brief) — reusing a
// proven pattern. Geodesic (WGS84) measurement — ground/great-circle
// distance, not MGA50 grid distance; the two differ slightly, worth
// surfacing if Cameron ever needs grid-exact numbers (see README).
//
// Section tool: draws a single line, then hands its coordinates to the
// caller (main-2d.js), which computes crossings against loaded design/
// service data (section-intersect.js) and opens the split view.

import MapboxDraw from "@mapbox/mapbox-gl-draw";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";
import * as turf from "@turf/turf";

/**
 * @param {import("mapbox-gl").Map} map
 * @param {{
 *   onMeasureResult: (text: string) => void,
 *   onSectionLine: (lineCoordsWgs84: Array<[number, number]>) => void,
 * }} handlers
 */
export function createDrawTools(map, { onMeasureResult, onSectionLine }) {
  const draw = new MapboxDraw({ displayControlsDefault: false, controls: {} });
  map.addControl(draw);

  let mode = null; // "distance" | "area" | "section" | null

  function describeMeasureFeature(feature) {
    if (!feature) return "";
    if (feature.geometry.type === "LineString") {
      const km = turf.length(feature, { units: "kilometers" });
      const m = km * 1000;
      return m < 1000 ? `Distance: ${m.toFixed(1)} m` : `Distance: ${km.toFixed(3)} km`;
    }
    if (feature.geometry.type === "Polygon") {
      const sqm = turf.area(feature);
      return sqm < 10000 ? `Area: ${sqm.toFixed(1)} m²` : `Area: ${(sqm / 10000).toFixed(3)} ha`;
    }
    return "";
  }

  function handleChange() {
    const all = draw.getAll();
    const last = all.features[all.features.length - 1];
    if (!last) return;

    if (mode === "distance" || mode === "area") {
      onMeasureResult(describeMeasureFeature(last));
    } else if (mode === "section" && last.geometry.type === "LineString") {
      const coords = last.geometry.coordinates;
      // Reset BEFORE calling changeMode() below, not after — found
      // 2026-08-27 as the real cause of Cameron's "Maximum call stack
      // size exceeded" (which kept surfacing as a chart-rendering crash,
      // a total red herring). draw.changeMode() calls the current mode's
      // onStop(), which mapbox-gl-draw uses to finalise/re-emit the just-
      // drawn feature — re-firing draw.create/draw.update SYNCHRONOUSLY,
      // which re-invokes this same handleChange(). With `mode` still
      // "section" at that point, the re-entrant call used to match this
      // branch AGAIN, calling onSectionLine() and changeMode() again,
      // forever — real infinite recursion between this function and
      // mapbox-gl-draw's own internals, not anything wrong in
      // onSectionLine itself. This went unnoticed while onSectionLine
      // was still `async` (awaiting a Mapbox Terrain-RGB fetch deferred
      // the recursion's actual work past the synchronous changeMode call
      // via the microtask queue); removing that `await` when Terrain-RGB
      // was dropped (2026-08-26) made onSectionLine fully synchronous,
      // nesting its entire body — including chart rendering — directly
      // inside this same call stack, which is what finally exhausted it.
      // Resetting `mode` first makes the re-entrant call a no-op instead.
      mode = null;
      draw.changeMode("simple_select");
      onSectionLine(coords);
    }
  }

  map.on("draw.create", handleChange);
  map.on("draw.update", handleChange);
  map.on("draw.delete", () => {
    if (mode === "distance" || mode === "area") onMeasureResult("");
  });

  return {
    startDistance() {
      draw.deleteAll();
      onMeasureResult("");
      mode = "distance";
      draw.changeMode("draw_line_string");
    },
    startArea() {
      draw.deleteAll();
      onMeasureResult("");
      mode = "area";
      draw.changeMode("draw_polygon");
    },
    startSection() {
      draw.deleteAll();
      mode = "section";
      draw.changeMode("draw_line_string");
    },
    clear() {
      draw.deleteAll();
      mode = null;
      draw.changeMode("simple_select");
      onMeasureResult("");
    },
    stop() {
      mode = null;
      draw.changeMode("simple_select");
    },
  };
}
