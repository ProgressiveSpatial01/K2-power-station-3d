// api/shared-delete.js — custodian-gated, same secret check as
// shared-upload.js. Removes both the stored file bytes and its index
// entry, so a deleted file actually disappears for every visitor on
// their next load, not just for whoever clicked delete.

import { removeFromIndex, deleteBlob, secretMatches } from "../src/server/shared-storage.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { secret, id } = req.body ?? {};

  if (!secretMatches(secret)) {
    res.status(403).json({ error: "Invalid or missing custodian secret." });
    return;
  }
  if (!id) {
    res.status(400).json({ error: "Missing required field: id." });
    return;
  }

  try {
    const removed = await removeFromIndex(id);
    if (removed) await deleteBlob(removed.blobUrl);
    res.status(200).json({ removed: !!removed });
  } catch (err) {
    console.error("[api/shared-delete] failed:", err);
    res.status(500).json({ error: err.message });
  }
}
