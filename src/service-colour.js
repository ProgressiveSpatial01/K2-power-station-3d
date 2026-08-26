// service-colour.js — turn a raw 12d `colour` attribute into a real CSS
// colour Mapbox/Three.js can use directly.
//
// Found 2026-08-26 (Cameron: "colours aren't coming through"): the 2D
// services layer was hardcoded to one flat colour for every service,
// ignoring the real `colour` field entirely. Fixing that surfaced a
// second problem — the real 800-record weekly export uses several
// colour formats, not all of them valid CSS:
//   - plain CSS-valid: "brown", "white", "rgb(189,0,46)"
//   - AutoCAD Color Index: "acad 001", "acad 095", "acad 140" — an
//     indexed palette (0-255), NOT a CSS colour string on its own.
//   - "<name> <number>" (e.g. "blue 192", "red 200") — 12d's own
//     extended-palette convention; the exact meaning of the trailing
//     number isn't confirmed, so this only uses the leading name.
//   - genuinely unrecognisable: "vis rock3" (looks like a terrain
//     visualisation/material tag, not a colour at all).

// AutoCAD Color Index -> RGB, sourced from gohtx.com/acadcolors.php
// (checked 2026-08-26, not guessed). Only the indices actually seen in
// real K2 data plus the well-known 1-9 primaries are included — add
// more here if a real export uses an index not covered, rather than
// guessing at the full 256-entry table.
const ACI_TABLE = {
  1: [255, 0, 0], // red
  2: [255, 255, 0], // yellow
  3: [0, 255, 0], // green
  4: [0, 255, 255], // cyan
  5: [0, 0, 255], // blue
  6: [255, 0, 255], // magenta
  7: [255, 255, 255], // white
  8: [65, 65, 65], // dark grey
  9: [128, 128, 128], // grey
  95: [129, 129, 86], // muted olive — seen on real "drain sidepit" records
  140: [0, 191, 255], // deep sky blue — seen on real "power mh" records
};

const warnedOnce = new Set();
function warnOnce(msg) {
  if (warnedOnce.has(msg)) return;
  warnedOnce.add(msg);
  console.warn(msg);
}

/**
 * @param {string|null|undefined} raw - the record's raw `colour` field
 * @param {string} fallback - CSS colour to use when `raw` can't be resolved
 * @returns {string} a CSS colour string
 */
export function normalizeColour(raw, fallback = "#888888") {
  if (!raw) return fallback;

  // CSS.supports validates named colours, rgb()/rgba()/hsl()/#hex all in
  // one go — better than maintaining our own list of valid CSS colour
  // keywords, and correctly rejects "acad 001"/"blue 192"/"vis rock3".
  if (typeof CSS !== "undefined" && CSS.supports("color", raw)) return raw;

  const acadMatch = raw.match(/^acad\s+0*(\d+)$/i);
  if (acadMatch) {
    const idx = Number(acadMatch[1]);
    const rgb = ACI_TABLE[idx];
    if (rgb) return `rgb(${rgb.join(",")})`;
    warnOnce(
      `[12d colour] Unmapped AutoCAD Color Index ${idx} ("${raw}") — using fallback. ` +
        "Add it to ACI_TABLE in service-colour.js if this recurs."
    );
    return fallback;
  }

  // "<name> <number>" pattern — use the leading name if it's valid CSS
  // on its own (see file header: the trailing number's meaning isn't
  // confirmed, so it's dropped rather than guessed at).
  const nameMatch = raw.match(/^([a-zA-Z]+)\s+\d+$/);
  if (nameMatch && typeof CSS !== "undefined" && CSS.supports("color", nameMatch[1])) {
    return nameMatch[1];
  }

  warnOnce(`[12d colour] Unrecognised colour "${raw}" — using fallback ${fallback}.`);
  return fallback;
}
