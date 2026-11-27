// "Play in StreamHub": the in-app player. One stream at a time, shown full size below the header
// or as a mini-player in the corner while browsing. The video element lives outside the app's
// re-rendered content, so it keeps playing while pages change.
//
// Streamlink (with the ad blocking plugin) finds the stream's ad-free HLS address; hls.js plays
// it. If Twitch puts an ad into the playlist, the player asks Streamlink again with the next
// proxy; with no proxy left it blacks out and mutes the ad instead of showing it.
//
// YouTube: yt-dlp finds the video's stream (no ads: YouTube only adds them in its own player),
// and SponsorBlock segments are skipped or marked on the timeline.

import Hls from "hls.js";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { h } from "./ui";
import type { AdblockStatus, Platform, Settings } from "./types";
import * as sponsorblock from "./sponsorblock";

export interface PlayerCtx {
  settings(): Settings;
  /** The player closed (stopped, or the stream ended): with an error to show, if any. */
  closed(id: number, error: string | null): void;
  /** Play this channel in the external player instead. */
  openExternal(platform: Platform, channel: string): void;
  chatEnabled(): boolean;
  openChat(platform: Platform, channel: string): void;
  closeChat(): void;
}

interface Current {
  id: number;
  platform: Platform;
  /** Twitch/Kick: the channel; YouTube: the video id. */
  channel: string;
  /** What the bar shows: the channel, or the video's title. */
  label: string;
  /** YouTube: SponsorBlock segments, and the ones the user undid. */
  segments: sponsorblock.Segment[];
  sbState?: "loading" | "done" | "failed";
  undone: Set<string>;
  /** YouTube: the audio tracks (dubs) and the one playing. */
  audioTracks: { id: number; name: string }[];
  audio: number;
  mode: "full" | "mini" | "hidden";
  status: AdblockStatus | null;
  hls: Hls | null;
  /** Which proxy Streamlink tries first (0 = the first in the list). */
  attempt: number;
  /** No other proxy to switch to. */
  last: boolean;
  retries: number;
  /** An ad is on screen right now (blacked out and muted). */
  blocking: boolean;
  resolving: boolean;
  qualities: Quality[];
  /** The quality playing (its name), kept when switching proxies. */
  quality: string | null;
}

interface Resolved {
  url: string;
  server: string | null;
  last: boolean;
  direct: boolean;
  /** The proxy used (index in the list): after an ad, the next one is tried. */
  index: number;
  qualities: Quality[];
}

interface Quality {
  name: string;
  url: string;
}

const VOLUME_KEY = "streamhub.player.volume";

let ctx: PlayerCtx;
let current: Current | null = null;
let fullscreen = false;

const host = h("div", { id: "player-host" });
const bar = h("div", { class: "player-bar" });
const video = h("video", { class: "player-video", controls: true, autoplay: true, playsinline: true });
const notice = h("div", { class: "player-notice" });
const sbBar = h("div", { class: "sb-bar" });
const sbToast = h("div", { class: "sb-toast" });
host.append(bar, h("div", { class: "player-stage" }, video, notice, sbBar, sbToast));

export function init(context: PlayerCtx): void {
  ctx = context;
  document.body.append(host);
  try {
    const saved = JSON.parse(localStorage.getItem(VOLUME_KEY) ?? "null") as { volume: number; muted: boolean } | null;
    if (saved) {
      video.volume = Math.min(1, Math.max(0, saved.volume));
      video.muted = saved.muted;
    }
  } catch {
    // no saved volume
  }
  savedMuted = video.muted;
  video.addEventListener("volumechange", () => {
    if (current?.blocking) return;
    savedMuted = video.muted;
    try {
      localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume: video.volume, muted: video.muted }));
    } catch {
      // storage unavailable
    }
  });
  video.addEventListener("click", (e) => {
    if (current?.mode === "mini") {
      e.preventDefault();
      expand();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && fullscreen) void setFullscreen(false);
  });
  video.addEventListener("timeupdate", checkSegments);
  video.addEventListener("loadedmetadata", renderSegments);
  video.addEventListener("durationchange", renderSegments);
}

// ---- SponsorBlock ----

let toastTimer: number | undefined;

function toast(text: string, undo?: () => void) {
  window.clearTimeout(toastTimer);
  sbToast.replaceChildren(h("span", {}, text));
  if (undo) {
    sbToast.append(h("button", { class: "link", onclick: () => { undo(); sbToast.classList.remove("visible"); } }, "Undo"));
  }
  sbToast.classList.add("visible");
  toastTimer = window.setTimeout(() => sbToast.classList.remove("visible"), 5000);
}

function renderSegments() {
  const d = video.duration;
  if (!current || !current.segments.length || !Number.isFinite(d) || d <= 0) {
    sbBar.replaceChildren();
    return;
  }
  sbBar.replaceChildren(
    ...current.segments.map((s) =>
      h("span", {
        class: "sb-mark",
        title: sponsorblock.categoryName(s.category),
        style: `left:${(s.start / d) * 100}%;width:${Math.max(0.4, ((s.end - s.start) / d) * 100)}%;background:${sponsorblock.categoryColor(s.category)}`,
      }),
    ),
  );
}

function checkSegments() {
  const c = current;
  if (!c || !c.segments.length || video.seeking) return;
  const t = video.currentTime;
  const actions = ctx.settings().sbActions;
  for (const s of c.segments) {
    if (t < s.start || t >= s.end - 0.3 || c.undone.has(s.uuid)) continue;
    if ((actions[s.category] ?? "off") !== "skip") continue;
    const from = t;
    video.currentTime = s.end;
    toast(`Skipped ${sponsorblock.categoryName(s.category).toLowerCase()}`, () => {
      c.undone.add(s.uuid);
      video.currentTime = from;
    });
    return;
  }
}

/** SponsorBlock's segments, fetched as soon as the video is opened (alongside finding its stream). */
async function loadSegments(session: Current) {
  session.sbState = "loading";
  try {
    const segs = await sponsorblock.segments(session.channel, ctx.settings().sbActions);
    if (current !== session) return;
    session.segments = segs;
    session.sbState = "done";
  } catch {
    // no SponsorBlock: the video still plays
    if (current !== session) return;
    session.sbState = "failed";
  }
  showSegmentsStatus(session);
  renderSegments();
  renderBar();
}

function showSegmentsStatus(session: Current) {
  if (!session.status || session.status.detail === "Live") return;
  const n = session.segments.length;
  const detail =
    session.sbState === "done"
      ? `${n} SponsorBlock segment${n === 1 ? "" : "s"}`
      : session.sbState === "failed"
        ? "SponsorBlock unavailable"
        : "Loading SponsorBlock…";
  session.status = { ...session.status, detail };
}

export function supported(): boolean {
  return Hls.isSupported();
}

export function activeId(): number | null {
  return current?.id ?? null;
}

function setNotice(text: string) {
  notice.textContent = text;
  notice.classList.toggle("visible", Boolean(text));
}

function destroyPlayer() {
  if (!current?.hls) return;
  try {
    current.hls.destroy();
  } catch {
    // already gone
  }
  current.hls = null;
}

function status(level: AdblockStatus["level"], label: string, detail: string, server: string | null = null): AdblockStatus {
  return { level, label, detail, server, adsCovered: 0, adsGotThrough: 0 };
}

/** Twitch marks the ads it puts into a playlist (the same markers the iOS app and the plugin look for). */
function playlistHasAds(details: unknown): boolean {
  const d = details as {
    dateRanges?: Record<string, { id?: string; class?: string; attr?: Record<string, string> }>;
    fragments?: { title?: string | null; tagList?: string[][] }[];
  };
  for (const range of Object.values(d.dateRanges ?? {})) {
    const cls = range.class ?? range.attr?.CLASS ?? "";
    if (cls === "twitch-stitched-ad" || String(range.id ?? "").startsWith("stitched-ad")) return true;
    if (Object.keys(range.attr ?? {}).some((k) => k.startsWith("X-TV-TWITCH-AD"))) return true;
  }
  return (d.fragments ?? []).some((f) => typeof f.title === "string" && f.title.startsWith("Amazon"));
}

/** Black out and mute an ad that got through (no proxy left to switch to). */
function setBlocking(on: boolean) {
  if (!current || current.blocking === on) return;
  current.blocking = on;
  host.classList.toggle("blocking", on);
  video.muted = on ? true : savedMuted;
  if (on) {
    current.status = status("warn", "Ad blocked", "Hidden and muted until the stream is back");
    setNotice("Ad break: hidden until the stream is back");
  } else {
    setNotice("");
  }
  renderBar();
}

let savedMuted = false;

/** Ask Streamlink for the stream's ad-free address (with the proxy for this attempt) and play it. */
async function resolve() {
  const session = current;
  if (!session || session.resolving) return;
  session.resolving = true;
  setNotice(session.attempt > 0 ? "Switching to another ad-free server…" : "Finding the stream…");
  if (session.platform === "youtube") {
    try {
      const r = await invoke<{ kind: "hls" | "file"; url: string; title: string; channel: string; live: boolean }>("yt_stream", {
        id: session.channel,
        quality: ctx.settings().quality,
      });
      if (current !== session) return;
      if (r.title) session.label = r.title;
      session.status = status("ok", "No ads", r.live ? "Live" : "Loading SponsorBlock…");
      if (!r.live) showSegmentsStatus(session);
      renderBar();
      if (r.kind === "file") playFile(r.url);
      else play(r.url);
      // Settings → YouTube: add it to your YouTube watch history (signed in only; no ads involved)
      if (ctx.settings().ytAddToHistory !== false) void invoke("yt_mark_watched", { id: session.channel }).catch(() => {});

    } catch (e) {
      if (current === session) close(String(e));
    } finally {
      session.resolving = false;
    }
    return;
  }
  try {
    const settings = ctx.settings();
    const r = await invoke<Resolved>("resolve_stream", {
      platform: session.platform,
      channel: session.channel,
      // keep the quality picked in the player (then the setting's, as a fallback)
      settings: session.quality ? { ...settings, quality: `${session.quality},${settings.quality}` } : settings,
      attempt: session.attempt,
    });
    if (current !== session) return;
    session.attempt = r.index;
    session.last = r.last;
    session.qualities = r.qualities;
    session.quality = r.qualities.find((q) => q.url === r.url)?.name ?? session.quality;
    session.status =
      session.platform === "kick"
        ? null
        : r.direct
          ? status("warn", "Direct through your VPN", "No proxy worked")
          : status("ok", "Ad-free stream", r.server ? `via ${r.server}` : "", r.server);
    renderBar();
    play(r.url);
  } catch (e) {
    if (current === session) close(String(e));
  } finally {
    session.resolving = false;
  }
}

function play(url: string) {
  const session = current;
  if (!session) return;
  destroyPlayer();
  const hls = new Hls({
    lowLatencyMode: false,
    liveSyncDurationCount: 3,
    maxBufferLength: 30,
    backBufferLength: 30,
    manifestLoadingMaxRetry: 2,
    levelLoadingMaxRetry: 4,
  });
  session.hls = hls;
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    if (current !== session || session.platform !== "youtube" || hls.levels.length < 2) return;
    // YouTube: the qualities are the master playlist's levels
    const levels = hls.levels.map((l, i) => {
      const fps = Number((l as unknown as { frameRate?: number }).frameRate ?? 0);
      return { i, height: l.height, name: `${l.height}p${fps >= 45 ? Math.round(fps) : ""}` };
    });
    levels.sort((a, b) => b.height - a.height);
    session.qualities = [];
    for (const l of levels) {
      if (!session.qualities.some((q) => q.name === l.name)) session.qualities.push({ name: l.name, url: `level:${l.i}` });
    }
    const wanted = (session.quality ?? ctx.settings().quality).split(",")[0];
    const match = wanted === "best" ? session.qualities[0] : session.qualities.find((q) => q.name === wanted || q.name.startsWith(wanted.replace(/p.*/, "p")));
    const pick = match ?? session.qualities[0];
    session.quality = pick.name;
    hls.currentLevel = Number(pick.url.slice(6));
    renderBar();
  });
  hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
    if (current !== session || session.platform !== "youtube") return;
    const tracks = hls.audioTracks.map((t, i) => ({ i, name: t.name || t.lang || `Track ${i + 1}`, lang: (t.lang || "").toLowerCase(), def: Boolean(t.default) }));
    session.audioTracks = tracks.map((t) => ({ id: t.i, name: t.name }));
    if (tracks.length < 2) return;
    // YouTube adds dubbed audio tracks: play the language from Settings (English by default),
    // preferring the original recording, else the original language
    const want = ctx.settings().audioLanguage || "en";
    const score = (t: (typeof tracks)[number]) => {
      const original = /original/i.test(t.name);
      if (want !== "original" && (t.lang.startsWith(want) || t.name.toLowerCase().startsWith(languageName(want)))) return original ? 4 : 3;
      if (original) return 2;
      return t.def ? 1 : 0;
    };
    const best = tracks.reduce((a, b) => (score(b) > score(a) ? b : a));
    session.audio = best.i;
    if (hls.audioTrack !== best.i) hls.audioTrack = best.i;
    renderBar();
  });
  hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
    if (current !== session || session.platform !== "twitch") return;
    const ads = playlistHasAds(data.details);
    if (ads && !session.last && !ctx.settings().direct) {
      // switch proxies before the ad plays
      session.attempt += 1;
      session.status = status("warn", "Switching proxy", "Ad detected, trying the next server");
      setBlocking(false);
      renderBar();
      void resolve();
    } else {
      setBlocking(ads);
    }
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (current !== session || !data.fatal) return;
    session.retries += 1;
    if (session.retries > 5) {
      const d = data as unknown as { details?: string; response?: { code?: number } };
      const why = [d.details, d.response?.code ? `HTTP ${d.response.code}` : ""].filter(Boolean).join(", ");
      close(`The stream stopped (it may have ended)${why ? `: ${why}` : ""}.`);
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      hls.recoverMediaError();
    } else {
      // the address may have expired, or the stream restarted: ask Streamlink again
      void resolve();
    }
  });
  video.addEventListener(
    "playing",
    () => {
      if (current === session) {
        session.retries = 0;
        if (!session.blocking) setNotice("");
      }
    },
    { once: true },
  );
  hls.loadSource(url);
  hls.attachMedia(video);
  void video.play().catch(() => {
    // autoplay blocked: the user can press play
  });
}

/** A single video file (YouTube, when there's no HLS stream). */
function playFile(url: string) {
  const session = current;
  if (!session) return;
  destroyPlayer();
  video.src = url;
  video.addEventListener("playing", () => current === session && setNotice(""), { once: true });
  video.addEventListener("error", () => current === session && close("The video couldn't be played."), { once: true });
  void video.play().catch(() => {
    // autoplay blocked: the user can press play
  });
}

/** Close the player, telling the app why (null: stopped by the user). */
function close(error: string | null) {
  pausedByHiding = false;
  if (!current) return;
  const id = current.id;
  destroyPlayer();
  if (fullscreen) void setFullscreen(false);
  host.classList.remove("blocking");
  if (current.blocking) video.muted = savedMuted;
  current = null;
  video.removeAttribute("src");
  video.load();
  setNotice("");
  sbBar.replaceChildren();
  sbToast.classList.remove("visible");
  layout();
  ctx.closed(id, error);
}

function chip(status: AdblockStatus | null, platform: Platform): HTMLElement | null {
  if (!status) return platform === "kick" ? h("span", { class: "chip kick" }, "Kick") : h("span", { class: "chip info" }, "Starting…");
  const extra = status.server ? ` · ${status.server}` : platform === "youtube" && status.detail ? ` · ${status.detail}` : "";
  return h("span", { class: `chip ${status.level}`, title: status.detail }, status.label, extra);
}

function qualitySelect(c: Current): HTMLElement {
  const select = h(
    "select",
    {
      class: "player-quality",
      title: "Stream quality",
      onchange: (e) => {
        const name = (e.target as HTMLSelectElement).value;
        const q = c.qualities.find((x) => x.name === name);
        if (!q || current !== c) return;
        c.quality = q.name;
        if (q.url.startsWith("level:") && c.hls) {
          c.hls.currentLevel = Number(q.url.slice(6));
          return;
        }
        setNotice(`Switching to ${q.name}…`);
        play(q.url);
      },
    },
    ...c.qualities.map((q) => h("option", { value: q.name, selected: q.name === c.quality }, q.name)),
  );
  return select;
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "english",
  es: "spanish",
  pt: "portuguese",
  fr: "french",
  de: "german",
  it: "italian",
  ja: "japanese",
  ko: "korean",
  ru: "russian",
  hi: "hindi",
};

function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

function audioSelect(c: Current): HTMLElement {
  return h(
    "select",
    {
      class: "player-quality",
      title: "Audio language",
      onchange: (e) => {
        const id = Number((e.target as HTMLSelectElement).value);
        if (current !== c || !c.hls) return;
        c.audio = id;
        c.hls.audioTrack = id;
      },
    },
    ...c.audioTracks.map((t) => h("option", { value: String(t.id), selected: t.id === c.audio }, t.name)),
  );
}

function renderBar() {
  if (!current) {
    bar.replaceChildren();
    return;
  }
  const c = current;
  const button = (label: string, title: string, onclick: () => void, cls = "player-btn") =>
    h("button", { class: cls, title, onclick }, label);
  const items: (Node | null)[] = [
    c.mode === "full" && !fullscreen ? button("‹ Back", "Keep watching in the corner and browse", () => minimize()) : null,
    h("strong", { class: "player-name", title: c.label }, c.label),
    chip(c.status, c.platform),
    h("span", { class: "player-spacer" }),
    c.mode === "mini" ? button("⤢", "Show the stream", () => expand()) : null,
    c.mode === "full" && c.audioTracks.length > 1 ? audioSelect(c) : null,
    c.mode === "full" && c.qualities.length > 1 ? qualitySelect(c) : null,
    c.mode === "full" && ctx.chatEnabled() && !fullscreen && c.platform !== "youtube"
      ? button("Chat", "Open chat", () => ctx.openChat(c.platform, c.channel))
      : null,
    c.mode === "full" ? button(fullscreen ? "Exit full screen" : "Full screen", "Full screen (Esc to leave)", () => void setFullscreen(!fullscreen)) : null,
    c.mode === "full" && !fullscreen && c.platform !== "youtube"
      ? button("Open in player", "Watch in your video player instead", () => toExternal())
      : null,
    button(c.mode === "mini" ? "×" : "Stop", "Stop the stream", () => stopCurrent(), "player-btn stop"),
  ];
  bar.replaceChildren(...items.filter((n): n is Node => n !== null));
}

function layout() {
  host.className = current ? `${current.mode}${fullscreen ? " fullscreen" : ""}` : "";
  document.body.classList.toggle("player-full", current?.mode === "full");
  renderBar();
}

async function setFullscreen(on: boolean) {
  if (!current) return;
  fullscreen = on;
  if (on) ctx.closeChat();
  try {
    await getCurrentWindow().setFullscreen(on);
  } catch {
    // the app's window stays as it is; the player still fills it
  }
  layout();
}

let nextId = -1;

/** Start playing a stream in StreamHub (replacing the one playing). Returns its id. */
export function open(platform: Platform, channel: string, label = channel): number {
  if (current) close(null);
  const id = nextId--;
  current = {
    id,
    platform,
    channel,
    label,
    segments: [],
    undone: new Set(),
    audioTracks: [],
    audio: -1,
    mode: "full",
    status: null,
    hls: null,
    attempt: 0,
    last: false,
    retries: 0,
    blocking: false,
    resolving: false,
    qualities: [],
    quality: null,
  };
  layout();
  // YouTube: SponsorBlock loads at the same time as the stream, not after it
  if (platform === "youtube") void loadSegments(current);
  void resolve();
  return id;
}

/** Paused because the player was hidden (Settings → small player off): Show resumes it. */
let pausedByHiding = false;

export function minimize(): void {
  if (!current || current.mode !== "full") return;
  if (fullscreen) void setFullscreen(false);
  const choice = ctx.settings().miniPlayer ?? "corner";
  current.mode = choice === "corner" ? "mini" : "hidden";
  if (choice === "pause" && !video.paused) {
    video.pause();
    pausedByHiding = true;
  }
  layout();
}

export function expand(): void {
  if (!current) return;
  if (pausedByHiding) {
    pausedByHiding = false;
    void video.play().catch(() => {});
  }
  current.mode = "full";
  layout();
  window.scrollTo(0, 0);
}

export function isPlaying(id: number): boolean {
  return current?.id === id;
}

/** Stop the stream in the player. */
export function stop(id: number): void {
  if (current?.id === id) close(null);
}

function stopCurrent() {
  close(null);
}

function toExternal() {
  if (!current) return;
  const { platform, channel } = current;
  close(null);
  ctx.openExternal(platform, channel);
}
