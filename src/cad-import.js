// cad-import.js — AutoCAD .dxf / .dwg → the same record shape twelve-d.js's
// parse12da() produces (an array of `string`-style records, plus
// `.surfaces` for triangulated meshes), so the Design input needs no new
// rendering path at all: layers become the same model-path tree, colours go
// through the same normaliser, linework/surfaces land in the same Design
// groups in 2D and 3D. Added 2026-10-14 per Cameron: "can we please
// support dwg and dxf files on the design input".
//
// .dxf → `dxf-parser` (MIT, ASCII DXF). .dwg → `@mlightcad/libredwg-web`
// (LibreDWG compiled to WASM; GPL-3.0 — see README), loaded lazily so
// neither costs anything until a CAD file is actually chosen.
//
// COORDINATES ARE NEVER TRANSFORMED OR RESCALED. A DXF/DWG carries no CRS,
// and headers lie about units (the GT11 conduits DWG says mm but its
// numbers are metres), so this reads the numbers as GDA2020 / MGA50 metres
// — the project CRS — and then CHECKS that the drawing's extents actually
// fall near the site. A local plant grid, a mm-scaled export, or another
// project's coordinates is refused with the extents in the message, same
// policy as an IFC on an unknown local grid. Never guess a transform.
const SITE_E = 384900;
const SITE_N = 6434050;
const MAX_DISTANCE_FROM_SITE_M = 50000;

export function isCadFileName(name) {
  return /\.(dxf|dwg)$/i.test(name);
}

// --- AutoCAD Color Index → CSS rgb() --------------------------------------

function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((n) => Math.round((n + m) * 255));
}

const ACI_BASIC = {
  1: [255, 0, 0], 2: [255, 255, 0], 3: [0, 255, 0], 4: [0, 255, 255], 5: [0, 0, 255],
  6: [255, 0, 255], 7: [255, 255, 255], 8: [128, 128, 128], 9: [192, 192, 192],
};

export function aciToCss(index) {
  if (ACI_BASIC[index]) return `rgb(${ACI_BASIC[index].join(",")})`;
  if (index >= 10 && index <= 249) {
    const hue = Math.floor((index - 10) / 10) * 15;
    const k = (index - 10) % 10;
    const value = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5, 0.3, 0.3][k];
    const sat = k % 2 === 0 ? 1 : 0.5;
    return `rgb(${hsvToRgb(hue, sat, value).join(",")})`;
  }
  if (index >= 250 && index <= 255) {
    const g = [51, 91, 132, 173, 214, 255][index - 250];
    return `rgb(${g},${g},${g})`;
  }
  return null;
}

// --- Neutral geometry (what both parsers are reduced to) -------------------
//
//   { kind: "line", layer, aci, pts: [[x,y,z],…], closed }
//   { kind: "face", layer, aci, pts: [[x,y,z]×3|4] }
//   { kind: "marker", layer, aci, pt: [x,y,z] }      (POINT / INSERT)
// plus a `skipped` tally of entity types we deliberately don't draw.

const NULL_Z = -998; // 12d/Civil "no elevation" sentinel is -999

function pt(p, fallbackZ = 0) {
  if (!p) return null;
  let z = p.z ?? fallbackZ;
  if (z <= NULL_Z) z = 0;
  return [p.x, p.y, z];
}

function tessellateBulge(a, b, bulge) {
  // DXF bulge = tan(sweep/4); positive = counter-clockwise from a to b.
  const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!bulge || chord === 0) return [];
  const sweep = 4 * Math.atan(bulge);
  const radius = chord / (2 * Math.sin(Math.abs(sweep) / 2));
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const h = Math.sqrt(Math.max(0, radius * radius - (chord / 2) ** 2));
  const nx = -(b[1] - a[1]) / chord;
  const ny = (b[0] - a[0]) / chord;
  const sgn = bulge > 0 ? 1 : -1;
  const cx = mx + sgn * h * nx * (Math.abs(sweep) > Math.PI ? -1 : 1);
  const cy = my + sgn * h * ny * (Math.abs(sweep) > Math.PI ? -1 : 1);
  const a0 = Math.atan2(a[1] - cy, a[0] - cx);
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 36)));
  const out = [];
  for (let i = 1; i < steps; i++) {
    const t = a0 + (sweep * i) / steps;
    out.push([cx + radius * Math.cos(t), cy + radius * Math.sin(t), a[2] + ((b[2] - a[2]) * i) / steps]);
  }
  return out;
}

function polylinePoints(vertices, closed) {
  const pts = [];
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i];
    pts.push(v.pt);
    const next = vertices[i + 1] ?? (closed ? vertices[0] : null);
    if (v.bulge && next) pts.push(...tessellateBulge(v.pt, next.pt, v.bulge));
  }
  if (closed && pts.length) pts.push(pts[0]);
  return pts;
}

function arcPoints(center, radius, startRaw, endRaw, full) {
  // Both parsers give radians; a value > 2π can only be degrees.
  const deg = Math.max(Math.abs(startRaw), Math.abs(endRaw)) > 6.2832;
  const start = deg ? (startRaw * Math.PI) / 180 : startRaw;
  let end = deg ? (endRaw * Math.PI) / 180 : endRaw;
  if (full) end = start + 2 * Math.PI;
  else while (end <= start) end += 2 * Math.PI;
  const steps = Math.max(8, Math.ceil(((end - start) / (2 * Math.PI)) * 72));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = start + ((end - start) * i) / steps;
    pts.push([center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t), center[2]]);
  }
  return pts;
}

const SKIP_QUIET = new Set(["TEXT", "MTEXT", "ATTRIB", "ATTDEF", "DIMENSION", "LEADER", "MULTILEADER", "HATCH", "IMAGE", "VIEWPORT", "WIPEOUT", "OLE2FRAME", "OLEFRAME", "XLINE", "RAY"]);

function dxfToNeutral(dxf) {
  const out = { items: [], skipped: {}, layerAci: {}, header: dxf.header ?? {} };
  for (const [name, l] of Object.entries(dxf.tables?.layer?.layers ?? {})) out.layerAci[name] = Math.abs(l.colorIndex ?? 7);
  const skip = (t) => (out.skipped[t] = (out.skipped[t] || 0) + 1);

  for (const e of dxf.entities ?? []) {
    const base = { layer: e.layer ?? "0", aci: e.colorIndex ?? 256, trueColour: e.color };
    switch (e.type) {
      case "LINE":
        out.items.push({ ...base, kind: "line", pts: e.vertices.map((v) => pt(v)), closed: false });
        break;
      case "LWPOLYLINE":
      case "POLYLINE": {
        if (e.isPolyfaceMesh || e.is3dPolygonMesh) { skip(e.type + " (mesh)"); break; }
        const z0 = e.elevation ?? 0;
        const verts = (e.vertices ?? []).map((v) => ({ pt: pt(v, z0), bulge: v.bulge }));
        if (verts.length >= 2) out.items.push({ ...base, kind: "line", pts: polylinePoints(verts, !!e.shape), closed: !!e.shape });
        break;
      }
      case "ARC":
        out.items.push({ ...base, kind: "line", pts: arcPoints(pt(e.center), e.radius, e.startAngle, e.endAngle, false), closed: false });
        break;
      case "CIRCLE":
        out.items.push({ ...base, kind: "line", pts: arcPoints(pt(e.center), e.radius, 0, 0, true), closed: true });
        break;
      case "3DFACE":
        out.items.push({ ...base, kind: "face", pts: e.vertices.map((v) => pt(v)) });
        break;
      case "POINT":
        out.items.push({ ...base, kind: "marker", pt: pt(e.position) });
        break;
      case "INSERT":
        out.items.push({ ...base, kind: "marker", pt: pt(e.position) });
        break;
      default:
        if (!SKIP_QUIET.has(e.type)) skip(e.type);
    }
  }
  return out;
}

function dwgToNeutral(db) {
  const out = { items: [], skipped: {}, layerAci: {}, header: db.header ?? {} };
  for (const l of db.tables?.LAYER?.entries ?? []) out.layerAci[l.name] = Math.abs(l.colorIndex ?? 7);
  const skip = (t) => (out.skipped[t] = (out.skipped[t] || 0) + 1);

  for (const e of db.entities ?? []) {
    const base = { layer: e.layer ?? "0", aci: e.colorIndex ?? 256 };
    switch (e.type) {
      case "LINE":
        out.items.push({ ...base, kind: "line", pts: [pt(e.startPoint), pt(e.endPoint)], closed: false });
        break;
      case "LWPOLYLINE": {
        const z0 = e.elevation ?? 0;
        const closed = (e.flag & 1) === 1;
        const verts = (e.vertices ?? []).map((v) => ({ pt: [v.x, v.y, z0], bulge: v.bulge }));
        if (verts.length >= 2) out.items.push({ ...base, kind: "line", pts: polylinePoints(verts, closed), closed });
        break;
      }
      case "POLYLINE2D":
      case "POLYLINE3D": {
        const closed = (e.flag & 1) === 1;
        const z0 = e.elevation ?? 0;
        const verts = (e.vertices ?? []).map((v) => ({ pt: pt(v, z0), bulge: v.bulge }));
        if (verts.length >= 2) out.items.push({ ...base, kind: "line", pts: polylinePoints(verts, closed), closed });
        break;
      }
      case "ARC":
        out.items.push({ ...base, kind: "line", pts: arcPoints(pt(e.center), e.radius, e.startAngle, e.endAngle, false), closed: false });
        break;
      case "CIRCLE":
        out.items.push({ ...base, kind: "line", pts: arcPoints(pt(e.center), e.radius, 0, 0, true), closed: true });
        break;
      case "3DFACE": {
        const c = [e.corner1, e.corner2, e.corner3, e.corner4].filter(Boolean).map((p) => pt(p));
        out.items.push({ ...base, kind: "face", pts: c });
        break;
      }
      case "POINT":
        out.items.push({ ...base, kind: "marker", pt: pt(e.position) });
        break;
      case "INSERT":
        out.items.push({ ...base, kind: "marker", pt: pt(e.insertionPoint) });
        break;
      default:
        if (!SKIP_QUIET.has(e.type)) skip(e.type);
    }
  }
  return out;
}

// --- Neutral → 12d-shaped records ----------------------------------------

function itemInRange(it) {
  const pts = it.pts ?? [it.pt];
  return pts.every(
    (p) => p && Math.abs(p[0] - SITE_E) <= MAX_DISTANCE_FROM_SITE_M && Math.abs(p[1] - SITE_N) <= MAX_DISTANCE_FROM_SITE_M
  );
}

// A drawing that's genuinely in MGA50 near the site can still carry the odd
// stray object at (0,0) or a far-off leftover (a real third-party feature
// survey did: extents E 0–385267) — those are dropped and counted. But if
// MOST of the drawing is out of range the whole file is on some other grid
// or in other units, and it's refused rather than shown in the wrong place.
function splitByExtent(items) {
  const kept = items.filter(itemInRange);
  const dropped = items.length - kept.length;
  const minKept = Math.ceil(items.length * 0.8);
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (const it of items) for (const p of it.pts ?? [it.pt]) {
    if (!p) continue;
    minE = Math.min(minE, p[0]); maxE = Math.max(maxE, p[0]);
    minN = Math.min(minN, p[1]); maxN = Math.max(maxN, p[1]);
  }
  return { kept, dropped, ok: items.length === 0 || kept.length >= minKept, minE, maxE, minN, maxN };
}

const MARKER_HALF_SIZE_M = 0.15;

export function neutralToRecords(neutral, fileName) {
  const check = splitByExtent(neutral.items);
  if (!check.ok) {
    throw new Error(
      `${fileName}'s coordinates don't look like MGA50 metres near the K2 site ` +
        `(E ${check.minE.toFixed(1)}–${check.maxE.toFixed(1)}, N ${check.minN.toFixed(1)}–${check.maxN.toFixed(1)}; ` +
        `expected roughly E ${SITE_E}, N ${SITE_N}). It's probably on a local grid or in different units. ` +
        "No transform is applied or guessed — re-export it in GDA2020 / MGA50, or tell me the transform."
    );
  }

  const stem = fileName.replace(/\.[^.]+$/, "");
  const modelFor = (layer) => `${stem}/${String(layer).replace(/\//g, "-")}`;
  const colourFor = (it) => {
    if (it.trueColour != null && it.trueColour > 0) {
      return `rgb(${(it.trueColour >> 16) & 255},${(it.trueColour >> 8) & 255},${it.trueColour & 255})`;
    }
    const aci = it.aci === 256 || it.aci === 0 || it.aci == null ? neutral.layerAci[it.layer] ?? 7 : Math.abs(it.aci);
    return aciToCss(aci) ?? "white";
  };

  const records = [];
  const meshes = new Map(); // layer → { points, index, triangles, colour }
  let faces = 0;

  for (const it of check.kept) {
    if (it.kind === "face") {
      let m = meshes.get(it.layer);
      if (!m) meshes.set(it.layer, (m = { points: [], index: new Map(), triangles: [], colour: colourFor(it) }));
      const ids = it.pts.map((p) => {
        const k = `${p[0].toFixed(3)},${p[1].toFixed(3)},${p[2].toFixed(3)}`;
        if (!m.index.has(k)) { m.index.set(k, m.points.length); m.points.push(p); }
        return m.index.get(k);
      });
      // 3DFACE repeats corner 3 as corner 4 for a triangle.
      const uniq = ids.filter((id, i) => ids.indexOf(id) === i);
      if (uniq.length === 3) m.triangles.push(uniq);
      else if (uniq.length === 4) m.triangles.push([uniq[0], uniq[1], uniq[2]], [uniq[0], uniq[2], uniq[3]]);
      faces++;
      continue;
    }

    let points;
    if (it.kind === "marker") {
      if (!it.pt) continue;
      const [x, y, z] = it.pt;
      const d = MARKER_HALF_SIZE_M;
      points = [[x, y + d, z], [x + d, y, z], [x, y - d, z], [x - d, y, z], [x, y + d, z]];
    } else {
      points = it.pts.filter(Boolean);
    }
    if (points.length < 2) continue;
    records.push({
      model: modelFor(it.layer),
      name: it.layer,
      style: null,
      colour: colourFor(it),
      closed: !!it.closed,
      justify: null,
      diameter: null,
      points,
      centrelinePoints: points,
      raw: {},
    });
  }

  records.surfaces = [...meshes.entries()]
    .filter(([, m]) => m.triangles.length > 0)
    .map(([layer, m]) => ({
      model: modelFor(layer),
      name: layer,
      colour: m.colour,
      points: m.points,
      triangles: m.triangles,
      nulling: [],
      raw: {},
    }));
  records.unrecognizedTopLevelKeys = new Set();
  records.cadSummary = { faces, skipped: neutral.skipped, droppedOutOfRange: check.dropped };
  return records;
}

// --- Loading ----------------------------------------------------------------

let libredwgPromise = null;
async function getLibreDwg() {
  if (!libredwgPromise) {
    libredwgPromise = (async () => {
      const mod = await import("@mlightcad/libredwg-web");
      const { default: wasmUrl } = await import("../node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm?url");
      const instance = await mod.createModule({ locateFile: () => wasmUrl });
      return { lib: mod.LibreDwg.createByWasmInstance(instance), Dwg_File_Type: mod.Dwg_File_Type };
    })();
  }
  return libredwgPromise;
}

/** @param {File} file — .dxf or .dwg */
export async function loadCadFile(file) {
  let neutral;
  if (/\.dxf$/i.test(file.name)) {
    const text = await file.text();
    if (text.startsWith("AutoCAD Binary DXF")) {
      throw new Error(`${file.name} is a binary DXF — export it as an ASCII DXF (or as a DWG) instead.`);
    }
    const { default: DxfParser } = await import("dxf-parser");
    neutral = dxfToNeutral(new DxfParser().parseSync(text));
  } else {
    const { lib, Dwg_File_Type } = await getLibreDwg();
    const dwg = lib.dwg_read_data(await file.arrayBuffer(), Dwg_File_Type.DWG);
    if (!dwg) throw new Error(`${file.name} couldn't be read as a DWG (unsupported version or corrupt).`);
    const db = lib.convert(dwg);
    lib.dwg_free(dwg);
    neutral = dwgToNeutral(db);
  }
  return neutralToRecords(neutral, file.name);
}

export function describeCadSkips(records) {
  const s = records.cadSummary?.skipped ?? {};
  const parts = Object.entries(s).map(([t, n]) => `${n} ${t}`);
  const dropped = records.cadSummary?.droppedOutOfRange ?? 0;
  const droppedNote = dropped ? ` ${dropped} object(s) far outside the site area (stray/leftover) were left out.` : "";
  return (parts.length ? ` Not drawn (unsupported): ${parts.join(", ")}.` : "") + droppedNote;
}

export { dxfToNeutral, dwgToNeutral };
