// profile-chart.js — minimal hand-rolled SVG line chart for the section
// tool's elevation profile. No charting library: this is one polyline
// with axes, not worth a dependency for.

/**
 * Render an elevation-vs-distance chart into `container`.
 * @param {HTMLElement} container
 * @param {{ points: Array<{distanceM: number, elevationAhd: number|null}>, totalDistanceM: number }} profile
 */
export function renderProfileChart(container, { points, totalDistanceM }) {
  const width = 640;
  const height = 320;
  const margin = { top: 16, right: 16, bottom: 32, left: 56 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const known = points.filter((p) => p.elevationAhd != null);
  if (known.length === 0) {
    container.innerHTML = `<p class="profile-empty">No elevation data available along this line (outside terrain coverage).</p>`;
    return;
  }

  const minEl = Math.min(...known.map((p) => p.elevationAhd));
  const maxEl = Math.max(...known.map((p) => p.elevationAhd));
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

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" style="width:100%; height:auto; display:block; background:#1b1d20;">
      ${yTicksSvg}
      ${pathsSvg}
      ${xTicksSvg}
      <text x="${margin.left}" y="${margin.top - 4}" fill="#8a8f98" font-size="11">Elevation AHD (m) vs distance along line</text>
    </svg>
  `;
}
