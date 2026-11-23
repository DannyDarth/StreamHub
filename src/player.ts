// "Play in StreamHub": the in-app player. One stream at a time, shown full size below the header
// or as a mini-player in the corner while browsing. The video element lives outside the app's
// re-rendered content, so it keeps playing while pages change.
//
// Streamlink (with the ad blocking plugin) finds the stream's ad-free HLS address; hls.js plays
// it. If Twitch puts an ad into the playlist, the player asks Streamlink again with the next
// proxy; with no proxy left it blacks out and mutes the ad instead of showing it.

import Hls from "hls.js";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { h } from "./ui";
import type { AdblockStatus, Platform, Settings } from "./types";

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
  channel: string;
  mode: "full" | "mini";
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
}

interface Resolved {
  url: string;
  server: string | null;
  last: boolean;
  direct: boolean;
  /** The proxy used (index in the list): after an ad, the next one is tried. */
  index: number;
}

const VOLUME_KEY = "streamhub.player.volume";

let ctx: PlayerCtx;
let current: Current | null = null;
let fullscreen = false;

const host = h("div", { id: "player-host" });
const bar = h("div", { class: "player-bar" });
const video = h("video", { class: "player-video", controls: true, autoplay: true, playsinline: true });
const notice = h("div", { class: "player-notice" });
host.append(bar, h("div", { class: "player-stage" }, video, notice));

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
  try {
    const r = await invoke<Resolved>("resolve_stream", {
      platform: session.platform,
      channel: session.channel,
      settings: ctx.settings(),
      attempt: session.attempt,
    });
    if (current !== session) return;
    session.attempt = r.index;
    session.last = r.last;
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

/** Close the player, telling the app why (null: stopped by the user). */
function close(error: string | null) {
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
  layout();
  ctx.closed(id, error);
}

function chip(status: AdblockStatus | null, platform: Platform): HTMLElement | null {
  if (!status) return platform === "kick" ? h("span", { class: "chip kick" }, "Kick") : h("span", { class: "chip info" }, "Starting…");
  return h("span", { class: `chip ${status.level}`, title: status.detail }, status.label, status.server ? ` · ${status.server}` : "");
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
    h("strong", { class: "player-name" }, c.channel),
    chip(c.status, c.platform),
    h("span", { class: "player-spacer" }),
    c.mode === "mini" ? button("⤢", "Show the stream", () => expand()) : null,
    c.mode === "full" && ctx.chatEnabled() && !fullscreen ? button("Chat", "Open chat", () => ctx.openChat(c.platform, c.channel)) : null,
    c.mode === "full" ? button(fullscreen ? "Exit full screen" : "Full screen", "Full screen (Esc to leave)", () => void setFullscreen(!fullscreen)) : null,
    c.mode === "full" && !fullscreen ? button("Open in player", "Watch in your video player instead", () => toExternal()) : null,
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
export function open(platform: Platform, channel: string): number {
  if (current) close(null);
  const id = nextId--;
  current = {
    id,
    platform,
    channel,
    mode: "full",
    status: null,
    hls: null,
    attempt: 0,
    last: false,
    retries: 0,
    blocking: false,
    resolving: false,
  };
  layout();
  void resolve();
  return id;
}

export function minimize(): void {
  if (!current || current.mode === "mini") return;
  if (fullscreen) void setFullscreen(false);
  current.mode = "mini";
  layout();
}

export function expand(): void {
  if (!current) return;
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
