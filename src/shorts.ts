// YouTube Shorts: one vertical video at a time, looping; the mouse wheel, ↑ ↓ or the buttons move
// to the next or previous Short. The feed comes from YouTube's own Shorts sequence (youtube.rs,
// only real Shorts, no ads); each Short plays through yt-dlp like any other video (no ads), with
// SponsorBlock.
//
// Speed: the next Shorts are found and start buffering (paused, in their own video element) while
// one plays, so moving on swaps in a video that's already loaded. The feed and the first Shorts
// are got ready as soon as the YouTube tab opens. Quality: the highest YouTube has, from the start.

import Hls from "hls.js";
import { invoke } from "@tauri-apps/api/core";
import { h } from "./ui";
import * as sponsorblock from "./sponsorblock";
import type { Settings } from "./types";

export interface ShortsCtx {
  settings(): Settings;
  /** Open a Short in StreamHub's normal player. */
  openInPlayer(id: string, title: string): void;
}

interface Stream {
  kind: "hls" | "file";
  url: string;
  title: string;
  channel: string;
}

/** A Short's video element, loading or loaded. */
interface Media {
  video: HTMLVideoElement;
  hls: Hls | null;
}

interface Short {
  id: string;
  thumb: string;
  stream?: Promise<Stream>;
  info?: Stream;
  media?: Media;
  segments?: sponsorblock.Segment[];
  marked?: boolean;
}

const MUTED_KEY = "streamhub.shorts.muted";
/** How many Shorts after the one showing are loaded ahead (and how many before are kept). */
const AHEAD = 3;
const BEHIND = 1;

let ctx: ShortsCtx | null = null;
const list: Short[] = [];
let index = 0;
let next: string | null = null;
let started = false;
let loadingMore: Promise<void> | null = null;
let feedError = "";
let shown: Short | null = null;
let lastWheel = 0;
let muted = localStorage.getItem(MUTED_KEY) === "1";
/** Paused because the tab was left (so coming back plays again); a pause by you stays. */
let autoPaused = false;

const poster = h("img", { class: "shorts-poster", alt: "", referrerpolicy: "no-referrer" }) as HTMLImageElement;
const slot = h("div", { class: "shorts-slot" });
const title = h("div", { class: "shorts-title" });
const channel = h("div", { class: "shorts-channel" });
const bar = h("div", { class: "shorts-progress-fill" });
const notice = h("div", { class: "shorts-notice" });
const toastEl = h("div", { class: "shorts-toast" });
const muteBtn = h("button", { class: "shorts-btn", title: "Sound on/off (M)", onclick: () => toggleMute() });
const stage = h(
  "div",
  { class: "shorts-stage" },
  poster,
  slot,
  notice,
  toastEl,
  h("div", { class: "shorts-info" }, title, channel),
  h("div", { class: "shorts-progress" }, bar),
);
const root = h(
  "div",
  { class: "shorts" },
  stage,
  h(
    "div",
    { class: "shorts-controls" },
    h("button", { class: "shorts-btn", title: "Previous Short (↑)", onclick: () => void go(-1) }, "▲"),
    h("button", { class: "shorts-btn", title: "Next Short (↓)", onclick: () => void go(1) }, "▼"),
    muteBtn,
    h("button", { class: "shorts-btn", title: "Copy the link", onclick: () => share() }, "⤴"),
    h(
      "button",
      {
        class: "shorts-btn",
        title: "Open in the player",
        onclick: () => {
          const s = list[index];
          if (!s || !ctx) return;
          pause();
          ctx.openInPlayer(s.id, s.info?.title || "YouTube Short");
        },
      },
      "⛶",
    ),
  ),
);

updateMute();

function active(): HTMLVideoElement | null {
  return shown?.media?.video ?? null;
}

stage.addEventListener("click", () => togglePause());
root.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (Math.abs(e.deltaY) < 8 || Date.now() - lastWheel < 450) return;
    lastWheel = Date.now();
    void go(e.deltaY > 0 ? 1 : -1);
  },
  { passive: false },
);
document.addEventListener("keydown", (e) => {
  if (!root.isConnected) return;
  const t = e.target as HTMLElement | null;
  if (t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable)) return;
  if (e.key === "ArrowDown") void go(1);
  else if (e.key === "ArrowUp") void go(-1);
  else if (e.key === "m" || e.key === "M") toggleMute();
  else if (e.key === " ") togglePause();
  else return;
  e.preventDefault();
});

function togglePause() {
  const v = active();
  if (!v) return;
  if (v.paused) void v.play().catch(() => {});
  else v.pause();
}

function setNotice(text: string) {
  notice.textContent = text;
  notice.classList.toggle("visible", Boolean(text));
}

let toastTimer = 0;
function toast(text: string) {
  toastEl.textContent = text;
  toastEl.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("visible"), 1800);
}

function updateMute() {
  muteBtn.textContent = muted ? "🔇" : "🔊";
}

function toggleMute() {
  muted = !muted;
  localStorage.setItem(MUTED_KEY, muted ? "1" : "0");
  const v = active();
  if (v) v.muted = muted;
  updateMute();
}

function share() {
  const s = list[index];
  if (!s) return;
  void navigator.clipboard
    .writeText(`https://www.youtube.com/shorts/${s.id}`)
    .then(() => toast("Link copied"))
    .catch(() => toast("Couldn't copy the link"));
}

function loadMore(): Promise<void> {
  if (loadingMore) return loadingMore;
  if (started && !next) return Promise.resolve();
  loadingMore = (async () => {
    try {
      const r = await invoke<{ shorts: { id: string; thumb: string }[]; next: string | null }>("yt_shorts", { token: started ? next : null });
      started = true;
      next = r.next;
      feedError = "";
      const have = new Set(list.map((s) => s.id));
      for (const s of r.shorts) if (!have.has(s.id)) list.push({ id: s.id, thumb: s.thumb });
    } catch (e) {
      feedError = String(e) === "not-signed-in" ? "YouTube didn't give any Shorts." : `Couldn't load Shorts: ${String(e)}`;
    } finally {
      loadingMore = null;
    }
  })();
  return loadingMore;
}

/** Find the Short's stream (yt-dlp) once, and its SponsorBlock segments. */
function stream(s: Short): Promise<Stream> {
  if (!s.segments && ctx) {
    s.segments = [];
    sponsorblock
      .segments(s.id, ctx.settings().sbActions)
      .then((segs) => (s.segments = segs))
      .catch(() => {});
  }
  if (s.stream) return s.stream;
  const p = invoke<Stream>("yt_stream", { id: s.id, quality: ctx?.settings().quality ?? "best" }).then((r) => {
    s.info = r;
    return r;
  });
  s.stream = p;
  // try again next time it's needed
  p.catch(() => {
    if (s.stream === p) s.stream = undefined;
  });
  return p;
}

/** Start loading the Short's video (paused, muted) so it's ready to play. */
async function prepare(s: Short): Promise<Media | null> {
  if (s.media) return s.media;
  const r = await stream(s);
  if (s.media) return s.media;
  const video = h("video", { class: "shorts-video", loop: true, playsinline: true, preload: "auto" }) as HTMLVideoElement;
  video.muted = true;
  const media: Media = { video, hls: null };
  if (r.kind === "hls" && Hls.isSupported()) {
    const hls = new Hls({
      maxBufferLength: 15,
      // start at the top quality instead of working up from the lowest
      capLevelToPlayerSize: false,
      abrEwmaDefaultEstimate: 25_000_000,
      testBandwidth: false,
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      let best = 0;
      hls.levels.forEach((l, i) => {
        if (l.height * l.width > hls.levels[best].height * hls.levels[best].width) best = i;
      });
      hls.startLevel = best;
      hls.nextLevel = best;
    });
    hls.loadSource(r.url);
    hls.attachMedia(video);
    media.hls = hls;
  } else {
    video.src = r.url;
  }
  video.addEventListener("timeupdate", () => {
    if (video !== active()) return;
    bar.style.width = video.duration ? `${(video.currentTime / video.duration) * 100}%` : "0";
    if (!s.segments?.length || video.seeking || !ctx) return;
    const actions = ctx.settings().sbActions;
    for (const seg of s.segments) {
      if (video.currentTime < seg.start || video.currentTime >= seg.end - 0.3) continue;
      if ((actions[seg.category] ?? "off") !== "skip") continue;
      video.currentTime = seg.end;
      toast(`Skipped ${sponsorblock.categoryName(seg.category).toLowerCase()}`);
      return;
    }
  });
  video.addEventListener("playing", () => {
    if (video === active()) {
      setNotice("");
      poster.classList.add("hidden");
    }
  });
  video.addEventListener("error", () => {
    if (video === active()) setNotice("This Short couldn't be played. Press ↓ for the next one.");
  });
  s.media = media;
  return media;
}

function release(s: Short) {
  const m = s.media;
  if (!m) return;
  s.media = undefined;
  m.video.pause();
  try {
    m.hls?.destroy();
  } catch {
    // already gone
  }
  m.video.removeAttribute("src");
  m.video.load();
  m.video.remove();
}

function prepareAhead() {
  for (const s of list.slice(index + 1, index + 1 + AHEAD)) void prepare(s).catch(() => {});
}

/** Load the Shorts around the one showing; let go of the rest. */
function keepAround() {
  list.forEach((s, i) => {
    if (i < index - BEHIND || i > index + AHEAD) release(s);
  });
  prepareAhead();
  if (index >= list.length - AHEAD - 2) void loadMore().then(prepareAhead);
}

async function show() {
  const s = list[index];
  if (!s) {
    setNotice(feedError || "Loading Shorts…");
    return;
  }
  const previous = shown;
  shown = s;
  if (previous && previous !== s) previous.media?.video.pause();
  slot.replaceChildren();
  poster.src = s.thumb;
  poster.classList.remove("hidden");
  bar.style.width = "0";
  title.textContent = s.info?.title ?? "";
  channel.textContent = s.info?.channel ?? "";
  setNotice(s.media ? "" : "Loading…");
  keepAround();
  let media: Media | null;
  try {
    media = await prepare(s);
  } catch (e) {
    if (shown !== s) return;
    setNotice(`This Short couldn't be played (${String(e)}). Skipping…`);
    window.setTimeout(() => shown === s && void go(1), 1500);
    return;
  }
  if (shown !== s || !media) return;
  title.textContent = s.info?.title ?? "";
  channel.textContent = s.info?.channel ?? "";
  slot.replaceChildren(media.video);
  media.video.currentTime = 0;
  media.video.muted = muted;
  if (media.video.readyState >= 2) {
    setNotice("");
    poster.classList.add("hidden");
  }
  if (!root.isConnected) return;
  autoPaused = false;
  void media.video.play().catch(() => {
    // autoplay blocked: a click plays it
  });
  if (!s.marked && ctx && ctx.settings().ytAddToHistory !== false) {
    s.marked = true;
    void invoke("yt_mark_watched", { id: s.id }).catch(() => {});
  }
}

async function go(step: number) {
  const target = index + step;
  if (target < 0) return;
  if (target >= list.length) {
    if (!next && started) return;
    setNotice("Loading more Shorts…");
    await loadMore();
    if (target >= list.length) {
      setNotice(feedError || "No more Shorts right now.");
      return;
    }
  }
  index = target;
  void show();
}

/** Stop playing (left the Shorts tab, or opened a video in the player). */
export function pause(): void {
  const v = active();
  if (v && !v.paused) {
    v.pause();
    autoPaused = true;
  }
}

/** Call after every render: pause when the Shorts tab isn't on screen. */
export function pauseIfHidden(): void {
  if (!root.isConnected) pause();
}

/**
 * Get the first Shorts ready in the background (the YouTube tab was opened), so the Shorts tab
 * starts at once.
 */
export function warmUp(context: ShortsCtx): void {
  ctx = context;
  if (started || loadingMore || feedError) return;
  void loadMore().then(() => {
    for (const s of list.slice(0, 2)) void prepare(s).catch(() => {});
  });
}

/** Start over with a fresh set of Shorts (Refresh). */
export function refresh(): void {
  for (const s of list) release(s);
  list.length = 0;
  index = 0;
  next = null;
  started = false;
  feedError = "";
  shown = null;
  slot.replaceChildren();
}

/** The Shorts tab. The same element is reused across renders, so playback carries on. */
export function view(context: ShortsCtx): HTMLElement {
  ctx = context;
  if (!list.length) {
    setNotice(feedError || "Loading Shorts…");
    if (!feedError) {
      void loadMore().then(() => {
        if (root.isConnected && !shown) void show();
      });
    }
  } else if (shown !== list[index]) {
    void show();
  } else if (autoPaused) {
    // back on the tab: carry on
    autoPaused = false;
    queueMicrotask(() => root.isConnected && void active()?.play().catch(() => {}));
  }
  return root;
}
