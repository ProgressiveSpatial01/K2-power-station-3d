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
// views. No shared *state* between the 2D and 3D pages yet (each has
// its own file pickers, nothing carries across the navigation) — see
// README "Open items" for that as a follow-up.

import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { mga50ToWgs84 } from "./crs.js";
import { extractGeoreference } from "./ifc.js";
import { loadTwelveDaFile } from "./twelve-d.js";
import { createLayerGroup } from "./layer-tree.js";

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

// Last-loaded data, kept so custom sources/layers can be re-added after
// a base style switch (Mapbox GL wipes all custom sources/layers on
// map.setStyle() — see wireBaseStyleGroup()).
const state = {
  ifcFeature: null,
  ifcRowAdded: false,
  serviceFeatures: [],
  checkedServiceStyles: new Set(),
};

const layerTreeEl = document.getElementById("layer-tree");
const baseGroup = createLayerGroup(layerTreeEl, { label: "Base Map" });
const designGroup = createLayerGroup(layerTreeEl, { label: "Design" });
const servicesGroup = createLayerGroup(layerTreeEl, { label: "Underground Services" });

wireBaseStyleGroup();

map.on("load", () => {
  setStatus("Ready — choose an .ifc design and/or a .12da/.12daz services file.");
  addCustomLayers();
  wireIfcInput();
  wireServicesInput();
});

// Base style switches destroy all custom sources/layers; re-add them
// (from `state`) once the new style has finished loading.
map.on("style.load", () => {
  if (state.ifcFeature || state.serviceFeatures.length > 0) {
    addCustomLayers();
  }
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

/** Re-add every custom source/layer currently held in `state`. Safe to call repeatedly. */
function addCustomLayers() {
  if (state.ifcFeature) addOrUpdateIfcLayer(state.ifcFeature);
  if (state.serviceFeatures.length > 0) addOrUpdateServicesLayer(state.serviceFeatures);
}

function addOrUpdateIfcLayer(feature) {
  const sourceId = "ifc-design-point";
  const layerId = "ifc-design-point-layer";
  const data = { type: "FeatureCollection", features: [feature] };

  if (map.getSource(sourceId)) {
    map.getSource(sourceId).setData(data);
    return;
  }

  map.addSource(sourceId, { type: "geojson", data });
  map.addLayer({
    id: layerId,
    type: "circle",
    source: sourceId,
    paint: {
      "circle-radius": 8,
      "circle-color": "#ffb454",
      "circle-stroke-color": "#000",
      "circle-stroke-width": 2,
    },
  });
  map.on("click", layerId, (e) => {
    const p = e.features[0].properties;
    new mapboxgl.Popup()
      .setLngLat(e.lngLat)
      .setHTML(
        `<b>${p.name}</b><br>IFC project base point<br>` +
          `${p.crsName ?? "CRS unknown"}<br>` +
          `E ${p.eastingOffset} N ${p.northingOffset}<br>RL ${p.heightOffset} AHD<br>` +
          `<i>Only a marker — no design geometry shown in 2D yet, see 3D view.</i>`
      )
      .addTo(map);
  });

  // Guard against re-adding a duplicate sidebar row: this function reruns
  // its "create" branch every time a base-style switch wipes Mapbox's
  // custom layers (see map.on("style.load", ...) above), but the sidebar
  // row itself should only ever be created once.
  if (!state.ifcRowAdded) {
    state.ifcRowAdded = true;
    designGroup.addRow({
      label: feature.properties.name,
      color: "#ffb454",
      checked: true,
      onChange: (checked) => map.setLayoutProperty(layerId, "visibility", checked ? "visible" : "none"),
    });
  }
}

function addOrUpdateServicesLayer(features) {
  const sourceId = "services-12d";
  const layerId = "services-12d-layer";
  const data = { type: "FeatureCollection", features };

  if (map.getSource(sourceId)) {
    map.getSource(sourceId).setData(data);
  } else {
    map.addSource(sourceId, { type: "geojson", data });
    map.addLayer({
      id: layerId,
      type: "line",
      source: sourceId,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#2fa3ff", "line-width": 3 },
    });
    map.on("click", layerId, (e) => {
      const p = e.features[0].properties;
      new mapboxgl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(
          `<b>${p.name ?? "Service"}</b> (${p.style ?? "unknown style"})<br>` +
            `Diameter: ${p.diameter ?? "?"} m, justify: ${p.justify ?? "?"}<br>` +
            `Depth: surveyed (12d) — see 3D view for actual elevation.`
        )
        .addTo(map);
    });
  }

  applyServicesFilter(layerId);

  // Add a sub-toggle for every style not already represented — mirrors
  // CSBP's sub-grouping, but driven by a Mapbox `filter` on one shared
  // layer rather than one Mapbox layer per style (cheaper, and scales
  // to however many service styles a real K2 export turns out to have).
  const stylesSeen = new Set(features.map((f) => f.properties.style ?? "(no style)"));
  for (const style of stylesSeen) {
    if (state.checkedServiceStyles.has(style)) continue; // already has a row
    state.checkedServiceStyles.add(style);
    servicesGroup.addRow({
      label: style,
      color: "#2fa3ff",
      checked: true,
      onChange: (checked) => {
        if (checked) state.checkedServiceStyles.add(style);
        else state.checkedServiceStyles.delete(style);
        applyServicesFilter(layerId);
      },
    });
  }
}

function applyServicesFilter(layerId) {
  const checked = [...state.checkedServiceStyles];
  map.setFilter(layerId, ["in", ["get", "style"], ["literal", checked]]);
}

function wireIfcInput() {
  const fileInput = document.getElementById("ifc-input");
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus(`Reading ${file.name}…`);
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      const georef = extractGeoreference(buffer);
      if (!georef) {
        setStatus(`No IFCMAPCONVERSION found in ${file.name} — can't place it on the map.`);
        return;
      }
      if (!georef.isKnownMga50) {
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
      state.ifcFeature = feature;
      addOrUpdateIfcLayer(feature);

      map.flyTo({ center: [lon, lat], zoom: 18 });
      setStatus(
        `Placed ${file.name} at MGA50 E${georef.eastingOffset} N${georef.northingOffset} ` +
          `(${georef.crsName ?? "CRS name not found"}). This is only the project base point, ` +
          "not the design footprint — full 2D footprint extraction not implemented yet."
      );
    } catch (err) {
      console.error(err);
      setStatus(`Failed to read ${file.name}: ${err.message}`);
    }
  });
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

      const features = records.map((r) => ({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: r.centrelinePoints.map(([e, n]) => mga50ToWgs84([e, n])),
        },
        properties: {
          name: r.name,
          style: r.style ?? "(no style)",
          diameter: r.diameter,
          justify: r.justify,
          depthAccuracy: "surveyed",
        },
      }));

      state.serviceFeatures = state.serviceFeatures.concat(features);
      addOrUpdateServicesLayer(state.serviceFeatures);

      if (features.length > 0) {
        const coords = features.flatMap((f) => f.geometry.coordinates);
        const bounds = coords.reduce(
          (b, c) => b.extend(c),
          new mapboxgl.LngLatBounds(coords[0], coords[0])
        );
        map.fitBounds(bounds, { padding: 80, maxZoom: 19 });
      }

      setStatus(`Loaded ${file.name}: ${records.length} service string(s) on the map.`);
    } catch (err) {
      console.error(err);
      setStatus(`Failed to load ${file.name}: ${err.message}`);
    }
  });
}
