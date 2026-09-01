// profile-chart.js — minimal hand-rolled SVG chart for the section tool.
// No charting library: this is a handful of lines/dots with axes, not
// worth a dependency for.
//
// **Update 2026-08-26, per Cameron: "the mapbox terrain should be
// removed, it doesn't really do anything relevant."** This used to also
// plot a Mapbox Terrain-RGB elevation line — removed. The chart now shows
// only real design/service data: surfaces and service/linework crossings
// from section-intersect.js. See the README "Terrain" section.
//
// **Also added 2026-08-26, per Cameron: "it should have a live snap
// displaying difference in between a surface or ifc object, and the
// services model so when you drag your mouse across the section it is
// locked to the surface with one snap and then snaps to the nearest
// [service] with the other snap giving a delta height."** — a live
// mouse-drag readout: as you move across the plot area, one snap follows
// the loaded surface's own elevation directly under the cursor
// (interpolated along whichever surface chord covers that point) and the
// other snaps to the nearest service/design-linework crossing, showing
// the vertical delta between them (e.g. cover depth between a pipe and a
// proposed pad). IFC is NOT included in the surface snap yet — same
// "only a bounding-box footprint, no real geometry" limitation as
// section-intersect.js (see its header) — this reads from the same
// `surfaceChords` data that module already produces, so it inherits that
// gap rather than reintroducing it here.

/**
 * Render a section/profile chart into `container`.
 * @param {HTMLElement} container
 * @param {{ totalDistanceM: number }} section - the drawn line's total length
 * @param {{
 *   lineCrossings?: Array<{ distanceM: number, elevationAhd: number, layerKind: string,
 *     name: string, model: string, colour: string }>,
 *   surfaceChords?: Array<{ points: Array<{distanceM: number, elevationAhd: number}>,
 *     surfaceName: string, colour: string }>,
 * }} [overlays] - real design/services crossings along the cut line, from
 *   section-intersect.js.
 */
export function renderProfileChart(container, { totalDistanceM }, overlays = {}) {
  // Wraps the whole body so a caller-visible error can report EXACTLY
  // which sub-step failed — added 2026-08-27 after "Failed to build
  // profile while rendering the chart: Maximum call stack size exceeded"
  // recurred with only 7 line crossings and 0 surface chords, ruling out
  // every large-array theory already fixed/verified for this file (see
  // README). Something is throwing this specific RangeError even at
  // trivial size, and static reading hasn't found it — this narrows it
  // down empirically instead.
  let step = "setup";
  try {
    return renderProfileChartInner(container, { totalDistanceM }, overlays, (s) => {
      step = s;
    });
  } catch (err) {
    throw new Error(`renderProfileChart(${step}): ${err.message}`, { cause: err });
  }
}

function renderProfileChartInner(container, { totalDistanceM }, overlays, setStep) {
  const { lineCrossings = [], surfaceChords = [] } = overlays;
  const width = 640;
  const height = 320;
  const margin = { top: 16, right: 16, bottom: 32, left: 56 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  if (lineCrossings.length === 0 && surfaceChords.length === 0) {
    container.innerHTML =
      `<p class="profile-empty">No currently-visible service/linework/surface layer crosses ` +
      `this line (terrain is no longer plotted — see README).</p>`;
    return;
  }

  setStep("computing min/max elevation");

  // Built with a manual reduce, NOT Math.min(...arr)/Math.max(...arr) —
  // spreading into a function call has an engine-specific argument-count
  // ceiling (V8: tens of thousands), and a real drone-flight-density
  // surface (thousands of triangles, unlike the tiny 2-triangle test
  // sample this was first verified against) can cross the cut line often
  // enough to blow past it, throwing "Maximum call stack size exceeded"
  // instead of building the chart — hit for real by Cameron 2026-08-26
  // once he loaded an actual dense surface.
  let minEl = Infinity;
  let maxEl = -Infinity;
  for (const c of lineCrossings) {
    if (c.elevationAhd < minEl) minEl = c.elevationAhd;
    if (c.elevationAhd > maxEl) maxEl = c.elevationAhd;
  }
  for (const chord of surfaceChords) {
    for (const p of chord.points) {
      if (p.elevationAhd < minEl) minEl = p.elevationAhd;
      if (p.elevationAhd > maxEl) maxEl = p.elevationAhd;
    }
  }
  // Pad the elevation range a little so nothing touches the edges.
  const pad = Math.max(0.5, (maxEl - minEl) * 0.1);
  const yMin = minEl - pad;
  const yMax = maxEl + pad;

  const x = (d) => margin.left + (d / totalDistanceM) * plotW;
  const y = (el) => margin.top + plotH - ((el - yMin) / (yMax - yMin)) * plotH;
  const distanceAtX = (svgX) =>
    Math.min(totalDistanceM, Math.max(0, ((svgX - margin.left) / plotW) * totalDistanceM));

  setStep("building Y-axis ticks");
  // A handful of Y gridlines/labels.
  const yTickCount = 5;
  const yTicks = Array.from({ length: yTickCount }, (_, i) => yMin + (i / (yTickCount - 1)) * (yMax - yMin));
  const yTicksSvg = yTicks
    .map((val) => {
      const yy = y(val).toFixed(1);
      return `
        <line x1="${margin.left}" y1="${yy}" x2="${width - margin.right}" y2="${yy}" stroke="#333" stroke-width="1" />
        <text x="${margin.left - 8}" y="${yy}" text-anchor="end" dominant-baseline="middle" fill="#aaa" font-size="11">${val.toFixed(1)}m</text>
      `;
    })
    .join("");

  setStep("building X-axis ticks");
  // A handful of X gridlines/labels (distance).
  const xTickCount = 5;
  const xTicks = Array.from({ length: xTickCount }, (_, i) => (i / (xTickCount - 1)) * totalDistanceM);
  const xTicksSvg = xTicks
    .map((val) => {
      const xx = x(val).toFixed(1);
      return `<text x="${xx}" y="${height - margin.bottom + 18}" text-anchor="middle" fill="#aaa" font-size="11">${val.toFixed(0)}m</text>`;
    })
    .join("");

  setStep(`building surface chord SVG (${surfaceChords.length} chord(s))`);
  // Surfaces: each triangle's chord drawn independently (see
  // section-intersect.js's header for why adjacent triangles' chords
  // naturally read as one continuous line without extra stitching).
  const surfaceChordsSvg = surfaceChords
    .map((chord) => {
      const d = chord.points
        .map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.distanceM).toFixed(1)} ${y(p.elevationAhd).toFixed(1)}`)
        .join(" ");
      return `<path d="${d}" fill="none" stroke="${chord.colour}" stroke-width="3"><title>${escapeXml(chord.surfaceName)}</title></path>`;
    })
    .join("");

  setStep(`building line-crossing SVG (${lineCrossings.length} crossing(s))`);
  // Services/design linework: a marker dot at the real crossing elevation,
  // plus a faint drop-line to the bottom axis so a deeply-buried crossing
  // is still easy to spot.
  const lineCrossingsSvg = lineCrossings
    .map((c) => {
      const xx = x(c.distanceM).toFixed(1);
      const yy = y(c.elevationAhd).toFixed(1);
      const bottom = (margin.top + plotH).toFixed(1);
      const label = `${c.name} (${c.model}) — RL ${c.elevationAhd.toFixed(2)} AHD`;
      return (
        `<line x1="${xx}" y1="${yy}" x2="${xx}" y2="${bottom}" stroke="${c.colour}" stroke-width="1" stroke-opacity="0.35" stroke-dasharray="2,2" />` +
        `<circle cx="${xx}" cy="${yy}" r="4" fill="${c.colour}" stroke="#111" stroke-width="1"><title>${escapeXml(label)}</title></circle>`
      );
    })
    .join("");

  setStep("building legend HTML");
  const legend = legendHtml(lineCrossings, surfaceChords);

  setStep("assigning innerHTML");
  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" style="width:100%; height:auto; display:block; background:#1b1d20;">
      ${yTicksSvg}
      ${surfaceChordsSvg}
      ${lineCrossingsSvg}
      ${xTicksSvg}
      <text x="${margin.left}" y="${margin.top - 4}" fill="#8a8f98" font-size="11">Elevation AHD (m) — surfaces/crossings vs distance along line</text>
      <g class="live-snap" style="display:none; pointer-events:none;">
        <line class="snap-guide" stroke="#666" stroke-width="1" stroke-dasharray="3,3" />
        <line class="snap-connector" stroke="#ffb454" stroke-width="1.5" stroke-dasharray="4,2" />
        <circle class="snap-surface" r="5" fill="none" stroke="#2ee6c8" stroke-width="2" />
        <circle class="snap-service" r="5" fill="none" stroke="#ffb454" stroke-width="2" />
      </g>
      <rect class="snap-capture" x="${margin.left}" y="${margin.top}" width="${plotW}" height="${plotH}" fill="transparent" />
    </svg>
    <div class="snap-mode-toggle" style="display:flex; gap:6px; margin:6px 2px 0;">
      <button type="button" data-mode="surface-service" style="flex:1; font-size:11px; padding:4px 0; border-radius:4px; border:1px solid #2fa3ff; background:#2fa3ff; color:#fff; cursor:pointer;">Surface ↔ Pipe</button>
      <button type="button" data-mode="service-service" style="flex:1; font-size:11px; padding:4px 0; border-radius:4px; border:1px solid #444; background:#111; color:#ccc; cursor:pointer;">Pipe ↔ Pipe</button>
      <button type="button" data-mode="surface-surface" style="flex:1; font-size:11px; padding:4px 0; border-radius:4px; border:1px solid #444; background:#111; color:#ccc; cursor:pointer;">Surface ↔ Surface</button>
    </div>
    <div class="snap-surface-select" style="display:none; gap:6px; margin:4px 2px 0; align-items:center;">
      <span class="snap-surface-a-label" style="font-size:11px; color:#8a8f98; flex-shrink:0;">Surface:</span>
      <select class="snap-surface-a" style="flex:1; min-width:0; font-size:11px; background:#111; color:#ddd; border:1px solid #444; border-radius:4px;"></select>
      <span class="snap-surface-b-label" style="display:none; font-size:11px; color:#8a8f98; flex-shrink:0;">vs:</span>
      <select class="snap-surface-b" style="display:none; flex:1; min-width:0; font-size:11px; background:#111; color:#ddd; border:1px solid #444; border-radius:4px;"></select>
    </div>
    <div class="snap-readout" style="min-height:16px; margin:4px 2px 0; font-size:12px; color:#ffb454;"></div>
    ${legend}
  `;

  setStep("wiring the live snap");
  wireLiveSnap(container, { x, y, distanceAtX, margin, plotH, lineCrossings, surfaceChords });
}

/**
 * The live snap-to-compare tool (see file header). Reads back the just-
 * rendered SVG's own elements rather than keeping parallel state — this
 * is the whole reason margin/plotH/x/y/distanceAtX get passed in, so the
 * maths here matches what was actually drawn exactly.
 *
 * Three modes (added 2026-08-28, extended 2026-08-31 per Cameron: "in
 * the section view can you switch between surfaces for the heights? can
 * you also add another option of comparing the 2 surfaces?"):
 *  - "surface-service" (default): point A follows ONE selected design
 *    surface's own elevation directly under the cursor; point B snaps
 *    to the nearest service/linework crossing to the cursor.
 *  - "service-service": point A and B both snap to services — the two
 *    NEAREST crossings to the cursor position, so hovering near two
 *    close-together pipes compares those two directly (e.g. clearance
 *    between two crossing services), rather than either against a surface.
 *  - "surface-surface": point A and B each follow a SEPARATELY selected
 *    surface's own elevation under the cursor — e.g. comparing this
 *    month's vs last month's drone-flight surface at any point along the
 *    cut, not just the whole-map A/B visibility toggle surface-compare.js
 *    already provides (see its own docstring) — this is a precise,
 *    per-point reading instead.
 * Originally (2026-08-28) the surface snap silently used whichever
 * loaded surface's chord happened to cover that point first — fine with
 * one surface loaded, ambiguous with two or more overlapping ones. Now
 * explicit: a dropdown picks which surface feeds each surface-driven
 * snap point, shown only in the modes that need it.
 *
 * All three modes report the same three numbers (per Cameron: "as well
 * as depths give 2d and 3d distance between pipes") — vertical delta
 * (height/depth), 2D distance (horizontal separation along the cut
 * line — both snapped points lie ON that line by construction, so this
 * is exact, not an approximation), and 3D distance (straight-line
 * distance accounting for both).
 */
function wireLiveSnap(container, { x, y, distanceAtX, margin, plotH, lineCrossings, surfaceChords }) {
  const svg = container.querySelector("svg");
  const captureRect = container.querySelector(".snap-capture");
  const liveGroup = container.querySelector(".live-snap");
  const guideLine = container.querySelector(".snap-guide");
  const connector = container.querySelector(".snap-connector");
  const dotA = container.querySelector(".snap-surface");
  const dotB = container.querySelector(".snap-service");
  const readout = container.querySelector(".snap-readout");
  const modeButtons = [...container.querySelectorAll(".snap-mode-toggle button")];
  const surfaceSelectRow = container.querySelector(".snap-surface-select");
  const selectA = container.querySelector(".snap-surface-a");
  const selectB = container.querySelector(".snap-surface-b");
  const labelB = container.querySelector(".snap-surface-b-label");
  if (!svg || !captureRect) return;

  let mode = "surface-service";

  // Every distinct surface name present, in first-seen order (matches
  // section-intersect.js's chord order, which follows upload order) —
  // used to populate the surface-picker dropdown(s).
  const surfaceNames = [...new Set(surfaceChords.map((c) => c.surfaceName))];
  for (const select of [selectA, selectB]) {
    select.replaceChildren(
      ...surfaceNames.map((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        return opt;
      })
    );
  }
  if (surfaceNames.length > 1) selectB.value = surfaceNames[1];

  function updateModeButtonStyles() {
    for (const btn of modeButtons) {
      const active = btn.dataset.mode === mode;
      btn.style.background = active ? "#2fa3ff" : "#111";
      btn.style.color = active ? "#fff" : "#ccc";
      btn.style.borderColor = active ? "#2fa3ff" : "#444";
    }
  }
  function updateSurfaceSelectVisibility() {
    const needsA = mode === "surface-service" || mode === "surface-surface";
    const needsB = mode === "surface-surface";
    surfaceSelectRow.style.display = needsA ? "flex" : "none";
    labelB.style.display = needsB ? "inline" : "none";
    selectB.style.display = needsB ? "inline-block" : "none";
  }
  updateSurfaceSelectVisibility();
  for (const btn of modeButtons) {
    btn.addEventListener("click", () => {
      mode = btn.dataset.mode;
      updateModeButtonStyles();
      updateSurfaceSelectVisibility();
    });
  }

  function svgPointFromMouse(evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }

  /** @param {string} [surfaceName] - restrict to one surface; omit to match any (original single-surface behaviour) */
  function elevationOnSurfaceAt(distanceM, surfaceName) {
    for (const chord of surfaceChords) {
      if (surfaceName != null && chord.surfaceName !== surfaceName) continue;
      const pts = chord.points;
      if (distanceM < pts[0].distanceM || distanceM > pts[pts.length - 1].distanceM) continue;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (distanceM >= a.distanceM && distanceM <= b.distanceM) {
          const span = b.distanceM - a.distanceM;
          const t = span === 0 ? 0 : (distanceM - a.distanceM) / span;
          return {
            distanceM,
            elevationAhd: a.elevationAhd + t * (b.elevationAhd - a.elevationAhd),
            label: chord.surfaceName,
          };
        }
      }
    }
    return null; // no loaded surface covers this point along the line
  }

  /** The `n` nearest service/linework crossings to `distanceM`, nearest first. */
  function nearestServiceCrossings(distanceM, n) {
    return [...lineCrossings]
      .sort((a, b) => Math.abs(a.distanceM - distanceM) - Math.abs(b.distanceM - distanceM))
      .slice(0, n)
      .map((c) => ({ distanceM: c.distanceM, elevationAhd: c.elevationAhd, label: c.name }));
  }

  /** @returns {{ a: {distanceM,elevationAhd,label}|null, b: (same)|null }} */
  function computeSnapPoints(distanceM) {
    if (mode === "service-service") {
      const [a = null, b = null] = nearestServiceCrossings(distanceM, 2);
      return { a, b };
    }
    if (mode === "surface-surface") {
      return {
        a: elevationOnSurfaceAt(distanceM, selectA.value),
        b: elevationOnSurfaceAt(distanceM, selectB.value),
      };
    }
    const surfaceHit = elevationOnSurfaceAt(distanceM, selectA.value);
    const [serviceHit = null] = nearestServiceCrossings(distanceM, 1);
    return { a: surfaceHit, b: serviceHit };
  }

  function onMove(evt) {
    const { x: svgX } = svgPointFromMouse(evt);
    const distanceM = distanceAtX(svgX);
    const xx = x(distanceM);

    liveGroup.style.display = "block";
    guideLine.setAttribute("x1", xx);
    guideLine.setAttribute("x2", xx);
    guideLine.setAttribute("y1", margin.top);
    guideLine.setAttribute("y2", margin.top + plotH);

    const { a: pointA, b: pointB } = computeSnapPoints(distanceM);

    if (pointA) {
      dotA.style.display = "block";
      dotA.setAttribute("cx", x(pointA.distanceM));
      dotA.setAttribute("cy", y(pointA.elevationAhd));
    } else {
      dotA.style.display = "none";
    }

    if (pointB) {
      dotB.style.display = "block";
      dotB.setAttribute("cx", x(pointB.distanceM));
      dotB.setAttribute("cy", y(pointB.elevationAhd));
    } else {
      dotB.style.display = "none";
    }

    if (pointA && pointB) {
      connector.style.display = "block";
      connector.setAttribute("x1", x(pointA.distanceM));
      connector.setAttribute("y1", y(pointA.elevationAhd));
      connector.setAttribute("x2", x(pointB.distanceM));
      connector.setAttribute("y2", y(pointB.elevationAhd));

      // Both points lie ON the section line by construction (surface
      // interpolation happens exactly at the cursor's own position;
      // service crossings are, by definition, where a service crosses
      // this line) — so the horizontal separation between their
      // distanceM values IS the real 2D distance, not an approximation.
      const verticalM = Math.abs(pointA.elevationAhd - pointB.elevationAhd);
      const horizontalM = Math.abs(pointA.distanceM - pointB.distanceM);
      const distance3dM = Math.hypot(horizontalM, verticalM);

      readout.textContent =
        `Δheight ${verticalM.toFixed(3)} m · 2D ${horizontalM.toFixed(3)} m · 3D ${distance3dM.toFixed(3)} m — ` +
        `${pointA.label} (RL ${pointA.elevationAhd.toFixed(3)}) ↔ ${pointB.label} (RL ${pointB.elevationAhd.toFixed(3)})`;
    } else {
      connector.style.display = "none";
      if (mode === "service-service") {
        readout.textContent = "Need at least 2 service/linework crossings near the cursor to compare in this mode.";
      } else if (mode === "surface-surface") {
        readout.textContent =
          !pointA && !pointB
            ? `Neither "${selectA.value}" nor "${selectB.value}" covers this point along the line.`
            : !pointA
              ? `"${selectA.value}" doesn't cover this point along the line.`
              : `"${selectB.value}" doesn't cover this point along the line.`;
      } else {
        readout.textContent = !pointA && !pointB
          ? "No surface or service data under the cursor here."
          : !pointA
            ? "No loaded surface covers this point (nearest service shown, no delta to compare against)."
            : "No service/linework crossing loaded to compare against.";
      }
    }
  }

  function onLeave() {
    liveGroup.style.display = "none";
    readout.textContent = "";
  }

  captureRect.addEventListener("mousemove", onMove);
  captureRect.addEventListener("mouseleave", onLeave);
}

/**
 * A small caption explaining the overlay symbols — real per-feature
 * colours vary (each dot/line uses that record's own normalised 12d
 * colour, see service-colour.js), so this describes the SHAPE convention
 * (dot vs. line) rather than trying to list every colour used.
 */
function legendHtml(lineCrossings, surfaceChords) {
  const parts = [];
  if (lineCrossings.length > 0) {
    parts.push(`<span>●</span> Service/design linework crossing (hover for name + RL)`);
  }
  if (surfaceChords.length > 0) {
    parts.push(`<span>▬</span> Design surface (hover for name)`);
  }
  parts.push(`<span style="color:#ffb454">┊</span> Drag across the chart for a live delta height + 2D/3D distance (buttons above switch Surface↔Pipe / Pipe↔Pipe / Surface↔Surface; pick which surface(s) from the dropdown)`);
  return `<p style="margin:6px 2px 0; font-size:11px; color:#8a8f98;">${parts.join(" &nbsp;·&nbsp; ")}</p>`;
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}
