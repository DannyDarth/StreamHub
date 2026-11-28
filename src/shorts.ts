// YouTube Shorts: one vertical video at a time, looping; the mouse wheel, ↑ ↓ or the buttons move
// to the next or previous Short. The feed comes from YouTube's own Shorts sequence (youtube.rs,
// only real Shorts, no ads); each Short plays through yt-dlp like any other video (no ads), with
// SponsorBlock.

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

interface Short {
  id: string;
  thumb: string;
  stream?: Promise<Stream>;
  info?: Stream;
  segments?: sponsorblock.Segment[];
  marked?: boolean;
}

const MUTED_KEY = "streamhub.shorts.muted";

let ctx: ShortsCtx;
const list: Short[] = [];
let index = 0;
let next: string | null = null;
let started = false;
let loadingMore = false;
let feedError = "";
let hls: Hls | null = null;
let shown: Short | null = null;
let lastWheel = 0;
/** Paused because the tab was left (so coming back plays again); a pause by you stays. */
let autoPaused = false;

const video = h("video", { class: "shorts-video", loop: true, playsinline: true }) as HTMLVideoElement;
const title = h("div", { class: "shorts-title" });
const channel = h("div", { class: "shorts-channel" });
const bar = h("div", { class: "shorts-progress-fill" });
const notice = h("div", { class: "shorts-notice" });
const toastEl = h("div", { class: "shorts-toast" });
const muteBtn = h("button", { class: "shorts-btn", title: "Sound on/off (M)", onclick: () => toggleMute() });
const stage = h(
  "div",
  { class: "shorts-stage" },
  video,
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
    h("button", { class: "shorts-btn", title: "Previous Short (↑)", onclick: () => go(-1) }, "▲"),
    h("button", { class: "shorts-btn", title: "Next Short (↓)", onclick: () => go(1) }, "▼"),
    muteBtn,
    h("button", { class: "shorts-btn", title: "Copy the link", onclick: () => share() }, "⤴"),
    h(
      "button",
      {
        class: "shorts-btn",
        title: "Open in the player",
        onclick: () => {
          const s = list[index];
          if (!s) return;
          pause();
          ctx.openInPlayer(s.id, s.info?.title || "YouTube Short");
        },
      },
      "⛶",
    ),
  ),
);

video.muted = localStorage.getItem(MUTED_KEY) === "1";
updateMute();

stage.addEventListener("click", () => {
  if (video.paused) void video.play().catch(() => {});
  else video.pause();
});
root.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (Math.abs(e.deltaY) < 8 || Date.now() - lastWheel < 450) return;
    lastWheel = Date.now();
    go(e.deltaY > 0 ? 1 : -1);
  },
  { passive: false },
);
document.addEventListener("keydown", (e) => {
  if (!root.isConnected) return;
  const t = e.target as HTMLElement | null;
  if (t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable)) return;
  if (e.key === "ArrowDown") go(1);
  else if (e.key === "ArrowUp") go(-1);
  else if (e.key === "m" || e.key === "M") toggleMute();
  else if (e.key === " ") {
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  } else return;
  e.preventDefault();
});
video.addEventListener("timeupdate", () => {
  bar.style.width = video.duration ? `${(video.currentTime / video.duration) * 100}%` : "0";
  const s = shown;
  if (!s?.segments?.length || video.seeking) return;
  const actions = ctx.settings().sbActions;
  for (const seg of s.segments) {
    if (video.currentTime < seg.start || video.currentTime >= seg.end - 0.3) continue;
    if ((actions[seg.category] ?? "off") !== "skip") continue;
    video.currentTime = seg.end;
    toast(`Skipped ${sponsorblock.categoryName(seg.category).toLowerCase()}`);
    return;
  }
});
video.addEventListener("playing", () => setNotice(""));

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
  muteBtn.textContent = video.muted ? "🔇" : "🔊";
}

function toggleMute() {
  video.muted = !video.muted;
  localStorage.setItem(MUTED_KEY, video.muted ? "1" : "0");
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

async function loadMore() {
  if (loadingMore || (started && !next)) return;
  loadingMore = true;
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
    loadingMore = false;
  }
}

function stream(s: Short): Promise<Stream> {
  if (!s.segments) {
    s.segments = [];
    sponsorblock
      .segments(s.id, ctx.settings().sbActions)
      .then((segs) => (s.segments = segs))
      .catch(() => {});
  }
  if (s.stream) return s.stream;
  const p = invoke<Stream>("yt_stream", { id: s.id, quality: ctx.settings().quality }).then((r) => {
    s.info = r;
    return r;
  });
  s.stream = p;
  // try again next time it's shown
  p.catch(() => {
    if (s.stream === p) s.stream = undefined;
  });
  return p;
}

function destroyHls() {
  if (!hls) return;
  try {
    hls.destroy();
  } catch {
    // already gone
  }
  hls = null;
}

async function show() {
  const s = list[index];
  if (!s) {
    setNotice(feedError || "Loading Shorts…");
    return;
  }
  shown = s;
  destroyHls();
  video.removeAttribute("src");
  video.load();
  video.poster = s.thumb;
  bar.style.width = "0";
  title.textContent = s.info?.title ?? "";
  channel.textContent = s.info?.channel ?? "";
  setNotice(s.info ? "" : "Loading…");
  // get the next ones ready while this one plays
  for (const n of list.slice(index + 1, index + 3)) void stream(n).catch(() => {});
  if (index >= list.length - 4) void loadMore();
  let r: Stream;
  try {
    r = await stream(s);
  } catch (e) {
    if (shown !== s) return;
    setNotice(`This Short couldn't be played (${String(e)}). Skipping…`);
    window.setTimeout(() => shown === s && go(1), 1500);
    return;
  }
  if (shown !== s || !root.isConnected) return;
  title.textContent = r.title;
  channel.textContent = r.channel;
  if (r.kind === "hls" && Hls.isSupported()) {
    hls = new Hls({ maxBufferLength: 20 });
    hls.loadSource(r.url);
    hls.attachMedia(video);
  } else {
    video.src = r.url;
  }
  autoPaused = false;
  void video.play().catch(() => {
    // autoplay blocked: a click plays it
  });
  if (!s.marked && ctx.settings().ytAddToHistory !== false) {
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
  if (!video.paused) {
    video.pause();
    autoPaused = true;
  }
}

/** Call after every render: pause when the Shorts tab isn't on screen. */
export function pauseIfHidden(): void {
  if (!root.isConnected) pause();
}

/** Start over with a fresh set of Shorts (Refresh). */
export function refresh(): void {
  list.length = 0;
  index = 0;
  next = null;
  started = false;
  feedError = "";
  shown = null;
  destroyHls();
  video.removeAttribute("src");
  video.load();
}

/** The Shorts tab. The same element is reused across renders, so playback carries on. */
export function view(context: ShortsCtx): HTMLElement {
  ctx = context;
  if (!list.length) {
    setNotice(feedError || "Loading Shorts…");
    if (!loadingMore && !feedError) {
      void loadMore().then(() => {
        if (root.isConnected) void show();
      });
    }
  } else if (shown !== list[index]) {
    void show();
  } else if (autoPaused) {
    // back on the tab: carry on
    autoPaused = false;
    queueMicrotask(() => root.isConnected && void video.play().catch(() => {}));
  }
  return root;
}
