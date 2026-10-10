/* --------------------------------------------------------------------------
   Mint a one-shot upload URL for one part of a film.

   Supabase refuses any single upload over 50 MB on the free plan, and the
   bucket cannot be raised above it. So a film is stored as a run of parts,
   each comfortably under that ceiling, and stitched back together before it
   plays. The split is on raw bytes — no re-encoding — so what the show plays
   is the operator's file exactly.

   Parts of one film share an upload id and carry their position in the name:

       1790152649741__p01of03__montage.mp4

   The film goes browser → storage directly. It never passes through this
   function: a serverless request body is capped at 4.5 MB, and the storage key
   has to stay on the server.
   -------------------------------------------------------------------------- */
import { config, signUpload } from "../lib/supabase.mjs";

/** Hard ceiling for a whole film. */
const MAX_BYTES = 200 * 1024 * 1024;

/** Ceiling for a single part — under the 50 MB the free plan accepts. */
const PART_BYTES = 45 * 1024 * 1024;

/** Refuse a run so long it means the client is confused about part size. */
const MAX_PARTS = 24;

const pad = (n) => String(n).padStart(2, "0");

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");

  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  if (!config().ok) {
    res.status(503).json({
      error: "Cloud storage is not set up yet — the film can still be saved on this machine.",
    });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { filename, contentType, size, uploadId, partSize } = body;
    const part = Number(body.part);
    const parts = Number(body.parts);

    if (!filename) {
      res.status(400).json({ error: "filename is required" });
      return;
    }
    if (typeof size === "number" && size > MAX_BYTES) {
      res.status(413).json({
        error: `That file is ${(size / 1048576).toFixed(0)} MB. The limit is `
          + `${MAX_BYTES / 1048576} MB — export it smaller.`,
      });
      return;
    }
    if (!/^\d{10,17}$/.test(String(uploadId || ""))) {
      res.status(400).json({ error: "uploadId must be a timestamp" });
      return;
    }
    if (!Number.isInteger(part) || !Number.isInteger(parts)
        || part < 1 || parts < 1 || part > parts || parts > MAX_PARTS) {
      res.status(400).json({ error: `part/parts out of range (max ${MAX_PARTS} parts)` });
      return;
    }
    if (typeof partSize === "number" && partSize > PART_BYTES + 1024) {
      res.status(413).json({
        error: `A part is ${(partSize / 1048576).toFixed(0)} MB; each must stay under `
          + `${PART_BYTES / 1048576} MB.`,
      });
      return;
    }

    // Keep the original name legible in storage, trimmed so the path stays sane.
    const safe = String(filename).replace(/[^\w.\-]+/g, "_").slice(-60);
    const name = `${uploadId}__p${pad(part)}of${pad(parts)}__${safe}`;

    res.status(200).json({
      uploadUrl: await signUpload(name),
      method: "PUT",
      headers: contentType ? { "content-type": contentType } : {},
      pathname: name,
    });
  } catch (err) {
    console.error("sign upload failed", err);
    res.status(500).json({ error: String(err?.message || err) });
  }
}
