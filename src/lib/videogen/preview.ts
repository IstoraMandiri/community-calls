import {
  previewAudio,
  jingleAudio,
  previewControls,
  previewPlay,
  previewRestart,
  previewScrub,
  previewTime,
  previewDownload,
  renderedPlayer,
  renderedVideo,
} from "./dom";
import { fmt } from "./format";
import { ensureAma } from "./ama";
import { renderedUrl, type Job, type Participant } from "./job";
import type { SidecarMeta } from "./sidecar";
import type { Cue } from "./vtt";
import {
  segmentAt,
  segmentIndexAt,
  type Segment,
  type Timeline,
} from "./timeline";
import {
  setActiveSlide,
  hideSlideOverlay,
  SLIDE_KEYS,
  type SlideContext,
  type SlideKey,
} from "./slides";

type Ctx = {
  ready: Promise<void>;
  audioSrc: string;
  seek: (t: number) => void;
  getJob: () => Job | null;
  getSidecar: () => SidecarMeta | null;
  getCues: () => Cue[];
  getParticipants: () => Participant[];
  getTimeline: () => Timeline;
};

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

// Preview transport over the whole-video timeline (preroll slides + main +
// postroll slides). One global clock (`globalT`, in seconds) drives the
// scrubber and the rendered visual; you can scrub into any slide. Audio is
// region-aware: the main call audio plays during the main segment, the
// intro/outro jingles play during their slide groups, and everything else is
// silence. The realtime driver clicks play and awaits window.__renderEnded.
export function setupPreviewControls(ctx: Ctx): void {
  previewControls.classList.remove("hidden");

  let timeline: Timeline | null = null;
  let globalT = 0;
  let playing = false;
  let lastWall = 0;
  let raf = 0;
  let activeIdx = -1; // last segment index media was synced to
  let currentJingleUrl: string | null = null;
  // Optional cap (driver --duration) that ends the main segment early.
  let mainCapSec: number | null = null;

  // window.__renderEnded resolves once the whole timeline has played through;
  // the realtime screencast driver awaits it to know when to stop recording.
  let endedResolve: () => void = () => {};
  const endedPromise = new Promise<void>((r) => {
    endedResolve = r;
  });
  const w = window as unknown as {
    __renderEnded: Promise<void>;
    __capMainAt: (sec: number) => void;
  };
  w.__renderEnded = endedPromise;
  // Driver hook: cap the main segment at `sec` so postroll fires without
  // waiting out the full (up to 86 min) audio. Replaces the old synthetic
  // `ended` dispatch.
  w.__capMainAt = (sec: number) => {
    mainCapSec = sec > 0 ? sec : null;
  };

  function buildSlideContext(): SlideContext {
    const job = ctx.getJob();
    const meta = ctx.getSidecar();
    return {
      call: job?.call,
      hosts: meta?.hosts,
      chapters: meta?.chapters,
      summary: meta?.summary,
      cues: ctx.getCues(),
      participants: ctx.getParticipants(),
      meta: meta ?? null,
    };
  }

  function updateScrubUI(t: number): void {
    const total = timeline?.totalDuration ?? 0;
    if (total > 0) previewScrub.value = String(t);
    previewTime.textContent = `${fmt(t)} / ${fmt(total)}`;
  }

  // Paint the correct visual for a global time: the stage (via ctx.seek) in
  // the main segment, otherwise the active slide.
  function renderGlobal(t: number): void {
    if (!timeline) return;
    const seg = segmentAt(timeline, t);
    if (seg.kind === "main") {
      hideSlideOverlay();
      ctx.seek(t - timeline.mainStart);
    } else {
      setActiveSlide(seg.key, buildSlideContext);
    }
    updateScrubUI(t);
  }

  function pauseJingle(): void {
    if (!jingleAudio.paused) jingleAudio.pause();
  }

  function ensureJingle(url: string, offset: number): void {
    if (currentJingleUrl !== url) {
      jingleAudio.src = url;
      currentJingleUrl = url;
    }
    // Jingles are short; if we've scrubbed past the jingle's length it just
    // stays silent for the rest of the slide group.
    if (
      offset >= 0 &&
      (Number.isNaN(jingleAudio.currentTime) ||
        Math.abs(jingleAudio.currentTime - offset) > 0.25)
    ) {
      try {
        jingleAudio.currentTime = offset;
      } catch {
        /* metadata not loaded yet — fine, it'll start from 0 */
      }
    }
    if (playing) void jingleAudio.play().catch(() => {});
  }

  // Start/stop the right audio when crossing into a segment.
  function onEnterSegment(seg: Segment, t: number): void {
    if (!timeline) return;
    if (seg.kind === "main") {
      pauseJingle();
      const local = Math.max(0, t - timeline.mainStart);
      if (Math.abs(previewAudio.currentTime - local) > 0.25) {
        previewAudio.currentTime = local;
      }
      if (playing) void previewAudio.play().catch(() => {});
    } else {
      if (!previewAudio.paused) previewAudio.pause();
      if (seg.jingleUrl) ensureJingle(seg.jingleUrl, t - seg.jingleStart);
      else pauseJingle();
    }
  }

  function syncMedia(t: number): void {
    if (!timeline) return;
    const idx = segmentIndexAt(timeline, t);
    const seg = timeline.segments[idx];
    if (idx !== activeIdx) {
      onEnterSegment(seg, t);
      activeIdx = idx;
    } else if (
      seg.kind === "main" &&
      playing &&
      previewAudio.paused &&
      !previewAudio.ended
    ) {
      void previewAudio.play().catch(() => {});
    }
  }

  function frame(): void {
    if (!playing || !timeline) return;
    const now = performance.now();
    const dt = (now - lastWall) / 1000;
    lastWall = now;

    const seg = segmentAt(timeline, globalT);
    if (seg.kind === "main") {
      // Main audio is the authority while it's actually playing, so there's
      // no drift over a long call; otherwise advance by wall clock. Clamp to
      // mainEnd so a longer-than-decoded media element can't push the clock
      // into postroll while the call audio is still playing.
      if (!previewAudio.paused) {
        globalT = Math.min(
          timeline.mainEnd,
          timeline.mainStart + previewAudio.currentTime,
        );
      } else {
        globalT += dt;
      }
      // Cap against the timeline position (not audio.currentTime) so the
      // --duration cap still fires when the audio isn't actually playing
      // (e.g. autoplay blocked), instead of running out the full call.
      const mainLocal = globalT - timeline.mainStart;
      const capped = mainCapSec != null && mainLocal >= mainCapSec;
      if (previewAudio.ended || capped) globalT = timeline.mainEnd;
    } else {
      globalT += dt;
    }

    if (globalT >= timeline.totalDuration) {
      globalT = timeline.totalDuration;
      renderGlobal(globalT);
      finish();
      return;
    }

    syncMedia(globalT);
    renderGlobal(globalT);
    raf = requestAnimationFrame(frame);
  }

  function finish(): void {
    playing = false;
    cancelAnimationFrame(raf);
    previewAudio.pause();
    pauseJingle();
    previewPlay.textContent = "▶";
    endedResolve();
  }

  function pause(): void {
    playing = false;
    cancelAnimationFrame(raf);
    previewAudio.pause();
    pauseJingle();
    previewPlay.textContent = "▶";
  }

  async function play(): Promise<void> {
    if (!timeline || timeline.totalDuration <= 0) return;
    if (globalT >= timeline.totalDuration) globalT = 0; // replay from the top
    // AMA must attach inside the user gesture (Chrome autoplay policy).
    await ensureAma().catch(() => {});
    playing = true;
    previewPlay.textContent = "⏸";
    activeIdx = -1; // force media re-entry for the current segment
    lastWall = performance.now();
    syncMedia(globalT);
    renderGlobal(globalT);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }

  // Move the clock to `t` and re-sync media without changing play/pause state.
  function seekTo(t: number): void {
    if (!timeline) return;
    globalT = clamp(t, 0, timeline.totalDuration);
    activeIdx = -1;
    lastWall = performance.now();
    syncMedia(globalT);
    renderGlobal(globalT);
  }

  ctx.ready.then(() => {
    timeline = ctx.getTimeline();
    previewAudio.src = ctx.audioSrc;
    previewScrub.min = "0";
    previewScrub.max = String(timeline.totalDuration || 1);
    previewScrub.step = "0.05";
    previewScrub.value = "0";
    // Paint the t=0 frame so the resting state is the timeline's first frame
    // (the title slide), not the bare stage — this is also what the realtime
    // driver captures as frame 0.
    seekTo(0);
    if (renderedUrl) {
      previewDownload.href = renderedUrl;
      previewDownload.classList.remove("hidden");
      renderedVideo.src = renderedUrl;
      renderedPlayer.classList.remove("hidden");
    }
  });

  previewPlay.addEventListener("click", () => {
    if (playing) pause();
    else void play();
  });

  previewRestart.addEventListener("click", () => {
    const wasPlaying = playing;
    pause();
    seekTo(0);
    if (wasPlaying) void play();
  });

  previewScrub.addEventListener("input", () => {
    if (!timeline) return;
    seekTo(parseFloat(previewScrub.value));
  });

  // Slide-jump buttons seek the timeline to that slide (paused) so you can
  // inspect it in context; "×" hides the overlay. Slides that aren't in the
  // current timeline (e.g. summary when there's no summary) are shown ad hoc.
  const jumps = document.getElementById("slide-jumps");
  jumps?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(
      "button[data-slide]",
    ) as HTMLButtonElement | null;
    if (!btn) return;
    const which = btn.dataset.slide!;
    if (which === "off") {
      pause();
      hideSlideOverlay();
      return;
    }
    // Ignore a data-slide that isn't a real slide key (markup drift), rather
    // than feeding an invalid key into buildSlide's switch.
    if (!timeline || !SLIDE_KEYS.includes(which as SlideKey)) return;
    const seg = timeline.segments.find(
      (s) => s.kind === "slide" && s.key === which,
    );
    pause();
    if (seg) {
      seekTo(seg.start);
    } else {
      setActiveSlide(which as SlideKey, buildSlideContext);
    }
  });
}
