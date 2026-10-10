/* ==========================================================================
   KDF Reveal — MediaPipe hand-tracked jigsaw
   Grab = closed fist.  Release = open palm.
   ========================================================================== */

import { HandLandmarker, FilesetResolver }
  from "./vendor/tasks-vision/vision_bundle.mjs";
import { resolveSources, resolveCue } from "./montage-source.js";

/* --------------------------------------------------------------------------
   CONFIG — every number a stage operator might need to retune, in one place.
   -------------------------------------------------------------------------- */
const CONFIG = {
  puzzle: { cols: 3, rows: 1, tabDepth: 0.20 },   // 3 vertical strips

  // Safe area the logo box and the scattered pieces stay clear of.
  safe: { top: 100, bottom: 108 },

  // Neon circuit backdrop. `density` scales how many traces are laid down;
  // `pulses` is how many lights travel them at once.
  backdrop: { enabled: true, density: 1, pulses: 8, cell: 58 },

  // 1.25 rather than 1.5: about a third fewer pixels to fill every frame, and
  // indistinguishable at hall viewing distance.
  maxPixelRatio: 1.25,
  // Drop the animated backdrop layers if the machine cannot keep up, so a
  // weaker laptop degrades instead of overheating.
  degradeBelowFps: 45,

  // Gesture thresholds. Value = mean(fingertip→wrist) / hand span.
  // A splayed palm sits near 2.0, a tight fist near 1.0.
  grip: {
    closeAt:      1.34,   // below this → closing
    openAt:       1.62,   // above this → opening (gap = hysteresis)
    framesToGrab: 3,      // consecutive frames before the state commits
    framesToDrop: 3,
  },

  // One Euro filter coefficients. minCutoff sets how still a resting hand
  // looks; beta sets how much lag is traded away as the hand speeds up.
  // Jitter too high -> lower minCutoff. Feels laggy when moving -> raise beta.
  filter: {
    cursor:   { minCutoff: 1.5, beta: 0.010, dCutoff: 1.0 },
    landmark: { minCutoff: 2.5, beta: 0.014, dCutoff: 1.0 },
    grip:     { minCutoff: 1.2, beta: 0.500, dCutoff: 1.0 },
  },

  // Tracking persistence. MediaPipe drops a frame or two constantly; coasting
  // through those gaps is the difference between a steady hold and a piece
  // that falls out of the VIP's hand on stage.
  track: { matchRadius: 340, coastFrames: 9 },

  reach:  { grab: 260, snap: 210 },   // px — deliberately forgiving on stage
  lostHandHintMs: 5000,

  // The calibration step: hold a detected hand this long before the reveal
  // begins. Proves tracking is live before the presenter is committed.
  // `settleMs` holds the calibration screen after the chime starts, so the
  // phrase is most of the way through before the reveal takes over. The last
  // strike is left to ring on into the puzzle.
  calibrate: { holdMs: 2000, decay: 1.6, settleMs: 1300, graceMs: 200 },

  // Playback level for a supplied calibration cue file, if there is one.
  cueGain: 0.7,

  // Hand tracking. `trackFps` caps inference; 60 matches the display, so it
  // only bites in the lite profile below.
  // One hand is all a single presenter needs, and it halves inference cost.
  // It also stops a bystander behind the presenter stealing the cursor.
  hands: 1,
  // The camera delivers 30fps; asking the model for more than that is pure
  // waste with no visual difference at all.
  trackFps: 30,
  confetti: { burst: 90, rain: 160 },

  // MediaPipe downsamples to a couple of hundred pixels internally, so a 720p
  // capture is decoded and uploaded every frame for nothing.
  camera: { width: 960, height: 540 },
  audio:  true,
};

/* --------------------------------------------------------------------------
   Lite profile

   The venue machine is a low-memory laptop, not a Mac. On one of those the
   three things that genuinely hurt are hand-tracking inference, oversized
   canvas buffers, and canvas blur — shadowBlur is rasterised on every draw
   and is by far the most expensive thing the stage paints. Lite trims all
   three and keeps what the room actually watches: the pieces, the reveal,
   the film.

   Chosen at startup from what the browser reports (deviceMemory is Chromium
   only, so core count is the fallback signal), forced with ?lite=1 or ?lite=0,
   and entered automatically mid-show if the frame rate proves the guess wrong.
   -------------------------------------------------------------------------- */
let lite = (() => {
  const forced = new URLSearchParams(location.search).get("lite");
  if (forced === "1") return true;
  if (forced === "0") return false;
  const mem = navigator.deviceMemory;             // GB, rounded down; Chromium only
  const cores = navigator.hardwareConcurrency || 8;
  return (mem !== undefined && mem <= 4) || cores <= 4;
})();

function applyLite() {
  document.documentElement.classList.toggle("lite", lite);
  if (!lite) return;
  CONFIG.maxPixelRatio = 1;
  CONFIG.backdrop.pulses = 4;
  CONFIG.camera = { width: 640, height: 360 };    // the model downsamples to ~224px regardless
  CONFIG.hands = 1;
  CONFIG.trackFps = 20;
  CONFIG.confetti = { burst: 40, rain: 60 };
}
applyLite();

/** Glow radius for a per-frame canvas draw — none at all in the lite profile. */
function glowPx(px) {
  return lite ? 0 : px;
}

/* --------------------------------------------------------------------------
   DOM
   -------------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const canvas = $("stage");
const ctx    = canvas.getContext("2d");
const bgCanvas = $("backdrop");
const bgCtx    = bgCanvas.getContext("2d");
const video  = $("cam");

const ui = {
  hero: $("hero"), done: $("done"), topbar: $("topbar"), footer: $("footer"),
  pill: $("pill"), pillText: $("pillText"), progress: $("progress"),
  monitor: $("monitor"), mHands: $("mHands"), mGrip: $("mGrip"), mFps: $("mFps"),
  montage: $("montage"), montageVideo: $("montageVideo"),
  blackout: $("blackout"),
  calibrate: $("calibrate"), calRing: $("calRing"),
  toast: $("toast"),
};

/* --------------------------------------------------------------------------
   State
   -------------------------------------------------------------------------- */
const STATE = { IDLE: "idle", ARMING: "arming", CALIBRATE: "calibrate", PLAY: "play", DONE: "done", MONTAGE: "montage", BLACKOUT: "blackout" };
let state = STATE.IDLE;

let landmarker = null;
let pieces = [];
let hands  = [];
let particles = [];
let logo = null;              // offscreen canvas holding the finished artwork
let box  = { x: 0, y: 0, w: 0, h: 0 };   // logo bounding box in stage coords

let circuit = null;           // static trace layer, redrawn only on resize
let traces = [];              // the same traces as polylines, for the pulses
let pulses = [];
let view = { W: 0, H: 0 };    // the viewport `box` was solved against
let poster = null;            // puzzle artwork, once an image is supplied
let boardAspect = 4 / 5;      // width / height — adopts the artwork's own ratio
let fused = 0;                // 0 = seams visible, 1 = pieces read as one logo
let lastPlacedAt = 0;
let lastHandSeenAt = 0;
let lastVideoTime = -1;
let lastDetectAt = 0;
let dpr = 1;

const fps = { frames: 0, mark: 0, value: 0, lowRun: 0 };

/* --------------------------------------------------------------------------
   Audio — synthesised, so there are no asset files to lose before a ceremony.

   The context is created once and kept running. A browser hands back a
   *suspended* context unless it is built inside a user gesture, and a
   suspended context's clock does not advance — so every cue scheduled against
   it lands on the same timestamp and fires as one garbled cluster the moment
   the browser resumes. That cluster is what a room hears as a stutter. We
   unlock on the first gesture and re-check before each cue.
   -------------------------------------------------------------------------- */
let audio = null;
let master = null;

function ensureAudio() {
  if (!CONFIG.audio) return null;
  if (!audio) {
    audio = new (window.AudioContext || window.webkitAudioContext)();
    master = audio.createGain();
    master.gain.value = 0.9;
    master.connect(audio.destination);
    decodeCue();
  }
  if (audio.state === "suspended") audio.resume().catch(() => {});
  return audio;
}

/**
 * Go fullscreen.
 *
 * Browsers only grant this from a genuine user gesture, so it cannot happen on
 * page load. Activate is the first real click and the natural place for it.
 * For an unattended venue machine use `npm run kiosk`, which launches Chrome
 * already fullscreen and needs no gesture at all.
 */
function goFullscreen() {
  if (document.fullscreenElement) return;
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) return;
  try {
    Promise.resolve(req.call(el)).catch(() => { /* refused: run windowed */ });
  } catch { /* refused: run windowed */ }
}

// Unlock on the first interaction of any kind, long before a cue needs to fire.
// The same gesture is the only moment a browser will grant fullscreen, so take
// it here too — a page can never do this on load, however it was opened.
for (const evt of ["pointerdown", "keydown", "touchstart"]) {
  addEventListener(evt, () => { ensureAudio(); goFullscreen(); },
                   { once: true, passive: true });
}

/**
 * One voice with a soft attack and an exponential tail.
 *
 * `attack` matters more than it looks: ramping from silence over a few
 * milliseconds instead of starting at full amplitude is the difference between
 * a note and a click, and a click through a PA at volume is what reads as a
 * glitch.
 */
function voice(freq, dur = 0.12, type = "sine", gain = 0.13, when = 0, attack = 0.014) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const t = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(gain, t + attack);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(amp).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}

// Kept for callers that predate `voice`.
function tone(freq, dur = 0.12, type = "sine", gain = 0.13) {
  voice(freq, dur, type, gain);
}

/**
 * The calibration chime: ting — ting — tinggg — tinnngggg.
 * [frequency, start offset in seconds, ring time in seconds]
 * G5, G5, C6, E6 — an ascending figure that resolves upward.
 */
/** Sweep length for the calibration transition; the impact lands on its end. */
const REWIND_DUR = 1.30;

const CHIME = [
  [783.99, 0.00, 0.70],
  [783.99, 0.45, 0.70],
  [1046.50, 0.95, 1.40],
  [1318.51, 1.55, 3.00],
];

/**
 * A struck bell rather than a beep: a sine fundamental plus a quiet partial
 * well above it that decays much faster. That fast-fading partial is what the
 * ear reads as the strike; the fundamental underneath is the ring.
 */
function bell(freq, dur, when = 0, gain = 0.10) {
  voice(freq, dur, "sine", gain, when, 0.006);
  voice(freq * 2.76, dur * 0.32, "sine", gain * 0.30, when, 0.004);
}

/**
 * Low body under the final strike — a pad, not a thump.
 *
 * Two things keep it out of the way. A sine rather than a triangle, because
 * the triangle's harmonics sat up in the same range as the bells and read as
 * far louder than its gain suggested. And straight-line ramps rather than the
 * bell's exponential, which front-loads most of its energy into the first half
 * second: the pad now swells in and fades evenly underneath the chime.
 */
function pad(freq, dur, when = 0, gain = 0.016, attack = 0.4) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const t = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, t);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(gain, t + attack);
  amp.gain.linearRampToValueAtTime(0, t + dur);
  osc.connect(amp).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

const sfx = {
  grab:  () => voice(180, 0.10, "triangle", 0.09),
  drop:  () => voice(120, 0.09, "sine", 0.06),
  snap:  () => { voice(880, 0.16, "sine", 0.12); voice(1320, 0.22, "sine", 0.07); },
  finish:() => [523, 659, 784, 1047, 1319].forEach((f, i) => voice(f, 1.1, "sine", 0.09, i * 0.095)),
  boom:  () => { voice(70, 1.4, "sine", 0.2); voice(104, 0.9, "triangle", 0.09); },
  riser: () => sweep(180, 1400, 1.1),
  rewind: () => rewind(1.4),

  /**
   * The bell phrase — four spaced strikes. No longer the calibration cue, but
   * kept whole so it can be auditioned against the rewind and swapped back in
   * by pointing `ready` at it.
   */
  chime: () => {
    for (const [freq, at, dur] of CHIME) bell(freq, dur, at);
    const last = CHIME[CHIME.length - 1][1];
    pad(130.81, 4.2, Math.max(0, last - 0.4));
  },

  /**
   * Calibration locked in — a tape-rewind sweep resolving into an impact.
   *
   * The sweep alone reads as "something is coming", which leaves a presenter
   * unsure whether the step actually took. Landing it on a hit fixes that, and
   * the hit is timed to fall exactly on the cut to the reveal so the sound and
   * the picture turn over together.
   */
  ready: () => {
    if (playCueSample()) return;
    rewind(REWIND_DUR);
    impact(REWIND_DUR);
  },
};

/* --------------------------------------------------------------------------
   Calibration cue sample

   The sound the calibration ring fills to. Loaded through the hidden panel
   (index.html?op=1) and kept on this machine, exactly like the montage; a file
   shipped beside index.html still works as a fallback. Nothing about the show
   depends on either existing — with no cue at all the synthesised rewind below
   plays instead, and a file that will not decode falls back rather than
   leaving the step silent.

   The bytes are fetched at startup but decoded on the first user gesture —
   decoding needs an AudioContext, and asking for one before a gesture gets a
   suspended one. Activate happens long before calibration completes, so the
   buffer is always ready by the time the cue fires.
   -------------------------------------------------------------------------- */
let cueBytes = null;
let cueBuffer = null;

async function loadCueSample() {
  if (!CONFIG.audio) return;
  try {
    const src = await resolveCue();
    if (!src) {
      console.info("No calibration cue loaded; using the synthesised rewind.");
      return;
    }
    cueBytes = await (await fetch(src.url)).arrayBuffer();
    console.info(`Calibration cue: ${src.label} (${src.origin}, `
      + `${(cueBytes.byteLength / 1024).toFixed(0)} KB)`);
  } catch (err) {
    console.warn("Could not read the calibration cue; using the synthesised rewind.", err);
  }
}
loadCueSample();

/** Decode once, as soon as there is a context to decode against. */
function decodeCue() {
  if (!cueBytes || cueBuffer || !audio) return;
  audio.decodeAudioData(cueBytes.slice(0))
    .then((buf) => {
      cueBuffer = buf;
      // The ring now takes exactly as long as the cue takes to land, so the
      // two finish together. Whatever is left of the file rings on into the
      // reveal, which starts a beat later.
      CONFIG.calibrate.holdMs = clamp(cuePeakMs(buf), 900, 4000);
      CONFIG.calibrate.settleMs = 120;
      console.info(`Cue decoded: ${buf.duration.toFixed(2)}s, lands at `
        + `${CONFIG.calibrate.holdMs}ms — ring set to match.`);
    })
    .catch((err) => {
      cueBytes = null;
      console.warn("Calibration cue failed to decode; falling back to the synthesised rewind.", err);
    });
}

/**
 * Where a cue lands — the moment the picture should change.
 *
 * A transition sound rises, hits, then decays. Timing the cut off the file's
 * *length* puts the reveal somewhere in that decay, a beat late; timing it off
 * the loudest moment puts the reveal on the hit. The first third is skipped so
 * a sound that opens loud cannot be mistaken for its own landing.
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
  // The start of the loudest slice: better a frame early than a frame late.
  return Math.round((bestSlice / SLICES) * buf.duration * 1000);
}

let cueBus = null;

/**
 * Start the calibration cue, timed to run alongside the ring.
 *
 * The cue begins the moment a hand is first seen and is scaled so it resolves
 * as the ring closes — `holdMs` is set from the cue's own landing point when a
 * file is loaded, and the synthesised stand-in is simply stretched to whatever
 * `holdMs` is. Everything runs through one bus so an abandoned hold can be
 * silenced in a single move.
 */
function startCue(offsetMs = 0) {
  const ctx = ensureAudio();
  if (!ctx) return false;
  stopCue();

  cueBus = ctx.createGain();
  cueBus.gain.value = 1;
  cueBus.connect(master);

  if (cueBuffer) {
    const src = ctx.createBufferSource();
    src.buffer = cueBuffer;
    const amp = ctx.createGain();
    amp.gain.value = CONFIG.cueGain;
    src.connect(amp).connect(cueBus);
    // Resume at the ring's position, not from the top.
    src.start(ctx.currentTime, Math.min(offsetMs / 1000, cueBuffer.duration - 0.01));
  } else {
    // No file: compress the synthesised rewind into whatever hold is left, so
    // its impact still lands as the ring closes.
    const left = Math.max(0.2, (CONFIG.calibrate.holdMs - offsetMs) / 1000);
    rewind(left, 0, 1, cueBus);
    impact(left, 1, cueBus);
  }
  return true;
}

/**
 * Silence the cue when the hand is lost. Fading over 120ms rather than cutting
 * keeps an abandoned attempt from ending on a click.
 */
function stopCue() {
  if (!cueBus || !audio) return;
  const bus = cueBus;
  cueBus = null;
  const t = audio.currentTime;
  try {
    bus.gain.cancelScheduledValues(t);
    bus.gain.setValueAtTime(bus.gain.value, t);
    bus.gain.linearRampToValueAtTime(0, t + 0.12);
    setTimeout(() => { try { bus.disconnect(); } catch { /* gone */ } }, 300);
  } catch { /* already torn down */ }
}

/** Play the supplied file. Returns false when there is nothing decoded yet. */
function playCueSample() {
  const ctx = ensureAudio();
  if (!ctx || !cueBuffer) return false;
  const src = ctx.createBufferSource();
  src.buffer = cueBuffer;
  const amp = ctx.createGain();
  amp.gain.value = CONFIG.cueGain;
  src.connect(amp).connect(master);
  src.start(ctx.currentTime);
  return true;
}

/**
 * Tape-rewind transition — a reverse whoosh with a spooling warble over it.
 *
 * Two layers do the work. Filtered noise climbing through a bandpass is the
 * air of the whoosh; a square wave wobbled by a fast LFO is the spool, and
 * that wobble is the part that reads as *tape* rather than as a generic
 * swoosh. Both fade out together so it hands over cleanly to whatever follows.
 */
function rewind(dur = 1.4, when = 0, level = 1, dest = null) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const t = ctx.currentTime + when;

  // Noise bed.
  const frames = Math.ceil(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;

  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 1.6;
  bp.frequency.setValueAtTime(320, t);
  bp.frequency.exponentialRampToValueAtTime(6000, t + dur * 0.85);

  const namp = ctx.createGain();
  namp.gain.setValueAtTime(0, t);
  namp.gain.linearRampToValueAtTime(0.10 * level, t + dur * 0.7);
  namp.gain.linearRampToValueAtTime(0, t + dur);
  src.connect(bp).connect(namp).connect(dest || master);
  src.start(t);
  src.stop(t + dur + 0.05);

  // Spool warble.
  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.setValueAtTime(400, t);
  osc.frequency.exponentialRampToValueAtTime(2600, t + dur * 0.9);

  const lfo = ctx.createOscillator();
  lfo.frequency.setValueAtTime(18, t);
  lfo.frequency.linearRampToValueAtTime(42, t + dur);
  const lfoAmt = ctx.createGain();
  lfoAmt.gain.value = 140;
  lfo.connect(lfoAmt).connect(osc.frequency);

  const oamp = ctx.createGain();
  oamp.gain.setValueAtTime(0, t);
  oamp.gain.linearRampToValueAtTime(0.035 * level, t + dur * 0.6);
  oamp.gain.linearRampToValueAtTime(0, t + dur);
  osc.connect(oamp).connect(dest || master);
  osc.start(t); lfo.start(t);
  osc.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
}

/**
 * The hit a transition lands on. A pitch-dropping sine carries the weight, a
 * clipped noise burst gives it an edge. Without one the rewind simply trails
 * off and nothing marks the moment the step actually completed.
 */
function impact(when = 0, level = 1, dest = null) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const t = ctx.currentTime + when;

  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(45, t + 0.35);
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(0.13 * level, t + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
  osc.connect(amp).connect(dest || master);
  osc.start(t);
  osc.stop(t + 0.8);

  const frames = Math.ceil(ctx.sampleRate * 0.18);
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(3000, t);
  lp.frequency.exponentialRampToValueAtTime(600, t + 0.18);
  const namp = ctx.createGain();
  namp.gain.setValueAtTime(0.055 * level, t);
  namp.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  src.connect(lp).connect(namp).connect(dest || master);
  src.start(t);
  src.stop(t + 0.2);
}

/** Rising tone — the lift into the montage. */
function sweep(from, to, dur) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(0.05, t + dur * 0.75);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(amp).connect(master);
  osc.start(t); osc.stop(t + dur + 0.05);
}

/* --------------------------------------------------------------------------
   Utilities
   -------------------------------------------------------------------------- */
const lerp  = (a, b, t) => a + (b - a) * t;

/**
 * Easing that does not change speed with the frame rate.
 *
 * `lerp(a, b, 0.4)` once per frame moves twice as far per second at 120 fps as
 * at 60, and slows to a crawl when the machine dips — which is exactly when
 * motion most needs to look steady. Converting the per-frame fraction into a
 * per-millisecond one makes the movement identical everywhere, and stops a
 * dropped frame turning into a visible jerk.
 */
function ease(from, to, k, dt) {
  return lerp(from, to, 1 - Math.pow(1 - k, dt / 16.667));
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dist  = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/**
 * Viewport size, guarded. A hidden or not-yet-painted window reports 0, which
 * would collapse the whole board; fall back to the screen and a sane floor.
 */
function viewport() {
  // The `||` chain already covers the unusable case — a hidden or unpainted
  // window reports 0. Do not clamp to a minimum beyond that: flooring a real
  // measurement makes the board size itself for a screen that isn't there, and
  // it gets drawn off the edge of the one that is.
  const W = window.innerWidth  || document.documentElement.clientWidth  || screen.width  || 1280;
  const H = window.innerHeight || document.documentElement.clientHeight || screen.height || 720;
  return { W, H };
}

const easeOutExpo  = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const easeOutBack  = (t) => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2);
const easeInOut    = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** 0 before `a`, 1 after `b`, eased in between. */
const span = (t, a, b, ease = easeOutExpo) => ease(clamp((t - a) / (b - a), 0, 1));

let toastTimer;
function toast(msg) {
  ui.toast.textContent = msg;
  ui.toast.classList.add("in");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove("in"), 2200);
}

function setPill(text, mode) {
  ui.pillText.textContent = text;
  ui.pill.dataset.state = mode;
}

/* --------------------------------------------------------------------------
   One Euro filter
   Adaptive low-pass: heavy smoothing while the hand is nearly still (kills
   jitter), light smoothing while it moves fast (kills lag). A fixed-alpha
   filter cannot do both, which is why raw exponential smoothing always feels
   either shaky or rubbery.
   -------------------------------------------------------------------------- */
class LowPass {
  constructor() { this.y = null; }
  filter(x, a) {
    this.y = this.y === null ? x : a * x + (1 - a) * this.y;
    return this.y;
  }
  reset() { this.y = null; }
}

class OneEuro {
  constructor({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new LowPass();
    this.dx = new LowPass();
    this.prev = null;
    this.lastT = null;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(value, t) {
    const dt = this.lastT === null ? 1 / 60 : clamp((t - this.lastT) / 1000, 1e-4, 0.2);
    this.lastT = t;
    const rate = this.prev === null ? 0 : (value - this.prev) / dt;
    this.prev = value;
    const edx = this.dx.filter(rate, OneEuro.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, OneEuro.alpha(cutoff, dt));
  }
}

class Vec2Filter {
  constructor(opts) { this.fx = new OneEuro(opts); this.fy = new OneEuro(opts); }
  filter(x, y, t) { return { x: this.fx.filter(x, t), y: this.fy.filter(y, t) }; }
}

/* --------------------------------------------------------------------------
   Logo artwork — drawn once into an offscreen canvas. Each puzzle piece
   clips its own region out of this, so alignment is perfect by construction.
   -------------------------------------------------------------------------- */
function buildLogo(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");

  // A supplied poster is the artwork. The board already matches its aspect
  // ratio, so this fills exactly with no crop and no distortion.
  if (poster) {
    g.drawImage(poster, 0, 0, w, h);
    return c;
  }

  drawFallbackPoster(g, w, h);
  return c;
}

/**
 * Stand-in poster, laid out to the same 4:5 proportions and running order as
 * the printed one: lockup, tagline, details, headline, imagery band, contact,
 * partner strip.
 *
 * Every position is a fraction of the board and every string is measured and
 * shrunk to fit its own column, so nothing collides or overruns at whatever
 * size the layout solver picks.
 */
function drawFallbackPoster(g, w, h) {
  const FONT = getComputedStyle(document.body).fontFamily;

  const set = (size, weight, tracking = 0, style = "") => {
    g.font = `${style} ${weight} ${size}px ${FONT}`.trim();
    g.letterSpacing = `${tracking}px`;
  };
  /** Shrink until the string fits `maxW`, so long partner names never collide. */
  const fit = (str, maxW, size, weight, tracking = 0, style = "") => {
    let s = size;
    for (let i = 0; i < 14; i++) {
      set(s, weight, tracking * (s / size), style);
      if (g.measureText(str).width <= maxW) break;
      s *= 0.93;
    }
    return s;
  };

  /* ---- ground ---- */
  const bg = g.createLinearGradient(0, 0, w * 0.4, h);
  bg.addColorStop(0,    "#1b2f6b");
  bg.addColorStop(0.45, "#16255a");
  bg.addColorStop(1,    "#0f1a42");
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);

  const bloom = g.createRadialGradient(w * 0.5, h * 0.08, 0, w * 0.5, h * 0.08, w * 1.1);
  bloom.addColorStop(0, "rgba(88,140,255,0.34)");
  bloom.addColorStop(1, "rgba(88,140,255,0)");
  g.fillStyle = bloom;
  g.fillRect(0, 0, w, h);

  g.strokeStyle = "rgba(255,255,255,0.045)";
  g.lineWidth = Math.max(1, w * 0.0012);
  const step = w / 22;
  for (let x = step; x < w; x += step) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  for (let y = step; y < h; y += step) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }

  g.textBaseline = "middle";

  /* ---- lockup ---- */
  const kdf = h * 0.100;
  const markX = w * 0.075, markY = h * 0.085;

  set(kdf, 800, -kdf * 0.04);
  const markW = g.measureText("KDF").width;

  // The hatch is knocked out on its own layer, so it can only ever appear
  // inside the letterforms — drawing it straight onto the poster would streak
  // across the background.
  const pad = kdf * 0.9;
  const m = document.createElement("canvas");
  m.width = Math.ceil(markW + pad * 2);
  m.height = Math.ceil(kdf * 2);
  const mg = m.getContext("2d");
  mg.font = `800 ${kdf}px ${FONT}`;
  mg.letterSpacing = `${-kdf * 0.04}px`;
  mg.textBaseline = "middle";
  mg.fillStyle = "#ffffff";
  mg.fillText("KDF", pad, m.height / 2);
  mg.globalCompositeOperation = "destination-out";
  mg.strokeStyle = "#000";
  mg.lineWidth = Math.max(1.1, kdf * 0.032);
  for (let i = -6; i < 34; i++) {
    const x0 = i * kdf * 0.155;
    mg.beginPath();
    mg.moveTo(x0, m.height);
    mg.lineTo(x0 + kdf * 0.46, 0);
    mg.stroke();
  }
  g.drawImage(m, markX - pad, markY - m.height / 2);

  const nameX = markX + markW + w * 0.038;
  const nameSize = h * 0.047;
  set(nameSize, 800, nameSize * 0.01);
  g.textAlign = "left";
  g.fillStyle = "#ffffff";
  ["KEDAH", "DIGITAL", "FESTIVAL"].forEach((line, i) => {
    g.fillText(line, nameX, markY - nameSize * 1.06 + i * nameSize * 1.06);
  });

  /* ---- tagline ---- */
  g.textAlign = "center";
  const tag = h * 0.025;
  set(tag, 700, tag * 0.10);
  g.fillStyle = "rgba(255,255,255,0.95)";
  g.fillText("Explore  •  Create  •  Innovate", w / 2, h * 0.170);

  /* ---- detail pills ---- */
  const pill = h * 0.0185;
  const items = ["30 September 2026", "Dewan Perdana, UiTM Kedah", "9am–5pm"];
  const padX = w * 0.024, gapX = w * 0.015, pillH = h * 0.036, py = h * 0.212;
  set(pill, 600);
  const widths = items.map((t) => g.measureText(t).width + padX * 2);
  let px = (w - (widths.reduce((a, b) => a + b, 0) + gapX * 2)) / 2;
  items.forEach((t, i) => {
    roundRect(g, px, py, widths[i], pillH, pillH / 2);
    g.fillStyle = "rgba(255,255,255,0.10)"; g.fill();
    g.strokeStyle = "rgba(255,255,255,0.30)";
    g.lineWidth = Math.max(1, w * 0.0014); g.stroke();
    set(pill, 600);
    g.fillStyle = "#ffffff";
    g.fillText(t, px + widths[i] / 2, py + pillH / 2);
    px += widths[i] + gapX;
  });

  /* ---- headline ---- */
  const head = h * 0.058;
  const lines = ["Let’s Explore the Future", "Together!"];
  g.fillStyle = "#ffffff";
  g.shadowColor = "rgba(0,0,0,0.45)";
  g.shadowBlur = head * 0.45;
  lines.forEach((line, i) => {
    fit(line, w * 0.88, head, 800, -head * 0.02, "italic");
    g.fillText(line, w / 2, h * 0.312 + i * head * 1.10);
  });
  g.shadowBlur = 0;

  const sub = h * 0.024;
  fit("Explore what’s waiting for you at KDF 2026", w * 0.84, sub, 600, 0, "italic");
  g.fillStyle = "rgba(255,255,255,0.88)";
  g.fillText("Explore what’s waiting for you at KDF 2026", w / 2, h * 0.445);

  /* ---- imagery band ---- */
  const bandY = h * 0.478, bandH = h * 0.372, bandX = w * 0.055, bandW = w * 0.89;
  g.save();
  roundRect(g, bandX, bandY, bandW, bandH, w * 0.02);
  g.clip();
  const band = g.createLinearGradient(bandX, bandY, bandX + bandW, bandY + bandH);
  band.addColorStop(0,   "#24408f");
  band.addColorStop(0.5, "#1a2b63");
  band.addColorStop(1,   "#2b1c5e");
  g.fillStyle = band;
  g.fillRect(bandX, bandY, bandW, bandH);

  [[0.24, 0.26, "rgba(94,224,255,0.30)"], [0.64, 0.62, "rgba(150,110,255,0.32)"],
   [0.86, 0.28, "rgba(0,229,192,0.24)"],  [0.40, 0.82, "rgba(88,140,255,0.28)"]]
    .forEach(([fx, fy, col]) => {
      const r = bandW * 0.42;
      const cx = bandX + bandW * fx, cy = bandY + bandH * fy;
      const rg = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      rg.addColorStop(0, col); rg.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = rg;
      g.fillRect(bandX, bandY, bandW, bandH);
    });

  // Isometric lattice, echoing the built mark rather than faking photography
  g.strokeStyle = "rgba(255,255,255,0.10)";
  g.lineWidth = Math.max(1, w * 0.0016);
  const iso = bandW * 0.075;
  for (let i = -8; i < 26; i++) {
    g.beginPath();
    g.moveTo(bandX + i * iso, bandY + bandH);
    g.lineTo(bandX + i * iso + bandH * 0.58, bandY);
    g.stroke();
    g.beginPath();
    g.moveTo(bandX + i * iso, bandY);
    g.lineTo(bandX + i * iso + bandH * 0.58, bandY + bandH);
    g.stroke();
  }
  g.restore();

  g.strokeStyle = "rgba(255,255,255,0.12)";
  g.lineWidth = Math.max(1, w * 0.002);
  roundRect(g, bandX, bandY, bandW, bandH, w * 0.02);
  g.stroke();

  // "Free entrance" roundel
  const rr = bandW * 0.115, rx = bandX + bandW * 0.80, ry = bandY + bandH * 0.74;
  g.beginPath(); g.arc(rx, ry, rr, 0, Math.PI * 2);
  g.fillStyle = "rgba(255,255,255,0.96)"; g.fill();
  const rt = rr * 0.26;
  g.fillStyle = "#16255a";
  fit("FREE",      rr * 1.5, rt,        800, rt * 0.06);
  g.fillText("FREE", rx, ry - rt * 0.85);
  fit("ENTRANCE",  rr * 1.6, rt,        800, rt * 0.06);
  g.fillText("ENTRANCE", rx, ry + rt * 0.25);
  g.fillStyle = "#5b6f9e";
  fit("ALL WELCOME", rr * 1.6, rt * 0.72, 700, rt * 0.05);
  g.fillText("ALL WELCOME", rx, ry + rt * 1.45);

  /* ---- contact ---- */
  const con = h * 0.023;
  fit("For inquiries, contact joyi@pscpen.com", w * 0.8, con, 600, 0, "italic");
  g.textAlign = "left";
  g.fillStyle = "rgba(255,255,255,0.92)";
  g.fillText("For inquiries, contact joyi@pscpen.com", w * 0.075, h * 0.888);

  /* ---- partner strip ---- */
  const stripY = h * 0.922, stripH = h - stripY;
  g.fillStyle = "#f2f4f9";
  g.fillRect(0, stripY, w, stripH);
  g.textAlign = "center";

  const cols = [
    ["Powered by",          "STELLANTIS"],
    ["Organised by",        "PENANG SCIENCE CLUSTER"],
    ["In collaboration with", "KPM  ·  MCMC"],
    ["Venue partner",       "UiTM KEDAH"],
  ];
  const colW = w / cols.length, inner = colW * 0.86;
  cols.forEach(([caption, name], i) => {
    const cx = colW * (i + 0.5);
    g.fillStyle = "#8a93a8";
    fit(caption, inner, stripH * 0.20, 600, stripH * 0.014);
    g.fillText(caption, cx, stripY + stripH * 0.32);
    g.fillStyle = "#1b2340";
    fit(name, inner, stripH * 0.30, 800, stripH * 0.004);
    g.fillText(name, cx, stripY + stripH * 0.66);
  });

  g.letterSpacing = "0px";
  g.textAlign = "left";
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/* --------------------------------------------------------------------------
   Jigsaw geometry
   Edge signs are stored per shared edge so neighbouring tabs always interlock.
   -------------------------------------------------------------------------- */
let edgesH = [], edgesV = [];

function rollEdges(cols, rows) {
  edgesH = []; edgesV = [];
  for (let r = 0; r <= rows; r++) {
    edgesH[r] = [];
    for (let c = 0; c < cols; c++) {
      edgesH[r][c] = (r === 0 || r === rows) ? 0 : (Math.random() < 0.5 ? -1 : 1);
    }
  }
  for (let r = 0; r < rows; r++) {
    edgesV[r] = [];
    for (let c = 0; c <= cols; c++) {
      edgesV[r][c] = (c === 0 || c === cols) ? 0 : (Math.random() < 0.5 ? -1 : 1);
    }
  }
}

/** Trace one puzzle edge from a→b. `sign` 0 = flat, ±1 = knob direction. */
function edge(g, ax, ay, bx, by, sign) {
  if (!sign) { g.lineTo(bx, by); return; }
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len;      // along the edge
  const nx = -uy,     ny = ux;             // perpendicular
  const d = len * CONFIG.puzzle.tabDepth * sign;
  const P = (u, v) => [ax + ux * len * u + nx * d * v, ay + uy * len * u + ny * d * v];

  const p0 = P(0.42, 0);
  g.lineTo(p0[0], p0[1]);
  const a1 = P(0.30, 0.10), a2 = P(0.28, 0.66), a3 = P(0.50, 0.66);
  g.bezierCurveTo(a1[0], a1[1], a2[0], a2[1], a3[0], a3[1]);
  const b1 = P(0.72, 0.66), b2 = P(0.70, 0.10), b3 = P(0.58, 0);
  g.bezierCurveTo(b1[0], b1[1], b2[0], b2[1], b3[0], b3[1]);
  g.lineTo(bx, by);
}

/**
 * Outlines are rebuilt only when the layout changes. Previously every piece
 * re-traced its bezier tabs three times a frame (slot, clip, rim) — pure waste,
 * since the shape never changes between resizes.
 */
function cachePiecePaths() {
  for (const p of pieces) {
    const path = new Path2D();
    piecePath(path, p, true);
    p.path = path;
  }
}

/** Build the outline of piece (c,r) at its home position inside the logo box. */
function piecePath(g, p, isPath2D = false) {
  const { x, y, w, h } = { x: box.x + p.col * box.w / CONFIG.puzzle.cols,
                           y: box.y + p.row * box.h / CONFIG.puzzle.rows,
                           w: box.w / CONFIG.puzzle.cols,
                           h: box.h / CONFIG.puzzle.rows };
  const { col: c, row: r } = p;
  if (!isPath2D) g.beginPath();
  g.moveTo(x, y);
  edge(g, x, y,         x + w, y,      edgesH[r][c]);           // top    L→R
  edge(g, x + w, y,     x + w, y + h, -edgesV[r][c + 1]);       // right  T→B
  edge(g, x + w, y + h, x, y + h,     -edgesH[r + 1][c]);       // bottom R→L
  edge(g, x, y + h,     x, y,          edgesV[r][c]);           // left   B→T
  g.closePath();
}

/* --------------------------------------------------------------------------
   Neon circuit backdrop

   Traces are generated once per resize and baked into an offscreen canvas, so
   each frame costs a single blit. Only the travelling lights are drawn live.
   -------------------------------------------------------------------------- */
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

function makeTrace(x, y, W, H, cell) {
  const pts = [[x, y]];
  let d = (Math.random() * 8) | 0;
  const steps = 4 + ((Math.random() * 9) | 0);
  for (let i = 0; i < steps; i++) {
    // Circuit traces turn in 45 degree increments, never at arbitrary angles.
    d = (d + [-1, 0, 0, 0, 1][(Math.random() * 5) | 0] + 8) % 8;
    const len = cell * (1 + ((Math.random() * 3) | 0));
    const nx = x + DIRS[d][0] * len;
    const ny = y + DIRS[d][1] * len;
    if (nx < -cell || nx > W + cell || ny < -cell || ny > H + cell) break;
    pts.push([nx, ny]);
    x = nx; y = ny;
  }
  return pts;
}

/** Cumulative lengths, so a pulse can be positioned by distance along a trace. */
function measureTrace(pts) {
  const acc = [0];
  for (let i = 1; i < pts.length; i++) {
    acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return acc;
}

function pointAt(trace, dist) {
  const { pts, acc } = trace;
  const total = acc[acc.length - 1];
  const d = clamp(dist, 0, total);
  let i = 1;
  while (i < acc.length - 1 && acc[i] < d) i++;
  const seg = acc[i] - acc[i - 1] || 1;
  const t = (d - acc[i - 1]) / seg;
  return [lerp(pts[i - 1][0], pts[i][0], t), lerp(pts[i - 1][1], pts[i][1], t)];
}

function buildCircuit(W, H) {
  const cell = CONFIG.backdrop.cell;
  // Tuned to roughly 120 runs on a 1920x1080 stage. The floor keeps a small
  // window from looking bare; the cap keeps a 4K build from baking forever.
  const count = clamp(
    Math.round((W * H) / (cell * cell * 5) * CONFIG.backdrop.density),
    22, 420);

  traces = [];
  for (let i = 0; i < count; i++) {
    const pts = makeTrace(
      Math.round(Math.random() * W / cell) * cell,
      Math.round(Math.random() * H / cell) * cell,
      W, H, cell);
    if (pts.length > 2) traces.push({ pts, acc: measureTrace(pts) });
  }

  const c = document.createElement("canvas");
  c.width = Math.round(W * dpr);
  c.height = Math.round(H * dpr);
  const g = c.getContext("2d");
  g.scale(dpr, dpr);
  g.lineCap = "round";
  g.lineJoin = "round";

  // Colour wash, baked once. This used to be three large CSS elements under a
  // 90px blur, animating forever — which pins the GPU compositor even when the
  // page is idle. Drawing it into the static layer costs nothing per frame.
  for (const [fx, fy, col, rs] of [
    [0.18, 0.12, "rgba(79,139,255,0.34)", 0.95],
    [0.86, 0.26, "rgba(123,92,255,0.30)", 0.85],
    [0.50, 0.94, "rgba(0,229,192,0.18)", 0.80],
  ]) {
    const r = Math.max(W, H) * rs;
    const rg = g.createRadialGradient(W * fx, H * fy, 0, W * fx, H * fy, r);
    rg.addColorStop(0, col);
    rg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = rg;
    g.fillRect(0, 0, W, H);
  }

  // Wide soft underglow, then a tight bright core — how neon actually reads.
  for (const pass of [
    { w: 7.0, style: "rgba(50,110,230,0.055)", blur: 14 },
    { w: 1.4, style: "rgba(125,195,255,0.17)", blur: 0 },
  ]) {
    g.strokeStyle = pass.style;
    g.lineWidth = pass.w;
    g.shadowColor = pass.blur ? "rgba(60,130,255,0.55)" : "transparent";
    g.shadowBlur = pass.blur;
    for (const { pts } of traces) {
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.stroke();
    }
  }
  g.shadowBlur = 0;

  // Vias at the ends of each run
  for (const { pts } of traces) {
    for (const [px, py] of [pts[0], pts[pts.length - 1]]) {
      g.beginPath(); g.arc(px, py, 3.2, 0, Math.PI * 2);
      g.fillStyle = "rgba(8,16,38,0.92)"; g.fill();
      g.lineWidth = 1.2;
      g.strokeStyle = "rgba(0,229,192,0.22)"; g.stroke();
    }
  }

  // Paint it straight onto the persistent backdrop layer and keep the source
  // only so the traces can be re-blitted if the size changes.
  circuit = c;
  bgCanvas.width  = c.width;
  bgCanvas.height = c.height;
  bgCanvas.style.width  = W + "px";
  bgCanvas.style.height = H + "px";
  bgCtx.setTransform(1, 0, 0, 1, 0, 0);
  bgCtx.clearRect(0, 0, c.width, c.height);
  bgCtx.drawImage(c, 0, 0);

  if (!glowSprite) makeGlowSprite();
  pulses = Array.from({ length: CONFIG.backdrop.pulses }, () => spawnPulse());
}

/** One radial-gradient sprite, tinted at draw time — far cheaper than setting
 *  shadowBlur on every dot, every frame. */
let glowSprite = null;
function makeGlowSprite() {
  const s = document.createElement("canvas");
  s.width = s.height = 64;
  const sg = s.getContext("2d");
  const rg = sg.createRadialGradient(32, 32, 0, 32, 32, 32);
  rg.addColorStop(0,   "rgba(255,255,255,1)");
  rg.addColorStop(0.35, "rgba(255,255,255,0.45)");
  rg.addColorStop(1,   "rgba(255,255,255,0)");
  sg.fillStyle = rg;
  sg.fillRect(0, 0, 64, 64);
  glowSprite = s;
}

function spawnPulse() {
  const trace = traces[(Math.random() * traces.length) | 0];
  return {
    trace,
    d: 0,
    speed: 0.06 + Math.random() * 0.14,
    life: trace ? trace.acc[trace.acc.length - 1] : 0,
    hue: Math.random() < 0.35 ? "0,229,192" : "120,195,255",
  };
}

function drawBackdrop(dt) {
  if (!CONFIG.backdrop.enabled || !circuit) return;
  // No blit here — the traces already live on #backdrop and never move. Only
  // the travelling lights are redrawn, and they are a handful of sprites.
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < pulses.length; i++) {
    const p = pulses[i];
    if (!p.trace) { pulses[i] = spawnPulse(); continue; }
    p.d += p.speed * dt;
    if (p.d > p.life) { pulses[i] = spawnPulse(); continue; }

    // Short comet tail rather than a bare dot, so movement is legible
    const tail = 42;
    for (let s = 0; s < 4; s++) {
      const [x, y] = pointAt(p.trace, p.d - (s * tail) / 4);
      const a = (1 - s / 4) * 0.58;
      const r = 13 * (1 - s / 7);
      ctx.globalAlpha = a;
      ctx.drawImage(glowSprite, x - r, y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

/* --------------------------------------------------------------------------
   Layout
   -------------------------------------------------------------------------- */
/**
 * Logo box size.
 *
 * The board fills as much of the viewport as it can. Pieces are placed right
 * against its edges and auto-snap handles the short drag, so no wide corridor
 * is reserved. The board's aspect ratio adopts the artwork's own ratio.
 */
function solveBox(W, H) {
  const A = boardAspect;                       // width / height of the artwork
  const usableH = H - CONFIG.safe.top - CONFIG.safe.bottom;
  // Fill as much of the viewport as reasonable. Pieces sit right against
  // the board edges (overlapping the panel slightly), so no wide corridor
  // is reserved — the auto-snap handles the short drag.
  const w = Math.min(W * 0.60, A * usableH * 0.92);
  return { w: Math.max(w, 1), h: Math.max(w / A, 1) };
}

const flankGap = (W) => Math.min(W * 0.006, 10);

function layout() {
  // 1.5 rather than 2: on a Retina panel full DPR nearly doubles every fill,
  // and the difference is invisible at viewing distance on a hall screen.
  dpr = Math.min(window.devicePixelRatio || 1, CONFIG.maxPixelRatio);
  const { W, H } = viewport();
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const { w, h } = solveBox(W, H);
  box = { w, h, x: (W - w) / 2, y: (H - h) / 2 };
  const resized = view.W !== W || view.H !== H;
  view = { W, H };   // pinned, so piece layout can never use a different size

  // Regenerating hundreds of traces into a full-viewport canvas is the single
  // most expensive thing here. Only do it when the size genuinely changed.
  if (resized || !circuit) buildCircuit(W, H);

  logo = buildLogo(Math.round(box.w * dpr), Math.round(box.h * dpr));
  pieces.forEach(refreshTarget);
  cachePiecePaths();
}

function refreshTarget(p) {
  p.tx = box.x + p.col * box.w / CONFIG.puzzle.cols;
  p.ty = box.y + p.row * box.h / CONFIG.puzzle.rows;
  if (p.placed) { p.x = p.tx; p.y = p.ty; }
}

/* --------------------------------------------------------------------------
   Puzzle setup
   -------------------------------------------------------------------------- */
function buildPuzzle() {
  const { cols, rows, tabDepth } = CONFIG.puzzle;
  rollEdges(cols, rows);
  pieces = [];

  // Deliberately the snapshot layout() solved against, not a fresh reading. A
  // resize landing between the two calls would otherwise leave the board and
  // the pieces sized to different screens.
  const { W, H } = view;
  const pw = box.w / cols, ph = box.h / rows;
  const overX = pw * tabDepth, overY = ph * tabDepth;
  // Give each strip a stable, unmistakable starting lane: left strip on the
  // left, middle strip above the board, and right strip on the right. This
  // mirrors the completed poster from left to right, so a presenter can see
  // where every fragment belongs before they pick it up.
  const slotGap = Math.min(W * 0.006, 10);

  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = {
        col: c, row: r, index: i,
        tx: 0, ty: 0, x: 0, y: 0,
        placed: false, held: null,
        scale: 1, rot: 0, restRot: 0, glow: 0, bob: Math.random() * Math.PI * 2,
      };
      refreshTarget(p);

      // The three lanes intentionally correspond to the source order. The
      // centre piece begins high enough to frame the board without covering
      // any other fragment; its lower portion remains easy to grab.
      const lane = c / Math.max(cols - 1, 1);
      if (lane < 0.34) {
        p.x = box.x - pw - slotGap;
        p.y = box.y + (box.h - ph) / 2;
      } else if (lane > 0.66) {
        p.x = box.x + box.w + slotGap;
        p.y = box.y + (box.h - ph) / 2 + ph * 0.16;
      } else {
        p.x = box.x + (box.w - pw) / 2;
        p.y = -ph * 0.15;
      }

      // Keep the lanes usable at every screen size while preserving their
      // relative arrangement. The top lane may tuck just above the viewport,
      // as in the stage composition, but never far enough to lose its handle.
      p.x = clamp(p.x, overX, W - overX - pw);
      p.y = clamp(p.y, -ph * 0.18, Math.max(-ph * 0.18, H - ph - overY));

      // A few degrees of rest tilt reads as "loose fragment"; it eases to
      // zero the moment a hand takes hold.
      p.restRot = ((i % 2 ? 1 : -1) * (3 + (i * 2.7) % 4)) * Math.PI / 180;
      p.rot = p.restRot;

      pieces.push(p);
      i++;
    }
  }

  cachePiecePaths();
  ui.progress.innerHTML = pieces.map(() => "<i></i>").join("");
  lastPlacedAt = performance.now();
}

function updateProgress() {
  const done = pieces.filter((p) => p.placed).length;
  [...ui.progress.children].forEach((el, i) => el.classList.toggle("on", i < done));
  return done;
}

/* --------------------------------------------------------------------------
   Camera + MediaPipe
   -------------------------------------------------------------------------- */
/**
 * Ask for the camera and download the hand model while the landing page is up.
 *
 * Both used to happen after Activate, which meant the browser's permission
 * prompt appeared over a live stage and the ~8MB model downloaded while the
 * audience watched a blank screen. Doing it here makes Activate instant.
 */
let trackingReady = null;

async function prepareTracking() {
  if (trackingReady) return trackingReady;
  trackingReady = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: CONFIG.camera.width, height: CONFIG.camera.height, facingMode: "user" },
    });
    video.srcObject = stream;
    await video.play();
    await buildLandmarker();
  })();

  try {
    await trackingReady;
  } catch (err) {
    console.error(err);
    trackingReady = null;              // allow a later retry
  }
  return trackingReady;
}

/** Release the camera. Nothing needs it once the reveal is finished. */
function stopTracking() {
  const stream = video.srcObject;
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  }
  landmarker = null;
  trackingReady = null;
  hands = [];
}

/* --------------------------------------------------------------------------
   Hand tracking assets

   Vendored into the repo rather than pulled from a CDN. The show runs on one
   venue machine and must come up with the network unplugged — a slow or dead
   uplink used to mean no gesture tracking at all, which is the whole piece.
   Update these together with vendor/tasks-vision if the version ever moves.
   -------------------------------------------------------------------------- */
const TRACKING_WASM = "./vendor/tasks-vision/wasm";
const TRACKING_MODEL = "./vendor/tasks-vision/hand_landmarker.task";

async function buildLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(TRACKING_WASM);
  const opts = (delegate) => ({
    baseOptions: {
      modelAssetPath: TRACKING_MODEL,
      delegate,
    },
    runningMode: "VIDEO",
    numHands: CONFIG.hands,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.55,
    minTrackingConfidence: 0.55,
  });
  try {
    landmarker = await HandLandmarker.createFromOptions(fileset, opts("GPU"));
  } catch {
    // Weak WebGL should degrade to CPU inference, not kill tracking outright.
    landmarker = await HandLandmarker.createFromOptions(fileset, opts("CPU"));
  }
}

/**
 * Grip openness: mean distance from each fingertip to the wrist, normalised
 * by hand span (wrist → middle MCP). Scale-invariant, so it works whether the
 * VIP is at 1m or 3m from the camera.
 */
function openness(lm) {
  const wrist = lm[0];
  const span = Math.hypot(lm[9].x - wrist.x, lm[9].y - wrist.y) || 1e-6;
  let total = 0;
  for (const tip of [8, 12, 16, 20]) {
    total += Math.hypot(lm[tip].x - wrist.x, lm[tip].y - wrist.y) / span;
  }
  return total / 4;
}

/** Palm centroid — far steadier than a fingertip, and visible when fisted. */
function palmCenter(lm) {
  let x = 0, y = 0;
  for (const i of [0, 5, 9, 13, 17]) { x += lm[i].x; y += lm[i].y; }
  return { x: x / 5, y: y / 5 };
}

let handSeq = 0;

function makeHand(now) {
  return {
    id: ++handSeq,
    x: 0, y: 0, open: 2,
    grabbing: false, closeFrames: 0, openFrames: 0,
    held: null, offX: 0, offY: 0, ring: 1,
    pts: Array.from({ length: 21 }, () => ({ x: 0, y: 0 })),
    cursorF: new Vec2Filter(CONFIG.filter.cursor),
    lmF: Array.from({ length: 21 }, () => new Vec2Filter(CONFIG.filter.landmark)),
    gripF: new OneEuro(CONFIG.filter.grip),
    handed: null,
    coasting: 0,
    born: now,
  };
}

/**
 * Bind this frame's detections to the hands already being tracked, so each
 * hand keeps its own filter state. MediaPipe does not guarantee a stable
 * ordering, and letting two hands swap array slots would tear both filters.
 * Match on handedness first, then on proximity.
 */
function bindDetections(found, handedness, vp) {
  const free = hands.slice();
  const pairs = [];

  found.forEach((lm, i) => {
    const c = palmCenter(lm);
    const raw = { x: (1 - c.x) * vp.W, y: c.y * vp.H };
    const label = handedness && handedness[i] && handedness[i][0]
      ? handedness[i][0].categoryName : null;

    let best = -1, bestScore = Infinity;
    free.forEach((h, j) => {
      if (!h) return;
      const d = dist(h.x, h.y, raw.x, raw.y);
      if (d > CONFIG.track.matchRadius) return;
      // Same handedness is worth more than being slightly closer.
      const score = d - (label && h.handed === label ? 220 : 0);
      if (score < bestScore) { bestScore = score; best = j; }
    });

    let hand;
    if (best >= 0) { hand = free[best]; free[best] = null; }
    else { hand = null; }
    pairs.push({ lm, raw, label, hand });
  });

  return { pairs, orphans: free.filter(Boolean) };
}

function readHands(now) {
  if (!landmarker || video.readyState < 2) return;
  // Inference is the heaviest work on the page. Capping its rate hands frames
  // back to the renderer on a weak CPU, and the One Euro filters already smooth
  // positions between detections. The small allowance absorbs rAF jitter, which
  // would otherwise skip a frame that arrived a millisecond early.
  if (now - lastDetectAt < 1000 / CONFIG.trackFps - 4) return;
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  lastDetectAt = now;

  const result = landmarker.detectForVideo(video, now);
  const found = result.landmarks || [];
  if (found.length) lastHandSeenAt = now;

  const vp = viewport();
  const { pairs, orphans } = bindDetections(found, result.handednesses, vp);
  const next = [];

  for (const { lm, raw, label, hand } of pairs) {
    const h = hand || makeHand(now);
    h.handed = label || h.handed;
    h.coasting = 0;

    const c = h.cursorF.filter(raw.x, raw.y, now);
    h.x = c.x; h.y = c.y;

    // Smooth every landmark, not just the cursor — the skeleton overlay is
    // what the audience actually sees, and raw landmarks boil visibly.
    for (let i = 0; i < 21; i++) {
      const p = h.lmF[i].filter((1 - lm[i].x) * vp.W, lm[i].y * vp.H, now);
      h.pts[i].x = p.x; h.pts[i].y = p.y;
    }

    h.open = h.gripF.filter(openness(lm), now);
    updateGrip(h);
    next.push(h);
  }

  // A hand that vanished this frame coasts on its last known pose rather than
  // dropping instantly. Brief detection gaps are constant and dropping the
  // piece on every one of them is unusable on stage.
  for (const h of orphans) {
    h.coasting++;
    if (h.coasting <= CONFIG.track.coastFrames) { next.push(h); continue; }
    if (h.grabbing) { h.grabbing = false; onRelease(h); }
  }

  hands = next;
}

/** Hysteresis + frame debounce, so a grab never flickers mid-ceremony. */
function updateGrip(h) {
  if (h.open < CONFIG.grip.closeAt) { h.closeFrames++; h.openFrames = 0; }
  else if (h.open > CONFIG.grip.openAt) { h.openFrames++; h.closeFrames = 0; }
  else { h.closeFrames = 0; h.openFrames = 0; }

  if (!h.grabbing && h.closeFrames >= CONFIG.grip.framesToGrab) {
    h.grabbing = true; onGrab(h);
  }
  if (h.grabbing && h.openFrames >= CONFIG.grip.framesToDrop) {
    h.grabbing = false; onRelease(h);
  }
}

/* --------------------------------------------------------------------------
   Grab / release
   -------------------------------------------------------------------------- */
function onGrab(h) {
  if (state !== STATE.PLAY) return;
  let best = null, bestD = CONFIG.reach.grab;
  for (const p of pieces) {
    if (p.placed || p.held) continue;
    const cx = p.x + box.w / CONFIG.puzzle.cols / 2;
    const cy = p.y + box.h / CONFIG.puzzle.rows / 2;
    const d = dist(h.x, h.y, cx, cy);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (!best) { sfx.drop(); return; }

  best.held = h;
  h.held = best;
  h.offX = best.x - h.x;
  h.offY = best.y - h.y;
  sfx.grab();
}

function onRelease(h) {
  const p = h.held;
  if (!p) return;
  h.held = null;
  p.held = null;

  if (dist(p.x, p.y, p.tx, p.ty) < CONFIG.reach.snap) {
    place(p);
  } else {
    sfx.drop();
  }
}

function place(p) {
  p.placed = true;
  p.held = null;
  p.glow = 1;
  lastPlacedAt = performance.now();
  sfx.snap();
  burst(p.x + box.w / CONFIG.puzzle.cols / 2, p.y + box.h / CONFIG.puzzle.rows / 2, 26);

  const done = updateProgress();
  if (done === pieces.length) setTimeout(finish, 700);
}

function finish() {
  if (state === STATE.DONE || state === STATE.MONTAGE) return;
  state = STATE.DONE;
  setPill("Complete", "live");
  ui.footer.classList.remove("in");
  stopTracking();          // puzzle is over; give the camera back
  sfx.finish();

  finale.running = true;
  finale.t = 0;
  finale.fired.clear();
  finale.waves.length = 0;

  const vp = viewport();
  burst(box.x + box.w / 2, box.y + box.h / 2, CONFIG.confetti.burst);
  for (let i = 0; i < CONFIG.confetti.rain; i++) {
    burst(Math.random() * vp.W, -20 - Math.random() * 260, 1, true);
  }

  // The film has held at metadata so it never competed with tracking for
  // memory or bandwidth. Buffer it now — the dock cue is a few seconds away.
  ui.montageVideo.preload = "auto";
}

/* --------------------------------------------------------------------------
   Puzzle artwork

   Fixed asset. poster.jpg sits beside index.html and is the puzzle — there is
   nothing to choose or upload on the night. Replace the file to change it.
   -------------------------------------------------------------------------- */
const POSTER_FILES = ["poster.jpg", "poster.png", "poster.jpeg", "poster.webp"];

const imageFrom = (url) => new Promise((ok, no) => {
  const img = new Image();
  img.onload = () => ok(img);
  img.onerror = () => no(new Error("could not decode " + url));
  img.src = url;
});

/**
 * The board adopts the artwork's own aspect ratio, so a portrait poster stays
 * portrait rather than being squashed or cropped.
 */
function applyPoster(img) {
  poster = img;
  boardAspect = img.width / img.height;
  layout();
  if (state !== STATE.IDLE) buildPuzzle();
}

async function loadArtwork() {
  for (const name of POSTER_FILES) {
    try {
      const res = await fetch(name, { method: "HEAD" });
      if (!res.ok) continue;
      applyPoster(await imageFrom(name));
      return true;
    } catch { /* try the next extension */ }
  }
  console.warn(`No puzzle artwork found. Expected one of: ${POSTER_FILES.join(", ")}`);
  return false;
}
loadArtwork();

/* --------------------------------------------------------------------------
   Montage
   The hand-off after the reveal. Plays whatever montage-source.js resolved —
   the operator's file first, then anything shipped beside index.html. With no
   film at all the reveal still runs and ends on a clean blackout.
   -------------------------------------------------------------------------- */
function openMontage() {
  if (state === STATE.MONTAGE) return;
  state = STATE.MONTAGE;
  setPill("Montage", "live");
  document.body.classList.add("montage-in");
  ui.montage.hidden = false;
  void ui.montage.offsetHeight;
  ui.montage.classList.add("in");

  hands = [];   // stop drawing a frozen skeleton over the montage

  const v = ui.montageVideo;
  // No montage present: end cleanly on black rather than an empty stage.
  if (!v || !v.currentSrc || v.error) { blackout(); return; }

  ui.montage.classList.add("has-video");
  v.muted = false;   // a montage usually carries its own audio bed for the PA
  playMontage();
}

/**
 * Start or resume the montage.
 *
 * A rejected play() is never treated as fatal. Autoplay-with-sound gets
 * refused without a user gesture, and the browser will also pause background
 * or video-only media on its own. Falling back to the placeholder grid on any
 * of those would mean one momentary hiccup costs the montage for the rest of
 * the ceremony — so we retry, and only a genuine media error gives up.
 */
function playMontage() {
  const v = ui.montageVideo;
  if (!v || !v.currentSrc || v.error) return;
  v.play().catch(() => {
    if (!v.muted) { v.muted = true; v.play().catch(() => {}); }
  });
}

/* --------------------------------------------------------------------------
   Montage

   The film is not part of the deploy. It is usually still being cut while the
   room is filling, so the operator loads it from disk through the hidden panel
   (index.html?op=1) and it lives in IndexedDB on the show machine — see
   montage-source.js. A file shipped beside index.html still works as a
   safety net, and if neither exists the reveal ends on a clean blackout.
   -------------------------------------------------------------------------- */
let montageSrc = null;
let montageBackup = null;
let usingBackup = false;

async function loadMontageFile() {
  let sources;
  try {
    sources = await resolveSources();
  } catch (err) {
    console.warn("Could not resolve a montage source.", err);
    return;
  }

  montageBackup = sources.backup;

  if (!sources.primary) {
    if (sources.pending) {
      console.info("Published film is downloading; nothing else to play meanwhile.");
      awaitPublished(sources.pending);
      return;
    }
    console.warn("No montage loaded. Open index.html?op=1 to load one, or ship montage.mp4 beside index.html.");
    return;
  }

  montageSrc = sources.primary;
  ui.montageVideo.src = montageSrc.url;
  ui.montageVideo.load();
  console.info(`Montage ready: ${montageSrc.label} (${montageSrc.origin})`
    + (montageBackup ? ` — backup: ${montageBackup.label}` : " — no backup loaded"));
  awaitPublished(sources.pending);
}
loadMontageFile();

/**
 * Swap to the backup film.
 *
 * Returns false when there is nothing to swap to, which is the caller's cue to
 * end the show on black. A decode failure on the primary is exactly the case
 * the backup slot exists for, and it costs about a frame to switch.
 */
/**
 * Take a multi-part published film once it has finished downloading.
 *
 * It arrives minutes after the page loads, so it is swapped in only while the
 * screen is still safe to touch — never once the montage is on. Whatever was
 * playing the role of primary becomes the backup, so a published film that
 * will not decode still falls back to the copy on this machine.
 */
function awaitPublished(pending) {
  if (!pending) return;
  pending.then((published) => {
    if (!published) return;
    if (state === STATE.MONTAGE || state === STATE.BLACKOUT) return;
    if (montageSrc?.origin === "published") return;
    if (montageSrc) montageBackup = montageSrc;
    montageSrc = published;
    usingBackup = false;
    ui.montageVideo.src = published.url;
    ui.montageVideo.load();
    console.info(`Published film ready: ${published.label} — now the montage.`
      + (montageBackup ? ` Backup: ${montageBackup.label}.` : ""));
  }).catch((err) => {
    console.warn("Could not assemble the published film; keeping what is here.", err);
  });
}

function swapToBackup() {
  if (usingBackup || !montageBackup) return false;
  usingBackup = true;
  console.warn(`Primary montage failed. Falling back to ${montageBackup.label}.`);
  const v = ui.montageVideo;
  v.src = montageBackup.url;
  v.load();
  if (state === STATE.MONTAGE) {
    ui.montage.classList.add("has-video");
    playMontage();
  }
  return true;
}

/**
 * The montage plays once. When it finishes the screen goes to black and stays
 * there — the ceremony is over and nothing should loop behind the speakers.
 */
function blackout() {
  if (state === STATE.BLACKOUT) return;
  state = STATE.BLACKOUT;
  setPill("Ended", "idle");
  particles = [];
  ui.blackout.hidden = false;
  void ui.blackout.offsetHeight;
  ui.blackout.classList.add("in");
}

ui.montageVideo.addEventListener("ended", () => {
  if (state === STATE.MONTAGE) blackout();
});

/**
 * Report the film's real resolution against the screen it has to fill.
 *
 * Softness on the night is nearly always the source being upscaled, not
 * anything the page does — and that is invisible without the numbers side by
 * side. Letterboxed playback fits by whichever axis runs out first, so the
 * scale factor is the smaller of the two ratios.
 */
ui.montageVideo.addEventListener("loadedmetadata", () => {
  const v = ui.montageVideo;
  if (!v.videoWidth) return;
  const { W, H } = viewport();
  const scale = Math.min(W / v.videoWidth, H / v.videoHeight);
  const verdict = scale > 1.08
    ? `upscaled ${scale.toFixed(2)}x — it will look soft; re-export larger`
    : "at or above native — the source is not the limit";
  console.info(`Montage ${v.videoWidth}x${v.videoHeight} on a ${Math.round(W)}x${Math.round(H)} screen: ${verdict}`);
});

// A media error is the one failure the backup exists for. Only give up on the
// screen once there is genuinely nothing left to play.
ui.montageVideo.addEventListener("error", () => {
  if (swapToBackup()) return;
  ui.montage.classList.remove("has-video");
  if (state === STATE.MONTAGE) blackout();
});

// Resume the montage if anything paused it — but never fight a deliberate end.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state === STATE.MONTAGE) playMontage();
});

// Ask for the camera as soon as the page opens, so the permission prompt is
// dealt with long before anyone is standing on a stage.
prepareTracking();

// The operator panel is never part of the show. It is fetched only when the
// URL asks for it, so on the night none of it is even downloaded.
if (new URLSearchParams(location.search).has("op")) {
  import("./operator.js")
    .then((m) => m.mountOperator())
    .catch((err) => console.error("Operator panel failed to load.", err));
}

/* --------------------------------------------------------------------------
   Finale
   A fixed timeline, in milliseconds from the moment the last piece lands.
   Everything downstream reads `finale.t`, so the whole sequence can be
   retimed here without touching the drawing code.
   -------------------------------------------------------------------------- */
const CUE = {
  flash:     0,
  pop:      [0,    900],    // board punches up, then settles
  shocks:   [40, 300, 620], // expanding rings
  rays:     [120, 1500],    // radial light spins up behind the logo
  sweep:    [820, 1900],    // specular band travels across the finished logo
  cannons:  [180, 520],     // confetti from the bottom corners
  card:      1500,          // "reveal complete" card
  dock:     [4200, 5500],   // logo docks upward, montage takes the stage
};

const finale = { t: 0, running: false, scale: 1, dy: 0, waves: [], fired: new Set() };

function cueOnce(key, at, fn) {
  if (finale.t >= at && !finale.fired.has(key)) { finale.fired.add(key); fn(); }
}

function stepFinale(dt) {
  if (!finale.running) return;
  finale.t += dt;
  const t = finale.t;

  // Board: a quick overshoot on completion, then a dock upward for the montage.
  const pop  = span(t, CUE.pop[0], CUE.pop[1], easeOutBack);
  const dock = span(t, CUE.dock[0], CUE.dock[1], easeInOut);
  finale.scale = lerp(1 + 0.075 * (1 - Math.abs(pop - 1)), 0.34, dock);
  finale.dy = lerp(0, -viewport().H * 0.30, dock);

  CUE.shocks.forEach((at, i) =>
    cueOnce("shock" + i, at, () => finale.waves.push({ age: 0, seed: i })));

  cueOnce("cannonL", CUE.cannons[0], () => cannon(viewport().W * 0.06, viewport().H, -62));
  cueOnce("cannonR", CUE.cannons[1], () => cannon(viewport().W * 0.94, viewport().H, -118));
  cueOnce("boom", CUE.flash, () => sfx.boom());
  cueOnce("card", CUE.card, () => revealOverlay(ui.done));
  cueOnce("dock", CUE.dock[0], () => { sfx.riser(); openMontage(); });

  for (let i = finale.waves.length - 1; i >= 0; i--) {
    finale.waves[i].age += dt;
    if (finale.waves[i].age > 1500) finale.waves.splice(i, 1);
  }
}

function drawRays(cx, cy) {
  const a = span(finale.t, CUE.rays[0], CUE.rays[1]) * (1 - span(finale.t, CUE.dock[0], CUE.dock[1]));
  if (a < 0.01) return;
  const R = Math.max(box.w, box.h) * 2.1;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.translate(cx, cy);
  ctx.rotate(finale.t * 0.00013);
  for (let i = 0; i < 16; i++) {
    const g = ctx.createLinearGradient(0, 0, R, 0);
    g.addColorStop(0, `rgba(120,180,255,${0.16 * a})`);
    g.addColorStop(1, "rgba(120,180,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, -0.035, 0.035);
    ctx.closePath();
    ctx.fill();
    ctx.rotate((Math.PI * 2) / 16);
  }
  ctx.restore();
}

function drawShockwaves(cx, cy) {
  const reach = Math.max(viewport().W, viewport().H) * 0.75;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const w of finale.waves) {
    const k = w.age / 1500;
    const r = easeOutExpo(k) * reach;
    const a = (1 - k) * (1 - k);
    ctx.strokeStyle = `rgba(0,229,192,${a * 0.55})`;
    ctx.lineWidth = 1 + 9 * (1 - k);
    ctx.shadowColor = `rgba(0,229,192,${a})`;
    ctx.shadowBlur = glowPx(20 * a);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();

    ctx.strokeStyle = `rgba(180,205,255,${a * 0.3})`;
    ctx.lineWidth = 1 + 5 * (1 - k);
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.82, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

function drawFlash(cx, cy) {
  const a = 1 - span(finale.t, CUE.flash, CUE.flash + 620);
  if (a <= 0.01) return;
  const R = Math.max(viewport().W, viewport().H);
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  g.addColorStop(0, `rgba(226,244,255,${0.85 * a})`);
  g.addColorStop(0.35, `rgba(0,229,192,${0.28 * a})`);
  g.addColorStop(1, "rgba(0,229,192,0)");
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, viewport().W, viewport().H);
  ctx.restore();
}

/** Specular band travelling across the finished logo. */
function drawSweep() {
  const k = span(finale.t, CUE.sweep[0], CUE.sweep[1], easeInOut);
  if (k <= 0 || k >= 1) return;
  const w = box.w * 0.42;
  const x = box.x - w + (box.w + w * 2) * k;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  ctx.globalCompositeOperation = "lighter";
  ctx.translate(x, box.y);
  ctx.transform(1, 0, -0.35, 1, 0, 0);
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0,    "rgba(255,255,255,0)");
  g.addColorStop(0.5,  "rgba(255,255,255,0.30)");
  g.addColorStop(1,    "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, -box.h * 0.3, w, box.h * 1.6);
  ctx.restore();
}

/* --------------------------------------------------------------------------
   Particles
   -------------------------------------------------------------------------- */
const PALETTE = ["#4f8bff", "#7b5cff", "#00e5c0", "#ffffff", "#cdd9f5"];
function burst(x, y, n, confetti = false) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = confetti ? 0 : 1.5 + Math.random() * 5;
    particles.push({
      x, y,
      vx: Math.cos(a) * s + (confetti ? (Math.random() - 0.5) * 1.4 : 0),
      vy: Math.sin(a) * s + (confetti ? 1.5 + Math.random() * 3 : 0),
      life: 1,
      decay: confetti ? 0.004 + Math.random() * 0.004 : 0.02 + Math.random() * 0.02,
      size: confetti ? 3 + Math.random() * 6 : 1.5 + Math.random() * 3,
      spin: (Math.random() - 0.5) * 0.3,
      rot: Math.random() * Math.PI,
      color: PALETTE[(Math.random() * PALETTE.length) | 0],
      confetti,
    });
  }
}

/** Angled burst from a point — used for the corner confetti cannons. */
function cannon(x, y, angleDeg, n = 90) {
  const a0 = (angleDeg * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const a = a0 + (Math.random() - 0.5) * 0.62;
    const s = 13 + Math.random() * 17;
    particles.push({
      x, y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life: 1,
      decay: 0.0035 + Math.random() * 0.003,
      size: 4 + Math.random() * 7,
      spin: (Math.random() - 0.5) * 0.42,
      rot: Math.random() * Math.PI,
      color: PALETTE[(Math.random() * PALETTE.length) | 0],
      confetti: true,
    });
  }
}

function stepParticles() {
  // Hoisted deliberately: viewport() reads window.innerHeight, which is a
  // layout read. Asking for it once per particle per frame was thousands of
  // reads a second for a number that cannot change mid-frame.
  const { H } = viewport();
  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i];
    q.x += q.vx; q.y += q.vy;
    q.vy += q.confetti ? 0.035 : 0.09;
    q.vx *= 0.99;
    q.rot += q.spin;
    q.life -= q.decay;
    if (q.life <= 0 || q.y > H + 60) particles.splice(i, 1);
  }
}

function drawParticles() {
  for (const q of particles) {
    ctx.globalAlpha = clamp(q.life, 0, 1);
    ctx.fillStyle = q.color;
    if (q.confetti) {
      // Only the confetti is oriented. A round spark looks the same at every
      // angle, so it skips the save/translate/rotate/restore entirely.
      ctx.save();
      ctx.translate(q.x, q.y);
      ctx.rotate(q.rot);
      ctx.fillRect(-q.size / 2, -q.size / 4, q.size, q.size / 2);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(q.x, q.y, q.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/* --------------------------------------------------------------------------
   Simulation
   -------------------------------------------------------------------------- */
function simulate(now, dt) {
  const pw = box.w / CONFIG.puzzle.cols;
  const ph = box.h / CONFIG.puzzle.rows;

  for (const p of pieces) {
    if (p.placed) {
      p.x = ease(p.x, p.tx, 0.35, dt);
      p.y = ease(p.y, p.ty, 0.35, dt);
      p.scale = ease(p.scale, 1, 0.2, dt);
      p.rot = ease(p.rot, 0, 0.25, dt);
      p.glow = Math.max(0, p.glow - dt * 0.0012);
      continue;
    }

    if (p.held) {
      // Tracking reports a new hand position around twenty times a second
      // while this runs sixty times a second, so this easing is what the room
      // actually sees: it carries the piece smoothly between detections
      // instead of letting it step.
      p.x = ease(p.x, p.held.x + p.held.offX, 0.42, dt);
      p.y = ease(p.y, p.held.y + p.held.offY, 0.42, dt);
      p.scale = ease(p.scale, 1.07, 0.18, dt);
      p.rot = ease(p.rot, 0, 0.16, dt);       // squares up in the hand

      // Auto-snap: if half the piece is already over its target slot, snap it
      // into place without waiting for the hand to open. This is the single
      // biggest reduction in human error — the presenter only has to get the
      // piece roughly in the right area and it locks itself in.
      if (Math.abs(p.x - p.tx) < pw * 0.5 && Math.abs(p.y - p.ty) < ph * 0.5) {
        const h = p.held;
        h.held = null;
        place(p);
      }
    } else {
      p.bob += dt * 0.0014;
      p.y += Math.sin(p.bob) * 0.14 * (dt / 16.667);   // idle breathing
      p.scale = ease(p.scale, 1, 0.15, dt);
      p.rot = ease(p.rot, p.restRot + Math.sin(p.bob * 0.6) * 0.012, 0.06, dt);
    }

    // Highlight when a closed hand could pick this up
    const cx = p.x + pw / 2, cy = p.y + ph / 2;
    const near = hands.some((h) => dist(h.x, h.y, cx, cy) < CONFIG.reach.grab);
    p.glow = ease(p.glow, p.held ? 1 : (near ? 0.55 : 0), 0.12, dt);
  }
}

/* --------------------------------------------------------------------------
   Rendering
   -------------------------------------------------------------------------- */
/**
 * Backing panel for the board. Separates the artwork from the circuit pattern
 * behind it, and gives the empty slots something to read against.
 */
let haloCache = null;
function drawBoardPanel() {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const pad = Math.max(box.w, box.h) * 0.055;

  // Built once per layout rather than per frame.
  if (!haloCache || haloCache.w !== box.w || haloCache.x !== box.x || haloCache.y !== box.y) {
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(box.w, box.h));
    halo.addColorStop(0,    "rgba(40,90,210,0.34)");
    halo.addColorStop(0.55, "rgba(30,60,160,0.14)");
    halo.addColorStop(1,    "rgba(0,0,0,0)");
    haloCache = { grad: halo, w: box.w, x: box.x, y: box.y };
  }
  ctx.fillStyle = haloCache.grad;
  ctx.fillRect(cx - box.w * 1.6, cy - box.h * 1.6, box.w * 3.2, box.h * 3.2);

  roundRect(ctx, box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2, pad * 0.85);
  ctx.fillStyle = "rgba(6,11,26,0.62)";
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = "rgba(150,190,255,0.14)";
  ctx.stroke();
}

function drawSlots() {
  ctx.save();
  for (const p of pieces) {
    if (p.placed) continue;
    ctx.fillStyle = "rgba(255,255,255,0.012)";
    ctx.fill(p.path);
    const armed = p.held && dist(p.x, p.y, p.tx, p.ty) < CONFIG.reach.snap;
    ctx.strokeStyle = armed ? "rgba(0,229,192,0.85)" : "rgba(255,255,255,0.07)";
    ctx.lineWidth = armed ? 2.4 : 1.2;
    ctx.setLineDash(armed ? [] : [7, 9]);
    if (armed) { ctx.shadowColor = "rgba(0,229,192,0.7)"; ctx.shadowBlur = glowPx(22); }
    ctx.stroke(p.path);
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);
  }
  ctx.restore();
}

function drawPiece(p) {
  const pw = box.w / CONFIG.puzzle.cols;
  const ph = box.h / CONFIG.puzzle.rows;
  const cx = p.tx + pw / 2, cy = p.ty + ph / 2;

  ctx.save();
  // Move the piece from its home position to where it currently is, and scale
  // about its own centre. The path itself is always built in home coordinates,
  // which keeps the clipped artwork perfectly registered.
  ctx.translate(p.x - p.tx, p.y - p.ty);
  ctx.translate(cx, cy);
  ctx.rotate(p.rot);
  ctx.scale(p.scale, p.scale);
  ctx.translate(-cx, -cy);

  if (!p.placed) {
    ctx.shadowColor = "rgba(0,0,0,0.75)";
    ctx.shadowBlur = glowPx(20);
    ctx.shadowOffsetY = lite ? 0 : 14;   // no blur and no offset: no shadow pass at all
  }

  ctx.save();
  ctx.clip(p.path);
  ctx.drawImage(logo, box.x, box.y, box.w, box.h);
  ctx.restore();

  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

  // Rim light. Placed pieces let their seams fade out at the end so the
  // finished board reads as one logo rather than three tiles.
  const seam = p.placed ? (1 - fused) : 1;
  ctx.strokeStyle = `rgba(160,190,255,${0.14 * seam + p.glow * 0.6})`;
  ctx.lineWidth = (1.4 + p.glow * 1.6) * (p.placed ? seam : 1);
  if (p.glow > 0.02) { ctx.shadowColor = `rgba(0,229,192,${p.glow * 0.9})`; ctx.shadowBlur = glowPx(16 * p.glow); }
  ctx.stroke(p.path);
  ctx.shadowBlur = 0;
  ctx.restore();
}

const BONES = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],[0,17],
];

function drawHands() {
  for (const h of hands) {
    if (!h.pts || h.coasting > CONFIG.track.coastFrames) continue;
    const grabbing = h.grabbing;
    const tint = grabbing ? "0,229,192" : "160,190,255";
    // Fade the overlay out while coasting, so a genuine loss of tracking still
    // reads as one — it just doesn't snap.
    const solid = 1 - h.coasting / (CONFIG.track.coastFrames + 1);

    // Skeleton
    ctx.save();
    ctx.globalAlpha = (grabbing ? 0.85 : 0.4) * solid;
    ctx.strokeStyle = `rgba(${tint},0.75)`;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = `rgba(${tint},0.6)`;
    ctx.shadowBlur = glowPx(12);
    for (const [a, b] of BONES) {
      ctx.beginPath();
      ctx.moveTo(h.pts[a].x, h.pts[a].y);
      ctx.lineTo(h.pts[b].x, h.pts[b].y);
      ctx.stroke();
    }
    ctx.fillStyle = `rgba(${tint},0.9)`;
    for (let i = 0; i < 21; i++) {
      ctx.beginPath();
      ctx.arc(h.pts[i].x, h.pts[i].y, i % 4 === 0 ? 4 : 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Cursor ring — contracts on grab
    h.ring = lerp(h.ring, grabbing ? 0.55 : 1, 0.2);
    ctx.save();
    ctx.translate(h.x, h.y);
    ctx.strokeStyle = `rgba(${tint},${grabbing ? 0.95 : 0.45})`;
    ctx.lineWidth = grabbing ? 3 : 1.6;
    ctx.shadowColor = `rgba(${tint},0.8)`;
    ctx.shadowBlur = glowPx(grabbing ? 16 : 8);
    ctx.beginPath();
    ctx.arc(0, 0, 34 * h.ring, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${tint},0.95)`;
    ctx.fill();
    ctx.restore();
  }
}

function render(now, dt) {
  const vp = viewport();
  ctx.clearRect(0, 0, vp.W, vp.H);
  drawBackdrop(dt);
  if (state === STATE.IDLE || !logo) { drawParticles(); return; }

  // During calibration the presenter should see the tracking working, and
  // nothing else — the board is not revealed until the reveal begins.
  if (state === STATE.CALIBRATE) { drawHands(); drawParticles(); return; }

  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2 + finale.dy;

  if (finale.running) drawRays(cx, cy);

  // The whole board moves as one during the finale: pop, then dock upward.
  ctx.save();
  if (finale.running) {
    ctx.translate(cx, cy);
    ctx.scale(finale.scale, finale.scale);
    ctx.translate(-cx, -(box.y + box.h / 2));
  }
  drawBoardPanel();
  drawSlots();
  // Placed, then loose, then held — held last so it never ends up underneath
  // another piece. Ordered passes rather than three throwaway arrays a frame.
  for (const p of pieces) if (p.placed) drawPiece(p);
  for (const p of pieces) if (!p.placed && !p.held) drawPiece(p);
  for (const p of pieces) if (p.held) drawPiece(p);
  if (finale.running) drawSweep();
  ctx.restore();

  if (finale.running) {
    drawShockwaves(cx, cy);
    drawFlash(cx, cy);
  }
  drawHands();
  drawParticles();
}

/* --------------------------------------------------------------------------
   Loop
   -------------------------------------------------------------------------- */
let prev = 0;
let lastMontageCheck = 0;

/**
 * True once a montage with an actual video is on screen.
 *
 * Deliberately requires `has-video`: with no film the montage stage is
 * transparent and the canvases behind it are still what the room is looking
 * at, right up until the blackout covers them.
 */
/**
 * Switch to the lite profile on a live page.
 *
 * Only what can change safely mid-show does: canvases re-allocate at the lower
 * pixel ratio (layout() never moves a piece), glows stop, inference slows. The
 * camera stream stays as it was opened — renegotiating it on stage would blank
 * the tracker for a second in front of the room.
 */
function enterLite() {
  lite = true;
  applyLite();
  layout();
  if (circuit) buildCircuit(view.W, view.H);   // the backdrop only re-sizes itself on resize
  try {
    Promise.resolve(landmarker?.setOptions({ numHands: CONFIG.hands })).catch(() => {});
  } catch { /* older runtime without setOptions: keep tracking as it is */ }
}

function filmOwnsScreen() {
  return (state === STATE.MONTAGE || state === STATE.BLACKOUT)
    && ui.montage.classList.contains("has-video");
}
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(now - prev, 48);
  prev = now;

  if (state === STATE.CALIBRATE) {
    readHands(now);
    stepCalibration(dt);
  }
  if (state === STATE.PLAY || state === STATE.DONE) {
    readHands(now);
    simulate(now, dt);
  }
  if (state === STATE.DONE || state === STATE.MONTAGE) {
    fused = Math.min(1, fused + dt * 0.0016);
    stepFinale(dt);
  }
  // Once the film owns the screen, both canvases are completely covered by it
  // — backdrop and stage sit at z-index 0 and 2, the film at 4 over an opaque
  // black frame. Drawing them is work nobody can see, and it is work that
  // competes with video decode on precisely the machine least able to spare
  // it. Dropped frames look like a bad export. Hand the GPU to the film.
  if (!filmOwnsScreen()) {
    stepParticles();
    render(now, dt);
  }

  // Montage watchdog — if anything paused the video, put it back.
  if (state === STATE.MONTAGE && !ui.montageVideo.ended && now - lastMontageCheck > 1000) {
    lastMontageCheck = now;
    if (ui.montageVideo.paused) playMontage();
  }

  // Readouts
  fps.frames++;
  if (now - fps.mark > 500) {
    fps.value = Math.round((fps.frames * 1000) / (now - fps.mark));
    fps.frames = 0; fps.mark = now;
    ui.mFps.textContent = fps.value;

    // If the machine is genuinely struggling, shed the animated layers rather
    // than grinding on and cooking the GPU.
    //
    // A backgrounded tab throttles rAF to near zero, which is not the same
    // thing at all — so only count samples taken while visible, and require a
    // sustained run of them before degrading.
    if (document.visibilityState !== "visible") {
      fps.lowRun = 0;
    } else if (fps.value > 0 && fps.value < CONFIG.degradeBelowFps) {
      fps.lowRun = (fps.lowRun || 0) + 1;
      // Degrade silently. A toast appearing over a live stage is worse than
      // the dropped frames it reports; the operator can see fps on the monitor.
      if (fps.lowRun >= 4 && !lite) {             // ~2 seconds of real struggle
        enterLite();
        fps.lowRun = 0;
        console.info("Reduced effects to hold the frame rate");
      } else if (fps.lowRun >= 6 && pulses.length) {
        pulses = [];                               // still struggling: last layer off
      }
    } else {
      fps.lowRun = 0;
    }
    ui.mHands.textContent = hands.length;
    ui.mGrip.textContent = hands[0] ? hands[0].open.toFixed(2) : "—";
  }

  // Tracking lost mid-reveal: the progress dots dim rather than a line of text
  // appearing, since the stage carries no copy.
  if (state === STATE.PLAY) {
    const lost = now - lastHandSeenAt > CONFIG.lostHandHintMs;
    ui.footer.classList.toggle("searching", lost);
  }
}

/* --------------------------------------------------------------------------
   Gesture calibration

   A held detection before the reveal starts. It gives the presenter a moment
   to find the frame, and it proves tracking is live while there is still time
   to fall back — rather than discovering it is not mid-ceremony.
   -------------------------------------------------------------------------- */
const RING_LEN = 2 * Math.PI * 58;      // matches r="58" in the markup
let calHeld = 0;
let calDone = false;   // one-shot latch for completeCalibration()
let calLost = 0;       // ms the hand has been out of view mid-hold
let calHideTimer = null;                // so a pending hide cannot outlive a re-show

/**
 * Reveal an overlay with its transition intact.
 *
 * A forced reflow, not a double requestAnimationFrame: rAF is throttled to a
 * standstill in a backgrounded window, which would leave the element mounted
 * but permanently transparent. Reading offsetHeight commits the starting style
 * synchronously, so the transition always runs.
 */
function revealOverlay(el) {
  el.hidden = false;
  el.classList.add("out");
  void el.offsetHeight;
  el.classList.remove("out");
}

function showCalibration() {
  clearTimeout(calHideTimer);
  ui.footer.classList.remove("in");   // grab/release hint belongs to the reveal
  revealOverlay(ui.calibrate);
}

function hideCalibration() {
  clearTimeout(calHideTimer);
  ui.calibrate.classList.add("out");
  calHideTimer = setTimeout(() => { ui.calibrate.hidden = true; }, 700);
}

function beginCalibration(force = false) {
  // Nothing to calibrate against without tracking; do not strand the operator
  // in front of a step that can never complete. `force` is for rehearsing the
  // screen itself without a camera attached.
  if (!force && (!landmarker || !video.srcObject)) { startPlay(); return; }

  state = STATE.CALIBRATE;
  calHeld = 0;
  calDone = false;
  calLost = 0;
  setPill("Calibrating", "wait");

  showCalibration();
  setRing(0, "waiting");
}

function setRing(progress, cls) {
  ui.calRing.style.strokeDasharray = RING_LEN;
  ui.calRing.style.strokeDashoffset = RING_LEN * (1 - clamp(progress, 0, 1));
  const ring = ui.calRing.closest(".ring");
  ring.classList.toggle("waiting", cls === "waiting");
  ring.classList.toggle("detected", cls === "detected");
  ring.classList.toggle("done", cls === "done");
}

function stepCalibration(dt) {
  const seen = hands.length > 0;
  const wasHeld = calHeld;
  calHeld = seen
    ? calHeld + dt
    : Math.max(0, calHeld - dt * CONFIG.calibrate.decay);

  // The cue runs with the ring rather than after it, and stays pinned to it.
  // Losing the hand rewinds the ring, so the sound is stopped and picked up
  // again at the ring's own position when the hand comes back — otherwise the
  // two drift apart by however long the hand was away. A short grace period
  // keeps a one-frame tracking flicker from chopping the sound.
  if (seen) {
    calLost = 0;
    if (!cueBus) startCue(calHeld);
  } else {
    calLost += dt;
    if (cueBus && calLost > CONFIG.calibrate.graceMs) stopCue();
  }

  const progress = calHeld / CONFIG.calibrate.holdMs;
  if (progress >= 1) { completeCalibration(); return; }

  setRing(progress, seen ? "detected" : "waiting");
}

/**
 * Runs exactly once per calibration.
 *
 * `state` alone cannot guard this. It stays CALIBRATE for the whole settle
 * window — the screen is still up while the cue plays and startPlay waits on
 * its timer — and stepCalibration keeps running every frame with calHeld still
 * above holdMs. Without a one-shot latch the cue retriggers on every frame of
 * that window, stacking dozens of overlapping copies of the sound.
 */
function completeCalibration() {
  if (calDone || state !== STATE.CALIBRATE) return;
  calDone = true;
  setRing(1, "done");
  // The cue has been running alongside the ring and is landing right now.
  // Only fire one here if something went wrong and nothing is playing.
  if (!cueBus) sfx.ready();
  setTimeout(() => startPlay(), CONFIG.calibrate.settleMs);
}

function startPlay() {
  if (state === STATE.PLAY) return;
  state = STATE.PLAY;
  hideCalibration();
  ui.footer.classList.add("in");
  setPill("Ready for reveal", "live");
  lastHandSeenAt = performance.now();
  lastPlacedAt = performance.now();
}

/* --------------------------------------------------------------------------
   Flow
   -------------------------------------------------------------------------- */
async function activate() {
  if (state !== STATE.IDLE) return;
  goFullscreen();
  state = STATE.ARMING;

  ui.hero.classList.add("out");
  setTimeout(() => { ui.hero.hidden = true; }, 700);
  ui.topbar.classList.add("in");
  setPill("Initialising", "wait");

  layout();
  buildPuzzle();

  // Everything heavy already happened on the landing page.
  if (!landmarker || !video.srcObject) {
    try {
      await prepareTracking();
    } catch { /* handled in prepareTracking */ }
  }
  if (!landmarker || !video.srcObject) {
    // The pill already reports this. A popup over a live stage is worse than
    // the condition it describes, and the operator is watching the pill.
    setPill("Camera offline", "idle");
    console.warn("Camera unavailable — mouse fallback active");
  }

  // Camera warm-up is async; if anything advanced the show while we waited
  // (an operator hitting auto-complete, say), do not drag it back.
  if (state !== STATE.ARMING) return;

  beginCalibration();
}

function reset() {
  state = STATE.PLAY;
  calHeld = 0;
  clearTimeout(calHideTimer);
  ui.calibrate.hidden = true;
  fused = 0;
  particles = [];
  finale.running = false;
  finale.t = 0;
  finale.scale = 1;
  finale.dy = 0;
  finale.waves.length = 0;
  finale.fired.clear();
  document.body.classList.remove("montage-in");
  ui.blackout.classList.remove("in");
  ui.blackout.hidden = true;
  ui.montage.classList.remove("in", "has-video");
  ui.montage.hidden = true;
  if (ui.montageVideo) {
    ui.montageVideo.pause();
    ui.montageVideo.currentTime = 0;
  }
  hands.forEach((h) => (h.held = null));
  ui.done.classList.add("out");
  setTimeout(() => { ui.done.hidden = true; }, 700);
  buildPuzzle();
  updateProgress();
  ui.footer.classList.add("in");
  setPill("Ready for reveal", "live");
  toast("Board reset");
}

function forceNext() {
  const p = pieces.find((q) => !q.placed);
  if (p) { if (p.held) { p.held.held = null; p.held = null; } place(p); }
}

function autoComplete() {
  const left = pieces.filter((p) => !p.placed);
  left.forEach((p, i) => setTimeout(() => { if (!p.placed) { if (p.held) { p.held.held = null; p.held = null; } place(p); } }, i * 420));
  toast("Auto-complete");
}

/* --------------------------------------------------------------------------
   Input
   -------------------------------------------------------------------------- */
$("activate").addEventListener("click", activate);

addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === " " || k === "enter") {
    e.preventDefault();
    if (state === STATE.IDLE) activate();
    else if (state === STATE.CALIBRATE) startPlay();   // operator override
  }
  if (k === "n") forceNext();
  if (k === "a") autoComplete();
  if (k === "r") reset();
  if (k === "m") ui.monitor.classList.toggle("in");
  if (k === "v") { if (state === STATE.DONE) { finale.t = Math.max(finale.t, CUE.dock[0]); } else if (state === STATE.PLAY) autoComplete(); }
  if (k === "c") document.body.classList.toggle("show-cursor");
  if (k === "f") document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  if (k === "k" && (state === STATE.PLAY || state === STATE.CALIBRATE)) beginCalibration(true);
  if (k === "b") {
    CONFIG.backdrop.enabled = !CONFIG.backdrop.enabled;
    bgCanvas.style.display = CONFIG.backdrop.enabled ? "block" : "none";
    toast(CONFIG.backdrop.enabled ? "Backdrop on" : "Backdrop off");
  }
  if (k === "1") { sfx.chime(); toast("Bell chime — the previous cue"); }
  if (k === "2") { sfx.ready(); toast("Rewind + impact — the calibration cue"); }
  if (k === "3") { sfx.riser(); toast("Riser — the lift into the montage"); }
  if (k === "h") toast("N next · A auto · K recalibrate · V montage · R reset · B backdrop · M monitor · F fullscreen · C cursor · 1/2/3 audition sounds");
});

// Mouse fallback — lets you rehearse the whole show without a camera.
// simulate() already follows whatever object sits in piece.held, so the mouse
// only needs to look like a hand.
const mouseHand = {
  x: -999, y: -999, offX: 0, offY: 0, open: 2, grabbing: false,
  closeFrames: 0, openFrames: 0, held: null, ring: 1,
  pts: null, coasting: 0, handed: null,
};
addEventListener("mousemove", (e) => {
  mouseHand.x = e.clientX;
  mouseHand.y = e.clientY;
});
addEventListener("mousedown", (e) => {
  if (state !== STATE.PLAY || hands.length) return;
  // Seed the position from the event itself — a click with no preceding
  // mousemove would otherwise reach for a piece from off-screen.
  mouseHand.x = e.clientX;
  mouseHand.y = e.clientY;
  mouseHand.grabbing = true;
  onGrab(mouseHand);
});
addEventListener("mouseup", () => {
  if (!mouseHand.grabbing) return;
  mouseHand.grabbing = false;
  onRelease(mouseHand);
});

let resizeTimer = null;
addEventListener("resize", () => {
  // A window drag fires this dozens of times a second; relaying out on every
  // one of them rebuilds the whole backdrop and locks the machine up.
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(onResize, 160);
});

function onResize() {
  // A hidden window reports nothing usable, and viewport() then falls back to
  // the screen size — which lays the board out for a display that isn't the
  // one being drawn to. The visibilitychange handler re-measures on return.
  if (document.visibilityState !== "visible") return;
  if (state === STATE.IDLE) { layout(); return; }
  layout();
  // Placed pieces follow their targets already; loose ones hold absolute
  // positions, so pull any that the new, smaller screen left outside.
  // Same bounds buildPuzzle() uses, gap included — otherwise a resize can slide
  // a piece flush against the screen edge with no margin.
  const pw = box.w / CONFIG.puzzle.cols, ph = box.h / CONFIG.puzzle.rows;
  const oX = pw * CONFIG.puzzle.tabDepth, oY = ph * CONFIG.puzzle.tabDepth;
  const gap = flankGap(view.W);
  const loX = gap + oX, hiX = Math.max(loX, view.W - gap - oX - pw);
  const loY = CONFIG.safe.top + oY, hiY = Math.max(loY, view.H - CONFIG.safe.bottom - oY - ph);
  for (const p of pieces) {
    if (p.placed) continue;
    p.x = clamp(p.x, loX, hiX);
    p.y = clamp(p.y, loY, hiY);
  }
}

// A window that was hidden during activation reports a zero size. Re-measure
// the moment it comes back so the board is never left collapsed.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || state === STATE.IDLE) return;
  const vp = viewport();
  const stale = box.w < 10 || Math.abs(box.w - solveBox(vp.W, vp.H).w) > 1;
  layout();
  if (stale && !pieces.some((p) => p.placed)) buildPuzzle();
});

// Exposed for the operator console and for rehearsal debugging.
window.KDF = {
  CONFIG,
  get lite() { return lite; },
  enterLite,
  get state() { return state; },
  get pieces() { return pieces; },
  get hands() { return hands; },
  get box() { return box; },
  activate, reset, forceNext, autoComplete, beginCalibration, startPlay,
  openMontage, blackout,
  get finale() { return finale; },
  OneEuro, Vec2Filter, buildLogo, loadArtwork,
  get poster() { return poster; },
  /** Jump the finale to a given millisecond — for rehearsing its timing. */
  seek(ms) {
    if (!finale.running) {
      pieces.forEach((p) => { p.x = p.tx; p.y = p.ty; p.rot = 0; p.placed = true; });
      updateProgress();
      finish();
    }
    finale.t = ms;
    return finale.t;
  },
};

layout();
requestAnimationFrame(loop);
