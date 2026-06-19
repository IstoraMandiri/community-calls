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
2. Produce a cleaned VTT (this is what goes into the markdown) and keep
   timestamps untouched. Fix:
   - **Mis-heard proper nouns**, e.g. "Sim Classic" → "Ethereum Classic",
     "nulllympia"/"noOlympia" → "nolympia", "AMP pool" → "Antpool", "two miners"
     → "2Miners", a speaker's own name slip ("Astora" → "Istora").
   - **Stutters / repetitions** — collapse "why, why, why are we, why are we
     assuming that? Why are we assuming that?" to "Why are we assuming that?".
   - Light punctuation/casing. Preserve meaning; don't paraphrase substance.
   - **Normalize speaker labels** against the registry (merge variants like
     `Istora` / `Istora Mandiri` to the canonical `displayName`; add new
     spellings as `aliases` rather than relabeling cues if both are valid).
   For a long transcript, do this in chunks or via a sub-agent.
   **Split fixes into two buckets:**
   - **Confident** — clear ASR errors, obvious proper nouns, plain de-stutter.
     Apply these directly.
   - **Flagged (needs user input)** — collect, do NOT silently apply: any
     name/proper-noun you can't verify from context or the reference calls, and
     any edit that rephrases a garbled cue enough to **risk changing its
     meaning**. For each, record the cue number/time, the raw line, your
     proposed fix, and a one-line reason it's uncertain.
3. **New speakers:** for every speaker label that doesn't resolve via the
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
4. Show a **representative sample** of the confident cleanup (not all cues) and
   the resolved speaker list, **and present the flagged (uncertain) fixes** —
   cue/time, raw line, proposed fix, reason — for the user to confirm, correct,
   or reject **one by one**. Apply their decisions before writing.
5. **Propose the roster** — the distinct people who actually spoke, as canonical
   display names. Curate out noise: someone merely quoted, or a chat-only
   participant who was relayed but never has their own cues, shouldn't be on the
   roster. Confirm the list with the user; it's written to frontmatter in
   Step 5 and drives both the call-page roster and the video.
6. **Write the cleaned transcript into the markdown now** — a `## Full
   Transcript` section with the cleaned cues in a ` ```webvtt ` block (no
   `NOTE chapters` yet) — and have the user **review it rendered** at
   `/calls/<NN>` (it renders flat via `remark-webvtt`; no extra component or
   import is needed — keep it inline). This is an intermediate gate: get the
   transcript right before adding chapters. Then proceed to Step 3, which
   prepends the `NOTE chapters` block to this same block.

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
2. **Sanity-check every boundary against the actual cues — required.** Chapters
   must *bookend* dialogs:
   - Each chapter start MUST be the exact start timestamp of the **first cue of
     a speaker's turn** that opens the topic. Never place a boundary in the
     middle of a continuous speaker turn / mid-sentence.
   - A new chapter begins where the previous topic has clearly concluded and a
     new one is introduced (a different speaker taking the floor, or a host
     pivoting with "so, the next thing…").
   To verify, dump the cues as `mm:ss Speaker | text` and confirm the cue at
   each chosen timestamp is a turn-opening line on the new topic.
3. **Discuss the chapters with the user before confirming — do not treat the
   first draft as final.** Present the proposed list with a one-line rationale
   for the boundaries, and explicitly invite feedback: too many/few, wrong
   split points, retitles, merges. Work through it as a conversation and only
   finalize / write it in once the user is satisfied. This block feeds **both**
   the website's chaptered transcript and the video's chapter chip/TOC.

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
1. `summary:` blurb + `roster:` (the confirmed list from Step 2.5) → frontmatter;
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
2. Offer a fast **draft** first to eyeball layout, then the final:
   ```bash
   # draft (fast): low fps, can cap length with --duration <sec>
   node scripts/videogen.mjs --realtime --job /videogen/<NN>/job.json \
     --out public/videogen/<NN>/<NN>-out.mp4 --fps 30 --port <port> [--duration 60]
   # final
   node scripts/videogen.mjs --realtime --job /videogen/<NN>/job.json \
     --out public/videogen/<NN>/<NN>-out.mp4 --fps 60 --port <port>
   ```
   The render is real-time (wall-clock ≈ audio length). The output filename is
   auto-stamped (`<NN>-out-<stamp>.mp4`).
3. Give the user the download URL:
   `http://localhost:<port>/videogen/<NN>/<NN>-out-<stamp>.mp4`, and note it's
   gitignored.

## Important notes

- Confirm at every gate; never run the whole pipeline unattended.
- Single source of truth is the markdown — never write the legacy
  `public/videogen/<NN>/{job,meta,transcript}` files.
- Never commit or push media. Markdown / `speakers/` (yaml + avatars) are
  committable, but only commit when the user asks.
- If you touched wired code (endpoints, `speakers/speakers.yaml`), it's already
  wired; just verify the page boots against `/videogen/<NN>/job.json` and the
  roster resolves.
