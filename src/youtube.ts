// The YouTube tab: subscriptions (signed in), search and channel pages. Data comes from the Rust
// side (youtube.rs, a hidden youtube.com page); videos play in StreamHub's player (no ads).

import { invoke } from "@tauri-apps/api/core";
import { h } from "./ui";

export interface YtVideo {
  id: string;
  title: string;
  channel: string;
  channelId: string | null;
  live: boolean;
  duration: string;
  published: string;
  views: string;
  avatar: string | null;
}

export interface YtChannel {
  id: string;
  name: string;
  avatar: string | null;
  subscribers: string;
}

export interface YtChannelPage {
  id: string;
  name: string;
  description: string;
  avatar: string | null;
  videos: YtVideo[];
}

export interface YtAccount {
  name: string;
  avatar: string | null;
}

export type YtPage = { kind: "subs" } | { kind: "search"; q: string } | { kind: "channel"; id: string };

export interface YtCtx {
  render(): void;
  account(): YtAccount | null;
  signIn(): void;
  watch(video: YtVideo): void;
}

export let nav: YtPage[] = [{ kind: "subs" }];

export function page(): YtPage {
  return nav[nav.length - 1];
}

export function go(p: YtPage): void {
  if (p.kind === "subs") nav = [p];
  else nav.push(p);
  window.scrollTo(0, 0);
}

export function back(): void {
  if (nav.length > 1) nav.pop();
}

// ---- loading, cached per page for two minutes ----

interface Entry {
  loading: boolean;
  error: string;
  data: unknown;
  at: number;
}

const cache = new Map<string, Entry>();
const MAX_AGE = 120_000;

function load<T>(ctx: YtCtx, key: string, fetcher: () => Promise<T>): Entry {
  let entry = cache.get(key);
  if (!entry || (!entry.loading && Date.now() - entry.at > MAX_AGE)) {
    entry = { loading: true, error: "", data: entry?.data ?? null, at: Date.now() };
    cache.set(key, entry);
    const current = entry;
    fetcher()
      .then((data) => {
        current.data = data;
        current.error = "";
      })
      .catch((e) => {
        current.error = String(e) === "not-signed-in" ? "not-signed-in" : String(e);
      })
      .finally(() => {
        current.loading = false;
        current.at = Date.now();
        ctx.render();
      });
  }
  return entry;
}

export function refresh(): void {
  const key = keyOf(page());
  cache.delete(key);
}

export function clearCache(): void {
  cache.clear();
}

function keyOf(p: YtPage): string {
  return p.kind === "subs" ? "subs" : p.kind === "search" ? `search:${p.q}` : `channel:${p.id}`;
}

function status(entry: Entry, empty: string, hasData: boolean): HTMLElement | null {
  if (entry.error && entry.error !== "not-signed-in") return h("p", { class: "row-error" }, entry.error);
  if (!hasData) return h("p", { class: "empty" }, entry.loading ? "Loading…" : empty);
  return null;
}

// ---- pieces ----

export function thumbnail(id: string): string {
  return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
}

function videoCard(ctx: YtCtx, v: YtVideo): HTMLElement {
  return h(
    "div",
    { class: "card-wrap" },
    h(
      "button",
      { class: "card", title: v.title, onclick: () => ctx.watch(v) },
      h(
        "div",
        { class: "thumb" },
        h("img", { src: thumbnail(v.id), alt: "", loading: "lazy", referrerpolicy: "no-referrer" }),
        v.live
          ? h("span", { class: "viewers yt-live" }, "● LIVE")
          : v.duration
            ? h("span", { class: "duration" }, v.duration)
            : null,
      ),
      h("div", { class: "card-title" }, v.title || "Untitled video"),
    ),
    h(
      "div",
      { class: "card-meta" },
      v.channelId
        ? h(
            "button",
            {
              class: "name-link",
              onclick: () => {
                go({ kind: "channel", id: v.channelId! });
                ctx.render();
              },
            },
            v.channel,
          )
        : h("strong", {}, v.channel),
      [v.views, v.published].filter(Boolean).length ? ` · ${[v.views, v.published].filter(Boolean).join(" · ")}` : "",
    ),
  );
}

function grid(ctx: YtCtx, videos: YtVideo[]): HTMLElement {
  return h("div", { class: "grid" }, ...videos.map((v) => videoCard(ctx, v)));
}

function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return h("section", { class: "section" }, h("h2", {}, title), ...children);
}

// ---- pages ----

function subs(ctx: YtCtx): HTMLElement {
  if (!ctx.account()) {
    return h(
      "div",
      { class: "signin" },
      h("h1", {}, "Your YouTube subscriptions, without ads"),
      h("p", { class: "muted" }, "Sign in to YouTube to see new videos and live streams from your subscriptions. You can also search above."),
      h("button", { class: "yt-signin", onclick: () => ctx.signIn() }, "Sign in to YouTube"),
    );
  }
  const entry = load(ctx, "subs", () => invoke<YtVideo[]>("yt_feed"));
  const videos = (entry.data as YtVideo[] | null) ?? [];
  const live = videos.filter((v) => v.live);
  const recent = videos.filter((v) => !v.live);
  if (entry.error === "not-signed-in") {
    return h(
      "div",
      { class: "signin" },
      h("p", { class: "muted" }, "Your YouTube sign-in has expired."),
      h("button", { class: "yt-signin", onclick: () => ctx.signIn() }, "Sign in to YouTube"),
    );
  }
  return h(
    "div",
    {},
    status(entry, "No new videos from your subscriptions.", videos.length > 0),
    live.length ? section("Live now", grid(ctx, live)) : null,
    recent.length ? section("New videos", grid(ctx, recent)) : null,
  );
}

function search(ctx: YtCtx, q: string): HTMLElement {
  const entry = load(ctx, `search:${q}`, () => invoke<{ videos: YtVideo[]; channels: YtChannel[] }>("yt_search", { query: q }));
  const data = entry.data as { videos: YtVideo[]; channels: YtChannel[] } | null;
  const channels = data?.channels ?? [];
  const videos = data?.videos ?? [];
  return h(
    "div",
    {},
    h("h1", { class: "page-title" }, `Results for “${q}”`),
    status(entry, "Nothing found.", channels.length + videos.length > 0),
    channels.length
      ? section(
          "Channels",
          h(
            "div",
            { class: "rows" },
            ...channels.slice(0, 5).map((c) =>
              h(
                "div",
                { class: "row" },
                c.avatar ? h("img", { class: "avatar", src: c.avatar, alt: "", referrerpolicy: "no-referrer" }) : h("span", { class: "avatar" }),
                h(
                  "button",
                  {
                    class: "name-link",
                    onclick: () => {
                      go({ kind: "channel", id: c.id });
                      ctx.render();
                    },
                  },
                  c.name,
                ),
                h("span", { class: "muted" }, c.subscribers),
              ),
            ),
          ),
        )
      : null,
    videos.length ? section("Videos", grid(ctx, videos)) : null,
  );
}

function channel(ctx: YtCtx, id: string): HTMLElement {
  const entry = load(ctx, `channel:${id}`, () => invoke<YtChannelPage>("yt_channel", { id }));
  const c = entry.data as YtChannelPage | null;
  if (!c) return status(entry, "Channel not found.", false) ?? h("p", {}, "");
  return h(
    "div",
    {},
    h(
      "div",
      { class: "channel-head" },
      c.avatar ? h("img", { class: "channel-avatar", src: c.avatar, alt: "", referrerpolicy: "no-referrer" }) : h("span", { class: "channel-avatar" }),
      h("div", { class: "channel-info" }, h("h1", {}, c.name), c.description ? h("p", { class: "bio" }, c.description.slice(0, 400)) : null),
    ),
    c.videos.length ? grid(ctx, c.videos) : h("p", { class: "empty" }, "No videos."),
  );
}

export function content(ctx: YtCtx): HTMLElement {
  const p = page();
  if (p.kind === "search") return search(ctx, p.q);
  if (p.kind === "channel") return channel(ctx, p.id);
  return subs(ctx);
}
