// api/shared-files.js — public, read-only: lists every file the
// custodian has uploaded, for any visitor's browser to auto-load on
// startup. No secret required — this is deliberately the "everyone can
// view" half of the custodian model. See src/server/shared-storage.js
// for the design rationale.

import { readIndex } from "../src/server/shared-storage.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const index = await readIndex();
    res.status(200).json(index);
  } catch (err) {
    console.error("[api/shared-files] failed:", err);
    res.status(500).json({ error: err.message });
  }
}
