// The full video as a single ordered timeline: preroll slides, then the main
// call playback, then postroll slides. Each segment has an absolute global
// start/end (in seconds) so the preview transport can scrub across the whole
// thing and the realtime driver can size its concatenated audio track from
// the same numbers. This is the single source of truth for slide timing —
// nothing else should hard-code pre/post-roll durations.

import type { SidecarMeta } from "./sidecar";
import type { SlideKey } from "./slides";

// Per-slide on-screen duration. Changing these here automatically reflows the
// preview scrubber AND the driver's audio padding (both read this timeline),
// so the two can no longer drift apart.
const SLIDE_MS: Record<SlideKey, number> = {
  title: 3500,
  toc: 4000,
  summary: 5000,
  stats: 5500,
  thanks: 3500,
  logo: 2500,
};

type SlideSegment = {
  kind: "slide";
  key: SlideKey;
  start: number;
  end: number;
  // Jingle for this segment's group (intro for preroll, outro for postroll).
  // Every segment in a group carries the same url + groupStart so we can
  // position the jingle correctly even when the user scrubs straight into a
  // mid-group slide.
  jingleUrl?: string;
  jingleStart: number;
};

type MainSegment = { kind: "main"; start: number; end: number };
export type Segment = SlideSegment | MainSegment;

export type Timeline = {
  segments: Segment[];
  totalDuration: number;
  mainStart: number;
  mainEnd: number;
  prerollMs: number;
  postrollMs: number;
};

type TimelineSpec = {
  meta: SidecarMeta | null;
  mainDurationSec: number;
  // false in noSlides mode (or when there's no sidecar meta to build from).
  includeSlides: boolean;
};

// Which slides to show is content-driven: title always, TOC only when there
// are chapters, summary only when there's a summary. Postroll is the full
// stats -> thanks -> logo run. Keeping this derivation in one place means the
// exposed prerollMs/postrollMs always match what actually renders.
function prerollKeys(meta: SidecarMeta): SlideKey[] {
  const keys: SlideKey[] = ["title"];
  if (meta.chapters && meta.chapters.length > 0) keys.push("toc");
  if (meta.summary) keys.push("summary");
  return keys;
}

const POSTROLL_KEYS: SlideKey[] = ["stats", "thanks", "logo"];

export function buildTimeline(spec: TimelineSpec): Timeline {
  const segments: Segment[] = [];
  const useSlides = spec.includeSlides && spec.meta != null;
  const meta = spec.meta;

  let t = 0;
  if (useSlides && meta) {
    const prerollStart = t;
    for (const key of prerollKeys(meta)) {
      const end = t + SLIDE_MS[key] / 1000;
      segments.push({
        kind: "slide",
        key,
        start: t,
        end,
        jingleUrl: meta.intro,
        jingleStart: prerollStart,
      });
      t = end;
    }
  }
  const prerollMs = t * 1000;

  const mainStart = t;
  const mainEnd = mainStart + Math.max(0, spec.mainDurationSec);
  segments.push({ kind: "main", start: mainStart, end: mainEnd });
  t = mainEnd;

  if (useSlides && meta) {
    const postrollStart = t;
    for (const key of POSTROLL_KEYS) {
      const end = t + SLIDE_MS[key] / 1000;
      segments.push({
        kind: "slide",
        key,
        start: t,
        end,
        jingleUrl: meta.outro,
        jingleStart: postrollStart,
      });
      t = end;
    }
  }

  return {
    segments,
    totalDuration: t,
    mainStart,
    mainEnd,
    prerollMs,
    postrollMs: (t - mainEnd) * 1000,
  };
}

// Locate the segment covering a global time, clamped to the timeline bounds.
export function segmentAt(tl: Timeline, t: number): Segment {
  const segs = tl.segments;
  if (t <= segs[0].start) return segs[0];
  for (const seg of segs) {
    if (t >= seg.start && t < seg.end) return seg;
  }
  return segs[segs.length - 1];
}

export function segmentIndexAt(tl: Timeline, t: number): number {
  const segs = tl.segments;
  if (t <= segs[0].start) return 0;
  for (let i = 0; i < segs.length; i++) {
    if (t >= segs[i].start && t < segs[i].end) return i;
  }
  return segs.length - 1;
}
