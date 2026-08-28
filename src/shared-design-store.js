// shared-design-store.js — lets files uploaded in the 2D page
// automatically appear in the 3D page too, and vice versa. Added
// 2026-08-28, per Cameron: "can we now have the models that are input
// into the 2d view carry over to the 3d view?"
//
// The 2D and 3D pages are two separate full HTML documents
// (index.html / 3d.html), reached via a normal <a href> navigation, not
// a single-page app — so there's no live JS state to share directly;
// navigating away destroys everything. IndexedDB is the browser storage
// mechanism built for exactly this: unlike localStorage's ~5-10MB
// string-only limit, it comfortably holds real binary file blobs the
// size these IFC/12d exports actually are, scoped to this origin, and
// persists across navigations and page reloads.
//
// Design: every file uploaded through either page's file inputs gets
// stashed here (its raw bytes + which upload slot it came from), and
// each page's own startup code (main-2d.js / main.js) replays whatever's
// stored through the EXACT SAME parsing/rendering function it already
// uses for a live file-picker upload — no separate "load from storage"
// code path to keep in sync with the real one.
//
// Scope: only slots the 3D page can currently render anything for are
// carried over — "design" (IFC) and "services" (12d). Design LINEWORK
// and SURFACES (full_tin) have no 3D rendering counterpart at all yet
// (2D-only features added this session) — stashing them here would
// silently do nothing useful once replayed on the 3D side, so they're
// deliberately left out until that 3D rendering work exists. See
// README "Open items."

const DB_NAME = "k2-shared-design-files";
const DB_VERSION = 1;
const STORE_NAME = "files";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Stash a just-uploaded file so the other page can automatically load it
 * too. Safe to call after every successful upload — failures here (e.g.
 * IndexedDB unavailable or blocked by browser settings) are logged but
 * never thrown, since carrying a file over to the other page is a
 * nice-to-have, not something that should ever break the upload the
 * user actually asked for right now. Call only on success — a file that
 * failed to parse/load shouldn't get replayed on the other page either.
 *
 * @param {"design"|"services"} slot - which upload input this came from
 * @param {File} file
 */
export async function stashDesignFile(slot, file) {
  try {
    const db = await openDb();
    const buffer = await file.arrayBuffer(); // Blobs are re-readable — doesn't consume anything the caller already read
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).add({ slot, name: file.name, type: file.type, buffer, savedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[shared-design-store] Couldn't stash file for the other view:", err);
  }
}

/**
 * Every stashed file, oldest first (so replaying them in order matches
 * the sequence they were originally uploaded in — matters if e.g. a
 * later services upload should visually sit on top of an earlier one).
 * @returns {Promise<Array<{ id: number, slot: string, name: string, type: string, buffer: ArrayBuffer, savedAt: number }>>}
 */
export async function getStashedDesignFiles() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => a.savedAt - b.savedAt));
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn("[shared-design-store] Couldn't read stashed files:", err);
    return [];
  }
}

/** Turn a stored record back into a real File object for reuse with the existing upload handlers. */
export function toFile(stored) {
  return new File([stored.buffer], stored.name, { type: stored.type });
}
