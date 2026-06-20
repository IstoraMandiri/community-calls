---
name: videogen
description: Turn a freshly-recorded call (mp4/audio + VTT) into a published call page (cleaned transcript, chapters, AI summary) and a rendered video, step by step with confirmation at each stage
---

# Videogen Skill

One-shot, interactive pipeline that takes a just-recorded episode from raw
files to (a) a committable call markdown — cleaned transcript + `NOTE chapters`
+ AI summary — and (b) a rendered MP4 for download.

**Operate one step at a time and CONFIRM with the user before moving on.** Show
proposed changes, let them edit, then proceed. Never auto-advance through the
whole pipeline.

## Arguments

`$ARGUMENTS` — optionally the paths to the recording and transcript, e.g.
`/videogen ~/Downloads/call54.mp4 ~/Downloads/call54.vtt`. If absent, ask for
them. An explicit audio file may be passed instead of the mp4
(`--audio path.m4a`); otherwise audio is extracted from the mp4.

## Conventions (ground truth)

- Call markdown: `calls/<YYYYMMDD>_<NNN>.md` (the agenda usually already exists).
- Call number `NN` drives all videogen paths.
- **All per-episode artifacts are named `<NN>-<thing>.<ext>`** (self-identifying
  out of context), under `public/videogen/<NN>/`:
  - `<NN>-audio.mp3` — compressed mono (64k) distributable audio. **Committed.**
  - `<NN>-audio.m4a` — raw/working audio (70MB+). **Gitignored.**
  - `<NN>-raw.vtt` — the unedited reference transcript. **Committed.**
  - `<NN>-out-<stamp>.mp4` — rendered video. **Gitignored.**
- **Speaker registry** (top-level `speakers/`, committable): `speakers/speakers.yaml`
  maps a short key → `{ displayName, aliases: [...], avatar: <file>, github }`,
  with the avatar images co-located next to it in `speakers/` (e.g.
  `speakers/istora.png`). One `resolveSpeaker(name)` (`src/lib/videogen/speakers.ts`)
  matches a name against key/displayName/aliases and returns the served avatar
  URL; it's used by the endpoints and the call-page roster.
- The page derives job/meta/transcript from the markdown via the dev-only
  endpoints in `src/pages/videogen/[call]/`. **Do not** write
  `public/videogen/<NN>/{job,meta,transcript}` files — the markdown is the
  single source of truth (and the job points at `<NN>-audio.mp3`).
- The call-page **roster** + the video participants both read frontmatter
  `roster: [name, ...]`, resolved through the registry.
- ffmpeg is available via the `ffmpeg-static` dependency.
- **Committable:** the markdown, `<NN>-audio.mp3`, `<NN>-raw.vtt`,
  `speakers/speakers.yaml` + new avatars. **Never commit:** `<NN>-audio.m4a`,
  `<NN>-out-*.mp4`. Only commit/push when the user explicitly asks.

## Step 0 — Identify the call (confirm)

`$ARGUMENTS` may be a bare call number, file paths, or both. Resolve the call
number first (from args, filenames, or by asking).

1. Find the call's markdown in `calls/` (match the `number:` frontmatter). If
   none exists, ask the user to create the agenda first (or offer
   `/draft-agenda`).
2. **Published-call guard — STOP if already published.** If the markdown
   already contains BOTH a `# AI Summary` section AND a ```` ```webvtt ````
   transcript block, this call has already been processed. Do **not** proceed:
   warn the user that re-running would overwrite published transcript/summary
   content, and recommend quitting. Only continue if the user explicitly
   insists (e.g. for testing), and never on a real published call.
3. Read the most recent *completed* call (one that already has a `# AI Summary`
   and a `webvtt` transcript) — it is the **style template** for the summary and
   section structure. Replicate it exactly.
4. Confirm the call identity (number, title, date) with the user.
5. Ensure the `youtube:` frontmatter is set (11-char video ID). The transcript
   timestamps deep-link to YouTube, so if the video is uploaded, ask for the ID
   and write it to frontmatter. If not uploaded yet, note that links will be
   inert until it is.

## Step 1 — Ingest (then report)

Get the source audio into a working file `public/videogen/<NN>/<NN>-audio.m4a`
(gitignored), by priority:

- **Dropped mp4/recording** — extract audio with ffmpeg-static.
- **`--audio path`** — copy/transcode that file.
- **No file, but `youtube:` is set** — pull from YouTube with yt-dlp. Its
  `-x`/`--audio-format` post-processing needs ffmpeg on PATH (not available
  here — only `ffmpeg-static`), and a bare download is often a DASH m4a that
  won't decode in the browser. So download the raw m4a stream only:
  ```bash
  yt-dlp -f 'bestaudio[ext=m4a]/140/bestaudio' -o public/videogen/<NN>/<NN>-audio.m4a "https://youtu.be/<ID>"
  ```
  (If `yt-dlp` isn't installed, fetch the standalone binary to a temp path and
  run it from there; it is not a managed project dependency.)

Then produce the **committed, distributable audio** — compressed mono mp3 — from
whatever working file you have. Resolve the ffmpeg path first
(`FF=$(node -e "console.log(require('ffmpeg-static'))")`) and run it directly:
```bash
"$FF" -y -i public/videogen/<NN>/<NN>-audio.m4a -vn -ac 1 -b:a 64k public/videogen/<NN>/<NN>-audio.mp3
```
`<NN>-audio.mp3` is what the page/driver use and what gets committed; the
`<NN>-audio.m4a` is just the gitignored working copy.

Then read the raw VTT and report a quick summary: cue count, total duration, and
the **distinct speaker labels**, marking which don't resolve via the registry
(`speakers/speakers.yaml`).

## Step 2 — Clean the transcript + speakers (review, confirm)

1. **Archive the raw transcript first, before any edits.** Copy the original
   dropped VTT verbatim to `public/videogen/<NN>/<NN>-raw.vtt` — this is the
   immutable reference (committable text). Never overwrite it on re-runs. The
   cleaned version goes into the markdown; `<NN>-raw.vtt` stays as the unedited
   source of record, so the diff between published and raw is always auditable.
2. **Deterministic pre-pass — run BEFORE the agents (plain code, no LLM).**
   Two transforms that are mechanical, repeatable, and cheaper done in code;
   they also make the agents' job easier (whole sentences, canonical labels):
   - **Normalize known speaker labels** against `speakers/speakers.yaml` — map
     every label that resolves (key / displayName / alias, case-insensitive) to
     the canonical `displayName`. A label that does **not** resolve is left
     untouched and surfaced in item 4 (new-speaker handling); never guess here.
   - **Group cues to sentence boundaries** — merge a run of consecutive
     **same-speaker** cues into one block whenever the earlier cue does not end
     at a sentence boundary (`.`/`?`/`!`, optionally a closing quote), capping at
     ~two sentences per block and stopping at a speaker change or a large pause.
     The block keeps the first cue's start and the last cue's end (both real raw
     boundaries — nothing invented). This is the **only** structural change, and
     it collapses the 800+ ASR fragments into clean sentence blocks.
   The normalized, sentence-grouped **blocks** are what get chunked next.
3. **Analyze the blocks with a dynamic workflow — chunked, not
   sentence-by-sentence.** A single whole-file pass (or a per-sentence pass)
   reliably misses things: it lets homophones through (`miners`/`minors`),
   leaves garbled orphan fragments in, and spells the same name three different
   ways across the call. Instead, fan the work out over a **dynamic workflow**
   (the `Workflow` tool — this skill is your opt-in to call it; you do **not**
   need the user to say "ultracode"):
   - **Chunk the grouped blocks by range.** Split into **~50 contiguous chunks**
     (`ceil(totalBlocks / 50)` blocks each), **never splitting a block**. Each
     chunk carries its real block numbers + timestamps so every fix maps back.
   - **One agent per chunk, on Sonnet or Haiku.** `pipeline()`/`parallel()` the
     chunks through a flag-and-analyze agent (`model: 'haiku'` by default;
     `'sonnet'` for a dense/technical call). Give **every** agent the same
     shared context so fixes are consistent chunk-to-chunk: the registry display
     names + aliases, the known proper-noun glossary for this project
     (`Ethereum Classic`, `ethereumclassic.org`, `dApp`, EIP/ECIP numbers,
     `2Miners`, `Antpool`, the speaker names), and the fix rules below. Each
     agent returns **structured** findings (schema), not rewritten prose.
   - **Fix rules** each chunk agent applies (keep timestamps untouched):
     - **Mis-heard proper nouns**, e.g. "Sim Classic" → "Ethereum Classic",
       "theoremclassic.org" → "ethereumclassic.org", "DAP" → "dApp",
       "nulllympia"/"noOlympia" → "nolympia", "AMP pool" → "Antpool", "two
       miners" → "2Miners", a speaker's own name slip ("Astora" → "Istora").
     - **Homophones in context**, e.g. "base fee refund for minors" → "miners".
     - **Garbled / orphan fragments** — a stray one-word cue ("bomb.") or a
       mis-segmented phrase ("real estateless one" → "real stateless one") gets
       flagged for repair or merge, not left verbatim.
     - **Stutters / repetitions** — collapse "why, why, why are we, why are we
       assuming that? Why are we assuming that?" to "Why are we assuming that?".
     - Light punctuation/casing. Preserve meaning; don't paraphrase substance.
     - **Flag (don't relabel) speaker labels** — the pre-pass already normalized
       known ones. Surface anything still unresolved or a label that looks
       mis-attributed (e.g. a diarization glitch splitting one person's turn) for
       item 4; do not silently relabel cues.
   - **Cross-chunk consistency pass (required).** After aggregating, run one
     reconciliation step (a final agent, or plain code) over the *union* of
     findings to make every recurring name/term uniform across the whole call —
     e.g. `Wego`/`WeGo`/`Wigo` → one spelling, `Luna`/`Lunar` → one. This is the
     class of error the chunking exists to catch and that a single pass drops.
   Each chunk agent splits its findings into **two buckets**:
   - **Confident** — clear ASR errors, obvious proper nouns, homophones fixed by
     context, plain de-stutter. Apply these directly.
   - **Flagged (needs user input)** — collect, do NOT silently apply: any
     name/proper-noun you can't verify from context or the reference calls, any
     garbled cue whose repair **risks changing its meaning**, and any term the
     consistency pass found spelled inconsistently with no obvious canonical
     form. For each, record the cue number/time, the raw line, your proposed
     fix, and a one-line reason it's uncertain.

   Sketch of the workflow each chunk agent returns against:
   ```js
   const FINDINGS = { type: 'object', properties: {
     confident: { type: 'array', items: { type: 'object', properties: {
       cue: {type:'number'}, time: {type:'string'}, raw: {type:'string'},
       fixed: {type:'string'}, kind: {type:'string'} } } },   // proper-noun | homophone | destutter | orphan | speaker-label | punctuation
     flagged:   { type: 'array', items: { type: 'object', properties: {
       cue: {type:'number'}, time: {type:'string'}, raw: {type:'string'},
       proposed: {type:'string'}, reason: {type:'string'} } } },
   } }
   const results = await pipeline(chunks,
     c => agent(`${SHARED_CONTEXT}\nAnalyze these cues, return findings:\n${c.text}`,
                {label: `clean:${c.firstCue}-${c.lastCue}`, model: 'haiku', schema: FINDINGS}));
   // aggregate, then a consistency-reconciliation agent over the union, then apply confident / present flagged
   ```
4. **New speakers:** for every speaker label that doesn't resolve via the
   registry, highlight it and ask the user, per speaker:
   - is it a mis-transcription of a known speaker (→ add as an `alias` on that
     speaker), or a real new person?
   - if new, **prompt for an avatar image URL**, download it next to the yaml,
     and register:
     ```bash
     curl -L -o speakers/<key>.<ext> "<url>"
     ```
     then add a `speakers/speakers.yaml` entry:
     ```yaml
     <key>:
       displayName: <Name>
       aliases: [<any variant spellings>]
       avatar: <key>.<ext>
     ```
     If the user has no avatar, omit `avatar` — the roster falls back to
     initials.
5. Show a **representative sample** of the confident cleanup (not all blocks)
   and the resolved speaker list, **and present the flagged (uncertain) fixes** —
   block/time, raw line, proposed fix, reason — for the user to confirm, correct,
   or reject **one by one**. Apply their decisions before writing.
6. **Propose the roster** — the distinct people who actually spoke, as canonical
   display names. Curate out noise: someone merely quoted, or a chat-only
   participant who was relayed but never has their own cues, shouldn't be on the
   roster. Confirm the list with the user; it's written to frontmatter in
   Step 5 and drives both the call-page roster and the video.
7. **Write the cleaned transcript into the markdown now** — a `## Full
   Transcript` section with the cleaned, sentence-grouped cues in a
   ` ```webvtt ` block (no `NOTE chapters` yet) — and have the user **review it
   rendered** at `/calls/<NN>` (it renders flat via `remark-webvtt`; no extra
   component or import is needed — keep it inline). This is an intermediate gate:
   get the transcript right before adding chapters. Then proceed to Step 3, which
   prepends the `NOTE chapters` block to this same block.
8. **Validate the constructed VTT — required gate, before the rendered review.**
   Run the structural validator and resolve every **ERROR** before showing the
   user the transcript:
   ```bash
   node scripts/videogen-validate.mjs calls/<YYYYMMDD>_<NNN>.md \
     --raw public/videogen/<NN>/<NN>-raw.vtt
   ```
   It parses the ` ```webvtt ` block exactly as the site/render do
   (`src/lib/videogen/{vtt,chapters}.ts`) and checks: WEBVTT header present;
   every timestamp well-formed with `start <= end`; cues in non-decreasing
   order; no empty cues; **timestamp-boundary parity against `<NN>-raw.vtt`** —
   every cleaned block's start and end must be a real raw boundary, the run must
   cover the same span end-to-end with no gaps or overlaps, so the only thing
   grouping changed is which boundaries were *kept* (it proves no timestamp was
   invented and no audio span dropped); and every speaker label resolves via
   `speakers/speakers.yaml` (an unknown label is either a new speaker or an ASR
   name slip — handle it in item 4 above, do not leave it dangling). It also
   **WARNs on any same-speaker block that ends mid-sentence and continues in the
   next block** — those are the mid-sentence cuts the item 2 pre-pass should have
   merged.
   Errors fail the gate; warnings are advisory. Re-run until clean, then do the
   rendered review. (At this point there are no chapters yet, so the chapter
   checks are skipped — they run again in Step 3.)

## Step 3 — Chapters (discuss, then confirm)

1. From the cleaned transcript, draft chapters as a `NOTE chapters` block —
   `[h:]mm:ss Title`, one per line, on the displayed timeline:
   ```
   NOTE chapters
   0:00 Welcome
   8:30 ...
   ```
   **Aim for ~10 chapters maximum.** Favour a small number of coherent chapters
   over fine-grained ones, and **do not needlessly separate** closely-related
   discussion — merge short adjacent topics (housekeeping, a brief aside, two
   halves of one debate) rather than splitting them. Don't carve a 30-second
   aside into its own chapter.
2. **Sanity-check every boundary against the actual cues — required, and
   enforced by the validator.** Chapters must *bookend* dialogs:
   - Each chapter start MUST be the **exact start timestamp of a cue**, and that
     cue must be the **first cue of a speaker's turn** that opens the topic.
     Never a round-number guess (`30:00`, `45:00`), never mid-turn, never
     mid-sentence. A round minute almost never coincides with a real cue start —
     if your boundary is a round number, it is wrong.
   - A new chapter begins where the previous topic has clearly concluded and a
     new one is introduced (a different speaker taking the floor, or a host
     pivoting with "so, the next thing…").
3. **Iterate the chapters against the validator until it passes — required
   loop.** After writing the draft `NOTE chapters` block, run:
   ```bash
   node scripts/videogen-validate.mjs calls/<YYYYMMDD>_<NNN>.md
   ```
   For every chapter ERROR it reports the **nearest real cue** (timestamp +
   speaker + text); for a boundary that landed mid-turn it WARNs. Iterate:
   - **Snap** each off-grid boundary to a real cue start — but not blindly to
     the nearest one. Read the cues around it and pick the cue that actually
     **opens the topic** (a speaker taking the floor / a host pivoting). The
     nearest cue is often mid-thought; the right one may be a few cues earlier or
     later. If the validator says "Green-room poker @ 3:00 → nearest cue is
     website-revamp dialogue", that is the tell that the *content* is mislabeled,
     not just the number — fix the title or move the boundary to where the topic
     truly starts.
   - Re-run until **zero chapter errors**. A mid-turn WARN is acceptable *only*
     when the boundary is a deliberate host pivot (the same host monologuing
     from one topic into the next, e.g. "Okay, so — onto the website"); for any
     other mid-turn warning, move the boundary to a turn-opening cue.
   To choose the right opening cue, dump the cues as `mm:ss Speaker | text`
   around each candidate and confirm it is a turn-opening line on the new topic.
4. **Offer the user ~3 grouping options at different granularities — do not
   present a single draft.** Chaptering is a judgement call about how finely to
   slice the call, so surface the trade-off explicitly. First **explain the
   rationale** (chapters drive both the website's chaptered transcript and the
   video's chapter chip/TOC; they should bookend coherent topics, open on a real
   turn, and stay scannable), then present three **already-validated** options:
   - **Coarse** (~5): macro topics only; merges small adjacent threads
     (intro+housekeeping, two halves of one debate). Best for a short TOC.
   - **Balanced** (~7): one chapter per major topic — usually mirrors the
     `# AI Summary` subsections one-to-one. The default.
   - **Fine** (~10): splits long blocks at real sub-pivots (e.g. a topic's
     walkthrough vs. the debate it triggers). Best for a long, multi-thread call.
   Every option must pass the validator (zero chapter errors) before you show it.
   For each, give a one-line rationale and the full `mm:ss Title` list, and use
   an interactive prompt so the user can pick one — or mix (take Balanced, split
   chapter 5). Then **iterate as a conversation**: retitle, merge, move split
   points, re-running the validator after any edit. Only finalize / write the
   `NOTE chapters` block once the user has chosen **and the validator is clean**.

## Step 4 — AI summary + key points + blurb (review, confirm)

From the cleaned transcript, generate, matching the template call's format
exactly:
1. The `# AI Summary` section (structured subsections with **Details** /
   **Conclusion**, mirroring the template).
2. The `## Key Points Discussed` bullets.
3. A short 1–2 sentence `summary:` blurb for the video's summary slide.
Show each; get approval. Follow the writing style in `AGENTS.md`.

## Step 5 — Write the markdown (the one committable artifact)

By now the cleaned transcript (Step 2) and the `NOTE chapters` block (Step 3)
are already in `calls/<...>_<NNN>.md`. This step adds the rest, preserving the
existing frontmatter and agenda:
1. `summary:` blurb + `roster:` (the confirmed list from Step 2.6) → frontmatter;
   ensure `youtube:` is set.
2. The `# AI Summary` and `## Key Points Discussed` sections.
Tell the user it's saved (all text, no media) and offer to iterate. Do **not**
commit unless asked.

## Step 6 — Render (confirm; draft then final)

**Do not edit any source or markdown files while a render is running.** The
render drives the live dev page; saving a file triggers HMR, which reloads the
page mid-capture and aborts the render ("Execution context was destroyed").
Finish all writes (Step 5) first, then render untouched.

1. Ensure the dev server is running (`npm run dev -- --host 0.0.0.0`); note the
   port.
2. Offer a fast **draft** first to eyeball layout, then the final. The draft
   stays under `public/videogen/<NN>/` (gitignored); the **final** renders to the
   clean handoff name at the **public root** — `<YYMMDD>-etccc-<NN>.mp4` (`date`
   frontmatter without dashes, last two year digits) — so the dev-server download
   URL is tidy and self-identifying. That name is gitignored too
   (`public/*-etccc-*.mp4`).
   ```bash
   # draft (fast): low fps, can cap length with --duration <sec>
   node scripts/videogen.mjs --realtime --job /videogen/<NN>/job.json \
     --out public/videogen/<NN>/<NN>-draft.mp4 --fps 30 --port <port> [--duration 60]
   # final
   node scripts/videogen.mjs --realtime --job /videogen/<NN>/job.json \
     --out public/<YYMMDD>-etccc-<NN>.mp4 --fps 60 --port <port>
   ```
   The render is real-time (wall-clock ≈ audio length).

## Step 7 — Output / handoff (serve + paste-ready YouTube block)

The pipeline's final act: hand the user a downloadable video and everything they
need to publish it. Keep the dev server running so the render is served, then
print the handoff block:
```bash
node scripts/videogen-handoff.mjs calls/<YYYYMMDD>_<NNN>.md --port <port>
```
It reads the markdown (frontmatter + the `NOTE chapters` block) and emits, ready
to copy-paste:
- the **download URL** (`http://localhost:<port>/<YYMMDD>-etccc-<NN>.mp4`),
- the **video title** (`<title> - Ethereum Classic Community Call #<N>`),
- the **summary** blurb (the YouTube description body),
- the **chapters** in YouTube format — **first line forced to `0:00`** (YouTube
  requires it; our timeline opens a few seconds in), the rest on the real
  timeline, and
- the **call-page URL** to link back to the transcript.
Present that block verbatim and tell the user: download the video from the URL,
upload it to YouTube, then paste the title / summary+chapters / link into the
YouTube fields. (YouTube derives chapter markers from the description timestamps;
it ignores any chapters embedded in the file, so the description is the way.)
Once the video is up, capture the 11-char id into `youtube:` frontmatter so the
transcript timestamps deep-link correctly.

## Important notes

- Confirm at every gate; never run the whole pipeline unattended.
- Single source of truth is the markdown — never write the legacy
  `public/videogen/<NN>/{job,meta,transcript}` files.
- Never commit or push media. Markdown / `speakers/` (yaml + avatars) are
  committable, but only commit when the user asks.
- If you touched wired code (endpoints, `speakers/speakers.yaml`), it's already
  wired; just verify the page boots against `/videogen/<NN>/job.json` and the
  roster resolves.
