# TODO

## Inline audio player (videogen-driven, no YouTube)

Upload MP3s of all episodes and build a **dynamic in-browser playback
component** that reuses the videogen stage but is driven by `mp3 + JS` in real
time instead of a pre-rendered MP4. The result is a nice inline player embedded
on the call pages (and/or archive) that shows the synced visuals — roster with
active-speaker focus, captions, chapter chip, audioMotion viz, pre/post-roll
slides — **without relying on a YouTube embed**.

### Why
- Removes the dependency on YouTube for playback on our own site.
- We already render these visuals; this surfaces them live instead of only as a
  downloadable MP4.
- One source of truth: the call markdown already provides transcript, chapters,
  participants, and summary via the videogen endpoints.

### The good news: most of this already exists
The videogen **preview transport** (`src/lib/videogen/preview.ts`) is already a
browser player: it plays the audio element, drives the unified timeline
(preroll slides → main → postroll), syncs the roster/subtitles/chip/viz, and
scrubs across the whole thing. Productionizing it as an embeddable component is
mostly extraction + packaging, not new rendering work.

### Rough plan
- [ ] **Audio hosting** — upload per-episode MP3s somewhere durable and cheap
      (decide where: object storage / CDN; NOT committed to the repo — same
      policy as the gitignored `.m4a`/`.mp4`). Wire a stable per-episode URL.
- [ ] **Extract a reusable player** from `videogen.astro` + `preview.ts` — a
      self-contained component (stage markup + boot) that takes a job
      (`/videogen/<NN>/job.json` from the existing endpoints) and an audio URL,
      and runs the live transport. Drop the dev-only gating for this path.
- [ ] **Embed on call pages** — an inline `<VideogenPlayer call={n} />` that
      lazy-loads (audioMotion, audio decode) and is responsive (the stage is
      authored at 1920×1080; scale it down to fit the content column).
- [ ] **Make it not dev-only** — currently the route + endpoints are stripped
      from prod by the build hook. The player path needs to ship: serve the
      job/meta/transcript (already markdown-derived) in prod, keep the heavy
      render driver dev-only.
- [ ] **Perf** — the full-episode audio decode is heavy (the preview already
      pays this). Consider streaming/seekable decode, or only decoding on play.
- [ ] **UX** — chapter markers on the scrubber, click-to-jump (chapters already
      exist in the timeline), captions toggle, keyboard controls.

### Open questions
- Where do the MP3s live, and how big across all ~58 episodes?
- Does the player replace the YouTube embed on call pages, or sit alongside it?
- Mobile layout for a 16:9 stage.
