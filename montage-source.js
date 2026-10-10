/* --------------------------------------------------------------------------
   Montage source

   Where the montage comes from on the night. The film is usually still being
   cut an hour before doors, so it is never baked into the deploy — the
   operator loads it from disk through the hidden panel (index.html?op=1) and
   the bytes live in IndexedDB from then on.

   Storing the blob rather than an object URL is the whole point: a blob: URL
   dies on reload, and a machine that has been sitting on a lectern for three
   hours will have been reloaded, slept, or restarted at least once. Bytes in
   IndexedDB survive all of that, and survive the wifi being unplugged.

   Resolution order for the primary source:
     1. operator-loaded file in IndexedDB
     2. montage.mp4 (or .webm/.mov/.m4v) sitting next to index.html
     3. nothing — the show ends on a clean blackout

   The backup slot is only ever reached if the primary fails to decode.
   -------------------------------------------------------------------------- */

import { currentFilm, withTimeout, assembleFilm } from "./film-store.js";

const DB_NAME = "kdf-reveal";
const DB_VERSION = 1;
const STORE = "montage";

export const VIDEO_SLOTS = ["primary", "backup"];
export const CUE_SLOT = "cue";

/** Files that may ship alongside index.html, in preference order. */
const MONTAGE_FILES = ["montage.mp4", "montage.webm", "montage.mov", "montage.m4v"];

/* ---------------------------------- IndexedDB ---------------------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/**
 * Persist a picked file. The File object is itself a Blob, so it goes in
 * whole — no re-encoding, no size ceiling beyond the browser's own quota.
 */
export async function storeFile(slot, file, meta = {}) {
  const db = await openDB();
  const record = {
    blob: file,
    name: file.name,
    size: file.size,
    type: file.type,
    savedAt: Date.now(),
    duration: meta.duration ?? null,
    width: meta.width ?? null,
    height: meta.height ?? null,
    channels: meta.channels ?? null,
    sampleRate: meta.sampleRate ?? null,
    peakMs: meta.peakMs ?? null,
  };
  try {
    await tx(db, "readwrite", (s) => s.put(record, slot));
  } finally {
    db.close();
  }
  return record;
}

export async function readFile(slot) {
  let db;
  try { db = await openDB(); } catch { return null; }
  try {
    return (await tx(db, "readonly", (s) => s.get(slot))) || null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function clearFile(slot) {
  const db = await openDB();
  try {
    await tx(db, "readwrite", (s) => s.delete(slot));
  } finally {
    db.close();
  }
}

/**
 * Ask the browser to exempt this origin from eviction-under-pressure. Chrome
 * grants it silently for an installed or frequently-visited origin and refuses
 * quietly otherwise, so the result is advisory — worth asking, never worth
 * blocking on.
 */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* not supported */ }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage?.estimate) return await navigator.storage.estimate();
  } catch { /* not supported */ }
  return null;
}

/* ---------------------------------- Probing ------------------------------ */

/**
 * Confirm the browser can actually decode this source before the night hangs
 * on it. A .mov out of an editor is the usual trap: it downloads fine and
 * reports a valid size, then fails to decode because the codec inside is
 * ProRes or HEVC. Reading metadata forces that failure to surface now.
 */
export function probeVideo(url) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;

    const done = (result) => {
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
      resolve(result);
    };

    const timer = setTimeout(() => done({ ok: false, error: "Timed out reading metadata" }), 15000);

    v.onloadedmetadata = () => {
      if (!v.videoWidth) return done({ ok: false, error: "No video track (audio only?)" });
      done({ ok: true, duration: v.duration, width: v.videoWidth, height: v.videoHeight });
    };
    v.onerror = () => done({ ok: false, error: mediaErrorText(v.error) });

    v.src = url;
  });
}

function mediaErrorText(err) {
  if (!err) return "Unknown media error";
  switch (err.code) {
    case 1: return "Loading aborted";
    case 2: return "Network error";
    case 3: return "Decode failed — codec unsupported";
    case 4: return "Format unsupported by this browser";
    default: return "Unknown media error";
  }
}

/* ---------------------------------- Resolution --------------------------- */

/** HEAD-probe the files that may have shipped beside index.html. */
async function findShippedFile() {
  for (const name of MONTAGE_FILES) {
    try {
      const res = await fetch(name, { method: "HEAD" });
      if (res.ok) return name;
    } catch { /* try the next container */ }
  }
  return null;
}

/**
 * Work out what plays tonight.
 *
 * Returns { primary, backup } where each is { url, label, origin } or null.
 * Object URLs minted here are deliberately never revoked — they are needed for
 * the lifetime of the page, and the page's lifetime is the event.
 */
export async function resolveSources() {
  const [stored, storedBackup] = await Promise.all([readFile("primary"), readFile("backup")]);

  let primary = null;
  let backup = null;

  // The published film wins, so an upload made anywhere reaches every machine
  // with the link. It is only ever a lookup over the network, so it is given a
  // short leash — a venue with no uplink falls through to the local copy below
  // rather than stalling the show on a request that will never answer.
  let shared = null;
  let pending = null;
  try {
    shared = await withTimeout(currentFilm(), 5000);
  } catch (err) {
    console.info("Published film unreachable; falling back to what is on this machine.", err?.message || err);
  }
  // A one-part film can be played straight from its URL. A film stored in
  // several parts has to be fetched and rejoined first, which takes as long as
  // the download takes — so it cannot be the immediate source. That work is
  // started here and handed back as `pending`; the copy on this machine covers
  // the screen until it is ready.
  if (shared?.parts?.length === 1) {
    primary = { url: shared.parts[0], label: shared.name, origin: "published" };
  } else if (shared?.parts?.length > 1) {
    pending = assembleFilm(shared).then((url) => (
      url ? { url, label: shared.name, origin: "published" } : null
    ));
  }

  if (!primary && stored?.blob) {
    primary = { url: URL.createObjectURL(stored.blob), label: stored.name, origin: "stored", record: stored };
  } else if (stored?.blob && !backup) {
    // The machine that uploaded keeps its own copy. If the published one will
    // not play tonight, that copy is the backup rather than dead weight.
    backup = { url: URL.createObjectURL(stored.blob), label: stored.name, origin: "stored", record: stored };
  }
  if (storedBackup?.blob) {
    backup = { url: URL.createObjectURL(storedBackup.blob), label: storedBackup.name, origin: "stored", record: storedBackup };
  }

  // A file shipped in the deploy fills whichever slot is still empty. It is
  // the safety net under the operator, not a competitor to them.
  if (!primary || !backup) {
    const shipped = await findShippedFile();
    if (shipped) {
      const entry = { url: shipped, label: shipped, origin: "shipped" };
      if (!primary) primary = entry;
      else if (!backup) backup = entry;
    }
  }

  return { primary, backup, pending };
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(s) {
  if (!Number.isFinite(s)) return "—";
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}


/* ---------------------------------- Cue audio ---------------------------- */

/** Files that may ship alongside index.html, in preference order. */
const CUE_FILES = ["rewind.mp3", "rewind.wav", "rewind.ogg", "rewind.m4a"];

/**
 * Confirm the browser can decode this audio.
 *
 * Decoding rather than reading metadata, because decodeAudioData is exactly
 * what the show uses — a file that loads in an <audio> tag but will not decode
 * through Web Audio would pass a metadata check and then fail on the night.
 */
export async function probeAudio(url) {
  let ctx;
  try {
    const bytes = await (await fetch(url)).arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctx();
    const buf = await ctx.decodeAudioData(bytes);
    if (!buf.duration) return { ok: false, error: "Decoded to an empty track" };
    return {
      ok: true,
      duration: buf.duration,
      channels: buf.numberOfChannels,
      sampleRate: buf.sampleRate,
      peakMs: cuePeakMs(buf),
    };
  } catch {
    return { ok: false, error: "Could not decode — try exporting as MP3 or WAV" };
  } finally {
    try { ctx?.close(); } catch { /* already closed */ }
  }
}

/**
 * Where a cue lands — the moment the ring should close on it. Mirrors the
 * calculation in app.js so the loader can report the same number the show
 * will use.
 */
function cuePeakMs(buf) {
  const d = buf.getChannelData(0);
  const SLICES = 60;
  const w = Math.floor(d.length / SLICES);
  if (!w) return Math.round(buf.duration * 1000);
  let best = 0;
  let bestSlice = SLICES - 1;
  for (let sl = Math.floor(SLICES / 3); sl < SLICES; sl++) {
    let peak = 0;
    for (let i = sl * w; i < (sl + 1) * w && i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
    if (peak > best) { best = peak; bestSlice = sl; }
  }
  return Math.round((bestSlice / SLICES) * buf.duration * 1000);
}

/**
 * The calibration cue for tonight: whatever the operator loaded, else a file
 * shipped beside index.html, else nothing (the show synthesises one).
 */
export async function resolveCue() {
  const rec = await readFile(CUE_SLOT);
  if (rec?.blob) {
    return { url: URL.createObjectURL(rec.blob), label: rec.name, origin: "stored" };
  }
  for (const name of CUE_FILES) {
    try {
      const res = await fetch(name, { method: "HEAD" });
      if (res.ok) return { url: name, label: name, origin: "shipped" };
    } catch { /* try the next container */ }
  }
  return null;
}
