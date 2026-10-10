/* --------------------------------------------------------------------------
   Operator panel

   Never reachable from the show. app.js dynamic-imports this module only when
   the URL carries ?op=1, so none of it — markup, styles, listeners — exists on
   the machine during the ceremony. That is the point: the landing page has to
   read as the finished piece, with no seam where a file drop used to be.

   Load the film here before doors, confirm it decodes, then open the clean URL.
   -------------------------------------------------------------------------- */

import {
  storeFile, readFile, clearFile, probeVideo, probeAudio,
  requestPersistence, storageEstimate, formatBytes, formatDuration,
} from "./montage-source.js";
import { currentFilm, uploadFilm, deleteFilm } from "./film-store.js";

/**
 * Everything the night needs, in load order. `kind` decides which probe runs
 * and how the result is described — the two are otherwise identical, because
 * the store underneath only ever holds a blob.
 */
const SLOTS = [
  { key: "primary", kind: "video", accept: "video/*",
    title: "The film", hint: "Plays full screen when the puzzle completes." },
];

export function mountOperator() {
  injectStyles();

  const root = document.createElement("div");
  root.className = "op-root";
  root.innerHTML = `
    <div class="op-sheet">
      <header class="op-head">
        <div>
          <h1>Montage loader</h1>
          <p>Stored on this machine only. Survives reloads, restarts and a dead network.</p>
        </div>
        <a class="op-open" href="./">Open the show &rarr;</a>
      </header>
      <div class="op-slots">
        ${SLOTS.map((s) => `
          <section class="op-slot" data-slot="${s.key}">
            <div class="op-slot-head">
              <h2>${s.title}</h2>
              <span>${s.hint}</span>
            </div>
            <div class="op-drop" data-drop="${s.key}" tabindex="0" role="button">
              <div class="op-drop-idle">
                <strong>Drop ${s.kind === "audio" ? "a sound" : "a video"} here</strong>
                <span>or click to choose a file</span>
              </div>
            </div>
            <div class="op-status" data-status="${s.key}">Nothing loaded.</div>
            <div class="op-actions">
              <button type="button" data-test="${s.key}" disabled>Test play</button>
              <button type="button" data-clear="${s.key}" disabled>Remove</button>
            </div>
            ${s.kind === "audio"
              ? `<audio class="op-preview" data-preview="${s.key}" controls hidden></audio>`
              : `<video class="op-preview" data-preview="${s.key}" controls playsinline hidden></video>`}
          </section>
        `).join("")}
      </div>
      <footer class="op-foot"><span data-quota>Checking storage…</span></footer>
    </div>
    <input type="file" hidden data-picker>
  `;
  document.body.appendChild(root);

  const picker = root.querySelector("[data-picker]");
  let pickingFor = null;

  picker.addEventListener("change", () => {
    if (picker.files?.[0] && pickingFor) accept(pickingFor, picker.files[0]);
    picker.value = "";
  });

  for (const cfg of SLOTS) {
    const slot = cfg.key;
    const drop = root.querySelector(`[data-drop="${slot}"]`);
    const openPicker = () => { pickingFor = slot; picker.accept = cfg.accept; picker.click(); };

    drop.addEventListener("click", openPicker);
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); }
    });

    // dragover must be cancelled or the browser just navigates to the file.
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      const file = e.dataTransfer?.files?.[0];
      if (file) accept(slot, file);
    });

    root.querySelector(`[data-clear="${slot}"]`).addEventListener("click", async () => {
      const status = root.querySelector(`[data-status="${slot}"]`);
      status.className = "op-status working";
      status.textContent = "Removing…";
      let remoteError = null;
      try {
        await deleteFilm();          // everyone with the link stops seeing it
      } catch (err) {
        remoteError = err;           // reported below; the local copy still goes
      }
      await clearFile(slot);         // and this machine's own copy
      const preview = root.querySelector(`[data-preview="${slot}"]`);
      preview.pause();
      preview.removeAttribute("src");
      preview.load();
      preview.hidden = true;
      render(slot, null, false);
      if (remoteError) {
        status.insertAdjacentHTML("beforeend",
          `<span class="op-warn">Removed here, but the published copy may remain.
            ${escapeHtml(String(remoteError.message || remoteError))}</span>`);
      }
      refreshQuota();
    });

    root.querySelector(`[data-test="${slot}"]`).addEventListener("click", async () => {
      const rec = await readFile(slot);
      if (!rec?.blob) return;
      const preview = root.querySelector(`[data-preview="${slot}"]`);
      preview.hidden = false;
      preview.src = URL.createObjectURL(rec.blob);
      preview.play().catch(() => {});
    });
  }

  // Anything dropped outside a slot would otherwise navigate away and lose the
  // panel — and on a machine mid-setup that reads as a crash.
  root.addEventListener("dragover", (e) => e.preventDefault());
  root.addEventListener("drop", (e) => e.preventDefault());

  /* Read a file, verify the browser can decode it, then keep it. */
  async function accept(slot, file) {
    const cfg = SLOTS.find((s) => s.key === slot);
    const status = root.querySelector(`[data-status="${slot}"]`);
    status.className = "op-status working";
    status.textContent = `Checking ${file.name}…`;

    const url = URL.createObjectURL(file);
    const probe = cfg.kind === "audio" ? await probeAudio(url) : await probeVideo(url);
    URL.revokeObjectURL(url);

    if (!probe.ok) {
      status.className = "op-status bad";
      const advice = cfg.kind === "audio"
        ? "Export as MP3 or WAV and try again"
        : "Re-export as H.264 MP4 and try again";
      status.innerHTML = `<strong>${escapeHtml(file.name)} will not play.</strong> ${escapeHtml(probe.error)}
        <br>${advice} — this file is not stored.`;
      return;
    }

    // This machine first. Cloud storage can be suspended, out of quota, or
    // simply unreachable from the venue — none of which should leave the
    // operator with no film at all. The local copy is what the show falls back
    // to, so it is the one worth securing before anything else is attempted.
    let rec = null;
    try {
      rec = await storeFile(slot, file, probe);
    } catch (err) {
      const quota = err?.name === "QuotaExceededError";
      status.className = "op-status bad";
      status.innerHTML = quota
        ? `<strong>Not enough room on this machine.</strong> Free up disk space, or use a smaller export.`
        : `<strong>Could not save.</strong> ${escapeHtml(String(err?.message || err))}`;
      return;
    }

    // Then publish, so every other device with the link sees it too.
    try {
      status.className = "op-status working";
      status.innerHTML = `<strong>${escapeHtml(file.name)}</strong>
        <span class="op-meta">Uploading… <b data-pct>0%</b></span>
        <span class="op-bar"><i data-fill></i></span>`;
      const pct = status.querySelector("[data-pct]");
      const fill = status.querySelector("[data-fill]");

      await uploadFilm(file, (f) => {
        const n = Math.round(f * 100);
        pct.textContent = `${n}%`;
        fill.style.width = `${n}%`;
      });
      render(slot, rec, true);
    } catch (err) {
      // Saved, just not shared. Say so plainly rather than reporting a failure
      // — this machine will still play the film tonight.
      console.warn("Saved locally, but could not publish.", err);
      render(slot, rec, false);
      status.insertAdjacentHTML("beforeend",
        `<span class="op-warn">Saved on this machine only — not published.
          ${escapeHtml(String(err?.message || err))}</span>`);
    }
    refreshQuota();
  }

  function render(slot, rec, published) {
    const status = root.querySelector(`[data-status="${slot}"]`);
    const testBtn = root.querySelector(`[data-test="${slot}"]`);
    const clearBtn = root.querySelector(`[data-clear="${slot}"]`);

    if (!rec) {
      status.className = "op-status";
      status.textContent = "Nothing loaded.";
      testBtn.disabled = true;
      // Something published from another machine can still be removed here.
      clearBtn.disabled = !published;
      if (published) {
        status.className = "op-status good";
        status.innerHTML = `<strong>A film is published.</strong>
          <span class="op-meta">Uploaded from another machine — every link shows it.</span>
          <span class="op-ok">Drop a new file to replace it, or Remove to clear it.</span>`;
      }
      return;
    }

    status.className = "op-status good";
    const cfg = SLOTS.find((s) => s.key === slot);
    const parts = [formatDuration(rec.duration)];
    if (cfg.kind === "audio") {
      if (rec.sampleRate) parts.push(`${(rec.sampleRate / 1000).toFixed(1)} kHz`);
      if (rec.channels) parts.push(rec.channels === 1 ? "mono" : "stereo");
    } else if (rec.width) {
      parts.push(`${rec.width}\u00d7${rec.height}`);
    }
    parts.push(formatBytes(rec.size));

    // For the cue, the useful number is where it lands — that is what the
    // calibration ring is timed to, so the operator can see the two agree.
    const note = cfg.kind === "audio" && rec.peakMs
      ? `Ready — the ring will fill over ${(rec.peakMs / 1000).toFixed(2)}s to land with it.`
      : published
        ? "Published — every device with the link plays this. A copy is kept here for offline."
        : "Ready — plays from this machine.";

    status.innerHTML = `<strong>${escapeHtml(rec.name)}</strong>
      <span class="op-meta">${parts.join(" &middot; ")}</span>
      <span class="op-ok">${escapeHtml(note)}</span>`;
    testBtn.disabled = clearBtn.disabled = false;
  }

  async function refreshQuota() {
    const el = root.querySelector("[data-quota]");
    const est = await storageEstimate();
    const persisted = await requestPersistence();
    const parts = [];
    if (est?.usage != null) parts.push(`Using ${formatBytes(est.usage)}`);
    if (est?.quota != null) parts.push(`of about ${formatBytes(est.quota)} available`);
    parts.push(persisted ? "Storage is protected from automatic cleanup." : "Storage is not pinned — avoid clearing site data before the event.");
    el.textContent = parts.join(" · ");
  }

  // Show whatever is already loaded from a previous session.
  (async () => {
    let published = false;
    try {
      published = !!(await currentFilm());
    } catch (err) {
      console.warn("Could not reach the published film.", err);
    }
    for (const cfg of SLOTS) render(cfg.key, await readFile(cfg.key), published);
    refreshQuota();
  })();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/* Styles live here so the show never downloads them. */
function injectStyles() {
  const css = `
  .op-root{position:fixed;inset:0;z-index:9999;overflow:auto;background:#0a0d14;
    font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#e6ebf5;
    padding:32px 24px;-webkit-font-smoothing:antialiased}
  .op-sheet{max-width:900px;margin:0 auto}
  .op-head{display:flex;gap:24px;align-items:flex-start;justify-content:space-between;
    flex-wrap:wrap;padding-bottom:20px;border-bottom:1px solid #1e2637;margin-bottom:24px}
  .op-head h1{margin:0 0 6px;font-size:20px;font-weight:650;letter-spacing:-.01em}
  .op-head p{margin:0;color:#8b97ad;max-width:52ch}
  .op-open{flex:none;text-decoration:none;background:#2f6df6;color:#fff;font-weight:600;
    padding:10px 18px;border-radius:8px}
  .op-open:hover{background:#5188ff}
  .op-slots{display:grid;gap:20px;grid-template-columns:minmax(0,560px);justify-content:center}
  .op-slot{background:#111725;border:1px solid #1e2637;border-radius:12px;padding:18px}
  .op-slot-head h2{margin:0 0 4px;font-size:15px;font-weight:650}
  .op-slot-head span{color:#8b97ad;font-size:13px}
  .op-drop{margin:14px 0;border:1.5px dashed #2c374d;border-radius:10px;
    background:#0d1320;min-height:104px;display:grid;place-items:center;text-align:center;
    cursor:pointer;transition:border-color .15s,background .15s}
  .op-drop:hover,.op-drop:focus-visible{border-color:#2f6df6;background:#101a2e;outline:none}
  .op-drop.over{border-color:#2f6df6;background:#12224a;border-style:solid}
  .op-drop-idle strong{display:block;font-weight:600}
  .op-drop-idle span{color:#8b97ad;font-size:13px}
  .op-status{font-size:13px;color:#8b97ad;min-height:38px}
  .op-status strong{color:#e6ebf5;display:block;word-break:break-all}
  .op-status.good strong{color:#4ade80}
  .op-status.bad{color:#fca5a5}
  .op-status.bad strong{color:#f87171}
  .op-status.working{color:#fbbf24}
  .op-meta,.op-ok{display:block}
  .op-bar{display:block;height:5px;margin-top:8px;border-radius:3px;background:#1a2233;overflow:hidden}
  .op-bar i{display:block;height:100%;width:0;background:#2f6df6;transition:width .2s linear}
  .op-ok{color:#4ade80;margin-top:2px}
  .op-warn{display:block;margin-top:6px;color:#fbbf24}
  .op-actions{display:flex;gap:8px;margin-top:12px}
  .op-actions button{flex:1;background:#1a2233;color:#e6ebf5;border:1px solid #2c374d;
    border-radius:7px;padding:8px 12px;font:inherit;font-size:13px;cursor:pointer}
  .op-actions button:hover:not(:disabled){background:#242f45;border-color:#3c4a66}
  .op-actions button:disabled{opacity:.4;cursor:default}
  .op-preview{width:100%;margin-top:12px;border-radius:8px;background:#000;max-height:260px}
  .op-foot{margin-top:24px;padding-top:16px;border-top:1px solid #1e2637;color:#6b7689;font-size:12px}
  `;
  const tag = document.createElement("style");
  tag.textContent = css;
  document.head.appendChild(tag);
}
