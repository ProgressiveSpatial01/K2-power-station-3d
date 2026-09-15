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

// Vercel's serverless functions cap the request body at 4.5MB regardless
// of plan (see api/shared-upload.js's header) — base64 inflates a raw
// file by ~4/3, so anything much past ~3MB raw risks landing on the
// wrong side of that even before the small JSON scaffolding around it.
// Checked BEFORE reading/encoding the file at all (2026-09-16, per
// Cameron uploading a real 84MB IFC and finding it "loads fine but I
// lose it on a refresh" — it was silently failing to share at all, and
// the only sign was a cryptic "Unexpected end of JSON input" once
// Vercel's platform-level rejection came back as a non-JSON body) —
// this way the failure is immediate and says WHY, instead of paying for
// a slow client-side base64 encode and a network round-trip first only
// to get a confusing parse error out the other end.
const MAX_SHARE_BYTES = 3 * 1024 * 1024;

/**
 * @param {{ slot: "design"|"services", subgroupName?: string, file: File }} args
 * @throws if the file is too big to fit this upload path, the secret is
 *   wrong/missing (server-enforced), or the request fails
 */
export async function uploadSharedFile({ slot, subgroupName, file }) {
  if (file.size > MAX_SHARE_BYTES) {
    const mb = (n) => (n / (1024 * 1024)).toFixed(1);
    throw new Error(
      `"${file.name}" is ${mb(file.size)} MB — too big to share (this upload path tops out around ` +
        `${mb(MAX_SHARE_BYTES)} MB, a Vercel platform limit, not something this app can raise on its own). ` +
        "It's loaded on your screen only and won't survive a refresh or show for other visitors — " +
        "flag it if this needs solving properly (uploading straight to Blob storage instead of through " +
        "this API route would support much bigger files)."
    );
  }
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
