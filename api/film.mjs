/* --------------------------------------------------------------------------
   What is playing tonight.

   The bucket is the record — there is no separate pointer to fall out of step
   with it. A film is one or more parts sharing an upload id; this route groups
   them back into a single answer and reports only complete sets, so an upload
   that died half way through can never be served as a truncated film.
   -------------------------------------------------------------------------- */
import { config, listFilms, publicUrl, removeFilms } from "../lib/supabase.mjs";

/** `<uploadId>__p<part>of<total>__<original name>` */
const PART_NAME = /^(\d{10,17})__p(\d{2})of(\d{2})__(.+)$/;

export function group(rows) {
  const groups = new Map();
  for (const row of rows) {
    const m = PART_NAME.exec(row.name);
    if (!m) {
      // A film uploaded before the split existed: a single whole file.
      groups.set(row.name, {
        id: row.name, label: row.name, total: 1, rows: [{ ...row, index: 1 }],
      });
      continue;
    }
    const [, id, index, total, label] = m;
    if (!groups.has(id)) groups.set(id, { id, label, total: Number(total), rows: [] });
    groups.get(id).rows.push({ ...row, index: Number(index) });
  }
  return [...groups.values()];
}

const newestAt = (g) => g.rows.reduce((t, r) => Math.max(t, Date.parse(r.created_at || 0) || 0), 0);

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");

  if (!config().ok) {
    res.status(200).json({ film: null, configured: false });
    return;
  }

  try {
    if (req.method === "GET") {
      const groups = group(await listFilms())
        .sort((a, b) => newestAt(b) - newestAt(a));

      // Only a complete set is playable. A half-finished upload is skipped so
      // an older, whole film keeps playing rather than being replaced by a
      // film that stops part way through.
      const ready = groups.find((g) => g.rows.length === g.total);
      if (!ready) {
        res.status(200).json({ film: null, configured: true, incomplete: groups.length > 0 });
        return;
      }

      ready.rows.sort((a, b) => a.index - b.index);
      res.status(200).json({
        configured: true,
        film: {
          name: ready.label,
          pathname: ready.id,
          parts: ready.rows.map((r) => publicUrl(r.name)),
          size: ready.rows.reduce((n, r) => n + (r.metadata?.size || 0), 0),
          uploadedAt: new Date(newestAt(ready)).toISOString(),
        },
      });
      return;
    }

    if (req.method === "DELETE") {
      // `?except=<uploadId>` keeps the film just uploaded and clears the rest,
      // so past cuts cannot quietly fill a 1 GB storage allowance.
      const except = String(req.query?.except || "");
      const doomed = group(await listFilms())
        .filter((g) => g.id !== except)
        .flatMap((g) => g.rows.map((r) => r.name));
      const deleted = await removeFilms(doomed);
      res.status(200).json({ deleted });
      return;
    }

    res.status(405).json({ error: "GET or DELETE" });
  } catch (err) {
    console.error("film route failed", err);
    res.status(500).json({ error: String(err?.message || err) });
  }
}
