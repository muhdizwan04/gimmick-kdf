/* --------------------------------------------------------------------------
   Supabase Storage

   Thin wrappers over the Storage REST API. Deliberately no SDK: this project
   ships no bundler and adding a dependency means another thing that can move
   underneath the show a week before it runs. These four calls are all it uses.

   Contains no secrets — the keys are read from the environment at call time,
   so this file being publicly readable alongside the rest of the site is fine.
   -------------------------------------------------------------------------- */

/** One bucket, one folder. Clearing the folder clears the film. */
export const BUCKET = "kdf";
export const FOLDER = "montage";

export function config() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  // Supabase renamed its keys: `sb_secret_…` replaces the old service_role JWT,
  // and both authenticate the same way. Accept either name so the variable can
  // be called after whichever the dashboard happens to be showing.
  const key = process.env.SUPABASE_SECRET_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || "";
  return { url, key, ok: Boolean(url && key) };
}

async function api(path, init = {}) {
  const { url, key } = config();
  const res = await fetch(`${url}/storage/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      apikey: key,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = (body && (body.message || body.error)) || `Supabase returned ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

/**
 * Films in the folder, newest first.
 *
 * Supabase lists folders as rows too; those come back without an `id`, and an
 * empty folder carries a placeholder object. Both are filtered out so callers
 * only ever see real uploads.
 */
export async function listFilms() {
  const rows = await api(`/object/list/${BUCKET}`, {
    method: "POST",
    body: JSON.stringify({
      prefix: FOLDER,
      limit: 100,
      sortBy: { column: "created_at", order: "desc" },
    }),
  });
  return (rows || []).filter((r) => r && r.id && r.name && !r.name.startsWith("."));
}

/** Public playback URL. The bucket is public, so this needs no signing. */
export function publicUrl(name) {
  const { url } = config();
  return `${url}/storage/v1/object/public/${BUCKET}/${FOLDER}/${encodeURIComponent(name)}`;
}

/**
 * A one-shot upload URL the browser can PUT to directly.
 *
 * The film never passes through the serverless function — a request body there
 * is capped at 4.5 MB, and the service-role key must not reach the browser.
 */
export async function signUpload(name) {
  const { url } = config();
  const out = await api(
    `/object/upload/sign/${BUCKET}/${FOLDER}/${encodeURIComponent(name)}`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return `${url}/storage/v1${out.url}`;   // out.url is a path with a token
}

export async function removeFilms(names) {
  if (!names.length) return 0;
  await api(`/object/${BUCKET}`, {
    method: "DELETE",
    body: JSON.stringify({ prefixes: names.map((n) => `${FOLDER}/${n}`) }),
  });
  return names.length;
}
