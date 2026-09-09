// surfaces-3d.js — turn parsed 12d `full_tin` surfaces (see twelve-d.js
// parse12da()'s full_tin notes) into 3D triangle meshes in the shared
// scene. New 2026-09-10, per Cameron: "can we have [the 3D viewer] setup
// like the 2d viewer with a custodian mode and added models etc" — the
// 3D page could previously only render IFC models and 12d services;
// design surfaces (Stripped Surface, Existing Surface, GT Excavations,
// etc.) had no 3D counterpart at all. Mirrors main-2d.js's
// buildSurfaceFeaturesFrom12d() (same nulling-flag scaffold exclusion,
// same per-surface colour), just building a THREE.Mesh per surface
// instead of a GeoJSON Polygon per triangle.

import * as THREE from "three";
import { mgaToScene } from "./crs.js";
import { normalizeColour } from "./service-colour.js";

/**
 * Build a THREE.Group of one mesh per surface from parsed 12d full_tin
 * records.
 * @param {ReturnType<typeof import("./twelve-d.js").parse12da>["surfaces"]} surfaces
 * @param {[number, number, number]} sceneOriginMga
 * @param {string} sourceFileName - for each mesh's userData.surfaceId, matching the 2D page's `${sourceFileName} — ${surfaceName}` convention
 * @returns {{ group: THREE.Group, excludedScaffold: number }}
 */
export function buildSurfaceMeshes(surfaces, sceneOriginMga, sourceFileName) {
  const group = new THREE.Group();
  group.name = "surfaces-12d";
  let excludedScaffold = 0;

  for (const surf of surfaces) {
    const surfaceName = surf.name ?? "(unnamed surface)";
    const surfaceId = `${sourceFileName} — ${surfaceName}`;
    const normalizedColour = normalizeColour(surf.colour, "#2ee6c8");

    // Project every point once, in scene-local metres — same reasoning
    // as main-2d.js's buildSurfaceFeaturesFrom12d(): interior vertices
    // are typically shared by ~6 triangles each, so doing this per-
    // triangle-reference would be several times more transform calls
    // than necessary on a real drone-flight-density surface.
    const scenePoints = surf.points.map((p) => mgaToScene(p, sceneOriginMga));

    // Same "nulling === 1 is 12d's own auto-bounding-box scaffold,
    // exclude" inference as the 2D page — see twelve-d.js's full_tin
    // notes for the actual evidence this is based on (one sample,
    // unconfirmed with Cameron beyond that).
    const keptTriangles = [];
    surf.triangles.forEach((tri, idx) => {
      if (surf.nulling[idx] === 1) {
        excludedScaffold++;
        return;
      }
      keptTriangles.push(tri);
    });
    if (keptTriangles.length === 0) continue;

    const positions = new Float32Array(scenePoints.length * 3);
    scenePoints.forEach(([x, y, z], i) => {
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
    });
    const indices = new Uint32Array(keptTriangles.length * 3);
    keptTriangles.forEach(([a, b, c], i) => {
      indices[i * 3] = a;
      indices[i * 3 + 1] = b;
      indices[i * 3 + 2] = c;
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();

    // Semi-transparent, double-sided (a surface can legitimately be
    // viewed from above or below once you're navigating a 3D scene,
    // unlike the 2D plan-view fill) — translated from the 2D page's
    // fill-opacity: 0.45 sensibility, not an exact conversion.
    const material = new THREE.MeshStandardMaterial({
      color: normalizedColour,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      metalness: 0,
      roughness: 0.9,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = surfaceId;
    mesh.userData = {
      source: "12d-full_tin",
      surfaceId,
      surfaceName,
      sourceFile: sourceFileName,
      model: surf.model,
      rawColour: surf.colour,
      triangleCount: keptTriangles.length,
    };
    group.add(mesh);
  }

  return { group, excludedScaffold };
}
