// main-2d.js — 2D landing view (Mapbox GL JS), the primary shell for the
// "Civil3D/Propeller hybrid" platform Cameron described (2026-08-24):
// a 2D drone-delivery-style map as the default view, with a "3D View"
// toggle out to the Three.js excavation scene (3d.html / src/main.js)
// for the cases that actually need 3D (clash, cut, spatial review).
//
// Sidebar layer panel (2026-08-24, per Cameron: "think Civillo Layout" —
// reading this as the CSBP viewer's grouped/sub-grouped collapsible
// layer panel, since that's the explicit reference pattern in the
// brief). Built with layer-tree.js, a small generic collapsible-group
// helper with no Mapbox knowledge of its own — this file wires each row
// to actual map visibility.
//
// Deliberately reuses the same data/logic modules as the 3D page
// (crs.js, ifc.js, twelve-d.js) rather than duplicating any CRS or
// parsing logic — only the rendering shell differs between the two
// views. IFC/services files uploaded here now carry over to the 3D page
// automatically too (2026-08-28, per Cameron) — see
// shared-design-store.js and the README's "2D → 3D file carry-over".

import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import * as OBC from "@thatopen/components";
import { mga50ToWgs84, sceneToMga } from "./crs.js";
import {
  extractGeoreference,
  setupIfcLoader,
  loadIfcFile,
  computeIfcPlacement,
  computeFootprintCornersScene,
  resolveCoordinationOffset,
} from "./ifc.js";
import { loadTwelveDaFile, splitOnGaps } from "./twelve-d.js";
import { normalizeColour } from "./service-colour.js";
import { createLayerGroup } from "./layer-tree.js";
import { buildModelTree } from "./model-tree.js";
import { createDrawTools } from "./draw-tools.js";
import { renderProfileChart } from "./profile-chart.js";
import { computeSectionCrossings, lineLengthM } from "./section-intersect.js";
import { createSurfaceCompareControl } from "./surface-compare.js";
import { stashDesignFile } from "./shared-design-store.js";

const statusEl = document.getElementById("status-bar");
function setStatus(msg) {
  statusEl.textContent = msg;
  console.log("[K2-2D]", msg);
}

// Same real GT11 project base point used as the 3D scene's origin (see
// main.js) — used here only as the map's initial centre, not as a
// coordinate-system origin (Mapbox works in WGS84 throughout).
const INITIAL_CENTER_MGA = [384899.031, 6434081.091];

const token = import.meta.env.VITE_MAPBOX_TOKEN;
if (!token) {
  setStatus("VITE_MAPBOX_TOKEN not set (.env.local) — map cannot load.");
  throw new Error("Missing VITE_MAPBOX_TOKEN");
}
mapboxgl.accessToken = token;

const [initialLon, initialLat] = mga50ToWgs84(INITIAL_CENTER_MGA);

const BASE_STYLES = {
  satellite: "mapbox://styles/mapbox/satellite-streets-v12",
  streets: "mapbox://styles/mapbox/streets-v12",
};

const map = new mapboxgl.Map({
  container: "map",
  style: BASE_STYLES.satellite,
  center: [initialLon, initialLat],
  zoom: 17,
});

map.addControl(new mapboxgl.NavigationControl(), "bottom-right");

// Whether a measure/section draw tool is currently active — checked by
// every clickable layer's popup handler below (IFC point/footprint,
// services/design-linework, design surfaces) so they can get out of the
// way while drawing. Added 2026-08-27, per Cameron: "if i have the tin
// surface on, clicking on it doesn't register as a cut point when trying
// to cut a section, it just gives me the tin details, i have to click
// off the tin to make it load." A feature's own `map.on("click",
// layerId, ...)` popup handler doesn't call stopPropagation and
// shouldn't, by Mapbox's documented event model, block mapbox-gl-draw's
// own click handling for the SAME click — but empirically, clicking a
// rendered feature while a draw mode is active was eating the click
// instead of adding a vertex. Rather than chase mapbox-gl-draw's exact
// internal interaction with feature-click queries (not independently
// confirmable without live mouse interaction against a real render — see
// README's render-loop-suspension note), the safe, standard fix real
// Mapbox apps use is to just suppress custom feature popups while a draw
// tool is active — you don't want one interrupting a measurement anyway.
// See wireMapToolbar()'s setActiveTool().
const drawToolState = { active: false };

// Headless @thatopen/components engine, lazily set up on first IFC load
// (so picking a 12d file or just browsing the map doesn't pay for
// spinning up the IFC/WASM pipeline). Renders into a 1x1 offscreen div
// (see index.html #ifc-offscreen) — we only need it to compute real
// geometry (a bounding-box footprint), never to display anything;
// Box3.setFromObject() doesn't care that nothing is actually visible.
let ifcEngine = null;
async function getIfcEngine() {
  if (ifcEngine) return ifcEngine;
  const components = new OBC.Components();
  const worlds = components.get(OBC.Worlds);
  const world = worlds.create();
  world.scene = new OBC.SimpleScene(components);
  world.renderer = new OBC.SimpleRenderer(components, document.getElementById("ifc-offscreen"));
  world.camera = new OBC.OrthoPerspectiveCamera(components);
  components.init();
  world.scene.setup();
  const { ifcLoader } = await setupIfcLoader(components, world);
  ifcEngine = { components, ifcLoader };
  return ifcEngine;
}

const layerTreeEl = document.getElementById("layer-tree");
const baseGroup = createLayerGroup(layerTreeEl, { label: "Base Map" });
const designGroup = createLayerGroup(layerTreeEl, { label: "Design" });
// "Linework" nests inside "Design" (alongside the IFC base point/footprint
// row added elsewhere) — per Cameron (2026-08-26): the Design upload needs
// to support linework, .ifc, and (eventually) surfaces as different kinds
// of design data sharing one upload slot, not just IFC.
// Each `onDelete` below references its controller before that controller
// is actually declared (further down the file) — safe, same pattern as
// surfaceCompareControl's setSurfaceVisible callback: the arrow function
// body only ever RUNS when a user clicks that group's delete button,
// long after the whole module has finished initialising.
const designLineworkGroup = designGroup.addSubgroup({
  label: "Linework",
  onDelete: () => designLineworkController.removeAll(),
});
// "Surfaces" (added 2026-08-26, first real sample "FL Surface.12daz") —
// same Design upload slot, a third kind of design data alongside IFC and
// linework. See buildSurfaceFeaturesFrom12d() below for the file format.
const designSurfaceGroup = designGroup.addSubgroup({
  label: "Surfaces",
  onDelete: () => designSurfaceController.removeAll(),
});
const servicesGroup = createLayerGroup(layerTreeEl, {
  label: "Underground Services",
  onDelete: () => servicesController.removeAll(),
});

wireBaseStyleGroup();

map.on("load", () => {
  setStatus("Ready — choose a design (.ifc/.12da/.12daz) and/or a .12da/.12daz services file.");
  addCustomLayers();
  wireDesignInput();
  wireServicesInput();
  wireMapToolbar();
});

// Base style switches destroy all custom sources/layers; re-add them
// once the new style has finished loading. Each re-add is a cheap no-op
// if that layer has nothing loaded yet.
map.on("style.load", () => {
  addCustomLayers();
});

map.on("error", (e) => {
  console.error("[K2-2D] Mapbox error:", e.error);
  setStatus(`Map error: ${e.error?.message ?? "see console"}`);
});

function wireBaseStyleGroup() {
  let current = "satellite";
  const setStyle = (key) => {
    if (key === current) return;
    current = key;
    map.setStyle(BASE_STYLES[key]);
  };
  baseGroup.addRow({
    label: "Satellite",
    checked: true,
    type: "radio",
    name: "base-style",
    onChange: (checked) => checked && setStyle("satellite"),
  });
  baseGroup.addRow({
    label: "Streets",
    checked: false,
    type: "radio",
    name: "base-style",
    onChange: (checked) => checked && setStyle("streets"),
  });
  // Base map is always shown — no group-level "hide everything" toggle
  // makes sense for it, so grey out its own checkbox rather than let it
  // do anything.
  baseGroup.groupCheckbox.disabled = true;
  baseGroup.groupCheckbox.title = "Base map is always visible";
}

/** Re-add every custom source/layer currently loaded. Safe to call repeatedly. */
function addCustomLayers() {
  ifcController.reAddIfPresent();
  servicesController.reAddIfPresent();
  designLineworkController.reAddIfPresent();
  designSurfaceController.reAddIfPresent();
}

const POINT_SOURCE_ID = "ifc-design-point";
const POINT_LAYER_ID = "ifc-design-point-layer";
const FOOTPRINT_SOURCE_ID = "ifc-design-footprint";
const FOOTPRINT_FILL_LAYER_ID = "ifc-design-footprint-fill";
const FOOTPRINT_LINE_LAYER_ID = "ifc-design-footprint-line";

/**
 * Controller for IFC design point + footprint features. Upgraded
 * 2026-08-31 from a single-slot `state.ifcFeature`/`ifcFootprintFeature`
 * pair — which OVERWROTE the previous IFC design's marker/footprint on
 * every new `.ifc` upload, with only one ever-created sidebar row — to a
 * proper multi-design accumulator, matching the pattern already used for
 * services/design-linework/design-surfaces. Cameron: "is it at a point
 * where we can import multiple files now instead of the 2 we have been
 * testing (as in does it overwrite what is currently imported everytime
 * we import again)" — it did, specifically for IFC; now it doesn't.
 *
 * Keyed on the uploaded file's own name (`ifcId`) — good enough here
 * unlike surfaces' `surfaceId`, since a single IFC upload is always
 * exactly one design with no internal per-record name to collide with.
 */
function createIfcFeatureController({ group }) {
  const pointFeatures = new Map(); // ifcId -> point feature
  const footprintFeatures = new Map(); // ifcId -> footprint feature (absent if geometry load failed)
  const checkedIds = new Set();
  const checkboxes = new Map();

  function applyFilter() {
    const ids = [...checkedIds];
    if (map.getLayer(POINT_LAYER_ID)) {
      map.setFilter(POINT_LAYER_ID, ["in", ["get", "ifcId"], ["literal", ids]]);
    }
    if (map.getLayer(FOOTPRINT_FILL_LAYER_ID)) {
      map.setFilter(FOOTPRINT_FILL_LAYER_ID, ["in", ["get", "ifcId"], ["literal", ids]]);
      map.setFilter(FOOTPRINT_LINE_LAYER_ID, ["in", ["get", "ifcId"], ["literal", ids]]);
    }
  }

  function createLayers() {
    map.addSource(POINT_SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [...pointFeatures.values()] },
    });
    map.addSource(FOOTPRINT_SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [...footprintFeatures.values()] },
    });
    map.addLayer({
      id: FOOTPRINT_FILL_LAYER_ID,
      type: "fill",
      source: FOOTPRINT_SOURCE_ID,
      paint: { "fill-color": "#ffb454", "fill-opacity": 0.25 },
    });
    map.addLayer({
      id: FOOTPRINT_LINE_LAYER_ID,
      type: "line",
      source: FOOTPRINT_SOURCE_ID,
      paint: { "line-color": "#ffb454", "line-width": 2 },
    });
    // Point layer added last (on top) so a design's base-point marker
    // stays visibly above its own (or any other design's) footprint fill.
    map.addLayer({
      id: POINT_LAYER_ID,
      type: "circle",
      source: POINT_SOURCE_ID,
      paint: {
        "circle-radius": 6,
        "circle-color": "#ffb454",
        "circle-stroke-color": "#000",
        "circle-stroke-width": 2,
      },
    });
    map.on("click", POINT_LAYER_ID, (e) => {
      if (drawToolState.active) return; // let the click through to the active draw tool instead
      const p = e.features[0].properties;
      new mapboxgl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(
          `<b>${p.name}</b><br>IFC project base point<br>` +
            `${p.crsName ?? "CRS unknown"}<br>` +
            `E ${p.eastingOffset} N ${p.northingOffset}<br>RL ${p.heightOffset} AHD`
        )
        .addTo(map);
    });
    map.on("click", FOOTPRINT_FILL_LAYER_ID, (e) => {
      if (drawToolState.active) return; // let the click through to the active draw tool instead
      const p = e.features[0].properties;
      new mapboxgl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(
          `<b>${p.name}</b><br>` +
            "Axis-aligned bounding-box outline (not a true footprint " +
            "polygon for rotated/non-rectangular designs — see " +
            "ifc.js computeFootprintCornersScene())."
        )
        .addTo(map);
    });
    applyFilter();
  }

  function refreshData() {
    if (map.getSource(POINT_SOURCE_ID)) {
      map.getSource(POINT_SOURCE_ID).setData({ type: "FeatureCollection", features: [...pointFeatures.values()] });
      map.getSource(FOOTPRINT_SOURCE_ID).setData({
        type: "FeatureCollection",
        features: [...footprintFeatures.values()],
      });
      applyFilter();
    } else {
      createLayers();
    }
  }

  /**
   * Removes one IFC design entirely — added 2026-08-31, per Cameron:
   * "we also need to be able to rename, edit and delete layers/groups."
   */
  function removeDesign(ifcId) {
    pointFeatures.delete(ifcId);
    footprintFeatures.delete(ifcId);
    checkedIds.delete(ifcId);
    checkboxes.delete(ifcId);
    refreshData();
  }

  return {
    /**
     * @param {string} ifcId - the uploaded file's name
     * @param {GeoJSON.Feature} pointFeature - the project base point (always available)
     * @param {GeoJSON.Feature | null} footprintFeature - the bounding-box outline,
     *   null if it couldn't be computed (e.g. geometry load failed) — point-only in that case
     */
    setDesign(ifcId, pointFeature, footprintFeature) {
      pointFeature.properties.ifcId = ifcId;
      if (footprintFeature) footprintFeature.properties.ifcId = ifcId;

      const isNew = !pointFeatures.has(ifcId);
      pointFeatures.set(ifcId, pointFeature);
      if (footprintFeature) footprintFeatures.set(ifcId, footprintFeature);
      refreshData();

      if (isNew) {
        checkedIds.add(ifcId);
        const input = group.addRow({
          label: ifcId,
          color: "#ffb454",
          checked: true,
          onChange: (checked) => {
            if (checked) checkedIds.add(ifcId);
            else checkedIds.delete(ifcId);
            applyFilter();
          },
          onDelete: () => removeDesign(ifcId),
        });
        checkboxes.set(ifcId, input);
      }
    },
    /** Re-create the source/layers after a base-style switch wiped them. No-op if nothing's loaded yet. */
    reAddIfPresent() {
      if (pointFeatures.size === 0 || map.getSource(POINT_SOURCE_ID)) return;
      createLayers();
    },
  };
}

const ifcController = createIfcFeatureController({ group: designGroup });

/**
 * Generic controller for a "many 12d line-string records, grouped by
 * `model` into a nested sidebar tree" layer. Used for BOTH Underground
 * Services and Design linework (added 2026-08-26 per Cameron: the
 * Design upload needs to support linework too, not just IFC) — the two
 * are structurally identical (parsed the same way via twelve-d.js,
 * grouped the same way via model-tree.js) and only differ in which
 * Mapbox source/sidebar group they render into and their popup content.
 * Factored out here rather than duplicating the logic a second time.
 *
 * Owns its own accumulated feature list and model-grouping state
 * internally (not the shared `state` object above) so multiple
 * instances don't collide.
 *
 * Grouping by `model`, not `style`: found 2026-08-26 against a real
 * 800-record weekly export that `style` is nearly useless for grouping
 * there (734/800 records just have style "1"), while `model` gives real
 * discipline categories (Sewer, Water, Power/High Voltage, Power/Low
 * Voltage, Drainage, ...) — see twelve-d.js parse12da() for how model
 * tracking works.
 *
 * Tree rebuilds from scratch (not patched in place) whenever a
 * genuinely new model path shows up — inserting into an already-
 * rendered compacted tree while keeping its structure correct is real
 * work; a full rebuild from the accumulated model set is simple and
 * correct instead. Trade-off: any checkboxes the user had unticked get
 * reset to "all checked" on a rebuild. Acceptable for now — in practice
 * this fires once or twice a session, not continuously.
 */
function createLineFeatureController({ sourceId, layerId, group, popupHtml }) {
  const allFeatures = [];
  const knownModelPaths = new Set();
  const checkedGroups = new Set();

  function applyFilter() {
    map.setFilter(layerId, ["in", ["get", "model"], ["literal", [...checkedGroups]]]);
  }

  // Was hardcoded to one flat blue for every leaf row regardless of the
  // real per-record colour actually drawn on the map — found 2026-08-31,
  // Cameron: "the legend of the services isnt reflecting the actual line
  // colours." A `model` group can in principle contain records with more
  // than one real colour (12d doesn't enforce one colour per discipline),
  // so this picks the MOST COMMON real colour among that model's
  // features as the representative swatch, rather than just the first
  // one found — closer to "the colour you'll actually mostly see on the
  // map for this group" when there's any variance.
  function colourForModel(fullPath) {
    const counts = new Map();
    for (const f of allFeatures) {
      if (f.properties.model !== fullPath) continue;
      const c = f.properties.colour;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    let best = null;
    let bestCount = 0;
    for (const [c, n] of counts) {
      if (n > bestCount) {
        best = c;
        bestCount = n;
      }
    }
    return best ?? "#2fa3ff"; // fallback — shouldn't happen, every real feature has a colour
  }

  function renderTree(g, nodes) {
    for (const node of nodes) {
      if (node.type === "leaf") {
        g.addRow({
          label: node.label,
          color: colourForModel(node.fullPath),
          checked: checkedGroups.has(node.fullPath),
          onChange: (checked) => {
            if (checked) checkedGroups.add(node.fullPath);
            else checkedGroups.delete(node.fullPath);
            applyFilter();
          },
          onDelete: () => removeModel(node.fullPath),
        });
      } else {
        const sub = g.addSubgroup({ label: node.label });
        renderTree(sub, node.children);
      }
    }
  }

  function rebuildTreeIfNeeded(newFeatures) {
    const modelsInThisLoad = new Set(newFeatures.map((f) => f.properties.model));
    const hasNewModel = [...modelsInThisLoad].some((m) => !knownModelPaths.has(m));
    if (!hasNewModel) return;

    for (const m of modelsInThisLoad) knownModelPaths.add(m);
    checkedGroups.clear();
    for (const m of knownModelPaths) checkedGroups.add(m); // default: everything checked

    group.clear();
    renderTree(group, buildModelTree([...knownModelPaths]));
  }

  /**
   * Removes every feature belonging to one `model` path — added
   * 2026-08-31, per Cameron: "we also need to be able to rename, edit
   * and delete layers/groups." Rebuilds the tree afterward via the exact
   * same mechanism additions already use (rebuildTreeIfNeeded), just
   * starting from a shrunken `knownModelPaths` instead of a grown one.
   */
  function removeModel(fullPath) {
    const remaining = allFeatures.filter((f) => f.properties.model !== fullPath);
    allFeatures.length = 0;
    for (const f of remaining) allFeatures.push(f);
    knownModelPaths.delete(fullPath);
    checkedGroups.delete(fullPath);

    if (map.getSource(sourceId)) {
      map.getSource(sourceId).setData({ type: "FeatureCollection", features: allFeatures });
    }
    applyFilter();
    group.clear();
    renderTree(group, buildModelTree([...knownModelPaths]));
  }

  function createSourceAndLayer(data) {
    map.addSource(sourceId, { type: "geojson", data });
    map.addLayer({
      id: layerId,
      type: "line",
      source: sourceId,
      layout: { "line-join": "round", "line-cap": "round" },
      // Data-driven from each feature's own (normalised) 12d colour —
      // was hardcoded to one flat blue for every service regardless of
      // its real colour, reported by Cameron as "colours aren't coming
      // through." See service-colour.js for why the raw 12d value can't
      // just be used directly (AutoCAD Color Index codes etc. aren't
      // valid CSS on their own).
      paint: { "line-color": ["get", "colour"], "line-width": 3 },
    });
    map.on("click", layerId, (e) => {
      if (drawToolState.active) return; // let the click through to the active draw tool instead
      new mapboxgl.Popup().setLngLat(e.lngLat).setHTML(popupHtml(e.features[0].properties)).addTo(map);
    });
  }

  return {
    addFeatures(newFeatures) {
      // NOT allFeatures.push(...newFeatures) — spreading into a function
      // call has an engine-specific argument-count ceiling; a real,
      // large-enough upload (see the same bug just fixed in
      // profile-chart.js) would throw "Maximum call stack size exceeded"
      // here instead of loading. A plain loop has no such limit.
      for (const f of newFeatures) allFeatures.push(f);
      const data = { type: "FeatureCollection", features: allFeatures };
      if (map.getSource(sourceId)) {
        map.getSource(sourceId).setData(data);
      } else {
        createSourceAndLayer(data);
      }
      applyFilter();
      rebuildTreeIfNeeded(newFeatures);
    },
    /** Re-create the source/layer after a base-style switch wiped it. No-op if nothing's loaded yet. */
    reAddIfPresent() {
      if (allFeatures.length === 0 || map.getSource(sourceId)) return;
      createSourceAndLayer({ type: "FeatureCollection", features: allFeatures });
      applyFilter();
    },
    /**
     * Only the features currently checked "on" in the sidebar tree — used
     * by the section/profile tool (see wireMapToolbar()'s onSectionLine)
     * so toggling a layer off in the sidebar also removes it from the
     * cut-line crossings, matching what's actually visible on the map.
     */
    getVisibleFeatures() {
      return allFeatures.filter((f) => checkedGroups.has(f.properties.model));
    },
    /** Deletes every loaded model group at once — wired to this layer's own group/subgroup delete button. */
    removeAll() {
      for (const m of [...knownModelPaths]) removeModel(m);
    },
  };
}

const servicesController = createLineFeatureController({
  sourceId: "services-12d",
  layerId: "services-12d-layer",
  group: servicesGroup,
  popupHtml: (p) =>
    `<b>${p.name ?? "Service"}</b><br>${p.model ?? ""} (style ${p.style ?? "?"})<br>` +
    `Diameter: ${p.diameter ?? "?"} m, justify: ${p.justify ?? "?"}<br>` +
    `Colour: ${p.rawColour ?? "?"}<br>` +
    "Depth: surveyed (12d) — see the 3D view, or cut a Section across it, for actual elevation.",
});

const designLineworkController = createLineFeatureController({
  sourceId: "design-linework",
  layerId: "design-linework-layer",
  group: designLineworkGroup,
  popupHtml: (p) =>
    `<b>${p.name ?? "Design line"}</b><br>${p.model ?? ""} (style ${p.style ?? "?"})<br>` +
    `Colour: ${p.rawColour ?? "?"}<br>` +
    "Design linework (12d) — not a service.",
});

/**
 * Parse 12d records into map-ready line features — shared by both
 * services and design linework (see createLineFeatureController()
 * above for why they're structurally identical). Splits on gaps
 * (twelve-d.js splitOnGaps() — see its header for why a flat distance
 * threshold doesn't work) and filters out anything left with <2 points
 * (point/symbol data, or an isolated point after splitting).
 *
 * Keeps each point's real elevation as a 3rd GeoJSON coordinate value
 * ([lon, lat, elevationAhd], added 2026-08-26) — Mapbox's 2D line layer
 * ignores it, but section-intersect.js's cut-line crossings need it to
 * show real pipe/linework depth rather than just terrain height. See
 * wireMapToolbar()'s onSectionLine for where it's used.
 *
 * @param {string} layerKind - tags each feature for the section-view
 *   legend/labelling (section-intersect.js) — "services" or
 *   "design-linework", not used for anything else here.
 */
function buildLineFeaturesFrom12d(records, layerKind) {
  let skippedShort = 0;
  const features = records.flatMap((r) => {
    const segments = splitOnGaps(r.centrelinePoints);
    // Same per-record values reused across however many segments this one
    // record split into — hoisted out of the per-segment map (2026-08-26,
    // same fix as buildSurfaceFeaturesFrom12d(), see its comment for why:
    // normalizeColour() does real work, not a cheap lookup).
    const model = r.model ?? "(unlabelled)";
    const normalizedColour = normalizeColour(r.colour);
    return segments
      .filter((seg) => {
        const ok = seg.length >= 2;
        if (!ok) skippedShort++;
        return ok;
      })
      .map((seg) => ({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: seg.map(([e, n, z]) => {
            const [lon, lat] = mga50ToWgs84([e, n]);
            return [lon, lat, z];
          }),
        },
        properties: {
          name: r.name,
          model,
          style: r.style ?? "(no style)",
          diameter: r.diameter,
          justify: r.justify,
          depthAccuracy: "surveyed",
          rawColour: r.colour,
          colour: normalizedColour,
          layerKind,
        },
      }));
  });
  return { features, skippedShort };
}

// LineString.coordinates is already a flat point list (depth 1).
// Polygon.coordinates (added 2026-08-26, for surface triangles) is one
// level deeper — an array of rings, each a point list (depth 2) — so it
// needs exactly one extra level flattened to reach real points, no more
// (naively flattening everything would shred each point itself into loose
// numbers). Slices off the 3rd (elevation) coordinate value, if present —
// mapboxgl.LngLatBounds.extend() only wants [lon, lat].
function pointsOf(geometry) {
  const points = geometry.type === "Polygon" ? geometry.coordinates.flat(1) : geometry.coordinates;
  return points.map(([lon, lat]) => [lon, lat]);
}

function fitMapToFeatures(features) {
  if (features.length === 0) return;
  const coords = features.flatMap((f) => pointsOf(f.geometry));
  const bounds = coords.reduce(
    (b, c) => b.extend(c),
    new mapboxgl.LngLatBounds(coords[0], coords[0])
  );
  map.fitBounds(bounds, { padding: 80, maxZoom: 19 });
}

/**
 * Controller for a "12d full_tin surface(s), rendered as a triangle mesh"
 * layer — structurally simpler than createLineFeatureController() since
 * surfaces don't have a `model` hierarchy worth a nested tree; one flat
 * sidebar row per surface is enough for now, toggling via a `surfaceId`
 * filter.
 *
 * Keyed on `surfaceId`, NOT the surface's own internal `name` (2026-08-26,
 * per Cameron: uploading multiple dated surfaces — e.g. monthly drone
 * flights — to compare against each other is the actual intended
 * workflow). The one real sample seen so far is literally named "12d
 * Quick Tin", 12d's own generic default — real exports could very
 * plausibly reuse that same generic name (or any other name) across
 * separate flights/uploads, which would silently MERGE two different
 * months' surfaces into one indistinguishable, un-independently-
 * toggleable sidebar entry if keyed on name alone. `surfaceId` combines
 * the uploaded file's name with the surface's internal name instead — see
 * buildSurfaceFeaturesFrom12d() — so every upload gets its own row even
 * if 12d gave the surface itself an identical (or generic) name.
 */
function createSurfaceFeatureController({ sourceId, fillLayerId, lineLayerId, group, popupHtml, onSurfacesChanged }) {
  const allFeatures = [];
  const knownSurfaceIds = new Set(); // Sets preserve insertion order — relied on by the compare control's "default to the two most recent" logic
  const checkedSurfaces = new Set();
  const checkboxes = new Map(); // surfaceId -> its sidebar row's <input>, so setSurfaceVisible() can drive the same checkbox the compare control's dropdowns pick from

  function applyFilter() {
    map.setFilter(fillLayerId, ["in", ["get", "surfaceId"], ["literal", [...checkedSurfaces]]]);
    map.setFilter(lineLayerId, ["in", ["get", "surfaceId"], ["literal", [...checkedSurfaces]]]);
  }

  function setSourceData() {
    const data = { type: "FeatureCollection", features: allFeatures };
    if (map.getSource(sourceId)) map.getSource(sourceId).setData(data);
  }

  /**
   * Removes one surface entirely (all its triangle features, its sidebar
   * row, its compare-control eligibility) — added 2026-08-31, per
   * Cameron: "we also need to be able to rename, edit and delete
   * layers/groups." Rename is generic (layer-tree.js), this is the
   * data-removal half delete also needs.
   */
  function removeSurface(id) {
    const remaining = allFeatures.filter((f) => f.properties.surfaceId !== id);
    allFeatures.length = 0;
    for (const f of remaining) allFeatures.push(f);
    knownSurfaceIds.delete(id);
    checkedSurfaces.delete(id);
    checkboxes.delete(id);
    setSourceData();
    applyFilter();
    onSurfacesChanged?.([...knownSurfaceIds]);
  }

  function addSidebarRowsIfNeeded(newFeatures) {
    let added = false;
    for (const f of newFeatures) {
      const id = f.properties.surfaceId;
      if (knownSurfaceIds.has(id)) continue;
      knownSurfaceIds.add(id);
      checkedSurfaces.add(id);
      added = true;
      const input = group.addRow({
        label: id,
        color: f.properties.colour,
        checked: true,
        onChange: (checked) => {
          if (checked) checkedSurfaces.add(id);
          else checkedSurfaces.delete(id);
          applyFilter();
        },
        onDelete: () => removeSurface(id),
      });
      checkboxes.set(id, input);
    }
    if (added) onSurfacesChanged?.([...knownSurfaceIds]);
  }

  function createSourceAndLayers(data) {
    map.addSource(sourceId, { type: "geojson", data });
    map.addLayer({
      id: fillLayerId,
      type: "fill",
      source: sourceId,
      paint: { "fill-color": ["get", "colour"], "fill-opacity": 0.45 },
    });
    map.addLayer({
      id: lineLayerId,
      type: "line",
      source: sourceId,
      paint: { "line-color": ["get", "colour"], "line-width": 0.5, "line-opacity": 0.6 },
    });
    map.on("click", fillLayerId, (e) => {
      if (drawToolState.active) return; // let the click through to the active draw tool instead — the actual bug report
      new mapboxgl.Popup().setLngLat(e.lngLat).setHTML(popupHtml(e.features[0].properties)).addTo(map);
    });
  }

  return {
    addFeatures(newFeatures) {
      // NOT allFeatures.push(...newFeatures) — see createLineFeatureController's
      // identical fix above. A real drone-flight-density surface (thousands
      // of triangle features per upload) can exceed the spread-argument
      // ceiling here specifically — this is likely THE actual crash site
      // for a real dense surface upload, more so than the line-feature
      // controller above (which only ever sees hundreds of segments).
      for (const f of newFeatures) allFeatures.push(f);
      const data = { type: "FeatureCollection", features: allFeatures };
      if (map.getSource(sourceId)) {
        map.getSource(sourceId).setData(data);
      } else {
        createSourceAndLayers(data);
      }
      applyFilter();
      addSidebarRowsIfNeeded(newFeatures);
    },
    reAddIfPresent() {
      if (allFeatures.length === 0 || map.getSource(sourceId)) return;
      createSourceAndLayers({ type: "FeatureCollection", features: allFeatures });
      applyFilter();
    },
    /** See createLineFeatureController()'s getVisibleFeatures() — same idea. */
    getVisibleFeatures() {
      return allFeatures.filter((f) => checkedSurfaces.has(f.properties.surfaceId));
    },
    /** For surface-compare.js: every surfaceId seen so far, in load order. */
    getKnownSurfaceIds() {
      return [...knownSurfaceIds];
    },
    /**
     * Drives the same visibility state a sidebar checkbox would — used by
     * surface-compare.js so its A/B toggle and the individual per-surface
     * checkboxes never disagree about what's actually showing.
     */
    setSurfaceVisible(id, visible) {
      const checkbox = checkboxes.get(id);
      if (!checkbox) return;
      checkbox.checked = visible;
      if (visible) checkedSurfaces.add(id);
      else checkedSurfaces.delete(id);
      applyFilter();
    },
    /** Deletes every loaded surface at once — wired to the "Surfaces" subgroup's own delete button. */
    removeAll() {
      for (const id of [...knownSurfaceIds]) removeSurface(id);
    },
  };
}

// Rendered above the Surfaces group's own rows; stays hidden until 2+
// surfaces are loaded (see surface-compare.js). References
// designSurfaceController inside a closure rather than directly, since
// it isn't assigned until just after this — never actually called until
// a user interacts with the dropdowns/buttons, well after both exist.
const surfaceCompareControl = createSurfaceCompareControl(designSurfaceGroup.body, {
  setSurfaceVisible: (id, visible) => designSurfaceController.setSurfaceVisible(id, visible),
});

const designSurfaceController = createSurfaceFeatureController({
  sourceId: "design-surface",
  fillLayerId: "design-surface-fill-layer",
  lineLayerId: "design-surface-line-layer",
  group: designSurfaceGroup,
  onSurfacesChanged: (ids) => surfaceCompareControl.onSurfacesChanged(ids),
  popupHtml: (p) =>
    `<b>${p.surfaceName}</b> (${p.sourceFile})<br>${p.model ?? ""}<br>` +
    `RL ${p.minZ.toFixed(3)}–${p.maxZ.toFixed(3)} AHD (this triangle)<br>` +
    `Colour: ${p.rawColour ?? "?"}<br>` +
    "12d full_tin surface — triangle mesh, not interpolated contours.",
});

/**
 * Convert parsed 12d `full_tin` surface records (see twelve-d.js
 * parse12da() full_tin notes) into per-triangle GeoJSON Polygon features.
 *
 * Excludes `nulling === 1` triangles — see twelve-d.js for why (inferred
 * from this one sample's geometry as "auto-bounding scaffold, not real
 * design data", not from any 12d spec; ask Cameron before trusting this
 * on a differently-shaped surface export).
 *
 * @param {string} sourceFileName - the uploaded file's name, used (with
 *   the surface's own internal `name`) to build a `surfaceId` that stays
 *   unique across separate uploads even when 12d gives two different
 *   surfaces the same (or a generic, e.g. "12d Quick Tin") internal name
 *   — see createSurfaceFeatureController()'s docstring for why that
 *   matters (comparing multiple dated surfaces, e.g. monthly drone
 *   flights, is the actual intended use).
 */
function buildSurfaceFeaturesFrom12d(surfaces, sourceFileName) {
  let excludedScaffold = 0;
  const features = surfaces.flatMap((surf) => {
    // Hoisted out of the per-triangle loop below (2026-08-26, performance
    // fix): these are the same for every triangle in a surface, but were
    // being recomputed per-triangle — including normalizeColour(), which
    // does real work (CSS.supports() + regex matching), not just a cheap
    // lookup. Measured against a synthetic 500,000-triangle surface (the
    // 2-triangle "Quick Tin" sample never would have shown this): a real
    // drone-flight-density surface is exactly the case that makes this
    // matter, per Cameron's stated monthly-comparison use case.
    const surfaceName = surf.name ?? "(unnamed surface)";
    const surfaceId = `${sourceFileName} — ${surfaceName}`;
    const model = surf.model ?? "(unlabelled)";
    const normalizedColour = normalizeColour(surf.colour, "#2ee6c8");

    // Also hoisted: project every point ONCE, not once per triangle that
    // references it. A real mesh's interior vertices are typically shared
    // by ~6 triangles each — re-running mga50ToWgs84() per occurrence was
    // ~3-6x more coordinate-transform calls than actually necessary.
    const pointsWgs84 = surf.points.map(([e, n, z]) => {
      const [lon, lat] = mga50ToWgs84([e, n]);
      return [lon, lat, z];
    });

    return surf.triangles
      .map((tri, idx) => ({ tri, nulling: surf.nulling[idx] }))
      .filter(({ nulling }) => {
        const keep = nulling !== 1;
        if (!keep) excludedScaffold++;
        return keep;
      })
      .map(({ tri, nulling }) => {
        // Keeps real elevation as each ring point's 3rd coordinate value
        // (Mapbox's fill/line layers ignore it) — section-intersect.js
        // needs it to interpolate the surface's elevation where the cut
        // line crosses this triangle, not just its plan-view outline.
        const ring = tri.map((i) => pointsWgs84[i]);
        ring.push(ring[0]); // close the polygon ring
        const elevations = tri.map((i) => surf.points[i][2]); // fixed length 3 — safe to spread below
        return {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [ring] },
          properties: {
            surfaceId,
            surfaceName,
            sourceFile: sourceFileName,
            model,
            rawColour: surf.colour,
            colour: normalizedColour,
            nulling,
            minZ: Math.min(...elevations),
            maxZ: Math.max(...elevations),
          },
        };
      });
  });
  return { features, excludedScaffold };
}

/**
 * The "Design" upload slot accepts more than one format — per Cameron
 * (2026-08-26): "the design upload probably needs to be able to support
 * linework, .ifc (3d trimesh), and surfaces." Routes by extension to
 * the appropriate handler below. `.12da`/`.12daz` covers BOTH linework
 * (`string` records) and surfaces (`full_tin` records, added 2026-08-26
 * once a real sample — "FL Surface.12daz" — arrived) — a single file
 * could in principle contain either or both, so handleDesign12dFile()
 * checks for both kinds of content rather than assuming one.
 */
function wireDesignInput() {
  const fileInput = document.getElementById("design-input");
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (/\.ifc$/i.test(file.name)) {
      await handleIfcDesignFile(file);
    } else if (/\.12daz?$/i.test(file.name)) {
      await handleDesign12dFile(file);
    } else {
      setStatus(`Unrecognised design file type: ${file.name} — expected .ifc, .12da, or .12daz.`);
    }
  });
}

async function handleIfcDesignFile(file) {
  setStatus(`Reading ${file.name}…`);
  let pointFeature; // set by whichever branch below actually places this design; read again once the footprint's computed
  try {
    const buffer = new Uint8Array(await file.arrayBuffer());
      const georef = extractGeoreference(buffer);

      if (georef && !georef.isKnownMga50) {
        // See ifc.js extractGeoreference() — a real K2 file has been seen
        // with a "K2 Plant Grid" target CRS, not GDA2020/MGA50. Its
        // offset is NOT a trustworthy real-world coordinate; plotting it
        // via mga50ToWgs84() as if it were would silently place the
        // marker somewhere nonsensical (e.g. MGA50 (0,0), nowhere near
        // WA). Refuse rather than guess.
        setStatus(
          `${file.name}'s IfcMapConversion target CRS is "${georef.crsName}", not ` +
            "GDA2020/MGA50 — can't place it on the map without a known transform " +
            "from that grid. Ask Cameron. See console."
        );
        console.warn("[K2-2D] Untrusted georeference, not plotted:", georef);
        return;
      }

      if (georef) {
        // Fast path: place the marker straight from the STEP-text
        // georeference, before loading full geometry (which takes a few
        // seconds the first time — fetches the web-ifc WASM).
        const [lon, lat] = mga50ToWgs84([georef.eastingOffset, georef.northingOffset]);
        const feature = {
          type: "Feature",
          geometry: { type: "Point", coordinates: [lon, lat] },
          properties: {
            name: file.name,
            crsName: georef.crsName,
            eastingOffset: georef.eastingOffset,
            northingOffset: georef.northingOffset,
            heightOffset: georef.heightOffset,
          },
        };
        pointFeature = feature;
        ifcController.setDesign(file.name, feature, null);
        map.flyTo({ center: [lon, lat], zoom: 18 });
        setStatus(
          `Placed ${file.name} at MGA50 E${georef.eastingOffset} N${georef.northingOffset} ` +
            `(${georef.crsName ?? "CRS name not found"}). Loading design geometry for a real footprint…`
        );
      } else {
        setStatus(
          `No IFCMAPCONVERSION found in ${file.name} — loading its geometry to check whether ` +
            "real-world coordinates are baked in directly instead (see ifc.js resolveCoordinationOffset)…"
        );
      }

      // Compute a real footprint (bounding-box outline, see ifc.js
      // computeFootprintCornersScene()) by actually loading the IFC's
      // geometry through the same @thatopen/components pipeline the 3D
      // page uses. For files with no IFCMAPCONVERSION, this is also the
      // ONLY way to place them at all — see resolveCoordinationOffset().
      try {
        const { components, ifcLoader } = await getIfcEngine();
        const { model } = await loadIfcFile(components, ifcLoader, file);

        let localOrigin; // [easting, northing, height] — see crs.js mgaToScene()/sceneToMga()
        let crsLabel;

        if (georef) {
          // IMPORTANT: use the georef's OWN offset as the local origin
          // (matching main.js's SCENE_ORIGIN_MGA pattern), not [0,0,0].
          // An earlier attempt used [0,0,0] on the theory that "scene"
          // coords would then just equal true MGA — mathematically fine,
          // but a real bug in practice: it positions the Three.js object
          // at a ~6.4-million-unit translation, which blows past
          // float32's precision for the ~10m-scale local geometry
          // sitting on top of it. Caught by checking the actual output
          // coordinates: came back near Antarctica instead of Kwinana.
          // Keeping the model near the ORIGIN during measurement (as the
          // 3D page already correctly does) avoids this entirely — only
          // convert back to real MGA at the very end.
          localOrigin = [georef.eastingOffset, georef.northingOffset, georef.heightOffset];
          const placement = computeIfcPlacement(georef, localOrigin);
          model.object.position.set(...placement.position); // ~[0,0,0]
          model.object.rotation.y = placement.rotationY;
          crsLabel = georef.crsName ?? "CRS name not found";
        } else {
          // No IFCMAPCONVERSION at all. Try the coordination-matrix
          // fallback: web-ifc's own COORDINATE_TO_ORIGIN (on by default)
          // already re-centred this model's geometry near the origin
          // internally if its raw coordinates were large/real-world —
          // no position/rotation of our own needed, just read back what
          // it subtracted.
          const offset = await resolveCoordinationOffset(model);
          if (!offset.isPlausibleMga50) {
            setStatus(
              `${file.name} has no IFCMAPCONVERSION, and its geometry's own coordinates don't ` +
                "look like real GDA2020/MGA50 either — can't place it on the map. See console."
            );
            console.warn("[K2-2D] Coordination offset outside plausible MGA50 range, not plotted:", offset);
            return;
          }
          localOrigin = [offset.easting, offset.northing, offset.height];
          crsLabel =
            "no IFCMAPCONVERSION — inferred from the geometry's own real-world coordinates " +
            "(web-ifc COORDINATE_TO_ORIGIN)";

          const [lon, lat] = mga50ToWgs84([localOrigin[0], localOrigin[1]]);
          const feature = {
            type: "Feature",
            geometry: { type: "Point", coordinates: [lon, lat] },
            properties: {
              name: file.name,
              crsName: crsLabel,
              eastingOffset: localOrigin[0],
              northingOffset: localOrigin[1],
              heightOffset: localOrigin[2],
            },
          };
          pointFeature = feature;
          ifcController.setDesign(file.name, feature, null);
          map.flyTo({ center: [lon, lat], zoom: 18 });
        }

        const corners = computeFootprintCornersScene(model); // [[x,z], ...] small scene units, safe precision
        const ring = corners.map(([x, z]) => mga50ToWgs84(sceneToMga([x, 0, z], localOrigin)));
        ring.push(ring[0]); // close the polygon ring

        const footprintFeature = {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [ring] },
          properties: { name: file.name },
        };
        ifcController.setDesign(file.name, pointFeature, footprintFeature);

        setStatus(
          `Placed ${file.name} at MGA50 E${localOrigin[0].toFixed(3)} N${localOrigin[1].toFixed(3)} ` +
            `(${crsLabel}). Footprint shown is an axis-aligned bounding-box outline, not the true ` +
            "design shape (see ifc.js) — good enough for a rectangular, unrotated design, looser " +
            "for anything rotated or non-rectangular."
        );
        stashDesignFile("design", file); // carries over to the 3D view — see shared-design-store.js
      } catch (err) {
        console.error("[K2-2D] Geometry load failed:", err);
        if (georef) {
          setStatus(
            `Placed ${file.name}'s base point, but couldn't load its geometry for a footprint: ` +
              `${err.message} (see console).`
          );
        } else {
          setStatus(
            `Couldn't load ${file.name}'s geometry (needed since it has no IFCMAPCONVERSION): ` +
              `${err.message} (see console).`
          );
        }
      }
  } catch (err) {
    console.error(err);
    setStatus(`Failed to read ${file.name}: ${err.message}`);
  }
}

/**
 * Design linework AND/OR surfaces: reuses the exact same 12d parsing
 * pipeline as services for linework (buildLineFeaturesFrom12d /
 * createLineFeatureController), plus buildSurfaceFeaturesFrom12d /
 * createSurfaceFeatureController for `full_tin` surfaces — rendered into
 * the Design group's Linework/Surfaces subgroups instead of Underground
 * Services. A single file could contain strings, full_tins, both, or (if
 * it's some other 12d export entirely) neither — each kind is added
 * independently, only if present.
 */
async function handleDesign12dFile(file) {
  setStatus(`Loading ${file.name}…`);
  try {
    const records = await loadTwelveDaFile(file);
    console.log("[K2-2D] Parsed design 12d records:", records);

    const hasLinework = records.length > 0;
    const hasSurfaces = records.surfaces.length > 0;

    if (!hasLinework && !hasSurfaces) {
      const unrecognized = [...records.unrecognizedTopLevelKeys].filter((k) => k !== "null");
      if (unrecognized.length > 0) {
        setStatus(
          `${file.name} has no linework (string) or surface (full_tin) data — found ` +
            `unrecognised block(s): ${unrecognized.join(", ")}. See console.`
        );
        console.warn("[K2-2D] Unrecognised top-level 12d block(s):", unrecognized);
      } else {
        setStatus(`${file.name} has no linework or surface data in it — nothing to show.`);
      }
      return;
    }

    const messages = [];
    let allNewFeatures = [];

    if (hasLinework) {
      const { features, skippedShort } = buildLineFeaturesFrom12d(records, "design-linework");
      if (skippedShort > 0) {
        console.warn(`[K2-2D] Skipped ${skippedShort} design linework segment(s) with <2 points.`);
      }
      designLineworkController.addFeatures(features);
      allNewFeatures = allNewFeatures.concat(features);
      messages.push(`${records.length} design linework string(s)`);
    }

    if (hasSurfaces) {
      const { features, excludedScaffold } = buildSurfaceFeaturesFrom12d(records.surfaces, file.name);
      if (excludedScaffold > 0) {
        console.warn(
          `[K2-2D] Excluded ${excludedScaffold} triangle(s) inferred as auto-bounding-box ` +
            "scaffold (nulling===1) — see twelve-d.js full_tin notes. Unconfirmed with Cameron."
        );
      }
      designSurfaceController.addFeatures(features);
      allNewFeatures = allNewFeatures.concat(features);
      messages.push(
        `${records.surfaces.length} surface(s) (${features.length} triangle(s) shown, ` +
          `${excludedScaffold} excluded as scaffold — unconfirmed, see console)`
      );
    }

    fitMapToFeatures(allNewFeatures);
    setStatus(`Loaded ${file.name}: ${messages.join(" and ")} on the map.`);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load ${file.name}: ${err.message}`);
  }
}

function wireServicesInput() {
  const fileInput = document.getElementById("services-input");
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus(`Loading ${file.name}…`);
    try {
      const records = await loadTwelveDaFile(file);
      console.log("[K2-2D] Parsed 12d records:", records);

      // Some real exports include point/symbol features (data_2d, no
      // data_3d — e.g. SDR survey pickups, symbol placements) alongside
      // line strings, and some records bundle several physically
      // separate features (e.g. multiple distinct manhole rim outlines)
      // into one `data_3d` array with no marker between them — see
      // buildLineFeaturesFrom12d() / twelve-d.js splitOnGaps() for how
      // both are handled (found against a real 800-record weekly
      // export; reported by Cameron as "pits seem to be joining up").
      const { features, skippedShort } = buildLineFeaturesFrom12d(records, "services");
      if (skippedShort > 0) {
        console.warn(
          `[K2-2D] Skipped ${skippedShort} segment(s) with <2 points (point/symbol data, or an ` +
            "isolated single point left over after gap-splitting)."
        );
      }

      servicesController.addFeatures(features);
      fitMapToFeatures(features);
      setStatus(`Loaded ${file.name}: ${records.length} service string(s) on the map.`);
      stashDesignFile("services", file); // carries over to the 3D view — see shared-design-store.js
    } catch (err) {
      console.error(err);
      setStatus(`Failed to load ${file.name}: ${err.message}`);
    }
  });
}

// --- Map toolbar: measure (distance/area) + section/profile ------------
//
// "Section" (per Cameron, 2026-08-24): draw a line, split the view so a
// profile pane opens alongside the map (a "Civillo"-style layout — see
// README) showing where that line crosses loaded design/service data
// (section-intersect.js). No terrain line any more (removed 2026-08-26,
// per Cameron: "the mapbox terrain should be removed, it doesn't really
// do anything relevant" — see README "Terrain"); IFC design geometry
// isn't intersected yet either — see section-intersect.js's header.
// Chose a side-by-side split (map | profile) rather than stacked top/
// bottom, matching how Civil3D/most section tools pair a plan view with
// a profile view — flag to Cameron if a stacked layout was actually meant.

function wireMapToolbar() {
  const btnDistance = document.getElementById("tool-distance");
  const btnArea = document.getElementById("tool-area");
  const btnSection = document.getElementById("tool-section");
  const btnClear = document.getElementById("tool-clear");
  const measureResultEl = document.getElementById("measure-result");
  const profilePane = document.getElementById("profile-pane");
  const profileSummaryEl = document.getElementById("profile-summary");
  const profileChartEl = document.getElementById("profile-chart");
  const profileCloseBtn = document.getElementById("profile-close");
  const profileExpandBtn = document.getElementById("profile-expand");

  const toolButtons = [btnDistance, btnArea, btnSection];
  function setActiveTool(activeBtn) {
    for (const b of toolButtons) b.classList.toggle("active", b === activeBtn);
    // See drawToolState's declaration (top of file) for why every
    // clickable layer's popup handler needs to know this.
    drawToolState.active = activeBtn !== null;
  }

  function showMeasureResult(text) {
    measureResultEl.textContent = text;
    measureResultEl.classList.toggle("active", !!text);
  }

  // Mapbox GL does auto-detect its container resizing (ResizeObserver),
  // but calling resize() explicitly right after the flex layout changes
  // is cheap, harmless if redundant, and removes any doubt — couldn't
  // visually confirm the auto-resize timing in my test environment (see
  // README's rendering-verification note), so not leaving it to chance.
  function afterPaneToggle() {
    requestAnimationFrame(() => map.resize());
  }

  // Collapses back to the default half-page height on close — reopening
  // for a new section always starts fresh rather than staying expanded
  // from a previous look.
  function resetProfileExpansion() {
    profilePane.classList.remove("expanded");
    profileExpandBtn.textContent = "⤢ Expand";
  }

  function closeProfilePane() {
    profilePane.classList.remove("active");
    resetProfileExpansion();
    setActiveTool(null);
    afterPaneToggle();
  }

  const tools = createDrawTools(map, {
    onMeasureResult: showMeasureResult,
    onSectionLine: (lineCoordsWgs84) => {
      setActiveTool(null); // section is single-shot; drawing is done
      profilePane.classList.add("active");
      afterPaneToggle();
      profileChartEl.innerHTML = "";
      // Broken into separately-labelled stages with sizes attached to any
      // error message (2026-08-27) — Cameron kept hitting "Maximum call
      // stack size exceeded" here even after two rounds of real fixes
      // (see README) which were re-verified against synthetic data far
      // bigger than anything realistic without reproducing it. Since I
      // can't get a real browser's devtools/stack trace from this
      // session, the next-best diagnostic is having the app report WHICH
      // stage failed and how much data was involved, directly in the
      // status bar, without needing Cameron to open devtools at all.
      let stage = "reading visible layers";
      try {
        const visibleLineFeatures = [
          ...servicesController.getVisibleFeatures(),
          ...designLineworkController.getVisibleFeatures(),
        ];
        const visibleSurfaceFeatures = designSurfaceController.getVisibleFeatures();

        stage = `computing line length (line has ${lineCoordsWgs84.length} point(s))`;
        const totalDistanceM = lineLengthM(lineCoordsWgs84);

        // Cut-line crossings against whatever's currently checked "on" in
        // the sidebar — services, design linework, design surfaces (added
        // 2026-08-26 per Cameron: "need to be able to see these layers on
        // the section view as well"). NOT the IFC design layer — see
        // section-intersect.js's header for why (only a bounding-box
        // footprint is tracked in 2D, not real geometry to intersect).
        // No terrain sampling any more either — removed the same day per
        // Cameron: "the mapbox terrain should be removed, it doesn't
        // really do anything relevant" (see README "Terrain").
        stage =
          `computing crossings (${visibleLineFeatures.length} visible line feature(s), ` +
          `${visibleSurfaceFeatures.length} visible surface triangle(s))`;
        const crossings = computeSectionCrossings(lineCoordsWgs84, {
          lineFeatures: visibleLineFeatures,
          surfaceFeatures: visibleSurfaceFeatures,
        });

        const crossingCount = crossings.lineCrossings.length + crossings.surfaceChords.length;
        profileSummaryEl.textContent =
          `Length: ${totalDistanceM.toFixed(1)} m. ` +
          (crossingCount > 0
            ? `${crossings.lineCrossings.length} service/linework crossing(s) and ` +
              `${crossings.surfaceChords.length} surface segment(s) shown below, at real surveyed/` +
              "design elevation — drag across the chart for a live surface↔service delta height. " +
              "IFC design geometry isn't intersected yet (only its footprint is tracked in 2D)."
            : "No currently-visible service/linework/surface layer crosses this line.");

        stage =
          `rendering the chart (${crossings.lineCrossings.length} line crossing(s), ` +
          `${crossings.surfaceChords.length} surface chord(s))`;
        renderProfileChart(profileChartEl, { totalDistanceM }, crossings);
      } catch (err) {
        console.error(`[K2-2D] Section profile failed while ${stage}:`, err);
        profileSummaryEl.textContent = `Failed to build profile while ${stage}: ${err.message}`;
      }
    },
  });

  btnDistance.addEventListener("click", () => {
    setActiveTool(btnDistance);
    closeProfilePaneKeepingTool();
    tools.startDistance();
  });
  btnArea.addEventListener("click", () => {
    setActiveTool(btnArea);
    closeProfilePaneKeepingTool();
    tools.startArea();
  });
  btnSection.addEventListener("click", () => {
    setActiveTool(btnSection);
    showMeasureResult("");
    tools.startSection();
  });
  btnClear.addEventListener("click", () => {
    tools.clear();
    closeProfilePane();
  });
  profileCloseBtn.addEventListener("click", () => {
    tools.stop();
    closeProfilePane();
  });
  profileExpandBtn.addEventListener("click", () => {
    const expanded = profilePane.classList.toggle("expanded");
    profileExpandBtn.textContent = expanded ? "⤡ Collapse" : "⤢ Expand";
    afterPaneToggle(); // map's visible height changed too — resize it
  });

  // Starting a measurement while the profile pane is open should close
  // it (they're different tools sharing the same draw layer) without
  // touching the measure-result badge, which the caller sets separately.
  function closeProfilePaneKeepingTool() {
    profilePane.classList.remove("active");
    afterPaneToggle();
  }
}
