/* --------------------------------------------------------------------------
   The shared film

   Talks to the two API routes so an upload made on one machine is what every
   other machine plays. The browser never handles a storage key — it asks for a
   one-shot upload URL per part and PUTs the bytes straight to storage.

   Free storage refuses a single upload over 50 MB, so a film is cut into parts
   on the way up and rejoined on the way down. The cut is on raw bytes, so the
   rejoined file is the operator's original byte for byte: nothing is
   re-encoded, and the video element only ever sees one continuous MP4. There
   is no seam to stutter on.

   Deliberately free of any SDK: this project ships no bundler, so everything
   here has to run in the browser exactly as written.
   -------------------------------------------------------------------------- */

/** Must stay under the 50 MB single-upload ceiling the free plan enforces. */
const PART_BYTES = 45 * 1024 * 1024;

/** Never let a dead network hang the show waiting on a lookup. */
export function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
  ]);
}

/** The film currently published, or null when there is none. */
export async function currentFilm() {
  const res = await fetch("/api/film", { cache: "no-store" });
  if (!res.ok) throw new Error(`/api/film returned ${res.status}`);
  const { film } = await res.json();
  return film || null;
}

function putPart(url, method, headers, blob, onLoaded) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method || "PUT", url);
    for (const [k, v] of Object.entries(headers || {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onLoaded(e.loaded); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
      // Storage explains itself in the body; a bare status code sends whoever
      // is standing at the machine hunting for a cause written down right here.
      let detail = "";
      try {
        const body = JSON.parse(xhr.responseText);
        detail = body.message || body.error || "";
      } catch { detail = (xhr.responseText || "").slice(0, 120); }
      reject(new Error(`Upload rejected (${xhr.status})${detail ? `: ${detail}` : ""}`));
    };
    xhr.onerror = () => reject(new Error("Upload failed — check the connection"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.send(blob);
  });
}

/**
 * Publish a film for every device.
 *
 * One file goes in; the parts are an implementation detail the operator never
 * sees. Progress is reported across the whole file, not per part, so the bar
 * moves once from 0 to 100.
 */
export async function uploadFilm(file, onProgress) {
  const uploadId = String(Date.now());
  const parts = Math.max(1, Math.ceil(file.size / PART_BYTES));
  let done = 0;                       // bytes fully uploaded in earlier parts

  for (let part = 1; part <= parts; part++) {
    const start = (part - 1) * PART_BYTES;
    const blob = file.slice(start, Math.min(file.size, start + PART_BYTES));

    const ask = await fetch("/api/upload-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: file.name, contentType: file.type, size: file.size,
        uploadId, part, parts, partSize: blob.size,
      }),
    });
    if (!ask.ok) {
      let msg = `Could not start the upload (${ask.status})`;
      try { msg = (await ask.json()).error || msg; } catch { /* not JSON */ }
      throw new Error(msg);
    }
    const { uploadUrl, method, headers } = await ask.json();

    await putPart(uploadUrl, method, headers, blob, (loaded) => {
      if (onProgress) onProgress(Math.min(1, (done + loaded) / file.size));
    });
    done += blob.size;
  }

  // Clear earlier cuts. Without this a 1 GB allowance fills after four
  // uploads of a film this size, and the next one fails for no obvious reason.
  try {
    await fetch(`/api/film?except=${encodeURIComponent(uploadId)}`, { method: "DELETE" });
  } catch (err) {
    console.warn("Published, but could not clear the previous film.", err);
  }

  return currentFilm();
}

/**
 * Fetch a published film and rejoin it into something playable.
 *
 * Parts are fetched in parallel: they are independent objects, and waiting for
 * one before asking for the next would add a round trip per part on a venue
 * connection. The pieces are concatenated in order into a single Blob, which
 * is the original file — so playback never crosses a boundary.
 */
export async function assembleFilm(film, onProgress) {
  if (!film?.parts?.length) return null;
  if (film.parts.length === 1) return film.parts[0];     // nothing to rejoin

  let done = 0;
  const chunks = await Promise.all(film.parts.map(async (url, i) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Part ${i + 1} of ${film.parts.length} failed (${res.status})`);
    const buf = await res.arrayBuffer();
    done += 1;
    if (onProgress) onProgress(done / film.parts.length);
    return buf;
  }));

  const type = /\.webm$/i.test(film.name || "") ? "video/webm" : "video/mp4";
  return URL.createObjectURL(new Blob(chunks, { type }));
}

/** Remove the published film. The local copy is cleared separately. */
export async function deleteFilm() {
  const res = await fetch("/api/film", { method: "DELETE" });
  if (!res.ok) throw new Error(`Could not delete (${res.status})`);
  return (await res.json()).deleted;
}
