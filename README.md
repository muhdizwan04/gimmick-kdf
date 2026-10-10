# KDF Reveal

Gesture-controlled jigsaw reveal for the Kedah Digital Festival launch.
MediaPipe hand tracking, no touch, no controller.

**Close your fist to grab. Open your palm to release.**

Four pieces. Nothing solves itself — the reveal only happens by hand.

---

## Run it

```bash
python3 -m http.server 8420
```

Then open <http://localhost:8420>.

Allow the camera when prompted. Do this before the ceremony starts so the
browser's permission prompt never appears on stage. To load the film, see
[Montage](#montage) — it is loaded at `?op=1`, not on the landing page.

The camera requires a secure context: `localhost` and any `https://` origin
work, a plain-`http://` LAN address does not. Run it on the venue machine
itself, or from the deployed HTTPS URL.

## Runs offline

Nothing is fetched from the internet at runtime. The hand-tracking runtime,
its WebAssembly, and the landmark model are vendored into `vendor/tasks-vision`
(about 26 MB) rather than pulled from a CDN, and the montage comes off the show
machine's own disk. Pull the ethernet and the whole piece still runs.

That matters because the gesture tracking *is* the piece: on a CDN it needed a
working uplink before anyone could raise a hand.

To move to a newer MediaPipe, replace the folder and update `TRACKING_WASM` and
`TRACKING_MODEL` in `app.js`:

```bash
npm pack @mediapipe/tasks-vision@<version>
```

Take `vision_bundle.mjs` and `wasm/` from the tarball, and the matching
`hand_landmarker.task` from Google's model storage.

## Lite mode

For low-memory machines. It switches on by itself when the browser reports
4 GB of RAM or less, or 4 CPU cores or fewer, and again mid-show if the frame
rate stays below 38 fps for about three seconds. Force it either way:

    https://<your-deploy>.vercel.app/?lite=1
    https://<your-deploy>.vercel.app/?lite=0

What it trims, and why each one matters on a weak laptop:

| | Normal | Lite |
|---|---|---|
| Canvas pixel ratio | up to 1.5 | 1 |
| Hand-tracking inference | every camera frame | 20 per second |
| Hands tracked | 2 | 1 |
| Camera resolution | 1280×720 | 640×360 |
| Canvas glows (`shadowBlur`) | on | off |
| Travelling backdrop lights | 12 | 4 |
| Confetti | 250 pieces | 100 pieces |
| Grain overlay, exit blur, button sheen | on | off |

The puzzle, the reveal and the film are identical in both. The film also holds
at metadata until the finale starts in every mode, so it never competes with
tracking for memory or bandwidth.

## Cloud storage (Supabase)

The film uploaded at `?op=1` is published so every device with the link plays
it. Storage is Supabase; the keys live only in Vercel's environment, never in
the page.

Set it up once:

1. Create a free project at supabase.com.
2. Storage → New bucket → name it **kdf** → tick **Public bucket**.
3. Project Settings → API → copy the **Project URL** and the **service_role**
   key.
4. Give them to Vercel (it prompts for the value, so the key never goes into a
   file or a chat):

        npx vercel env add SUPABASE_URL production
        npx vercel env add SUPABASE_SERVICE_ROLE_KEY production

5. Redeploy.

Until those are set, uploads say so plainly and the film still saves to the
machine doing the loading — see below.

**The service_role key is a secret.** It belongs in Vercel's environment
variables and nowhere else. It is never sent to the browser: the page asks the
server for a one-shot upload URL and PUTs the file straight to storage.

**Free projects pause after a week of inactivity.** Open the Supabase dashboard
or load the show once in the days before the event so it is awake on the night.

## If the cloud is unavailable

Cloud storage can be suspended, out of quota, or simply unreachable from a
venue. None of that stops the show:

- The loader saves to the machine **first**, then publishes. A failed upload
  leaves the film on that machine and says *"Saved on this machine only — not
  published"* rather than losing it.
- The show prefers the published film, falls back to the local copy, then to a
  `montage.mp4` shipped in the deploy.
- Removing a film clears this machine even if the published copy cannot be
  reached, and says so.

Whatever the setup, keep the final film on a USB stick at the venue.

## Deploying

The whole thing is static files — no build step, no server code.

```bash
npx vercel --prod
```

Take the URL it prints. `vercel.json` and `robots.txt` keep it out of search
results, and the URL itself is unguessable, so it is reachable by link only.

Deploying does **not** carry the montage with it — the film lives on the show
machine, not in the deploy. Open the deployed URL with `?op=1` on that machine
and load the film there.

## Operator keys

| Key | Action |
|-----|--------|
| `Space` / `Enter` | Activate (same as the button) |
| `N` | Force-place the next piece |
| `A` | Auto-complete the whole reveal |
| `K` | Re-run gesture calibration |
| `V` | Skip ahead to the montage (during the finale) |
| `R` | Reset the board |
| `M` | Toggle the camera monitor (hands / grip value / fps) |
| `F` | Toggle fullscreen |
| `C` | Show the mouse cursor |
| `H` | Show this list on screen |

The finale runs on a fixed timeline, so it always plays at the same pace no
matter how fast or slow the reveal itself went.

Mouse drag works as a full rehearsal fallback whenever no hand is detected, so
the entire show can be run and timed without a camera.

## Tuning

Everything a stage operator needs is in the `CONFIG` block at the top of
`app.js`; the finale timings are in `CUE` just above the effects code.

**Gesture thresholds** — `grip.closeAt` / `grip.openAt`. The value being
compared is the mean fingertip-to-wrist distance divided by hand span, so it is
scale-invariant: it reads the same at 1m and at 3m from the camera. A splayed
palm sits near `2.0`, a tight fist near `1.0`. Press `M` and watch the live
`Grip` readout while the actual presenter stands in the actual spot, then set
the two thresholds either side of what you see. The gap between them is
hysteresis — never collapse it, or the piece will flicker on stage.

**Smoothing** — `filter.cursor`, `filter.landmark`, `filter.grip` are One Euro
coefficients. One Euro is adaptive: it smooths hard while the hand is nearly
still and backs off as the hand speeds up, so it does not have to trade jitter
against lag the way a fixed-alpha filter does. Measured against the fixed-alpha
filter this replaced, on 2.49px of simulated input jitter:

| | fixed alpha | One Euro |
|---|---|---|
| jitter, hand held still | 1.13px | 0.68px |
| lag, hand sweeping ~840px/s | 26.3px | 13.5px |

Lower `minCutoff` if a resting hand still shimmers. Raise `beta` if fast moves
feel like they drag behind the hand.

**`track.coastFrames`** is how many frames a hand keeps its last pose after
MediaPipe loses it. Detection gaps of a frame or two are constant, and dropping
the piece on every one of them is unusable on stage. Raise it if the piece still
falls out of the presenter's hand; lower it if a genuinely lowered hand keeps
holding on. `track.matchRadius` binds each detection back to the hand it
belongs to, so two hands never swap filter state mid-grab.

**Forgiveness** — `reach.grab` and `reach.snap` are deliberately generous. A VIP
missing a piece in front of an audience is much worse than a piece snapping a
little too eagerly.

**No auto-solve.** Pieces never drift home on their own; the reveal only
advances when a hand moves it. The only way to place a piece without a gesture
is the operator pressing `N` or `A`, which are deliberate keypresses kept as a
safety net — say the word and they go too.

**`puzzle.cols` / `rows`** default to 2×2 = four pieces. Changing them is safe:
the logo box is solved at runtime from the piece count, so it shrinks to keep a
corridor wide enough for the scattered pieces either side and they can never
collide with the board or run off the screen edge. Nothing about the layout is
a hard-coded pixel value.

## The finale

When the last piece lands, a fixed timeline takes over (`CUE`, in milliseconds
from completion):

| ms | |
|----|---|
| 0 | sub-bass hit, screen flash, board punches up |
| 40 / 300 / 620 | three expanding shockwaves |
| 120–1500 | radial light rays spin up behind the logo |
| 180 / 520 | confetti cannons from the bottom corners |
| 820–1900 | specular band sweeps across the finished logo |
| ~1000 | seams fuse — six tiles read as one logo |
| 1500 | "Reveal complete" card |
| 4200–5500 | logo docks upward, montage takes the stage |

`KDF.seek(ms)` in the browser console jumps straight to any point on that
timeline, which is the fast way to rehearse the timing without replaying the
whole puzzle.

## Puzzle artwork

Hard-coded. `poster.jpg` sits beside `index.html` and *is* the puzzle — there
is nothing to choose, paste or upload on the night, and no UI for it. To change
the artwork, replace the file (`.png`, `.jpeg` and `.webp` also work).

The board takes the image's own aspect ratio, so the portrait poster stays
portrait — never squashed into a fixed frame or cropped at the edges. The rest
of the layout re-solves around it so the four pieces still fit beside a board
of any shape.

If the file is missing the landing page says so and falls back to a stand-in
mark drawn in code, rather than failing silently.

## Going fullscreen

Activate requests fullscreen on its own — browsers only grant it from a real
user gesture, so it cannot happen on page load.

For the venue machine, launch Chrome already fullscreen instead:

```bash
npm run dev      # in one terminal, leave it running
npm run kiosk    # in another
```

Kiosk mode has no tabs, no address bar and no exit affordance (`Cmd+Q` quits).
It runs on a dedicated Chrome profile at `~/.kdf-chrome`, so it never disturbs
the operator's own browser, and the camera permission granted on the first run
is remembered for every run after.

Effects degrade **silently** if the frame rate drops — nothing is drawn over
the stage. The operator can watch the live fps on the monitor (`M`).

## Run of show

1. **Open the page** — the camera permission prompt appears immediately. Allow
   it. Nothing else is on screen but the title and the button.
2. **Activate**.
3. **Calibration** — *"Kindly raise your hand"*. A ring fills while a hand is
   held in frame; the reveal begins automatically when it completes.
4. **The reveal** — four pieces. Fist to grab, open palm to release.
5. **Finale** — the poster fuses, then docks upward.
6. **Montage** — `montage.mp4` plays once inside a bordered frame.
7. **Black** — the screen goes black when the montage ends and stays there.

The camera is released the moment the puzzle completes; the light goes out and
nothing is being recorded during the montage.

## Camera

The camera is requested from the **landing page**, not on Activate. Both the
permission prompt and the ~8MB hand model used to land after the button was
pressed, which meant a browser dialog over a live stage and several seconds of
blank screen while the model downloaded. Now Activate is instant.

The chip reports its state: *Enable camera* → *Requesting camera…* →
*Loading hand model…* → *Camera ready*. On refusal it turns red and reads
*Camera unavailable — click to retry*, and the show still runs on the mouse
fallback.

If permission was already granted for the origin, it warms up on page load with
no prompt at all.

GPU inference falls back to CPU automatically if WebGL is too weak, rather than
losing tracking entirely.

### Board sizing

The board is solved at runtime so a flank corridor either side always fits a
whole piece plus its tabs. Measured across screen shapes:

| screen | board | share of screen height |
|---|---|---|
| 3840×2160 | 1301×1627 | 75% |
| 1920×1080 | 581×727 | 67% |
| 1600×900 | 461×577 | 64% |
| 1280×720 | 341×427 | 59% |

A portrait board on a landscape screen cannot go much larger than this without
the flanking pieces running off the edge — that is the trade-off of a 4:5
poster with pieces beside it. If the reveal needs the artwork bigger, a
landscape crop of the logo lockup would give considerably more room.

## Backdrop

A neon circuit pattern, generated in code — traces that turn only in 45 degree
increments with vias at the ends of each run, and lights that travel along them.
Behind the board sits a backing panel and halo, so the artwork never has to
compete with the pattern.

It is original work, not a downloaded image. That matters here: the screen
carries Stellantis, MCMC and UiTM branding in front of an audience, and a
stock or pinned image would be someone else's copyright on a public stage.
Generating it also means it scales to any resolution and ships no assets.

Tuning lives in `CONFIG.backdrop`:

- `density` — scales the number of traces (about 120 runs at 1920x1080)
- `pulses` — how many lights travel at once
- `cell` — trace grid pitch; larger reads calmer, smaller reads busier
- `enabled` — set false for a plain background

The traces are baked into an offscreen canvas once per resize, so each frame is
a single blit plus the moving lights. Measured at 1920x1080 on this machine:
0.039 ms for the blit, 0.134 ms for the lights, **0.17 ms total — about 1% of a
60fps frame budget.**

## Performance

The animation is all still there. What was removed was work that produced
nothing on screen.

**Cooking the GPU:**

- The ambient colour wash was three large elements under `filter: blur(90px)`
  animating continuously. On a Retina panel that re-blurs a larger-than-viewport
  surface every frame, forever, even on an idle page. Now baked once into the
  static backdrop — same look, no per-frame cost.
- `backdrop-filter: blur(24px)` on four always-visible elements. Each forces a
  readback and blur of the animating canvas behind it, every frame. All removed.

**Locking the machine up:**

- `buildCircuit()` ran on every `resize` event with no debounce, regenerating
  hundreds of traces into a full-viewport canvas. A window drag fires resize
  dozens of times a second. Now debounced, and it only rebuilds when the size
  actually changed: 60 resize events went from freezing the machine to 0.3 ms.
- Layout is skipped entirely while the window is hidden, where measurements are
  unreliable and `viewport()` would otherwise fall back to the screen size.

**Wasted per-frame work:**

- The circuit lives on its own canvas layer, painted once. The animation loop
  no longer blits a full-viewport image every frame — only the travelling
  lights are redrawn.
- Each piece's jigsaw outline is cached as a `Path2D` and rebuilt only on
  layout. Previously every piece re-traced its bezier tabs three times a frame
  (slot, clip, rim) for a shape that never changes.
- The board halo gradient is built once per layout, not per frame.
- Backdrop pulses use a pre-rendered glow sprite instead of `shadowBlur`.
- Device pixel ratio capped at 1.5 — roughly 44% fewer pixels than full Retina,
  invisible at hall viewing distance.

`B` toggles the backdrop. Below `CONFIG.degradeBelowFps` (38) the animated
layers are shed automatically, so a weaker machine degrades rather than
overheats.

## Montage

The film is **not part of the deploy**. It is usually still being cut while the
room fills, so it is loaded on the night from the show machine's own disk and
never travels over the network.

### Loading it (before doors)

Open the hidden loader — the show URL with `?op=1` appended:

    https://<your-deploy>.vercel.app/?op=1

Drop the film into **Primary**. The loader decodes it there and then and shows
duration, resolution and size; if the browser cannot play it you are told
immediately and nothing is stored, so a ProRes or HEVC export fails at 6pm
rather than in front of the room. Re-export as **H.264 MP4** if that happens.

Load a second file into **Backup** if you have one. Then click **Open the show**
and leave the machine on that clean URL.

### Why it survives

The file's bytes go into IndexedDB on that machine, not into an object URL. It
therefore survives reloads, browser restarts, and the network dropping entirely.
Playback is from local disk at full quality — there is no upload and no CDN.

### What the audience sees

Nothing. The loader exists only at `?op=1`; on the show URL there is no drop
zone, no button, and none of its code is even downloaded.

### Resolution order

1. The operator's **Primary** file in IndexedDB.
2. `montage.mp4` (or `.webm` / `.mov` / `.m4v`) shipped beside `index.html`.
3. Nothing — the reveal still runs and ends on a clean blackout.

If the primary fails to decode mid-show the **Backup** takes over within a
frame. If that fails too the screen goes to black rather than looping.

It plays **once**, letterboxed inside a frame clear of the docked logo. Audio
goes to the PA; if the browser refuses unmuted autoplay it falls back to muted
rather than showing nothing. A rejected or interrupted `play()` is retried and a
watchdog resumes it within a second, so one hiccup does not cost the montage.
When it ends the screen fades to black and holds. It does not loop.

### Clearing it

Reopen `?op=1` and click **Remove**. Do not clear site data on the show machine
between loading the film and the event — that is where it lives.


## Performance

The animation is all still there. What was removed was work that produced
nothing on screen.

**Cooking the GPU:**

- The ambient colour wash was three large elements under `filter: blur(90px)`
  animating continuously. On a Retina panel that re-blurs a larger-than-viewport
  surface every frame, forever, even on an idle page. Now baked once into the
  static backdrop — same look, no per-frame cost.
- `backdrop-filter: blur(24px)` on four always-visible elements. Each forces a
  readback and blur of the animating canvas behind it, every frame. All removed.

**Locking the machine up:**

- `buildCircuit()` ran on every `resize` event with no debounce, regenerating
  hundreds of traces into a full-viewport canvas. A window drag fires resize
  dozens of times a second. Now debounced, and it only rebuilds when the size
  actually changed: 60 resize events went from freezing the machine to 0.3 ms.
- Layout is skipped entirely while the window is hidden, where measurements are
  unreliable and `viewport()` would otherwise fall back to the screen size.

**Wasted per-frame work:**

- The circuit lives on its own canvas layer, painted once. The animation loop
  no longer blits a full-viewport image every frame — only the travelling
  lights are redrawn.
- Each piece's jigsaw outline is cached as a `Path2D` and rebuilt only on
  layout. Previously every piece re-traced its bezier tabs three times a frame
  (slot, clip, rim) for a shape that never changes.
- The board halo gradient is built once per layout, not per frame.
- Backdrop pulses use a pre-rendered glow sprite instead of `shadowBlur`.
- Device pixel ratio capped at 1.5 — roughly 44% fewer pixels than full Retina,
  invisible at hall viewing distance.

`B` toggles the backdrop. Below `CONFIG.degradeBelowFps` (38) the animated
layers are shed automatically, so a weaker machine degrades rather than
overheats.

## What has and has not been verified

Verified in-browser: layout from 604×850 up to 1600×900, piece scatter and
interlocking tabs, grab-and-release (a release near a slot places, a release far
from one does not), progress indicator, auto-complete, the full
finale timeline (all eight cues fire in order), seam fusing, the montage
hand-off and its grid fallback, reset from the montage back to a clean board,
and graceful degradation when the camera is unavailable. Also verified: the
four-piece layout keeps every piece on screen and clear of the board, a
portrait poster drives the board aspect exactly (0.8 in, 0.8 out) and the four
quadrants reassemble pixel-accurately, no piece moves on its own while the
stage sits idle, an uploaded file decodes and plays
full-bleed with sound, and the watchdog resumes playback after a forced pause. The One Euro figures in
the table above are measured, not estimated.

**Not yet verified: live MediaPipe hand tracking.** The preview browser blocks
camera access, so the tracking path has never run against a real hand. The grip
thresholds are reasoned defaults, not measured ones, and the filter coefficients
were tuned against simulated jitter rather than a real camera. Budget a
rehearsal pass to set them.

## Before the event

1. Rehearse on the **venue machine**, under **venue lighting**, in the outfit
   the presenter will actually wear. Stage lighting blows out webcam exposure
   and long or dark sleeves change what the tracker sees.
2. Mount the camera at chest height, roughly 1.5–2m from the presenter.
3. If a crowd stands behind the presenter, cap `camera.numHands` behaviour by
   reducing `numHands` to 1 in `startTracking()` so the tracker locks onto the
   nearest hand.
4. Cache the model locally rather than trusting venue wifi. Download
   `hand_landmarker.task` and the `@mediapipe/tasks-vision` wasm bundle, drop
   them beside `index.html`, and point `startTracking()` at the local paths.
   Nothing else in the app touches the network.
5. Have the operator ready on `N` and `A`.
