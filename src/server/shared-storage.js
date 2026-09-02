// shared-storage.js — server-side helper for the custodian/shared-file
// API (api/shared-*.js). Added 2026-08-31, per Cameron: "people wont
// have files to load themselves, i will be the sole custodian of the
// import data" — realised mid-deployment-planning that a deployed K2
// with only per-browser storage (see shared-design-store.js, the
// IndexedDB-based 2D↔3D carry-over) would show every OTHER visitor an
// empty map, since only Cameron ever uploads anything. That only works
// for Cameron's own remote access; it doesn't let him show real data to
// anyone else. This is the real fix: one shared store, backing both the
// public read side (anyone) and the custodian-gated write side (only
// someone who knows CUSTODIAN_SECRET).
//
// Deliberately NOT the more elaborate Vercel Blob "client upload token"
// pattern (browser uploads directly to Blob storage via a short-lived
// token, server only issues the token and gets a completion webhook) —
// that exists mainly to route around serverless function body-size
// limits for BIG uploads. The files this tool actually handles (IFC/12d
// exports) are small — real samples seen so far are 16KB/69KB — so a
// plain "POST the file as base64 JSON to a serverless function" is
// simpler to write, simpler to reason about, and fully sufficient. If a
// genuinely huge design file ever needs uploading, revisit then rather
// than pre-building complexity for a case that hasn't come up.
//
// Metadata for every stored file lives in ONE small JSON "index" blob,
// read-modified-written on every change. Race-condition-safe only in
// the sense that matters here: Cameron is the sole, sequential
// custodian — no concurrent-writer scenario to worry about in practice.

import { put, del, list } from "@vercel/blob";
import { randomUUID } from "node:crypto"; // explicit import rather than relying on the global `crypto` — that's only unconditionally present without one on Node 19+, and Vercel's Node runtime version isn't guaranteed to be that new

const INDEX_PATHNAME = "k2-shared-index.json";

/** @returns {Promise<{ files: Array<{ id: string, slot: string, subgroupName: string|null, name: string, blobUrl: string, uploadedAt: number }> }>} */
export async function readIndex() {
  const { blobs } = await list({ prefix: INDEX_PATHNAME });
  const existing = blobs.find((b) => b.pathname === INDEX_PATHNAME);
  if (!existing) return { files: [] };
  const resp = await fetch(existing.url);
  if (!resp.ok) return { files: [] };
  return await resp.json();
}

async function writeIndex(index) {
  await put(INDEX_PATHNAME, JSON.stringify(index), {
    access: "public",
    contentType: "application/json",
    allowOverwrite: true,
  });
}

export async function addToIndex(entry) {
  const index = await readIndex();
  index.files.push(entry);
  await writeIndex(index);
}

export async function removeFromIndex(id) {
  const index = await readIndex();
  const entry = index.files.find((f) => f.id === id);
  index.files = index.files.filter((f) => f.id !== id);
  await writeIndex(index);
  return entry ?? null;
}

/** Uploads one file's bytes to Blob storage under a unique, collision-safe pathname. */
export async function putFile(name, buffer, contentType) {
  const pathname = `k2-shared/${Date.now()}-${randomUUID()}-${name}`;
  const blob = await put(pathname, buffer, {
    access: "public",
    contentType: contentType || "application/octet-stream",
  });
  return blob.url;
}

export async function deleteBlob(url) {
  await del(url);
}

/** Constant-time-ish comparison isn't critical here (not a high-value crypto target), but avoids the most naive `===` timing tell regardless. */
export function secretMatches(provided) {
  const expected = process.env.CUSTODIAN_SECRET;
  if (!expected) return false; // fail closed if the env var was never set, rather than silently accepting anything
  if (!provided || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
