// Speaker-time donut. Walks the cues, attributes each cue's duration to its
// matched participant, renders a donut + avatar pins around the ring +
// legend.

import type { Cue } from "./vtt";
import { fmt } from "./format";
import type { Participant } from "./job";
import { matchParticipant } from "./roster";
import { setAvatar } from "./avatar";

const COLOURS = [
  "#7aeea8",
  "#a0ffc8",
  "#5ac488",
  "#3a8e60",
  "#c8e8d8",
  "#88b8a0",
  "#a8d8b8",
  "#608878",
];

type Slice = {
  participant: Participant;
  secs: number;
  startAngle: number;
  endAngle: number;
  midAngle: number;
  colour: string;
};

function computeSlices(cues: Cue[], participants: Participant[]): Slice[] {
  const totals = new Map<string, number>();
  for (const p of participants) totals.set(p.name, 0);
  for (const c of cues) {
    const p = matchParticipant(c.speaker);
    if (!p) continue;
    const dur = Math.max(0, c.end - c.start);
    totals.set(p.name, (totals.get(p.name) ?? 0) + dur);
  }
  const grand = Array.from(totals.values()).reduce((a, b) => a + b, 0);
  if (grand <= 0) return [];

  const slices: Slice[] = [];
  const byTotal = participants
    .map((p) => ({ p, secs: totals.get(p.name) ?? 0 }))
    .filter((s) => s.secs > 0)
    .sort((a, b) => b.secs - a.secs);

  let angle = -Math.PI / 2; // start at 12 o'clock
  let colourIdx = 0;
  for (const { p, secs } of byTotal) {
    const sweep = (secs / grand) * 2 * Math.PI;
    slices.push({
      participant: p,
      secs,
      startAngle: angle,
      endAngle: angle + sweep,
      midAngle: angle + sweep / 2,
      colour: COLOURS[colourIdx % COLOURS.length],
    });
    angle += sweep;
    colourIdx++;
  }
  return slices;
}

export function renderSpeakerStats(
  container: HTMLElement,
  cues: Cue[],
  participants: Participant[],
): void {
  const slices = computeSlices(cues, participants);
  const grandTotal = slices.reduce((acc, s) => acc + s.secs, 0);

  container.innerHTML = "";

  const chart = document.createElement("div");
  chart.className = "stats-chart";
  container.appendChild(chart);

  // SVG donut. No legend / no percentages — segments are delineated by a
  // small gap between arcs, and each speaker's avatar pins their slice.
  const SIZE = 640;
  const R = 250; // ring radius (avatar centres land here)
  const STROKE = 70;
  const C = 2 * Math.PI * R;
  const AVATAR = 90;
  const GAP_PX = 16; // visual gap between slices, in pixels of arc length

  const svgWrap = document.createElement("div");
  svgWrap.className = "stats-svg-wrap";
  svgWrap.style.width = `${SIZE}px`;
  svgWrap.style.height = `${SIZE}px`;
  chart.appendChild(svgWrap);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${SIZE} ${SIZE}`);
  svg.setAttribute("width", String(SIZE));
  svg.setAttribute("height", String(SIZE));
  svgWrap.appendChild(svg);

  // Render each slice with a small gap on each side. We achieve the gap by
  // shrinking the dash length by GAP_PX and shifting the offset forward by
  // GAP_PX/2 so the slice is centred within its original sweep.
  let offset = 0;
  for (const s of slices) {
    const sweep = (s.endAngle - s.startAngle) / (2 * Math.PI);
    const fullDash = sweep * C;
    const dash = Math.max(2, fullDash - GAP_PX);
    const arc = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "circle",
    );
    arc.setAttribute("cx", String(SIZE / 2));
    arc.setAttribute("cy", String(SIZE / 2));
    arc.setAttribute("r", String(R));
    arc.setAttribute("fill", "none");
    arc.setAttribute("stroke", s.colour);
    arc.setAttribute("stroke-width", String(STROKE));
    arc.setAttribute("stroke-linecap", "butt");
    arc.setAttribute("stroke-dasharray", `${dash} ${C - dash}`);
    arc.setAttribute("stroke-dashoffset", String(-(offset + GAP_PX / 2)));
    arc.setAttribute("transform", `rotate(-90 ${SIZE / 2} ${SIZE / 2})`);
    svg.appendChild(arc);
    offset += fullDash;
  }

  // Centre label
  const centre = document.createElementNS("http://www.w3.org/2000/svg", "text");
  centre.setAttribute("x", String(SIZE / 2));
  centre.setAttribute("y", String(SIZE / 2 - 8));
  centre.setAttribute("text-anchor", "middle");
  centre.setAttribute("fill", "rgba(232,232,232,0.9)");
  centre.setAttribute("font-family", "Instrument Serif, serif");
  centre.setAttribute("font-size", "48");
  centre.textContent = fmt(grandTotal);
  svg.appendChild(centre);
  const sub = document.createElementNS("http://www.w3.org/2000/svg", "text");
  sub.setAttribute("x", String(SIZE / 2));
  sub.setAttribute("y", String(SIZE / 2 + 30));
  sub.setAttribute("text-anchor", "middle");
  sub.setAttribute("fill", "rgba(200,200,200,0.55)");
  sub.setAttribute(
    "font-family",
    "JetBrains Mono Variable, ui-monospace, monospace",
  );
  sub.setAttribute("font-size", "16");
  sub.setAttribute("letter-spacing", "0.16em");
  sub.textContent = "TOTAL SPEAKING";
  svg.appendChild(sub);

  // Avatar pins sitting on the donut ring at each slice midpoint.
  for (const s of slices) {
    const cx = SIZE / 2 + R * Math.cos(s.midAngle);
    const cy = SIZE / 2 + R * Math.sin(s.midAngle);
    const pin = document.createElement("div");
    pin.className = "stats-pin";
    pin.style.width = `${AVATAR}px`;
    pin.style.height = `${AVATAR}px`;
    pin.style.left = `${cx - AVATAR / 2}px`;
    pin.style.top = `${cy - AVATAR / 2}px`;
    pin.style.borderColor = s.colour;
    setAvatar(pin, s.participant);
    svgWrap.appendChild(pin);
  }
}
