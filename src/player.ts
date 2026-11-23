// "Play in StreamHub": the in-app player. One stream at a time, shown full size below the header
// or as a mini-player in the corner while browsing. The video element lives outside the app's
// re-rendered content, so it keeps playing while pages change.

import mpegts from "mpegts.js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { h } from "./ui";
import type { AdblockStatus, Platform } from "./types";

export interface PlayerCtx {
  /** Stop the Streamlink session behind the player. */
  stop(id: number): Promise<void>;
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
  url: string;
  mode: "full" | "mini";
  status: AdblockStatus | null;
  player: mpegts.Player | null;
  retries: number;
  retryTimer?: number;
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
  video.addEventListener("volumechange", () => {
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
  return mpegts.getFeatureList().mseLivePlayback;
}

export function activeId(): number | null {
  return current?.id ?? null;
}

function setNotice(text: string) {
  notice.textContent = text;
  notice.classList.toggle("visible", Boolean(text));
}

function destroyPlayer() {
  if (!current) return;
  window.clearTimeout(current.retryTimer);
  if (current.player) {
    try {
      current.player.pause();
      current.player.unload();
      current.player.detachMediaElement();
      current.player.destroy();
    } catch {
      // already gone
    }
    current.player = null;
  }
}

/** (Re)connect to the stream: after a start, a proxy switch or a hiccup. */
function connect() {
  if (!current) return;
  destroyPlayer();
  const session = current;
  const player = mpegts.createPlayer(
    { type: "mpegts", isLive: true, url: session.url },
    {
      enableWorker: false,
      lazyLoad: false,
      // Don't jump ahead to catch up with live: the jumps land between keyframes, which showed
      // as blocky, smeared video. Streamlink already starts close to live.
      liveBufferLatencyChasing: false,
      liveSync: false,
      // a bigger first chunk so playback starts on whole frames
      stashInitialSize: 1024 * 1024,
    },
  );
  session.player = player;
  player.attachMediaElement(video);
  player.load();
  void Promise.resolve(player.play()).catch(() => {
    // autoplay blocked: the user can press play
  });
  const retry = () => {
    if (current !== session || session.retryTimer) return;
    session.retries += 1;
    if (session.retries > 30) {
      setNotice("The stream stopped.");
      return;
    }
    setNotice(session.status?.label === "Switching proxy" ? "Switching to another ad-free server…" : "Reconnecting…");
    session.retryTimer = window.setTimeout(() => {
      session.retryTimer = undefined;
      if (current === session) connect();
    }, 1500);
  };
  player.on(mpegts.Events.ERROR, retry);
  player.on(mpegts.Events.LOADING_COMPLETE, retry);
  video.addEventListener(
    "playing",
    () => {
      if (current === session) {
        session.retries = 0;
        setNotice("");
      }
    },
    { once: true },
  );
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
    c.mode === "full" && !fullscreen ? button("Open in player", "Watch in your video player instead", () => void toExternal()) : null,
    button(c.mode === "mini" ? "×" : "Stop", "Stop the stream", () => void stopCurrent(), "player-btn stop"),
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

/** Start playing a stream in StreamHub (replacing the one playing). */
export async function open(id: number, platform: Platform, channel: string, url: string): Promise<void> {
  if (current && current.id !== id) {
    const old = current.id;
    destroyPlayer();
    current = null;
    await ctx.stop(old);
  }
  current = { id, platform, channel, url, mode: "full", status: null, player: null, retries: 0 };
  setNotice("Finding the stream…");
  layout();
  connect();
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

export function setStatus(id: number, status: AdblockStatus): void {
  if (current?.id !== id) return;
  current.status = status;
  renderBar();
}

/** The Streamlink session ended (stopped, or the stream went offline). */
export function ended(id: number, error: string | null): void {
  if (current?.id !== id) return;
  destroyPlayer();
  if (fullscreen) void setFullscreen(false);
  current = null;
  video.removeAttribute("src");
  video.load();
  setNotice(error ?? "");
  layout();
}

async function stopCurrent() {
  if (!current) return;
  const id = current.id;
  destroyPlayer();
  await ctx.stop(id);
}

async function toExternal() {
  if (!current) return;
  const { platform, channel } = current;
  await stopCurrent();
  ctx.openExternal(platform, channel);
}
