// api/shared-upload.js — custodian-gated: only a request carrying the
// correct CUSTODIAN_SECRET (a Vercel environment variable, never shipped
// to the browser) can add a file to shared storage. Everyone else gets a
// 403. This is the actual enforcement the custodian model needs — see
// src/server/shared-storage.js's file header for why this exists and why
// it's a plain JSON+base64 upload rather than Vercel Blob's client-
// upload-token pattern.
//
// Body size: Vercel's serverless functions cap the request body at
// 4.5MB regardless of plan. Base64 adds ~33% overhead, so this
// comfortably handles real IFC/12d exports (16KB-69KB seen so far) but
// would reject a multi-megabyte file. Not a concern for this tool's
// actual data (point clouds were explicitly routed to a different
// project, see README/project memory) — revisit only if that changes.

import { randomUUID } from "node:crypto";
import { putFile, addToIndex, secretMatches } from "../src/server/shared-storage.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { secret, slot, subgroupName, name, contentBase64, contentType } = req.body ?? {};

  if (!secretMatches(secret)) {
    res.status(403).json({ error: "Invalid or missing custodian secret." });
    return;
  }
  if (!slot || !name || !contentBase64) {
    res.status(400).json({ error: "Missing required field(s): slot, name, contentBase64." });
    return;
  }

  try {
    const buffer = Buffer.from(contentBase64, "base64");
    const blobUrl = await putFile(name, buffer, contentType);
    const entry = {
      id: randomUUID(),
      slot,
      subgroupName: subgroupName || null,
      name,
      blobUrl,
      uploadedAt: Date.now(),
    };
    await addToIndex(entry);
    res.status(200).json({ entry });
  } catch (err) {
    console.error("[api/shared-upload] failed:", err);
    res.status(500).json({ error: err.message });
  }
}
