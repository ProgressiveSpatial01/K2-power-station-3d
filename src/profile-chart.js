// profile-chart.js — minimal hand-rolled SVG line chart for the section
// tool's elevation profile. No charting library: this is one polyline
// with axes, not worth a dependency for.

/**
 * Render an elevation-vs-distance chart into `container`.
 * @param {HTMLElement} container
 * @param {{ points: Array<{distanceM: number, elevationAhd: number|null}>, totalDistanceM: number }} profile
 * @param {{
 *   lineCrossings?: Array<{ distanceM: number, elevationAhd: number, layerKind: string,
 *     name: string, model: string, colour: string }>,
 *   surfaceChords?: Array<{ points: Array<{distanceM: number, elevationAhd: number}>,
 *     surfaceName: string, colour: string }>,
 * }} [overlays] - real design/services crossings along the cut line, from
 *   section-intersect.js (added 2026-08-26, per Cameron: "need to be able
 *   to see these layers on the section view as well") — plotted at their
 *   own real elevation, distinct from the terrain line.
 */
export function renderProfileChart(container, { points, totalDistanceM }, overlays = {}) {
  const { lineCrossings = [], surfaceChords = [] } = overlays;
  const width = 640;
  const height = 320;
  const margin = { top: 16, right: 16, bottom: 32, left: 56 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const known = points.filter((p) => p.elevationAhd != null);
  if (known.length === 0 && lineCrossings.length === 0 && surfaceChords.length === 0) {
    container.innerHTML = `<p class="profile-empty">No elevation data available along this line (outside terrain coverage).</p>`;
    return;
  }

  // Elevation range must cover the terrain line AND every crossing/chord —
  // a service several metres underground would otherwise fall outside a
  // Y-range picked from terrain alone.
  const allElevations = [
    ...known.map((p) => p.elevationAhd),
    ...lineCrossings.map((c) => c.elevationAhd),
    ...surfaceChords.flatMap((chord) => chord.points.map((p) => p.elevationAhd)),
  ];
  const minEl = Math.min(...allElevations);
  const maxEl = Math.max(...allElevations);
  // Pad the elevation range a little so the line doesn't touch the edges.
  const pad = Math.max(0.5, (maxEl - minEl) * 0.1);
  const yMin = minEl - pad;
  const yMax = maxEl + pad;

  const x = (d) => margin.left + (d / totalDistanceM) * plotW;
  const y = (el) => margin.top + plotH - ((el - yMin) / (yMax - yMin)) * plotH;

  // Break into contiguous segments so gaps (no tile coverage) don't draw
  // a misleading straight line across missing data.
  const segments = [];
  let current = [];
  for (const p of points) {
    if (p.elevationAhd == null) {
      if (current.length > 1) segments.push(current);
      current = [];
      continue;
    }
    current.push(p);
  }
  if (current.length > 1) segments.push(current);

  const pathsSvg = segments
    .map((seg) => {
      const d = seg.map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.distanceM).toFixed(1)} ${y(p.elevationAhd).toFixed(1)}`).join(" ");
      return `<path d="${d}" fill="none" stroke="#2fa3ff" stroke-width="2" />`;
    })
    .join("");

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

  // A handful of X gridlines/labels (distance).
  const xTickCount = 5;
  const xTicks = Array.from({ length: xTickCount }, (_, i) => (i / (xTickCount - 1)) * totalDistanceM);
  const xTicksSvg = xTicks
    .map((val) => {
      const xx = x(val).toFixed(1);
      return `<text x="${xx}" y="${height - margin.bottom + 18}" text-anchor="middle" fill="#aaa" font-size="11">${val.toFixed(0)}m</text>`;
    })
    .join("");

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

  // Services/design linework: a marker dot at the real crossing elevation,
  // plus a faint drop-line to the bottom axis so a crossing buried well
  // below the terrain line is still easy to spot.
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

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" style="width:100%; height:auto; display:block; background:#1b1d20;">
      ${yTicksSvg}
      ${pathsSvg}
      ${surfaceChordsSvg}
      ${lineCrossingsSvg}
      ${xTicksSvg}
      <text x="${margin.left}" y="${margin.top - 4}" fill="#8a8f98" font-size="11">Elevation AHD (m) vs distance along line</text>
    </svg>
    ${legendHtml(lineCrossings, surfaceChords)}
  `;
}

/**
 * A small caption explaining the overlay symbols — real per-feature
 * colours vary (each dot/line uses that record's own normalised 12d
 * colour, see service-colour.js), so this describes the SHAPE convention
 * (dot vs. line) rather than trying to list every colour used.
 */
function legendHtml(lineCrossings, surfaceChords) {
  if (lineCrossings.length === 0 && surfaceChords.length === 0) return "";
  const parts = [`<span style="color:#2fa3ff">▬</span> Terrain (Mapbox Terrain-RGB)`];
  if (lineCrossings.length > 0) {
    parts.push(`<span>●</span> Service/design linework crossing (hover for name + RL)`);
  }
  if (surfaceChords.length > 0) {
    parts.push(`<span>▬</span> Design surface (hover for name)`);
  }
  return `<p style="margin:6px 2px 0; font-size:11px; color:#8a8f98;">${parts.join(" &nbsp;·&nbsp; ")}</p>`;
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}
