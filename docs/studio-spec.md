# PYTTI STUDIO — Definitive Build Spec

**Synthesis basis:** STUDIO's skeleton won 2 of 3 verdicts and the third verdict's mustSteal list converges on the same composite ("Studio's object model and first-session story wearing Instrument's instrumentation and Darkroom's honesty devices"). This spec is STUDIO's session/library/stage/bench architecture with every coherent mustSteal grafted in. Conflicts resolved inline with reasoning, marked **⚖**. The implementer's buildability constraints are treated as binding: no structured↔raw round-trip editor, no second grammar in JS, no bidirectional time solver, Range/206 and orphan recovery designed in, O(runs)-never-O(frames) scanning.

Grounded against `/Users/max/Documents/Dev/pytti-core/src/pytti/config/structured_config.py` (all fields verified, `CONFIG_VERSION=2`), `/Users/max/Documents/Dev/pytti-core/src/pytti/config/model_names.py` (`faceshq` **is** a real checkpoint — Judge 2's correction adopted: the picker derives from `VQGAN_MODEL_NAMES`, all 6 entries, alias `sflckr` hidden), and `/Users/max/Documents/Dev/pytti-able/app/ui.py` (log parser, ETA math, encode pipeline, prompt-field forgiveness all survive server-side).

---

## 1. CONCEPT

PYTTI STUDIO is a darkroom with a contact-sheet wall: every render is a **session** — an auto-named, immutable, first-class object that materializes in the library the second it starts and fills in as the machine works — and the artwork, not the config file, is what you browse, scrub, compare, fork, resume, and encode. The creative loop is one gesture long: fork any session (live or finished, seed locked for exact reproduction), touch the prompt in the always-present bench, and RUN — or QUEUE it behind the render you're not ready to kill. The developing image is the largest thing on screen at all times; the machine's pulse (steps, s/step, scene position, "next frame in ~40s") is instrumentation, not log archaeology; every cost is printed in wall-clock hours *before* you pay it, citing the measurement it came from; and nothing is ever named, filed, or hunted for.

---

## 2. IA

### 2.1 Object model

- **SESSION** — id `s-<NNNN>-<slug>` (zero-padded monotonic counter + slug from first 3 words of scene 1, e.g. `s-0413-kelp-cathedral`). **⚖** Prompt-derived slug (PROGRESSIVE) replaces STUDIO's petnames per Judge 1; the sequence number kills INSTRUMENT's minute-resolution collision; no editable title exists (Judge 2's "naming creep" — one name-ish thing, zero rename affordances). A session owns: its config snapshot (seed baked in *and* displayed), its frames dir, telemetry (`session.json`), artifacts (encodes), lineage (`forkedFrom`).
- **DRAFT** — the single working config, embodied by the Bench, autosaved server-side on every change (disk always equals screen). RUN converts draft → session atomically.
- **QUEUE** — **⚖** PROGRESSIVE's one-slot queue, grafted in by unanimous judge demand: RUN while rendering offers `QUEUE` or `STOP & RUN NOW` (INSTRUMENT's restart-with-changes as the second button). One slot; queuing again replaces the queued snapshot with a toast.
- **PRESET** — optional named bookmark of a draft. Never required to render.

Lifecycle: `DRAFT →(run)→ LAUNCHING → LOADING MODELS → RENDERING →{complete→DONE | stop→STOPPED | exit≠0→FAILED}`; STOPPED + backups → RESUME (same session, `restore=true`); any state → FORK (config→draft, **seed LOCKED by default** — **⚖** Judge 1: exact reproduction is the default, reroll is the explicit act via the always-visible die).

### 2.2 Zones — one screen, three columns, drawers. No tabs, ever.

| Zone | Contents | Persistence |
|---|---|---|
| **STATUS STRIP** (top, fixed) | live-render LED + session id + step/total + s/step + ETA + STOP; queue chip; tab-title mirror | always |
| **LIBRARY** (left rail) | session cards newest-first, live card pulsing on top, Δ-vs-parent chips; expands to full ARCHIVE grid (`G`) | always |
| **STAGE** (center) | selected session, full-bleed frame; filmstrip; progress deck (the *single* telemetry surface — **⚖** Judge 3: no separate Scope); collapsed log line; PiP of live render when browsing elsewhere | always |
| **BENCH** (right rail) | the draft: PROMPT / CANVAS / START FROM / MOTION / COHERENCE / TIME / ENGINE / AUDIO sections, self-summarizing when collapsed; pinned footer = seed strip + cost meter + RUN | always (collapsible to spine) |
| **ENGINE ROOM** (drawer over Bench column) | every raw engine field, schema-generated, intent-grouped, mode-filtered, searchable, help inline | on demand (`E`) — **⚖** one schema-driven deep surface instead of STUDIO's per-section flaps *plus* a full-patch drawer: one renderer, one truth |
| **ARCHIVE** (over Stage+Library) | full contact sheet: filter, sort, lineage rows, compare entry | `G` |
| Sheets/drawers | INSPECTOR+DIFF (`I`), ENCODE, HELP/DSL (`?`), FIRST-BOOT check | on demand |

---

## 3. WIREFRAMES

### 3.1 Primary screen — RENDERING (live session selected, following)

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ PYTTI // STUDIO      ● REC s-0412-kelp-cathedral · 486/1200 · 11.4 s/step · ETA 2h16m  [■ STOP]  [⧖ s-0413] │ ①
├──────────────────────┬────────────────────────────────────────────────────────────┬─────────────────────────┤
│ LIBRARY    [⌕]  [G]  │ s-0412-kelp-cathedral                        ● RENDERING   │ BENCH          ● edited │ ⑧
│ ──────────────────── │ seed 88213 · LP · 2D · 512×512 · 1 CLIP                    │ forked from s-0411 🔒   │
│ ┌──────────────────┐ │ [ ⑂ FORK ] [ ⇆ COMPARE ] [ 🎞 ENCODE ] [ FINDER ] [ ⓘ ]   │ ─────────────────────── │
│ │ ▓▓▓▓▓▓▓  ● REC   │②│ ┌────────────────────────────────────────────────────────┐ │ ▾ PROMPT            ⚠1 │ ⑨
│ │ s-0412-kelp-cath │ │ │                                                        │ │ ┌─────────────────────┐ │
│ │ Δ +fog :0.5      │ │ │                                                        │ │ │ kelp cathedral:2 |  │ │
│ │ LP·2D ▰▰▰▱ 40%   │ │ │                                                        │ │ │ shafts of light ||  │ │
│ └──────────────────┘ │ │                                                        │ │ │ bioluminescent      │ │
│ ┌──────────────────┐ │ │            LATEST FRAME · frame 019                    │ │ │ reef:1.5            │ │
│ │ ▓▓▓▓▓▓▓  ✓ DONE  │③│ │            (full-bleed, crossfades 180ms               │ │ └─────────────────────┘ │
│ │ s-0411-kelp-cath │ │ │             on every save, clean — no                  │ │ ⤷ ①━━⇄200st━━② 2 scenes │ ⑩
│ │ Δ seed only      │ │ │             scanlines on artwork)                      │ │ | · || · :w · _[m] · ? │
│ │ 84 fr · [MP4]    │ │ │                                                        │ │ STYLE  oil painting    │
│ └──────────────────┘ │ │                                                        │ │ AVOID  watermark, text │
│ ┌──────────────────┐ │ │                                                        │ │ ▸ CANVAS  LP·512²·chunk4│ ⑪
│ │ ▓▓▓▓▓▓▓  ■ STOP  │ │ └────────────────────────────────────────────────────────┘ │ ▸ START FROM  (none)    │
│ │ s-0410-rust-reef │ │ FILMSTRIP ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪█ 19 saved   [◉ LIVE]        │④│ ▾ MOTION  2D            │
│ │ 118 fr ▸ RESUME  │ │ next frame in ~38s ────────────────────────────────       │⑤│   zoom .01 ∿ rot t/8 ∿  │
│ └──────────────────┘ │ SCENES [█████████▌░░ kelp cathedral ][⇄][ biolum reef  ]  │⑥│   chips: drift◄ zoom+ ↻ │
│ ┌──────────────────┐ │ STEP 486/1200 · 11.4 s/step ▁▂▄▅▄▅▆▅ · elap 1h32m         │ │ ▸ COHERENCE  med        │
│ │ ▓▓▓▓▓▓▓  ✕ FAIL  │ │ ▸ LOG  486/1200 [11.4s/it] Running prompt: biolum…   [L] │⑦│ ▾ TIME                  │
│ │ s-0409-rust-reef │ │                                                            │   1200 st · 24 fr/scene │
│ │ exit 1 · [LOG]   │ │                                                            │   48 fr = 4.0s @ 12fps  │
│ └──────────────────┘ │                                                            │ ▸ ENGINE  1 CLIP·11s/st │
│  older ▾             │                                                            │ ▸ AUDIO   off           │
│                      │                                                            │ ─────────────────────── │
│                      │                                                            │ SEED 88213 [🔒][⟳]     │ ⑫
│                      │                                                            │ EST ≈3h48m · measured   │
│                      │                                                            │     (s-0411) ⚠ >2h      │
│                      │                                                            │ [ ⧖ QUEUE s-0413 ]      │ ⑬
│                      │                                                            │ [ ■▶ STOP & RUN NOW ]   │
└──────────────────────┴────────────────────────────────────────────────────────────┴─────────────────────────┘
```

① **Status strip** — always visible truth: state LED (orange REC, pulsing *keyed to `progress` events*, not a CSS loop), live session, step fraction, measured s/step, ETA, STOP. `[⧖ s-0413]` = queue chip (click to inspect/clear). Tab title mirrors it: `▶ 40% · 2h16m — PYTTI`.
② **Live card** — top of library, safelight pulse, thumbnail swaps on every `frame` event, progress ring. **Δ chip** ("Δ +fog :0.5" / "Δ seed only") = diff-vs-parent summary, computed server-side at session mint (PROGRESSIVE steal, zero clicks).
③ Past cards: last-frame thumb (hover = coarse in-place scrub over ~12 sampled thumbs), id, Δ chip, frame count, artifact chips (click = play on stage), status glyph, `▸ RESUME` on stopped-with-backups, 2-line log excerpt on failed.
④ **Filmstrip** — every saved frame; grows rightward live; drag/arrows scrub (detaches from live); `[◉ LIVE]` snaps back; `Space` plays at authored fps.
⑤ **"next frame in ~38s"** hairline countdown = `(save_every − step % save_every) × sPerStep` (PROGRESSIVE steal, unanimous). The honest answer to "what is it doing for 15 seconds".
⑥ **Progress deck** — the single telemetry surface: scene-segmented bar (segments from server prompt parse; `⇄` hatched interpolation zones; "Running prompt:" log events tick boundaries), step fraction, s/step + **it/s sparkline** (INSTRUMENT steal — watch MPS warm up), phase readout flips to `XFADE`/`PRE-ANIM`, elapsed.
⑦ **Log line** — last cleaned line, terminal green (the only green on screen); `L` expands full drawer; amber/red badge on warn/error lines.
⑧ **Bench** — lineage line ("forked from s-0411 🔒" = seed inherited locked). `● edited` = dirty vs what's rendering.
⑨ Collapsed sections **self-summarize** with current values; **⚠ badges route preflight errors to their section** (fixes Judge 1's error-to-fix navigation hole).
⑩ **Scene map strip** — read-only parsed visualization under the editor: scene blocks + clickable `⇄ 200st` crossfade chip (edits `interpolation_steps`; only exists when `||` exists). Below it the one-line DSL cheat strip; tokens click-insert.
⑪ Contextual sections render only for the active mode; MOTION shows expression fields with sparkline previews + **preset chips** (drift◄, zoom+, spiral, sway) that *write* expressions (PROGRESSIVE steal).
⑫ **Seed strip** — pinned footer, never scrolls away: actual seed, LOCK toggle, reroll die.
⑬ **Cost meter + RUN** — estimate cites its basis ("measured (s-0411)" / "~calibrating"); amber ⚠ over 2h; blocking confirm over absurd estimates ("≈31h — run anyway?"). Because a render is live and the bench is dirty, RUN has morphed into the two-button form: `QUEUE s-0413` (primary) / `STOP & RUN NOW`. When idle it is a single `[ ▶ RUN s-0413 ]` showing the id it will mint.

### 3.2 Primary screen — IDLE / FIRST BOOT (empty library)

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ PYTTI // STUDIO                       ○ READY · mps · models ok · ffmpeg ok        [⚙] [?] │
├──────────────────────┬──────────────────────────────────────────────┬───────────────────────┤
│ LIBRARY              │                                              │ BENCH        ○ fresh  │
│                      │            ┌──────────────────┐              │ ▾ PROMPT              │
│  no sessions yet —   │            │   ▓ STARTER ▓    │              │ │ (empty — pick a    │
│  pick a starter →    │            │  three ghost     │              │ │  starter or type)  │
│                      │            │  cards on stage: │              │ ▸ CANVAS  UP·512²     │
│  (after first run,   │            │                  │              │ ▸ MOTION  off         │
│   cards appear here) │  ┌────────┐ ┌────────┐ ┌────────┐            │ ▾ TIME                │
│                      │  │LIMITED │ │2D DRIFT│ │ VQGAN  │            │   100 st ≈ 20m        │
│                      │  │PALETTE │ │LOOP    │ │TEXTURE │            │ ▸ ENGINE  1 CLIP      │
│                      │  │portrait│ │≈1h 10m │ │≈40 min │            │ ──────────────────────│
│                      │  │≈40 min │ │        │ │        │            │ SEED —— [🔒][⟳]      │
│                      │  │ [LOAD] │ │ [LOAD] │ │ [LOAD] │            │ EST ≈20m ~calibrating │
│                      │  └────────┘ └────────┘ └────────┘            │ [ ▶ RUN s-0001 ]      │
└──────────────────────┴──────────────────────────────────────────────┴───────────────────────┘
```

Starter ghost drafts (STUDIO, all judges): LOAD fills the bench; two interactions to first pixels, cost printed before the click. Stage idle state = starter cards (never a stale frame; there are none). After the first RUN, the pre-first-frame gap shows the **EXPOSING placard** (INSTRUMENT steal): `EXPOSING — first frame at step 50 · ~9m · loading models…`, driven by `state`/`progress` events.

### 3.3 Primary screen — REVIEWING while rendering (PiP + Compare)

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ PYTTI // STUDIO   ● REC s-0412 · 512/1200 · 11.4 s/step · ETA 2h11m   [■ STOP]              │
├──────────────────────┬──────────────────────────────────────────────┬───────────────────────┤
│ LIBRARY              │ COMPARE  s-0411 (done) ⇆ s-0412 (● live)     │ BENCH                 │
│ (cards as 3.1;       │ seeds 88213 / 88213 · Δ 1 field [view diff]  │ (unchanged — editing  │
│  compared cards      │ ┌──────────────────────┬───────────────────┐ │  never blocked by     │
│  show ⇆ badge)       │ │                      │                   │ │  review mode)         │
│                      │ │   s-0411             │   s-0412          │ │                       │
│                      │ │   step 500           │   step 500        │ │                       │
│                      │ │                      │        ┌────────┐ │ │                       │
│                      │ │                      │        │PiP:LIVE│①│ │                       │
│                      │ │                      │        └────────┘ │ │                       │
│                      │ └──────────────────────┴───────────────────┘ │                       │
│                      │ SCRUB (aligned by STEP №) ◂ ▮▮▮▮▮▮▯▯▯ ▸ 🔓②  │                       │
│                      │ A: fr 10 @ step 500 · B: fr 10 @ step 500    │                       │
└──────────────────────┴──────────────────────────────────────────────┴───────────────────────┘
```

① **PiP**: whenever the stage shows anything other than the live session, the live feed shrinks to a corner PiP (click to swap back). The render is never invisible.
② **⚖ Compare alignment is by STEP NUMBER** (equal compute — INSTRUMENT, all three judges), not STUDIO's progress fraction; per-side 🔓 unlock kept (STUDIO). 2-up side-by-side is the only mode — **⚖** the wipe handle is cut (Judge 3: meaningless across resolutions; side-by-side always works). A live session may occupy either side; its strip grows during compare.

### 3.4 ARCHIVE grid (`G`)

```
┌ ARCHIVE ────────────── search prompts… [⌕]  [all|done|stopped|failed] [has-video] [newest▾|lineage] ─ [esc] ┐
│ LINEAGE VIEW (fork-families as rows, oldest→newest):                                                        │
│ s-0401-rust-reef ─┬─▶ s-0405 ──▶ s-0409 ✕ ──▶ s-0410 ■                                                      │
│                   └─▶ s-0407 ✓                                                                              │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                                         │
│ │ ▒▒poster▒▒   │ │ ▒▒poster▒▒   │ │ ▒▒poster▒▒   │ │ ▒▒poster▒▒   │   cards: hover = filmstrip scrub        │
│ │ hover=scrub  │ │              │ │ ■ STOPPED    │ │ imported     │   (≈12 sampled thumbs)                  │
│ ├──────────────┤ ├──────────────┤ ├──────────────┤ ├──────────────┤                                         │
│ │ s-0411-kelp… │ │ s-0412-kelp… │ │ s-0410-rust… │ │ 2026-07-01…  │   "imported" = legacy outputs/<date>/   │
│ │ ✓ 84f·7.0s   │ │ ● 19f REC    │ │ ■ 118/340f   │ │ <time> dir adopted read-only                          │
│ │ Δ seed only  │ │ Δ +fog :0.5  │ │ [▶ RESUME]   │ │              │                                         │
│ │ seed 88213   │ │ 2h10m·11.4s/…│ │ seed 4417…   │ │              │                                         │
│ │[FORK][🎞][ⓘ]│ │[FORK][⇆]    │ │[FORK][🎞][✕]│ │[FORK][ⓘ]    │   ⇧click two cards → COMPARE             │
│ └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘                                         │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.5 ENGINE ROOM drawer (`E`) — the depth layer

```
┌ ENGINE ROOM ──────────── [⌕ search fields + help…]        12 modified · reset all ── [esc] ┐
│ SEEING          │ ▸ CLIP MODELS                                          preset: BALANCED  │
│ SEEDING         │   [x] ViT-B/32   +11.0 s/st     [ ] RN50      +9.1 s/st                  │
│ MEDIUM ◂ LP     │   [ ] ViT-B/16   +10.2 s/st     [x] RN50x4    +10.8 s/st   (measured @   │
│ CAMERA — inactive in OFF (expand anyway ▸)                                  512px)         │
│ COHERENCE       │ ▸ cutouts        [40]    NUM   ?                                          │
│ TIME            │ ▸ cut_pow        [2.0]   NUM   ?                                          │
│ OPTIMIZER       │ ▸ gradient_accumulation_steps [1]  NUM  ✓ divides cutouts                 │
│ AUDIO           │ ▸ learning_rate  [auto]  NUM   ?   ◂ cyan tick = modified-from-default    │
│ FILES           │ ▸ save_every     [0 = auto-match steps_per_frame]  (derived; override)    │
│ SYSTEM          │   …every schema field, grouped by intent, widget from type badge          │
│                 │   (STR/PATH/WEIGHT/EXPR/NUM/BOOL/CHOICE), full help prose inline on ?     │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Slides up over the Bench column only — the stage stays visible while you turn dials (PROGRESSIVE). Groups irrelevant to the current mode collapse to one dim honest row. Everything is the *same draft state* — no second store. EXPR fields get sparkline previews; CHOICE fields enumerate from schema validators, never hand-restated.

### 3.6 ENCODE sheet (on a session)

```
┌ ENCODE · s-0411-kelp-cathedral ────────────────────────────── [esc] ┐
│ ▒poster▒  84 frames · pattern kelp-cathedral_%04d.png (autodetected, │
│           start 1)                                                   │
│ FPS  [12]  ◂ prefilled from session frames_per_second                │
│       ⚠ if edited: "authored at 12fps — 24fps plays motion at 2.0×"  │
│ FORMAT  [● MP4 H.264 CRF17 slow ≈18MB] [○ ProRes 4444] [○ ProRes HQ] │
│ 84 frames @ 12fps = 7.0s                                             │
│ [ ▶ ENCODE ]      running: ▰▰▰▰▱▱ frame 52/84 · [cancel]             │
│ done: MP4 → inline <video> player (Range-served) · ProRes →          │
│       [REVEAL IN FINDER] + optional [make MP4 proxy]                 │
└──────────────────────────────────────────────────────────────────────┘
```

Async, no timeout, cancellable; artifact chip lands on the card; re-encodes stack.

### 3.7 INSPECTOR + DIFF (`I`)

```
┌ INSPECT · s-0412 ─────────────── DIFF vs [ s-0411 ▾ ] ──────── [esc] ┐
│ TELEMETRY  486 steps · 19 frames · 1h32m · 11.4 s/step avg           │
│ CONFIG (grouped, read-only; only changed fields when diffing):       │
│   scenes      kelp cathedral:2 | …        ◂ s-0411: kelp cathedral:2 │
│   seed        88213                          88213 (same)            │
│   (orange highlight on every differing value)                        │
│ ARTIFACTS  kelp-cathedral_12fps.mp4  [▶] [finder]                    │
│ LINEAGE    s-0405 → s-0411 → s-0412                                  │
│ [ ⑂ FORK THIS CONFIG ]                                               │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.8 HELP drawer (`?`) and FIRST-BOOT

HELP: right-side drawer — DSL grammar with live examples (`|`, `||`, `:w`, `:w:stop`, `:-1`, `_r/_l/_u/_d`, `_[mask.png]`, `10*sin(t/4)`, audio bands with "define in AUDIO" links), each line click-to-insert into the focused field; expression pattern chips (constant/sine/ramp/audio-band); searchable settings table. One canonical `t` definition everywhere: *t = seconds of animation time (frames elapsed ÷ frames_per_second)*. Audio-band chips render only when `input_audio_filters` defines variables (derive availability, never document a lie).

FIRST-BOOT (once, and via ⚙): device detection (MPS), `models_parent_dir`, missing-checkpoint notice, ffmpeg check, calibration table view. Writes `studio.yaml`.

---

## 4. SETTINGS MODEL

Every field of `ConfigSchema` (`structured_config.py`) named. Schema defaults are the *only* default source, served by `/api/schema` merged with one `annotations.yaml` (label, group, type badge, short hint, long prose, relevance predicate, cost note). `app/config/default.yaml` and `load_existing()` fallbacks are deleted.

### 4.1 Bench — top-level creative controls

**PROMPT (always open)**
| Field | Presentation |
|---|---|
| `scenes` | **⚖ The editor is a `<textarea>` with an overlaid syntax-highlight `<pre>`** (INSTRUMENT's cheap trick — binding buildability call; STUDIO's block editor and PROGRESSIVE's round-trip composer are cut as the two riskiest widgets proposed). Pipes cyan, weights orange, negatives orange, masks/expressions purple, `||` rendered as a visible rule. Below it: read-only **scene map strip** (parsed scene blocks + prompt/negative counts) and the one-line DSL cheat strip. JS tokenizes for *display only*; correctness verdicts come exclusively from `/api/preflight`, which imports the engine's parser — never two grammars. |
| `interpolation_steps` | Clickable `⇄ N st (≈Ns)` chip on the scene map strip; exists only when `||` exists. Default 0. |
| `scene_prefix` | "STYLE" row (auto-pipe forgiveness kept: `_clean_prompt_field`). |
| `scene_suffix` | "AVOID" row (same forgiveness). |
| `seed` | Pinned seed strip in the bench footer: actual seed always displayed (server bakes and returns it — never blank), `LOCK` toggle, `⟳` reroll die. Recorded per session. |

**CANVAS**
| Field | Presentation |
|---|---|
| `image_model` | Three character cards (Limited Palette / Unlimited Palette / VQGAN) with one-line look description + measured s/step badge. Schema default: Unlimited Palette. |
| `width`, `height` | Size presets 256(×1)/384(×~2.3)/512(×~4.5) with cost multipliers + custom fields + aspect presets; `-1` = match init offered as link toggle when init set. |
| `vqgan_model` | VQGAN card only; picker generated from `VQGAN_MODEL_NAMES` — all 6 real entries incl. `faceshq`; alias `sflckr` accepted on load, never shown. |
| `pixel_size` | "chunk" stepper on LP card; auto-forced 1 under VQGAN with an inline note. |
| `palette_size` × `palettes` | LP sub-panel: two sliders + derived "total colors = 100". |
| `target_palette` | LP sub-panel: image picker with swatch preview. |

**START FROM**
| Field | Presentation |
|---|---|
| `init_image` | Drop-well with thumbnail (path-paste forgiveness kept; drops upload via `/api/uploads`). |
| `semantic_init_weight` | "hold on to it" slider, revealed when init set. |
| `breath_mode` | Toggle physically *inside* the well — breath-without-init is unrepresentable. |
| `direct_init_weight` | Small override row in the well (underscore-filename hazard warning inline). |

**MOTION**
| Field | Presentation |
|---|---|
| `animation_mode` | Segmented: `OFF · 2D · 3D · VIDEO` — engine vocabulary kept (**⚖** PROGRESSIVE's renames cut: they sever pytti-book/YAML mapping, per Judge 1). 3D selectable, badged `PARKED — unverified on Mac`, panel renders dimmed-but-designed; the flag lives in `/api/schema` so unparking is a data change. |
| `translate_x`, `translate_y`, `rotate_2d`, `zoom_x_2d`, `zoom_y_2d` | 2D only: EXPR fields with sparkline preview over the planned t-range + **preset chips** (drift◄/►, zoom in/out, spiral, sway) that write expressions; insertable variable chips (`t`, audio bands). |
| `translate_z_3d`, `rotate_3d`, `field_of_view` | 3D (parked) panel; `rotate_3d` as axis+deg/frame widget emitting the quaternion (raw string in engine room). |
| `video_path` | VIDEO: drop-well with duration/fps probe. |
| `frame_stride` | VIDEO: with derived "1 of every N → M output frames". |
| `pre_animation_steps` + `lock_camera` | Animated modes: one "DEVELOP FIRST: 50 st 🔒" control (defaults 50 / true). |

**COHERENCE (animated modes only)**
| Field | Presentation |
|---|---|
| `direct_stabilization_weight` | Primary "flicker ↔ ghosting" dial (low/med/high macro writing the weight; raw string in engine room). |
| `flow_stabilization_weight` | Visible in VIDEO/3D only. |

**TIME**
| Field | Presentation |
|---|---|
| `steps_per_scene` (100), `steps_per_frame` (50), `frames_per_second` (12) | **⚖** Direct inputs with engine names, plus always-visible derived readouts: total steps (× scene count from server parse), frame count, video seconds, wall-clock at calibrated s/step. No bidirectional solver (Judge 1/3: underspecified free-variable rule = data-integrity surprise); derivation flows one way, inputs→readouts. `frames_per_second` labeled "playback fps — also the time-scale of t in motion expressions". Encode inherits it. |

**ENGINE (collapsed; summary e.g. "1 CLIP · 11 s/st")**
| Field | Presentation |
|---|---|
| CLIP ensemble | Costed presets: DRAFT (`ViTB32`) / BALANCED (+`RN50x4`) / RICH (+`ViTB16`), each with measured s/step at current resolution; touching raw checkboxes flips preset to CUSTOM. |

**AUDIO (experimental, collapsed)**
| Field | Presentation |
|---|---|
| `input_audio`, `input_audio_offset` | Picker + number. |
| `input_audio_filters` | **Exposed for the first time**: band table rows (`variable_name`, `f_center`, `f_width`, `order` — `AudioFilterConfig`); defined variables become insertable chips in EXPR fields. |

### 4.2 Engine room — full depth, grouped by intent

All bench fields also appear here (same draft state), plus the fields whose *only* home is the engine room:

- **SEEING:** raw CLIP checkboxes `ViTB32, ViTB16, ViTL14, ViTL14_336px, RN50, RN101, RN50x4, RN50x16, RN50x64` (each with measured per-model s/step delta); `cutouts` (40), `cut_pow` (2), `cutout_border` (0.25).
- **OPTIMIZER:** `learning_rate` (blank=auto), `reset_lr_each_frame` (true), `gradient_accumulation_steps` (1; live-validated: must divide `cutouts`).
- **MEDIUM:** `gamma` (1), `hdr_weight` (0.01), `palette_normalization_weight` (0.2), `random_initial_palette` (false), `lock_palette` (false), `smoothing_weight` (0.02, "smooth ↔ noisy").
- **SEEDING:** `direct_image_prompts` ("image as prompt" path+weight assist).
- **CAMERA:** `sampling_mode` (bicubic), `infill_mode` (wrap), `border_mode` (clamp), `near_plane` (1), `far_plane` (10000), raw `rotate_3d` string.
- **COHERENCE:** `semantic_stabilization_weight`, `edge_stabilization_weight`, `depth_stabilization_weight` (3D only, red cost tag), `flow_long_term_samples` (1), `reencode_each_frame` (true, VIDEO only).
- **FILES:** `save_every` shown read-only as "0 = auto-match steps_per_frame" with manual override; `backups` (3) override; `file_namespace` read-only (= session id); `allow_overwrite` read-only false.
- **SYSTEM (read-mostly, mirrors studio.yaml):** `device` (auto), `models_parent_dir`, `approximate_vram_usage` (false).

### 4.3 Derived / hidden — capability kept, decision removed

| Field | Disposition |
|---|---|
| `file_namespace` | = session id. Never typed. (Engine-room read-only row.) |
| `save_every` | Sent as `0` (auto-match `steps_per_frame` — the convention pytti-core v2 already supports). |
| `display_every` | Set = effective save cadence by the server; no UI (frames stream via SSE; there is no "preview"). |
| `allow_overwrite` | Pinned `false` (schema's fail-safe posture; unique session dirs make it moot; the old UI's inverted `true` default dies). |
| `backups` | Default 3, invisible substrate of RESUME. |
| `restore` | Never a checkbox → the RESUME action on stopped cards. |
| `seed` (when unlocked) | Server rolls, bakes into YAML, returns it, displays it. |
| `device`, `models_parent_dir`, `approximate_vram_usage` | First-boot panel + `studio.yaml`. |
| `config_version` | Internal (server stamps CONFIG_VERSION=2; `session.json` carries its own `schemaVersion`). |

Nothing is deleted from the engine surface. ~30 fields disappear from the default view because the mode makes them inert; ~12 become derived readouts; every one is reachable in the engine room.

---

## 5. LIVE PROTOCOL

### 5.1 REST

```
GET  /api/schema
  → { fields: { <name>: { type:"STR|PATH|WEIGHT|EXPR|NUM|BOOL|CHOICE|LIST",
        default, choices?, group, section, label, hint, prose,
        relevantWhen?: {field, equals|in}, costNote?, parked?: bool } },
      vqganModels: ["imagenet","coco","wikiart","sflickr","openimages","faceshq"],
      configVersion: 2 }

GET  /api/draft            → { values:{...}, forkOf: "s-0411"|null, seedLocked: bool }
PUT  /api/draft            body same shape → 204   (debounced client-side ~400ms; server writes config/draft.yaml)

POST /api/preflight        body { values } →
  → { ok: bool,
      issues: [ { field, section, severity:"error"|"warn", message } ],
      estimate: { stepsTotal, frames, videoSec, wallClockSec,
                  sPerStep, basis:"measured"|"seeded", basisSession?: "s-0411",
                  calibSamples: int } }

GET  /api/sessions         → { sessions: [SessionSummary...] }   // boot scan; sidecar-cached, O(runs)
GET  /api/sessions/{id}    → SessionDetail
POST /api/sessions         body { mode:"now"|"queue"|"preempt" }
  → 201 { sessionId, seed }                       // "now" when idle
  → 202 { queued: sessionId }                     // "queue": snapshot parked in the one slot (replaces prior, noted in response)
  → 409 { error:"busy", live:"s-0412" }           // "now" while rendering → client shows QUEUE / STOP & RUN NOW
  // "preempt" = graceful stop live (terminate→5s→kill), then spawn; one 201 when spawned
POST /api/sessions/{id}/stop     → 202            // graceful terminate→wait 5s→kill; finalize session.json
POST /api/sessions/{id}/resume   → 201 { sessionId }   // respawn same dir, restore=true; requires backups
DELETE /api/sessions/{id}        → 204            // frames + sidecar + artifacts; confirm client-side
GET  /api/queue            → { queued: SessionStub|null }
DELETE /api/queue          → 204

GET  /api/sessions/{id}/frames/{n}    → image/png, Cache-Control: immutable
GET  /api/sessions/{id}/thumbs/{n}    → image/jpeg (lazy PIL, ~192px, disk-cached; posters/filmstrips use these)
GET  /api/sessions/{id}/artifacts/{f} → video/*, MUST implement Range/206 (hand-rolled)

POST /api/sessions/{id}/encode  body { fps?: int, format:"mp4"|"prores4444"|"proreshq", proxy?: bool }
  → 201 { jobId }
DELETE /api/encodes/{jobId}     → 204 (cancel)

GET  /api/presets          → { presets: [ { name, values, savedAt } ] }
POST /api/presets          body { name, values } → 201
DELETE /api/presets/{name} → 204

POST /api/uploads          multipart → { path }        // drag-dropped files land in workspace/uploads/
GET  /api/browse?path=…    → { entries:[{name,path,dir,thumb?}] }   // pickers for PATH fields

GET  /api/calibration      → { buckets: { "<w>x<h>/<clipCount>/<model>": { sPerStep, samples, lastSession } } }
GET  /api/events           → SSE (below)
```

`SessionSummary`: `{ id, slug, state:"rendering|done|stopped|failed|queued|imported", seed, startedAt, endedAt?, frames, stepsDone, stepsTotal, sPerStepAvg?, elapsedSec?, forkedFrom?, deltaSummary?: "Δ seed only"|"Δ +2 fields: scenes, cutouts", artifacts:[{name, fps, format, bytes}], imported?: bool, exitCode?, failExcerpt?: [line,line] }`.
`SessionDetail` = summary + `{ config: {…full snapshot…}, diffableAgainst: any }`.

### 5.2 SSE — `GET /api/events`

Named events, monotonic `id:`, server ring buffer (last 1000) replayed on `Last-Event-ID`; heartbeat comment every 15s; per-client queue on a ThreadingHTTPServer.

```
event: state      data: {"sessionId","state":"launching|loading_models|rendering|stopping|done|stopped|failed",
                         "seed":88213,"exitCode":0?,
                         "summary":{"steps":486,"frames":19,"elapsedSec":5520,"sPerStepAvg":11.4}?}
event: progress   data: {"sessionId","step":486,"stepsTotal":1200,"scene":1,"sceneCount":2,
                         "phase":"pre_animation|scene|interpolation",
                         "sPerStep":11.4,"etaSec":8136,"elapsedSec":5520,"nextFrameInSec":38}
                         // coalesced server-side to ≤2 Hz; ETA = EWMA of s/step, "~" client-side until ≥20 steps
event: frame      data: {"sessionId","index":19,"step":950,"url":"/api/sessions/s-0412…/frames/19",
                         "thumbUrl":"…/thumbs/19","savedTotal":19}
event: log        data: {"sessionId","line":"Running prompt: bioluminescent reef:1.5",
                         "kind":"scene|info|warn|error"}
event: queue      data: {"queued":{"id","slug"}|null}
event: encode     data: {"jobId","sessionId","framesDone":52,"framesTotal":84,
                         "state":"running|done|failed|cancelled","outUrl":"…"?}
```

Producers: the ported `_stream_output` parser (ANSI strip, `\r` collapse, noise filter, `_TQDM_RE`, it/s-vs-s/it normalization, `_SCENE_RE`) emits `progress`/`log`; a scoped 500ms scandir watcher on the *one* known session frames dir emits `frame` (fallback rate source if tqdm goes quiet). No client polling exists anywhere; `state:done` structurally kills the immortal-timer class of bug.

### 5.3 Identity & resume (the risky part, decided)

Primary: spawn with `hydra.run.dir=outputs/<session_id>` + `file_namespace=<session_id>` — one key for config, dir, namespace. **Verify in build slice 1.** Fallback if the override misbehaves: because `file_namespace` is unique per session, the server binds the session by globbing `outputs/*/*/images_out/<session_id>` after spawn — race-free (unlike "newest dir within 2s"), since only this session can create that namespace. RESUME relaunches with `restore=true` into the same run dir; if Hydra insists on a fresh dir, `session.json` records both dirs and the server stitches them into one logical frame sequence (PROGRESSIVE's flagged risk, designed for). Orphan recovery: server writes `pid` into the session dir at spawn; on boot, sessions with a pid and no live process are finalized as `stopped` (frames intact, resumable) — never leaked.

---

## 6. STATE MODEL

Single global `state`; input handlers and the SSE `onmessage` only push into `state.events`; `tick()` (rAF) drains, mutates, sets dirty flags; `render()` projects. Vibescript discipline: no strings-as-`any` — SSE payloads parsed and validated at the boundary against known shapes, fail loud on unknown event types.

```js
const state = {
  // ── boot-lifetime (fetched once at load, immutable after) ─────────────
  schema: null,            // /api/schema payload: field metadata, groups, predicates, parked flags
  calibration: null,       // /api/calibration buckets
  firstBoot: false,        // bool: show first-boot check

  // ── server-truth mirrors (lifetime: app; mutated only by SSE/REST results) ──
  sessions: { byId: {}, order: [] },   // {[id]: SessionSummary}; order newest-first
  presets: [],                         // [{name, values, savedAt}]
  queue: null,                         // {id, slug} | null — the one slot

  // ── live render (lifetime: one render; reset on state:done/stopped/failed) ──
  live: {
    sessionId: null,       // string | null — THE binding cue for PiP/status strip
    state: 'idle',         // 'idle'|'launching'|'loading_models'|'rendering'|'stopping'
    step: 0, stepsTotal: 0,
    scene: 0, sceneCount: 1,
    phase: 'scene',        // 'pre_animation'|'scene'|'interpolation'
    sPerStep: 0, etaSec: 0, elapsedSec: 0, nextFrameInSec: 0,
    frames: 0, seed: null,
    itsRing: new Float32Array(120), itsHead: 0,   // sparkline ring buffer
    logRing: [], logHead: 0,                      // capped 500 cleaned lines {line, kind}
  },

  // ── draft (server-persisted via debounced PUT; lifetime: app) ─────────
  draft: {
    values: {},            // full config field map, schema-typed
    forkOf: null,          // string | null — lineage of the *next* session
    seedLocked: true,      // fork sets true; fresh draft false
    dirtySinceRun: false,  // drives '● edited' + RUN morph
    saveTimer: 0,          // debounce handle (not serialized)
    preflight: { ok: true, issues: [], estimate: null },  // refreshed on change (debounced)
  },

  // ── selection / viewing (ephemeral, client-only) ──────────────────────
  sel: {
    sessionId: null,       // what the Stage shows; null → follow live
    frameIdx: null,        // null = follow latest; number = scrubbed/pinned
    playing: false,        // filmstrip playback at authored fps
    compare: null,         // null | { otherId, locked: true, stepOffset: 0, focus:'a'|'b' }
  },

  // ── UI shell (ephemeral) ───────────────────────────────────────────────
  ui: {
    archiveOpen: false, engineRoomOpen: false, helpOpen: false,
    inspectorOpen: false, inspectorDiffAgainst: null,   // string | null
    logOpen: false, benchCollapsed: false,
    benchSections: { prompt: true, canvas: false, startFrom: false, motion: false,
                     coherence: false, time: true, engine: false, audio: false },
    sheet: null,           // null | {kind:'encode', sessionId, fps, format} | {kind:'firstBoot'}
    toast: null,           // null | {text, actions:[{label, event}], expiresAt}
    archiveFilter: { text:'', status:'all', hasVideo:false, sort:'newest' },
    engineRoomSearch: '',
    confirmPending: null,  // null | {kind:'longRun'|'delete'|'preempt', payload}
  },

  // ── encode job mirror (lifetime: one job) ─────────────────────────────
  encode: null,            // null | {jobId, sessionId, framesDone, framesTotal, state, outUrl}

  // ── transport plumbing ─────────────────────────────────────────────────
  sse: { connected: false, lastEventId: 0 },
  events: [],              // input + SSE queue; drained fully each tick, never rendered from directly
  dirty: {},               // chunk-name → bool, set by tick, cleared by render
  now: 0,                  // performance.now() at tick start (drives springs, countdown)
};
```

---

## 7. DOM CHUNKS

`domCache` lives **outside** `state` (vibescript ui.md). Each entry commented with its cache lifetime. Stateful nodes (the scenes `<textarea>`, `<video>`, anything holding selection) are never wiped or detached.

| Chunk | domCache shape | Strategy | Driven by |
|---|---|---|---|
| `statusStrip` | permanent nodes (led, label, stop, queueChip) | **permanent** — project text/class each render; also writes `document.title` | `live`, `queue` |
| `libraryRail` | `Map<sessionId, node>` | **JIT + inline eviction** — create on first visibility, evict on scroll-out; reorder via `insertBefore` on `sessions.order` change; live card's thumb `<img src>` swapped on frame events | `sessions`, `live.frames`, `sel.sessionId` |
| `archiveGrid` | `Map<sessionId, node>` | **JIT + occlusion** (hundreds of cards × hover-filmstrips; thumbs only, lower-bound row height) | `sessions`, `ui.archiveFilter`, `ui.archiveOpen` |
| `stage` | two permanent `<img>` (double buffer) + placard node + summaryCard node | **permanent** — preload + `img.decode()` then 180ms opacity swap; never blanks; EXPOSING placard / print-data summary card are the same chunk's alternate projections | `sel`, `live`, frame events |
| `pip` | one permanent `<img>` + frame | **permanent**, `display` projected (visible ⟺ `live.sessionId && sel.sessionId !== live.sessionId`) | `sel`, `live` |
| `filmstrip` | `Map<frameIdx, node>` | **JIT + occlusion** (thumbs; strip can hold 1000+); appended on `frame` events; auto-follow unless scrubbed | `sessions[sel].frames`, `sel.frameIdx` |
| `progressDeck` | permanent nodes: sceneBar segments (wipe-recreate segments only when scene count changes), stepText, etaText, countdownText, phaseText | **permanent** text projection (mono font ⇒ no layout shimmer) | `live` |
| `sparkline` | one permanent `<canvas>` | **permanent** — redrawn from `itsRing` when dirty | `live.itsRing` |
| `logDrawer` | permanent container; row nodes appended | **append-only + trim** (cap 500, drop from top); auto-scroll unless user-scrolled (tracked in render, no MutationObserver) | `live.logRing`, `ui.logOpen` |
| `bench` | built **once at boot** from `schema` — permanent section nodes + widget nodes keyed by field name; the scenes textarea + overlay `<pre>` are permanent (stateful: selection) | **permanent** — visibility/summary/badges projected from relevance predicates + preflight issues; never recreated | `draft`, `schema`, `live.state` |
| `sceneMapStrip` | small node array | **wipe-recreate** on parse-result change (cheap, ≤ a dozen nodes) | `draft.values.scenes` parse |
| `runBar` | permanent nodes (seed strip, cost meter, run/queue buttons) | **permanent** — button morph is class+text projection | `draft.preflight`, `live.state`, `draft.dirtySinceRun` |
| `engineRoom` | `Map<fieldName, rowNode>` built on first open from schema | **JIT on first open, then permanent**; rows filter/dim by search + mode predicate | `ui.engineRoomOpen/Search`, `draft.values` |
| `compare` | second permanent `<img>` pair + scrub bar | **JIT on first compare, then permanent hidden** | `sel.compare` |
| `inspector`, `encodeSheet`, `helpDrawer`, `firstBoot` | one node each | **wipe-recreate per open** (no selection state except encode's `<video>`, which lives only while the sheet is open) | `ui.sheet`, `ui.inspectorOpen`, `ui.helpOpen`, `encode` |
| `toast` | one permanent node | **permanent**, content projected | `ui.toast` |

Rules: all DOM writes happen inside `render()`; no partial conditional mutations (every branch sets every projected prop); springs (one shared ~30-line integrator) drive drawer positions, filmstrip inertia, card entries — opacity/transform only, no `will-change`.

---

## 8. VISUAL TOKENS

CRT soul kept, codified. **⚖ INSTRUMENT's hard color rule adopted verbatim (Judges 1–2): green is reserved for engine truth** — log text and terminal DONE glyphs only; no green chrome anywhere, so the eye learns *green = the machine spoke*. Orange = cost & consequence (REC pulse, warnings, dirty state, diff highlights, negative weights, × multipliers). Cyan = interactive/live/focus. Purple = the language (EXPR/mask tokens).

```css
:root {
  /* ── palette ── */
  --ink-0:   #020a10;   /* deepest wells: inputs, stage bed */
  --ink-1:   #030c12;   /* panel plates */
  --ink-2:   #060f18;   /* app ground */
  --line:    #0d3048;   /* hairlines — 1px only, no heavy chrome */
  --text:    #5fa8be;   /* body, labels (muted teal) */
  --accent:  #00e5ff;   /* cyan: interactive, focus, live, links */
  --signal:  #ff6d00;   /* orange: cost, warnings, REC, dirty, diffs, neg weights */
  --phos:    #39ff14;   /* green: ENGINE TRUTH ONLY (log lines, DONE glyph) */
  --expr:    #a855f7;   /* purple: EXPR + mask tokens, type badges */
  --danger:  #ff3a3a;   /* stop, fail, destructive */

  /* ── type (Share Tech Mono everywhere; sized, never styled) ── */
  --font: 'Share Tech Mono', monospace;
  --fs-caption: 10px;   /* data captions */
  --fs-label:   11px;   /* uppercase labels, letter-spacing 0.08em */
  --fs-body:    13px;   /* body, fields, log */
  --fs-prompt:  15px;   /* the scenes editor — the artwork's source code gets room */
  --fs-title:   20px;   /* session ids, section heads */
  --fs-numeral: 28px;   /* progress-deck counters (tabular by mono nature) */

  /* ── spacing (4px base) ── */
  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px;  --sp-4: 16px;
  --sp-5: 24px; --sp-6: 32px; --sp-7: 48px;

  /* ── texture ── */
  --scanline-opacity: 0.04;      /* chrome only: status strip, rail/drawer headers.
                                    NEVER on artwork: stage image, thumbs, filmstrip render clean */
  --bezel: 1px solid var(--line);/* stage + PiP + thumbs get the 1px monitor frame + faint inner vignette on the BED, not the image */
  --radius: 2px;
  --glow-focus: 0 0 8px rgba(0,229,255,.2);   /* focus + live card only */

  /* ── motion ── */
  --xfade-frame: 180ms;          /* stage crossfade: opacity only, after img.decode() */
  --decay-value: 600ms;          /* phosphor decay: updated readouts flash --accent → --text */
  --spring-k: 220; --spring-c: 26;  /* drawers, sheets, card entries, scrub inertia */
}
```

Motion rules: **motion only reports state change** (PROGRESSIVE, adopted) — the REC pulse is keyed to real `progress` events, not a CSS loop; nothing idles decoratively; progress fill is critically damped (a gauge never bounces); log lines appear instantly (truth doesn't animate); numbers tick, never tween; `prefers-reduced-motion` collapses everything to opacity. Buttons keep hover-invert; RUN wears the cyan glow, STOP the red outline, FORK orange. Styled scrollbars kept.

---

## 9. INTERACTION DETAILS

**Keyboard** (single-key when no field focused; ⌘-chords always):
`R` / `⌘↵` RUN (or open the QUEUE/STOP&RUN choice when busy+dirty) · `F` fork selected session · `C` compare selected vs its parent (or prompt to pick) · `G` archive · `I` inspector · `E` engine room · `L` log drawer · `?` help · `Space` play/pause filmstrip at authored fps · `←/→` scrub ±1 frame (`⇧` ±10) · `Esc` close topmost surface / return stage to live · `⌘K` engine-room search.

**Prompt editor / DSL:** highlighted textarea (tokens: pipes cyan, weights+negatives orange, masks+expressions purple, `||` a visible rule). Lexical highlighting only in JS; red squiggles and messages come from `/api/preflight` (debounced ~600ms), which imports the engine's parser — issues carry `{field, section}` so the bench badges the right section and clicking an issue scrolls+focuses the field. Cheat strip under the editor; every token click-inserts. EXPR fields: sparkline of the expression over the planned t-range, pattern chips (constant/sine/ramp/audio-band — band chips exist only when `input_audio_filters` has rows), variable chips.

**Filmstrip / scrub:** live strip auto-follows; any scrub detaches (`[◉ LIVE]` chip pulses to return); hover a thumb = show on stage; drag has spring inertia; a stopped/done session's strip is identical — killed runs are instantly scrubbable material. Stage never blanks; frames `decode()` before the 180ms crossfade.

**RUN semantics:** idle → `▶ RUN s-NNNN` (id it will mint shown). Rendering + dirty bench → two buttons: `⧖ QUEUE s-NNNN` (snapshot into the one slot; runs on completion; re-queue replaces with toast) and `■▶ STOP & RUN NOW` (graceful stop → spawn; one act). Blocking preflight errors disable RUN with the reason inline; estimates >2h get an amber note; >8h require an explicit confirm ("≈31h — run anyway?").

**STOP:** one click, `stopping…` state, terminate→5s→kill (ported verbatim). Frames untouched; card flips to STOPPED with `▸ RESUME`; summary "print data" card renders on the stage (steps · frames · elapsed · avg s/step) — same for DONE.

**FORK:** copies the session's exact config into the draft, sets `forkedFrom`, **seed LOCKED** (exact reproduction default; the die is one click to vary), focuses the prompt. Forking a live session snapshots what's running. FORK never spawns and never queues — it only edits the draft (**⚖** PROGRESSIVE's fork-that-spends-GPU conflation rejected; RUN is the only verb that costs compute).

**Compare:** `⇧click` a second card or `C`. Side-by-side, scrub aligned by **step number**, per-side unlock, live session allowed on either side. Header: both seeds + "Δ N fields" chip → inspector diff.

**Encode:** sheet on a session; fps prefilled from the session's `frames_per_second` (override → speed warning); MP4/ProRes 4444/ProRes HQ cards with size estimates; async, SSE progress, cancellable, no timeout; done → MP4 plays inline via Range-served `<video>`, ProRes → Reveal in Finder + optional MP4 proxy; artifacts recorded on the session and replayable from its card.

**Editing while rendering** is never blocked; the bench belongs to the *next* session (lineage line + RUN-button id make the binding explicit — Judge 2's three-currents ambiguity answered: Stage shows `sel`, PiP shows `live`, Bench footer names the future).

---

## 10. BUILD PLAN

Risk-first ordering (spine before skin, per STUDIO's register). Follow vibescript engineering discipline throughout: pydantic-style parse-and-validate at every boundary (`session.json`, SSE payloads, draft PUT), fail loud, exhaustive state unions, derive-don't-rediscover.

**Slice 0 — verification spikes (throwaway scripts, before any UI):**
1. Spawn `python -m pytti.workhorse conf=<preset> hydra.run.dir=outputs/s-test file_namespace=s-test` — verify frames land where expected. If not, implement the namespace-glob fallback binding.
2. Verify `restore=true` + `backups` resume behavior and frame numbering continuation; record dir-stitching needs.
3. Confirm the ported tqdm regex against current pytti-core v2 stdout.

**Slice 1 — `app/server.py` (stdlib only; one file, sectioned):**
1. `ThreadingHTTPServer` + static file serving from `app/static/`.
2. SSE hub: per-client queues, monotonic ids, 1000-event replay ring, `Last-Event-ID`, 15s heartbeats, disconnect cleanup.
3. Subprocess manager: spawn (seed bake+return, YAML snapshot, `pid` file, `session.json` stub), stdout parser thread (port `_stream_output`, `_TQDM_RE`, `_SCENE_RE`, ANSI/`\r`/noise handling verbatim from `ui.py`), graceful stop, one-slot queue, orphan recovery on boot.
4. Frames watcher (500ms scandir on the one live dir) → `frame` events; `session.json` finalize with summary; `measurements.json` calibration append.
5. Session store: boot scan (sidecars, O(runs)), legacy `outputs/<date>/<time>` adoption, `SessionSummary/Detail` endpoints, delete, Δ-vs-parent computation.
6. `/api/schema`: attrs introspection of `ConfigSchema` + `annotations.yaml` merge (write `annotations.yaml` now: labels/groups/prose migrated from TIPS + HELP_SECTIONS, contradictions reconciled — one `t` definition).
7. `/api/draft` (autosave), `/api/preflight` (import engine parsers; DSL, paths, grad-accum ∣ cutouts, VQGAN⇒pixel_size, breath⇒init; estimate with basis), `/api/presets`, `/api/uploads`, `/api/browse`, `/api/calibration`.
8. Image serving: PNG immutable, lazy PIL JPEG thumbs with disk cache.
9. Encode jobs: ffmpeg `-progress` pipe → SSE, cancel, artifact registration (port pattern/start-number autodetect + codec presets from `ui.py`); **hand-rolled Range/206** for artifacts.

**Slice 2 — `app/static/index.html`:** static shell — three-column grid, permanent chunk roots (status strip, library, stage+filmstrip+deck+log, bench, runBar, overlay roots), font link, `<script type=module>`.

**Slice 3 — `app/static/app.js` (game loop first, features after):**
1. Core: `state`, `domCache`, event queue, `tick()`/`render()` rAF loop, dirty flags, spring integrator, SSE client with reconnect+replay, fetch helpers with boundary validation.
2. Status strip + stage (double buffer, decode-then-fade, EXPOSING placard, summary card, tab title).
3. Bench generated from schema (widgets by type badge, relevance predicates, self-summaries, section badges), scenes editor (textarea+overlay tokenizer), scene map strip, seed strip, cost meter, RUN morph + queue/preempt flows, preflight wiring.
4. Library rail + `frame`/`state`/`progress` event handling; filmstrip with occlusion; progress deck + sparkline + countdown; log drawer.
5. Archive grid, hover-scrub, lineage view; inspector + diff; compare (step-aligned).
6. Engine room (JIT from schema, search, modified ticks); help drawer (click-to-insert); encode sheet; first-boot check; presets menu; starter ghost drafts.

**Slice 4 — `app/static/style.css`:** tokens (§8), layout, chunk styles, scanline-on-chrome overlays, focus glow, reduced-motion.

**Slice 5 — integration passes:** golden-test preflight against engine parse on a corpus of real scene strings; calibration accrual; legacy import on the existing `app/outputs`; launch scripts point at `python -m app.server`.

**What dies:** `app/ui.py` (all 1299 lines — parser/encode/forgiveness organs ported into `server.py` first), `app/patch_gradio.py`, the gradio dependency (installer + any requirements/lockfiles), `app/config/default.yaml` (schema is the only default source; `app/config/conf/` remains as the presets dir), the 3s `gr.Timer`, the 600s encode guillotine, the `**/images_out` glob poll.

---

## 11. CUT LIST

| Cut | Justification |
|---|---|
| Config-name textbox + save/load/refresh dropdown cluster | Sessions auto-name; presets are optional bookmarks in a menu. Naming as a workflow gate is the audit's #1 friction. |
| The 7-tab layout, Run tab, Output tab, FAQ tab | One screen; help became a property of every field + the `?` drawer. |
| Manual `file_namespace` field | Derived from session id; read-only engine-room row. |
| `allow_overwrite` toggle (UI default `true`) | Unique session dirs make it moot; pinned to the schema's fail-safe `false`. Inverted-default hazard eliminated. |
| Second encode-FPS field defaulting to 30 | Encode inherits the session's `frames_per_second`; override survives but wears a motion-speed warning. The 12-vs-30 silent 2.5× trap dies. |
| 3-second preview poll + Refresh button + `display_every` control | Frames push via SSE from the session's own dir; stale-frame lie structurally impossible. |
| `app/config/default.yaml` + `load_existing()` hard-coded fallbacks | Three competing default sets collapse to the schema, served once by `/api/schema`. |
| Raw `save_every` / `backups` / `restore` / `device` / `models_parent_dir` / `approximate_vram_usage` as everyday form fields | Derived, fixed, action-ified (RESUME), or moved to first-boot/system — capability intact, decision removed. |
| STUDIO's structured scene-block editor & PROGRESSIVE's lossless structured↔raw composer | Binding buildability call: the round-trip widget is the most expensive, most fragile item any concept proposed and degrades to a textarea anyway once weights are `t`-expressions. The highlighted textarea + parsed scene map delivers ~80% of the learnability at ~10% of the cost. |
| Client-side DSL *validation* (INSTRUMENT's red underlines from a JS grammar) | Never two grammars: JS tokenizes for color only; every correctness verdict comes from `/api/preflight` importing the engine parser. |
| Compare wipe handle + progress-fraction lockstep | Wipe is meaningless across resolutions; fraction alignment compares unequal compute. Side-by-side, step-number aligned, per-side unlock. |
| Petname ids + editable session titles + rename | One self-describing name (`s-NNNN-<prompt-slug>`); Judge 2's naming creep resolved by deletion. |
| "Drop the phantom faceshq entry" (INSTRUMENT) | Factually wrong — `faceshq` is in `VQGAN_MODEL_NAMES`. Picker derives from the module; only the `sflckr` alias is hidden. |
| Renamed vocabulary (DRIFT/FLIGHT/RIDE VIDEO, LOOK/FRAME/LENGTH) | Severs users from pytti-book, community presets, and the YAML they'll still read. Engine terms kept with plain-language sublabels. |
| Bidirectional TIME solver | No stated free-variable rule = data-integrity surprise where mistakes cost hours. One-way derive: engine inputs → readouts. |
| Fork-as-queued-run + long-press seed chooser | FORK only edits the draft; RUN is the only verb that spends GPU. Long-press is undiscoverable on desktop; seed choice is the always-visible LOCK/die. |
| Full-viewport scanlines | They fight the artwork. CRT texture lives on chrome; frames render clean behind a 1px bezel. |
| Decorative/idle animation (CSS-loop pulses, spinners) | In a tool defined by waiting, ambient fake motion is a lie about progress. The heartbeat is keyed to real `progress` events. |
| Gradio, `patch_gradio.py`, the immortal timer, the 600s encode timeout | Replaced wholesale by the stdlib server + SSE + async jobs. |