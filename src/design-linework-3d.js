// design-linework-3d.js — turn parsed 12d design `string` records (see
// twelve-d.js) into 3D line geometry in the shared scene. New
// 2026-09-10, per Cameron: "can we go with the 3d linework as well, it
// will be handy i think" — the second half of bringing 3D surfaces
// (surfaces-3d.js) up alongside the earlier custodian-mode work; the
// 3D page could render surfaces but still silently skipped design
// linework (a status-message note, not real geometry).
//
// Rendered as plain THREE.Line (native GL lines), not extruded tubes
// like services.js's pipes — design linework isn't necessarily a real
// pipe with a diameter (could be a kerb line, a boundary, anything CAD
// reference), so a flat line more honestly represents "reference
// geometry lifted into 3D," matching the 2D page's own plain
// line-width:3 styling intent (a flat line, not a modelled solid)
// rather than inventing a fake pipe radius that doesn't correspond to
// anything real.
//
// Deliberately does NOT call splitOnGaps() — same reasoning as
// main-2d.js's buildLineFeaturesFrom12d() for "design-linework":
// splitOnGaps() exists for a real AS-BUILT SURVEY problem (services
// capture can bundle several physically separate features into one
// record with no marker between them), which design linework doesn't
// have — each `string` record already represents one deliberately-
// designed feature. Trusting the record's own connectivity as 12d
// exported it, same as the 2D page does.

import * as THREE from "three";
import { mgaToScene } from "./crs.js";
import { normalizeColour } from "./service-colour.js";

const FALLBACK_COLOR = "#2fa3ff";

/**
 * Build a THREE.Group of one Line per design-linework record.
 * @param {ReturnType<typeof import("./twelve-d.js").parse12da>} records
 * @param {[number, number, number]} sceneOriginMga
 * @returns {{ group: THREE.Group, skippedShort: number }}
 */
export function buildDesignLineworkMeshes(records, sceneOriginMga) {
  const group = new THREE.Group();
  group.name = "design-linework";
  let skippedShort = 0;

  for (const record of records) {
    if (record.centrelinePoints.length < 2) {
      skippedShort++; // point/symbol data — same <2-point filter as the 2D page
      continue;
    }

    const color = normalizeColour(record.colour, FALLBACK_COLOR);
    const scenePoints = record.centrelinePoints.map((p) => new THREE.Vector3(...mgaToScene(p, sceneOriginMga)));
    const geometry = new THREE.BufferGeometry().setFromPoints(scenePoints);
    const material = new THREE.LineBasicMaterial({ color });

    const line = new THREE.Line(geometry, material);
    line.name = record.name ?? "design-line";
    line.userData = {
      source: "12d-design-linework",
      model: record.model,
      style: record.style,
      rawColour: record.colour,
    };
    group.add(line);
  }

  return { group, skippedShort };
}
