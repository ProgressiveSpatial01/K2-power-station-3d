// shared-remote-store.js — the actual custodian-model fix (2026-08-31,
// per Cameron: "people wont have files to load themselves, i will be the
// sole custodian of the import data, so i imagine that changes things").
// Talks to api/shared-*.js. Unlike shared-design-store.js (IndexedDB,
// per-browser, only ever meant to carry files from the 2D page to the 3D
// page within ONE person's own browser), this is the real shared store:
// every visitor's browser reads from the SAME backend, so whatever
// Cameron uploads is what everyone sees — no upload capability of their
// own needed or offered.
//
// The custodian "secret" here is deliberately lightweight (a single
// shared string, not real per-user accounts) — appropriate for "exactly
// one person ever writes," not a multi-user permission system. It's
// remembered in THIS BROWSER's localStorage purely so Cameron doesn't
// have to retype it every visit; the actual enforcement happens
// server-side (api/shared-upload.js / api/shared-delete.js reject
// anything that doesn't match CUSTODIAN_SECRET) — a visitor inspecting
// this file or the network tab learns nothing that lets them write,
// since they'd still need the real secret value, which never ships in
// the app bundle.

const SECRET_STORAGE_KEY = "k2-custodian-secret";

export function getCustodianSecret() {
  try {
    return localStorage.getItem(SECRET_STORAGE_KEY);
  } catch {
    return null; // private browsing / storage blocked — just means custodian mode can't persist here
  }
}

export function setCustodianSecret(secret) {
  try {
    if (secret) localStorage.setItem(SECRET_STORAGE_KEY, secret);
    else localStorage.removeItem(SECRET_STORAGE_KEY);
  } catch {
    // ignore — see getCustodianSecret()
  }
}

/** @returns {Promise<Array<{ id: string, slot: string, subgroupName: string|null, name: string, blobUrl: string, uploadedAt: number }>>} */
export async function listSharedFiles() {
  const resp = await fetch("/api/shared-files");
  if (!resp.ok) throw new Error(`Failed to list shared files (HTTP ${resp.status})`);
  const { files } = await resp.json();
  return files;
}

/** Fetches one shared file's actual bytes back into a real File object, for replay through the normal upload handlers. */
export async function fetchSharedFile(entry) {
  const resp = await fetch(entry.blobUrl);
  if (!resp.ok) throw new Error(`Failed to fetch "${entry.name}" (HTTP ${resp.status})`);
  const blob = await resp.blob();
  return new File([blob], entry.name, { type: blob.type });
}

/**
 * @param {{ slot: "design"|"services", subgroupName?: string, file: File }} args
 * @throws if the secret is wrong/missing (server-enforced) or the request fails
 */
export async function uploadSharedFile({ slot, subgroupName, file }) {
  const secret = getCustodianSecret();
  const contentBase64 = await fileToBase64(file);
  const resp = await fetch("/api/shared-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, slot, subgroupName: subgroupName || null, name: file.name, contentBase64, contentType: file.type }),
  });
  const body = await resp.json();
  if (!resp.ok) throw new Error(body.error || `Upload failed (HTTP ${resp.status})`);
  return body.entry;
}

export async function deleteSharedFile(id) {
  const secret = getCustodianSecret();
  const resp = await fetch("/api/shared-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, id }),
  });
  const body = await resp.json();
  if (!resp.ok) throw new Error(body.error || `Delete failed (HTTP ${resp.status})`);
  return body.removed;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]); // strip the "data:...;base64," prefix
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
