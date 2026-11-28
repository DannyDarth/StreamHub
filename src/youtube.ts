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
  /** How much of it you've watched on YouTube (any device), in percent. */
  resume?: number;
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

export type YtPage = { kind: "home" } | { kind: "subs" } | { kind: "history" } | { kind: "later" } | { kind: "search"; q: string } | { kind: "channel"; id: string };

export interface YtCtx {
  render(): void;
  account(): YtAccount | null;
  signIn(): void;
  watch(video: YtVideo): void;
}

export let nav: YtPage[] = [{ kind: "home" }];

export function page(): YtPage {
  return nav[nav.length - 1];
}

export function go(p: YtPage): void {
  if (p.kind === "subs" || p.kind === "home" || p.kind === "history" || p.kind === "later") nav = [p];
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
  /** Feeds: more pages have been added, so the entry isn't reloaded until Refresh. */
  paged?: boolean;
  more?: boolean;
  moreError?: string;
}

/** One page of a feed (Home, Subscriptions). */
interface Feed {
  videos: YtVideo[];
  next: string | null;
}

const cache = new Map<string, Entry>();
const MAX_AGE = 120_000;

function load<T>(ctx: YtCtx, key: string, fetcher: () => Promise<T>): Entry {
  let entry = cache.get(key);
  if (!entry || (!entry.loading && !entry.paged && Date.now() - entry.at > MAX_AGE)) {
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

/** Load the next page of a feed and add it to the end. */
function loadMore(ctx: YtCtx, key: string, command: string): void {
  const entry = cache.get(key);
  const feed = entry?.data as Feed | null;
  if (!entry || entry.loading || entry.more || entry.moreError || !feed?.next) return;
  entry.more = true;
  invoke<Feed>(command, { token: feed.next })
    .then((page) => {
      if (cache.get(key) !== entry) return;
      const seen = new Set(feed.videos.map((v) => v.id));
      entry.data = { videos: [...feed.videos, ...page.videos.filter((v) => !seen.has(v.id))], next: page.next };
      entry.paged = true;
    })
    .catch((e) => {
      // Stop and show the error with a "Try again" button, instead of retrying forever
      if (cache.get(key) === entry) entry.moreError = String(e);
    })
    .finally(() => {
      entry.more = false;
      ctx.render();
    });
}

let moreObserver: IntersectionObserver | null = null;

/** The end of a feed: loads the next page when scrolled near it. */
function feedEnd(ctx: YtCtx, key: string, command: string, entry: Entry): HTMLElement | null {
  const feed = entry.data as Feed | null;
  if (!feed?.next || entry.loading) return null;
  if (entry.moreError) {
    return h(
      "div",
      { class: "empty" },
      h("p", { class: "row-error" }, `Couldn't load more videos: ${entry.moreError}`),
      h("button", { onclick: () => { entry.moreError = undefined; loadMore(ctx, key, command); ctx.render(); } }, "Try again"),
    );
  }
  const end = h("p", { class: "empty" }, "Loading more…");
  moreObserver?.disconnect();
  moreObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore(ctx, key, command);
    },
    { rootMargin: "1200px" },
  );
  moreObserver.observe(end);
  return end;
}

export function refresh(): void {
  const key = keyOf(page());
  cache.delete(key);
}

export function clearCache(): void {
  cache.clear();
}

function keyOf(p: YtPage): string {
  return p.kind === "home" ? "home" : p.kind === "subs" ? "subs" : p.kind === "history" ? "history" : p.kind === "later" ? "later" : p.kind === "search" ? `search:${p.q}` : `channel:${p.id}`;
}

function status(entry: Entry, empty: string, hasData: boolean): HTMLElement | null {
  if (entry.error && entry.error !== "not-signed-in") return h("p", { class: "row-error" }, entry.error);
  if (!hasData) return h("p", { class: "empty" }, entry.loading ? "Loading…" : empty);
  return null;
}

// ---- pieces ----

export function thumbnail(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

function videoCard(ctx: YtCtx, v: YtVideo): HTMLElement {
  const openChannel = v.channelId
    ? () => {
        go({ kind: "channel", id: v.channelId! });
        ctx.render();
      }
    : null;
  // signed in: + Watch later on hover
  const later =
    ctx.account() && !v.live
      ? h(
          "button",
          {
            class: "yt-later",
            title: "Save to your Watch later list",
            onclick: (e) => {
              e.stopPropagation();
              const b = e.currentTarget as HTMLButtonElement;
              b.disabled = true;
              b.textContent = "Saving…";
              invoke("yt_watch_later_edit", { id: v.id, add: true })
                .then(() => {
                  b.textContent = "✓ Watch later";
                  b.classList.add("saved");
                  cache.delete("later");
                })
                .catch((err) => {
                  b.disabled = false;
                  b.textContent = "Couldn't save: try again";
                  b.title = String(err);
                });
            },
          },
          "+ Watch later",
        )
      : null;
  return h(
    "div",
    { class: "yt-card" },
    later,
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
    ),
    h(
      "div",
      { class: "yt-card-info" },
      v.avatar
        ? h(
            "button",
            { class: "yt-avatar", title: v.channel, onclick: () => openChannel?.() },
            h("img", { src: v.avatar, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }),
          )
        : null,
      h(
        "div",
        { class: "yt-card-text" },
        h("button", { class: "yt-title", title: v.title, onclick: () => ctx.watch(v) }, v.title || "Untitled video"),
        openChannel
          ? h("button", { class: "name-link yt-channel", onclick: openChannel }, v.channel)
          : h("div", { class: "yt-channel" }, v.channel),
        h("div", { class: "yt-meta" }, [v.views, v.published].filter(Boolean).join(" · ")),
      ),
    ),
  );
}

function grid(ctx: YtCtx, videos: YtVideo[]): HTMLElement {
  return h("div", { class: "grid yt-grid" }, ...videos.map((v) => videoCard(ctx, v)));
}

function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return h("section", { class: "section" }, h("h2", {}, title), ...children);
}

/** The day a video came out, from YouTube's "3 hours ago" text: "Today", "Yesterday", a weekday,
 * "Last week" and so on. YouTube only gives the age, so hours are counted back from now. */
export function dayLabel(published: string, now = new Date()): string {
  if (/scheduled|premieres|upcoming/i.test(published)) return "Upcoming";
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year)/i.exec(published);
  if (!m) return "Earlier";
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "week") return n === 1 ? "Last week" : `${n} weeks ago`;
  if (unit === "month") return n === 1 ? "Last month" : `${n} months ago`;
  if (unit === "year") return n === 1 ? "Last year" : `${n} years ago`;
  const hours = unit === "day" ? n * 24 : unit === "hour" ? n : 0;
  const date = new Date(now.getTime() - hours * 3600_000);
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(date)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "long" });
  return "Last week";
}

/** Videos grouped by day, in feed order (newest first). */
function byDay(ctx: YtCtx, videos: YtVideo[]): HTMLElement[] {
  const groups = new Map<string, YtVideo[]>();
  for (const v of videos) {
    const label = dayLabel(v.published);
    groups.set(label, [...(groups.get(label) ?? []), v]);
  }
  return [...groups].map(([label, list]) => section(label, grid(ctx, list)));
}

// ---- pages ----

function home(ctx: YtCtx): HTMLElement {
  const entry = load(ctx, "home", () => invoke<Feed>("yt_home"));
  const videos = (entry.data as Feed | null)?.videos ?? [];
  const live = videos.filter((v) => v.live);
  const rest = videos.filter((v) => !v.live);
  return h(
    "div",
    {},
    status(entry, "YouTube didn't recommend any videos.", videos.length > 0),
    live.length ? section("Live now", grid(ctx, live)) : null,
    rest.length ? section("Recommended", grid(ctx, rest)) : null,
    feedEnd(ctx, "home", "yt_home", entry),
  );
}

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
  const entry = load(ctx, "subs", () => invoke<Feed>("yt_feed"));
  const videos = (entry.data as Feed | null)?.videos ?? [];
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
    ...byDay(ctx, recent),
    feedEnd(ctx, "subs", "yt_feed", entry),
  );
}

/** Your YouTube watch history, grouped by the days YouTube gives (Today, Yesterday…). */
function history(ctx: YtCtx): HTMLElement {
  if (!ctx.account()) {
    return h(
      "div",
      { class: "signin" },
      h("h1", {}, "Your YouTube watch history"),
      h("p", { class: "muted" }, "Sign in to YouTube to see the videos you've watched."),
      h("button", { class: "yt-signin", onclick: () => ctx.signIn() }, "Sign in to YouTube"),
    );
  }
  const entry = load(ctx, "history", () => invoke<Feed>("yt_history"));
  if (entry.error === "not-signed-in") {
    return h(
      "div",
      { class: "signin" },
      h("p", { class: "muted" }, "Your YouTube sign-in has expired."),
      h("button", { class: "yt-signin", onclick: () => ctx.signIn() }, "Sign in to YouTube"),
    );
  }
  const videos = ((entry.data as Feed | null)?.videos ?? []) as HistoryVideo[];
  const groups = new Map<string, HistoryVideo[]>();
  for (const v of videos) {
    const day = v.day || "Earlier";
    groups.set(day, [...(groups.get(day) ?? []), v]);
  }
  return h(
    "div",
    {},
    h(
      "p",
      { class: "muted small-note" },
      "Videos you watched on YouTube. What you watch in StreamHub isn't added: StreamHub plays videos without telling YouTube.",
    ),
    status(entry, "Your watch history is empty (or turned off in your YouTube account).", videos.length > 0),
    ...[...groups].map(([day, list]) =>
      section(day, h("div", { class: "grid yt-grid" }, ...list.map((v) => historyCard(ctx, entry, v)))),
    ),
    feedEnd(ctx, "history", "yt_history", entry),
  );
}

type HistoryVideo = YtVideo & { day?: string; remove?: string | null };

/** Your Watch later list (signed in), with Remove. */
function watchLater(ctx: YtCtx): HTMLElement {
  if (!ctx.account()) {
    return h(
      "div",
      { class: "signin" },
      h("h1", {}, "Watch later"),
      h("p", { class: "muted" }, "Sign in to YouTube to see your Watch later list."),
      h("button", { class: "yt-signin", onclick: () => ctx.signIn() }, "Sign in to YouTube"),
    );
  }
  const entry = load(ctx, "later", () => invoke<Feed>("yt_watch_later"));
  const videos = (entry.data as Feed | null)?.videos ?? [];
  return h(
    "div",
    {},
    status(entry, "Nothing in Watch later. Add videos with + Watch later on any video.", videos.length > 0),
    videos.length
      ? h(
          "div",
          { class: "grid yt-grid" },
          ...videos.map((v) =>
            removableCard(ctx, entry, v, "Take it off Watch later", () => invoke("yt_watch_later_edit", { id: v.id, add: false })),
          ),
        )
      : null,
    feedEnd(ctx, "later", "yt_watch_later", entry),
  );
}

/** A card with a Remove button on hover. */
function removableCard(ctx: YtCtx, entry: Entry, v: YtVideo, title: string, remove: () => Promise<unknown>): HTMLElement {
  const card = videoCard(ctx, v);
  const button = h(
    "button",
    {
      class: "yt-remove",
      title,
      onclick: (e) => {
        e.stopPropagation();
        const b = e.currentTarget as HTMLButtonElement;
        b.disabled = true;
        b.textContent = "Removing…";
        remove()
          .then(() => {
            const feed = entry.data as Feed | null;
            if (feed) entry.data = { ...feed, videos: feed.videos.filter((x) => x.id !== v.id) };
            ctx.render();
          })
          .catch((err) => {
            b.disabled = false;
            b.textContent = "Couldn't remove: try again";
            b.title = String(err);
          });
      },
    },
    "× Remove",
  );
  card.append(button);
  return card;
}

/** A history video with a Remove button (YouTube's "Remove from watch history"). */
function historyCard(ctx: YtCtx, entry: Entry, v: HistoryVideo): HTMLElement {
  const card = videoCard(ctx, v);
  if (!v.remove) return card;
  const button = h(
    "button",
    {
      class: "yt-remove",
      title: "Remove from your YouTube watch history",
      onclick: (e) => {
        e.stopPropagation();
        const b = e.currentTarget as HTMLButtonElement;
        b.disabled = true;
        b.textContent = "Removing…";
        invoke("yt_history_remove", { token: v.remove })
          .then(() => {
            const feed = entry.data as Feed | null;
            if (feed) entry.data = { ...feed, videos: feed.videos.filter((x) => x.id !== v.id) };
            ctx.render();
          })
          .catch((err) => {
            b.disabled = false;
            b.textContent = "Couldn't remove: try again";
            b.title = String(err);
          });
      },
    },
    "× Remove",
  );
  card.append(button);
  return card;
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
  if (p.kind === "history") return history(ctx);
  if (p.kind === "later") return watchLater(ctx);
  if (p.kind === "home") return home(ctx);
  return subs(ctx);
}
