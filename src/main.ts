import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  DEFAULTS,
  LANGUAGES,
  QUALITIES,
  applyTheme,
  followSystemTheme,
  loadSettings,
  saveSettings,
} from "./settings";
import { AuthError, followedLive, validateToken } from "./twitch";
import { loadKickSlugs, parseKickInput, saveKickSlugs } from "./kick";
import { h } from "./ui";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdate, type Update } from "./updates";
import * as browse from "./browse";
import * as player from "./player";
import * as yt from "./youtube";
import { CATEGORIES as SB_CATEGORIES } from "./sponsorblock";
import type {
  AdblockStatus,
  EndedEvent,
  KickAccount,
  KickChannel,
  KickFollowed,
  LiveStream,
  Platform,
  Settings,
  StatusEvent,
  StreamlinkInfo,
  TwitchUser,
} from "./types";

const TOKEN_KEY = "streamhub.token";
const REFRESH_MS = 60_000;

type View = "twitch" | "kick" | "youtube" | "crunchyroll" | "settings";

interface Playing {
  platform: Platform;
  channel: string;
  /** Playing in StreamHub's own player. */
  inApp?: boolean;
  status: AdblockStatus | null;
}

const savedToken = localStorage.getItem(TOKEN_KEY) ?? "";
const savedKick = loadKickSlugs();

const state = {
  token: savedToken,
  user: null as TwitchUser | null,
  view: (!savedToken && savedKick.length > 0 ? "kick" : "twitch") as View,
  settings: loadSettings(),
  settingsTab: "general" as SettingsTab,
  streams: [] as LiveStream[],
  loading: false,
  error: "",
  playing: new Map<number, Playing>(),
  message: "",
  known: null as Set<string> | null,
  info: null as StreamlinkInfo | null,
  kickSlugs: savedKick,
  kickChannels: [] as KickChannel[],
  kickLoading: false,
  kickError: "",
  kickKnown: null as Set<string> | null,
  search: "",
  ytAccount: null as yt.YtAccount | null,
  update: null as Update | null,
  /** The version downloaded and waiting to install. */
  updateReady: "",
  updateDownloading: "",
  appVersion: "",
  kickAccount: null as KickAccount | null,
  kickFollowed: [] as KickFollowed[],
  /** The channel shown in the chat panel. */
  chat: null as { platform: Platform; channel: string } | null,
};

const app = document.getElementById("app")!;

// ---- actions ----

async function signIn() {
  state.error = "";
  state.message = "Finish signing in to Twitch in your browser…";
  render();
  try {
    const token = await invoke<string>("twitch_login");
    state.token = token;
    localStorage.setItem(TOKEN_KEY, token);
    state.message = "";
    await start();
  } catch (e) {
    state.message = "";
    state.error = String(e);
    render();
  }
}

function signOut() {
  state.token = "";
  state.user = null;
  state.streams = [];
  state.known = null;
  localStorage.removeItem(TOKEN_KEY);
  render();
}

interface LiveItem {
  key: string;
  name: string;
  detail: string;
}

/** Notify about channels that weren't live at the previous check. Returns the new "known" set. */
async function notifyNew(items: LiveItem[], before: Set<string> | null, site: string): Promise<Set<string>> {
  const live = new Set(items.map((i) => i.key));
  if (!before || !state.settings.notifications) return live;
  const fresh = items.filter((i) => !before.has(i.key));
  if (fresh.length === 0) return live;

  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (!granted) return live;
  if (fresh.length > 3) {
    sendNotification({ title: "StreamHub", body: `${fresh.length} of your ${site} channels went live` });
    return live;
  }
  for (const item of fresh) {
    sendNotification({ title: `${item.name} is live on ${site}`, body: item.detail });
  }
  return live;
}

async function refresh() {
  if (!state.token || !state.user) return;
  state.loading = true;
  render();
  try {
    const streams = await followedLive(state.token, state.user);
    state.streams = streams;
    state.error = "";
    state.known = await notifyNew(
      streams.map((st) => ({ key: st.user_id, name: st.user_name, detail: st.title || st.game_name })),
      state.known,
      "Twitch",
    );
  } catch (e) {
    if (e instanceof AuthError) {
      signOut();
      state.error = e.message;
    } else {
      state.error = `Couldn't load your followed channels: ${String(e)}`;
    }
  } finally {
    state.loading = false;
    render();
  }
}

async function start() {
  if (!state.token) {
    render();
    return;
  }
  try {
    state.user = await validateToken(state.token);
  } catch (e) {
    if (e instanceof AuthError) signOut();
    state.error = String(e instanceof Error ? e.message : e);
    render();
    return;
  }
  await refresh();
}

/** Every Kick channel shown under "My channels": the ones the user added and the ones they follow. */
function allKickSlugs(): string[] {
  return [...new Set([...state.kickSlugs, ...state.kickFollowed.map((f) => f.slug)])];
}

const KICK_CACHE = "streamhub.kick.cache";

/** Show the last Kick results right away at start-up, while fresh ones load. */
function loadKickCache() {
  try {
    const c = JSON.parse(localStorage.getItem(KICK_CACHE) ?? "null") as {
      account: KickAccount | null;
      followed: KickFollowed[];
      channels: KickChannel[];
    } | null;
    if (!c) return;
    state.kickAccount = c.account;
    state.kickFollowed = c.followed ?? [];
    state.kickChannels = c.channels ?? [];
  } catch {
    // no cache
  }
}

function saveKickCache() {
  try {
    localStorage.setItem(
      KICK_CACHE,
      JSON.stringify({ account: state.kickAccount, followed: state.kickFollowed, channels: state.kickChannels }),
    );
  } catch {
    // storage unavailable
  }
}

/** Set when Kick said nobody is signed in: then the followed list isn't asked for until sign-in. */
let kickSignedOut = false;

function kickNotSignedIn() {
  kickSignedOut = true;
  state.kickAccount = null;
  state.kickFollowed = [];
}

async function checkKickAccount() {
  try {
    state.kickAccount = await invoke<KickAccount>("kick_account");
    kickSignedOut = false;
  } catch (e) {
    if (String(e) === "not-signed-in") kickNotSignedIn();
    else state.kickError = `Couldn't check your Kick sign-in: ${String(e)}`;
  }
  render();
}

function checkKickChannels(slugs: string[]): Promise<KickChannel[]> {
  return slugs.length ? invoke<KickChannel[]>("kick_channels", { slugs }) : Promise.resolve([]);
}

/** Merge fresh channel checks into what's shown. */
function mergeKickChannels(fresh: KickChannel[]) {
  const bySlug = new Map(state.kickChannels.map((c) => [c.slug, c]));
  for (const c of fresh) bySlug.set(c.slug, c);
  const wanted = new Set(allKickSlugs());
  state.kickChannels = [...bySlug.values()].filter((c) => wanted.has(c.slug));
}

/**
 * Load the followed channels page by page, showing each page as it arrives (live channels come
 * first). Live ones without a picture get their details fetched right away, into `details`.
 */
async function loadFollowed(details: Promise<void>[]) {
  const before = state.kickFollowed;
  const loaded: KickFollowed[] = [];
  const addedSet = new Set(state.kickSlugs);
  let cursor: unknown = 0;
  try {
    for (let page = 0; page < 40 && cursor !== null && cursor !== undefined; page++) {
      const r = await invoke<{ channels: KickFollowed[]; next: unknown }>("kick_followed", { cursor });
      kickSignedOut = false;
      loaded.push(...r.channels);
      const seen = new Set(loaded.map((f) => f.slug));
      // while loading, keep the earlier list's other channels so nothing blinks out
      state.kickFollowed = [...loaded, ...before.filter((f) => !seen.has(f.slug))];
      render();
      const need = r.channels.filter((f) => f.live && !f.thumbnail && !addedSet.has(f.slug)).map((f) => f.slug);
      if (need.length) details.push(checkKickChannels(need).then((c) => mergeKickChannels(c)).then(() => render()));
      cursor = r.next;
    }
    state.kickFollowed = loaded;
  } catch (e) {
    if (String(e) === "not-signed-in") kickNotSignedIn();
    else state.kickError = `Couldn't load the Kick channels you follow: ${String(e)}`;
  }
}

let kickRefreshing: Promise<void> | null = null;

function refreshKick(): Promise<void> {
  kickRefreshing ??= doRefreshKick().finally(() => (kickRefreshing = null));
  return kickRefreshing;
}

async function doRefreshKick() {
  state.kickLoading = true;
  render();
  try {
    // the followed list and the channels added by hand load at the same time
    const details: Promise<void>[] = [];
    const followed = kickSignedOut ? Promise.resolve() : loadFollowed(details);
    const added = checkKickChannels(state.kickSlugs).then((channels) => {
      mergeKickChannels(channels);
      render();
    });
    await followed;
    await Promise.all([added, ...details]);

    if (!state.kickError.startsWith("Couldn't load")) state.kickError = "";
    saveKickCache();
    const live = kickLive();
    state.kickKnown = await notifyNew(
      live.map((c) => ({ key: c.slug, name: c.name, detail: c.title || c.category })),
      state.kickKnown,
      "Kick",
    );
  } catch (e) {
    state.kickError = `Couldn't check your Kick channels: ${String(e)}`;
  } finally {
    state.kickLoading = false;
    render();
  }
}

/** Live Kick channels: from the channel checks, or the followed list when a check failed. */
function kickLive(): KickChannel[] {
  const bySlug = new Map(state.kickChannels.map((c) => [c.slug, c]));
  const followed = new Map(state.kickFollowed.map((f) => [f.slug, f]));
  const live: KickChannel[] = [];
  const added = new Set(state.kickSlugs);
  for (const slug of allKickSlugs()) {
    const checked = bySlug.get(slug);
    const f = followed.get(slug);
    // a followed channel's live status comes from the (fresher) followed list; the channel
    // check only adds its picture and details
    if (f && !added.has(slug)) {
      if (!f.live) continue;
      if (checked && !checked.error && checked.live) {
        live.push({ ...checked, viewers: f.viewers ?? checked.viewers, title: f.title || checked.title });
        continue;
      }
    } else if (checked && !checked.error) {
      if (checked.live) live.push(checked);
      continue;
    }
    if (f?.live) {
      live.push({
        slug,
        name: f.name,
        live: true,
        title: f.title,
        category: f.category,
        viewers: f.viewers,
        thumbnail: f.thumbnail ?? null,
        avatar: f.avatar,
        startedAt: null,
        bio: null,
        followers: null,
        error: null,
      });
    }
  }
  return live.sort((a, b) => (b.viewers ?? 0) - (a.viewers ?? 0));
}

async function kickSignIn() {
  state.kickError = "";
  try {
    await invoke("kick_login");
    state.message = "Sign in on kick.com in the window that opened, then close it.";
  } catch (e) {
    state.kickError = String(e);
  }
  render();
}

async function kickSignOut() {
  try {
    await invoke("kick_logout");
  } catch (e) {
    state.kickError = String(e);
  }
  kickNotSignedIn();
  render();
  void refreshKick();
}

function addKick(input: string): boolean {
  const { slugs, invalid } = parseKickInput(input);
  if (invalid.length > 0) {
    state.kickError = `Not a Kick channel name: ${invalid.join(", ")}`;
    render();
    return false;
  }
  if (slugs.length === 0) return false;
  state.kickError = "";
  state.kickSlugs = saveKickSlugs([...state.kickSlugs, ...slugs]);
  void refreshKick();
  return true;
}

function removeKick(slug: string) {
  state.kickSlugs = saveKickSlugs(state.kickSlugs.filter((s) => s !== slug));
  state.kickChannels = state.kickChannels.filter((c) => c.slug !== slug);
  state.kickKnown?.delete(slug);
  render();
}

async function watch(platform: Platform, channel: string, where: Settings["playIn"] = state.settings.playIn) {
  state.error = "";
  try {
    const inApp = where === "app" && player.supported();
    if (inApp) {
      // StreamHub's player: one stream at a time, so the one playing there closes
      for (const [oldId, p] of state.playing) if (p.inApp) state.playing.delete(oldId);
    }
    const id = inApp
      ? player.open(platform, channel.toLowerCase())
      : await invoke<number>("watch", { platform, channel, settings: state.settings });
    state.playing.set(id, { platform, channel, status: null, inApp });
    if (state.settings.chatEnabled && state.settings.chatAutoOpen) void openChat(platform, channel);
  } catch (e) {
    state.error = String(e);
  }
  render();
}

async function openChat(platform: Platform, channel: string) {
  const provider = state.settings.chatProvider;
  try {
    await invoke("open_chat", { platform, channel, provider });
    const inPanel = provider === "panel" || (provider === "chatterino" && platform === "kick");
    if (inPanel) state.chat = { platform, channel };
  } catch (e) {
    state.error = String(e);
  }
  render();
}

async function closeChat() {
  state.chat = null;
  render();
  try {
    await invoke("close_chat");
  } catch (e) {
    state.error = String(e);
    render();
  }
}

/** Close the chat panel when its stream stops. */
function closeChatOf(platform: Platform, channel: string) {
  if (state.chat?.platform === platform && state.chat.channel === channel.toLowerCase()) void closeChat();
}

async function stop(id: number) {
  const p = state.playing.get(id);
  if (p) closeChatOf(p.platform, p.channel);
  // StreamHub's player has its own ids (below 0); Streamlink sessions are stopped in Rust
  if (id < 0) player.stop(id);
  else await invoke("stop", { id });
}

function updateSettings(patch: Partial<Settings>) {
  state.settings = { ...state.settings, ...patch };
  saveSettings(state.settings);
  if (patch.theme) applyTheme(state.settings.theme);
  if (patch.streamLanguage !== undefined) browse.clearCache();
  if (patch.crPlayInWindow !== undefined) void invoke("cr_episodes_in_window", { on: patch.crPlayInWindow });
}

function select<K extends "theme" | "buffer" | "streamLanguage" | "chatProvider" | "playIn" | "audioLanguage" | "miniPlayer">(
  label: string,
  key: K,
  options: readonly (readonly [string, string])[],
  help = "",
): HTMLElement {
  return h(
    "label",
    { class: "field" },
    h("span", {}, label),
    h(
      "select",
      {
        onchange: (e) =>
          updateSettings({ [key]: (e.target as HTMLSelectElement).value } as Partial<Settings>),
      },
      ...options.map(([value, text]) => h("option", { value, selected: state.settings[key] === value }, text)),
    ),
    help ? h("small", { class: "muted" }, help) : null,
  );
}

async function loadInfo() {
  try {
    state.info = await invoke<StreamlinkInfo>("streamlink_info", {
      streamlinkPath: state.settings.streamlinkPath || null,
    });
  } catch {
    state.info = null;
  }
  render();
}

// ---- views ----

const ctx: browse.Ctx = {
  render: () => render(),
  token: () => state.token,
  language: () => state.settings.streamLanguage,
  watch: (platform, channel) => void watch(platform, channel),
  openChat: (platform, channel) => void openChat(platform, channel),
  chatEnabled: () => state.settings.chatEnabled,
  kickSaved: (slug) => state.kickSlugs.includes(slug),
  addKick: (slug) => {
    addKick(slug);
  },
  removeKick: (slug) => removeKick(slug),
};

function crError(e: unknown) {
  state.error = String(e);
  render();
}

interface CrTab {
  id: number;
  title: string;
}
interface CrTabs {
  tabs: CrTab[];
  active: number | null;
  fullscreen: boolean;
}
let crTabs: CrTabs = { tabs: [], active: null, fullscreen: false };

function crCall(command: string, args: Record<string, unknown> = {}) {
  void invoke<CrTabs | null>(command, args)
    .then((t) => {
      if (t) crTabs = t;
      render();
    })
    .catch((e) => crError(e));
}

void invoke("cr_episodes_in_window", { on: state.settings.crPlayInWindow ?? false }).catch(() => {});
void listen<string>("crunchyroll-error", ({ payload }) => crError(payload));

// Esc in StreamHub's own page (focus left on the bar) leaves Crunchyroll's full screen too
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.view === "crunchyroll" && crTabs.fullscreen) void invoke("cr_action", { action: "fullscreen" });
});

void listen<CrTabs>("crunchyroll-tabs", ({ payload }) => {
  crTabs = payload;
  if (state.view === "crunchyroll") render();
});

/** The Crunchyroll tab: crunchyroll.com itself, in tabs (webviews placed below this bar by the Rust side). */
function crunchyrollView(): HTMLElement {
  const action = (name: string) => () => void invoke("cr_action", { action: name }).catch((e) => crError(e));
  return h(
    "main",
    { class: "cr-main" },
    h(
      "div",
      { class: "cr-bar" },
      h("button", { class: "small", title: "Back", onclick: action("back") }, "‹"),
      h("button", { class: "small", title: "Forward", onclick: action("forward") }, "›"),
      h("button", { class: "small", title: "Reload", onclick: action("reload") }, "⟳"),
      h("button", { class: "small", title: "Crunchyroll's home page", onclick: action("home") }, "Home"),
      h(
        "div",
        { class: "cr-tabs" },
        ...crTabs.tabs.map((t) =>
          h(
            "div",
            { class: `cr-tab${t.id === crTabs.active ? " active" : ""}`, title: t.title },
            h("button", { class: "cr-tab-name", onclick: () => crCall("cr_select", { id: t.id }) }, t.title || "Crunchyroll"),
            h(
              "button",
              { class: "cr-tab-close", title: "Close this tab (stops what it's playing)", onclick: () => crCall("cr_close_tab", { id: t.id }) },
              "×",
            ),
          ),
        ),
        h("button", { class: "small cr-new", title: "New tab (or Ctrl+click / middle-click a link)", onclick: () => crCall("cr_new_tab") }, "+"),
      ),
      h("button", { class: "small", title: "Open this page in a Crunchyroll window, where episodes play", onclick: action("window") }, "Open in window"),
      h("button", { class: "small", title: "Open this page in your browser", onclick: action("browser") }, "Open in browser"),
      h("button", { class: "small", title: "The video fills the screen (Esc to leave)", onclick: action("fullscreen") }, "Full screen"),
    ),
    crTabs.tabs.length
      ? h("p", { class: "empty" }, "Loading Crunchyroll…")
      : h(
          "div",
          { class: "empty" },
          h("p", {}, "No Crunchyroll tabs are open."),
          h("button", { onclick: () => crCall("cr_new_tab") }, "Open Crunchyroll"),
        ),
  );
}

function searchForm(): HTMLElement {
  const site: Platform = state.view === "kick" ? "kick" : state.view === "youtube" ? "youtube" : "twitch";
  const input = h("input", {
    id: "search",
    type: "search",
    placeholder: site === "kick" ? "Search Kick" : site === "youtube" ? "Search YouTube" : "Search Twitch",
    spellcheck: "false",
    autocomplete: "off",
    oninput: (e) => (state.search = (e.target as HTMLInputElement).value),
  });
  input.value = state.search;
  return h(
    "form",
    {
      class: "search",
      onsubmit: (e) => {
        e.preventDefault();
        const q = state.search.trim();
        if (!q) return;
        state.view = site;
        if (site === "youtube") yt.go({ kind: "search", q });
        else if (site === "kick") browse.go("kick", { kind: "search", q });
        else browse.go("twitch", { kind: "search", q });
        (document.activeElement as HTMLElement | null)?.blur();
        render();
      },
    },
    input,
  );
}

// ---- YouTube ----

let ytChecked = false;

async function checkYtAccount() {
  ytChecked = true;
  try {
    state.ytAccount = await invoke<yt.YtAccount>("yt_account");
  } catch (e) {
    state.ytAccount = null;
    if (String(e) !== "not-signed-in") state.error = `Couldn't check your YouTube sign-in: ${String(e)}`;
  }
  try {
    localStorage.setItem("streamhub.youtube.used", "1");
  } catch {
    // storage unavailable
  }
  render();
}

async function ytSignIn() {
  try {
    await invoke("yt_login");
    state.message = "Sign in to YouTube in the window that opened, then close it.";
  } catch (e) {
    state.error = String(e);
  }
  render();
}

async function ytSignOut() {
  try {
    await invoke("yt_logout");
  } catch (e) {
    state.error = String(e);
  }
  state.ytAccount = null;
  yt.clearCache();
  render();
}

function watchYoutube(v: yt.YtVideo) {
  state.error = "";
  for (const [oldId, p] of state.playing) if (p.inApp) state.playing.delete(oldId);
  player.resumeHint(v.id, v.resume ?? 0);
  const id = player.open("youtube", v.id, v.title);
  state.playing.set(id, { platform: "youtube", channel: v.title, status: null, inApp: true });
  render();
}

const ytCtx: yt.YtCtx = {
  render: () => render(),
  account: () => state.ytAccount,
  signIn: () => void ytSignIn(),
  watch: (v) => watchYoutube(v),
};

function ytSubnav(): HTMLElement {
  const page = yt.page();
  return h(
    "div",
    { class: "subnav" },
    yt.nav.length > 1 ? h("button", { class: "small", onclick: () => { yt.back(); render(); } }, "‹ Back") : null,
    h(
      "button",
      { class: `sub${page.kind === "home" ? " active" : ""}`, onclick: () => { yt.go({ kind: "home" }); render(); } },
      "Home",
    ),
    h(
      "button",
      { class: `sub${page.kind === "subs" ? " active" : ""}`, onclick: () => { yt.go({ kind: "subs" }); render(); } },
      "Subscriptions",
    ),
    h(
      "button",
      { class: `sub${page.kind === "history" ? " active" : ""}`, onclick: () => { yt.go({ kind: "history" }); render(); } },
      "History",
    ),
    h(
      "button",
      { class: `sub${page.kind === "later" ? " active" : ""}`, onclick: () => { yt.go({ kind: "later" }); render(); } },
      "Watch later",
    ),
    h("button", { class: "small push", onclick: () => { yt.refresh(); render(); } }, "Refresh"),
  );
}

function ytSettings(): HTMLElement[] {
  const a = state.ytAccount;
  return [
    h("h2", {}, "YouTube"),
    a
      ? h(
          "div",
          { class: "kick-account" },
          a.avatar ? h("img", { class: "avatar", src: a.avatar, alt: "", referrerpolicy: "no-referrer" }) : null,
          h("span", { class: "muted" }, "Signed in to YouTube as "),
          h("strong", {}, a.name),
          h("button", { class: "link", onclick: () => void ytSignOut() }, "Sign out"),
        )
      : h(
          "div",
          { class: "kick-account" },
          h("button", { class: "yt-signin", onclick: () => void ytSignIn() }, "Sign in to YouTube"),
          h("span", { class: "muted" }, "to see your subscriptions. You sign in on Google's own page."),
        ),
    select(
      "Audio language",
      "audioLanguage",
      [
        ["en", "English"],
        ["original", "The video's original language"],
        ["es", "Spanish"],
        ["pt", "Portuguese"],
        ["fr", "French"],
        ["de", "German"],
        ["ja", "Japanese"],
      ],
      "Many videos have dubbed audio. StreamHub plays this language when the video has it (the original recording first), otherwise the original.",
    ),
    checkbox(
      "Show comments",
      "A video's comments show beside it (top comments first, loading more as you scroll). Hide comments in the player hides them for now.",
      "ytComments",
    ),
    checkbox(
      "Add videos I watch to my YouTube history",
      "When you're signed in, videos you play in StreamHub show up in your YouTube watch history (and the History tab), as if you watched them on YouTube. YouTube only gets the same report its own player sends; no ads are requested.",
      "ytAddToHistory",
    ),
    h("h3", {}, "SponsorBlock"),
    h("p", { class: "muted" }, "Parts of YouTube videos marked by the SponsorBlock community. Skip them, show them on the timeline, or ignore them."),
    h(
      "div",
      { class: "sb-settings" },
      ...SB_CATEGORIES.map((c) =>
        h(
          "label",
          { class: "sb-row" },
          h("span", { class: "sb-swatch", style: `background:${c.color}` }),
          h("span", {}, c.name),
          h(
            "select",
            {
              onchange: (e) =>
                updateSettings({
                  sbActions: { ...state.settings.sbActions, [c.id]: (e.target as HTMLSelectElement).value as "skip" | "show" | "off" },
                }),
            },
            ...(
              [
                ["skip", "Skip"],
                ["show", "Show on timeline"],
                ["off", "Off"],
              ] as const
            ).map(([value, label]) => h("option", { value, selected: (state.settings.sbActions[c.id] ?? "off") === value }, label)),
          ),
        ),
      ),
    ),
  ];
}

/** Following / Browse (or My channels / Browse) and a back button. */
function subnav(site: Platform): HTMLElement {
  const page = site === "kick" ? browse.kickPage() : browse.twitchPage();
  const home = site === "kick" ? "mine" : "following";
  const link = (kind: "home" | "browse", label: string) => {
    const active = kind === "home" ? page.kind === home : page.kind !== home;
    return h(
      "button",
      {
        class: `sub${active ? " active" : ""}`,
        onclick: () => {
          if (site === "kick") browse.go("kick", kind === "home" ? { kind: "mine" } : { kind: "browse" });
          else browse.go("twitch", kind === "home" ? { kind: "following" } : { kind: "browse" });
          render();
        },
      },
      label,
    );
  };
  return h(
    "div",
    { class: "subnav" },
    browse.canGoBack(site)
      ? h("button", { class: "small", title: "Back", onclick: () => { browse.back(site); render(); } }, "‹ Back")
      : null,
    link("home", site === "kick" ? "My channels" : "Following"),
    link("browse", "Browse"),
    page.kind !== home
      ? h(
          "button",
          { class: "small push", onclick: () => { browse.refreshPage(site); render(); } },
          "Refresh",
        )
      : null,
  );
}

function header(): HTMLElement {
  const tab = (view: View, label: string) =>
    h(
      "button",
      {
        class: `tab tab-${view}${state.view === view ? " active" : ""}`,
        onclick: () => {
          // Crunchyroll's page is a separate webview: hidden (still playing) when another tab opens
          if (view === "crunchyroll") crCall("cr_show");
          else if (state.view === "crunchyroll") void invoke("cr_hide");
          state.view = view;
          // browsing: the stream keeps playing in the corner
          player.minimize();
          if ((view === "youtube" || view === "settings") && !ytChecked) void checkYtAccount();
          if (view === "settings") void loadInfo();
          render();
        },
      },
      label,
    );
  return h(
    "header",
    {},
    h("div", { class: "brand" }, h("img", { class: "logo", src: "/icon.png", alt: "" }), "StreamHub"),
    h("nav", {}, tab("twitch", "Twitch"), tab("kick", "Kick"), tab("youtube", "YouTube"), tab("crunchyroll", "Crunchyroll"), tab("settings", "Settings")),
    h("div", { class: "spacer" }),
    state.view === "crunchyroll" ? null : searchForm(),
    state.user
      ? h(
          "div",
          { class: "user" },
          h("span", {}, state.user.login),
          h("button", { class: "link", onclick: signOut }, "Sign out"),
        )
      : null,
  );
}

function statusChip(platform: Platform, status: AdblockStatus | null): HTMLElement {
  if (!status) {
    return platform === "kick"
      ? h("span", { class: "chip kick", title: "Kick doesn't put ads into the streams Streamlink plays" }, "Kick")
      : h("span", { class: "chip info" }, "Starting…");
  }
  return h(
    "span",
    { class: `chip ${status.level}`, title: status.detail },
    status.label,
    status.server ? ` · ${status.server}` : "",
  );
}

function playingBar(): HTMLElement | null {
  if (state.playing.size === 0) return null;
  return h(
    "section",
    { class: "playing" },
    ...[...state.playing.entries()].map(([id, p]) =>
      h(
        "div",
        { class: "playing-item" },
        h("strong", {}, p.channel),
        p.inApp ? h("span", { class: "chip info" }, "In StreamHub") : statusChip(p.platform, p.status),
        p.status && (p.status.adsCovered || p.status.adsGotThrough)
          ? h(
              "span",
              { class: "muted" },
              `${p.status.adsCovered} ads blocked · ${p.status.adsGotThrough} filtered`,
            )
          : null,
        p.inApp
          ? h("button", { class: "small push", onclick: () => player.expand() }, "Show")
          : null,
        state.settings.chatEnabled
          ? h("button", { class: `small${p.inApp ? "" : " push"}`, onclick: () => void openChat(p.platform, p.channel) }, "Chat")
          : null,
        h(
          "button",
          { class: `small${state.settings.chatEnabled || p.inApp ? "" : " push"}`, onclick: () => void stop(id) },
          "Stop",
        ),
      ),
    ),
  );
}

function liveView(): HTMLElement {
  const list =
    state.streams.length > 0
      ? h("div", { class: "grid" }, ...state.streams.map((st) => browse.twitchStreamCard(ctx, st)))
      : h("p", { class: "empty" }, state.loading ? "Loading…" : "None of the channels you follow are live right now.");
  return h(
    "main",
    {},
    h(
      "div",
      { class: "toolbar" },
      h("h1", {}, "Following · Live"),
      h("button", { class: "small", onclick: () => void refresh(), disabled: state.loading }, state.loading ? "Refreshing…" : "Refresh"),
    ),
    list,
  );
}

function kickCard(channel: KickChannel): HTMLElement {
  return h(
    "div",
    { class: "card-wrap" },
    h(
      "button",
      { class: "card", title: `Watch ${channel.name}`, onclick: () => void watch("kick", channel.slug) },
      h(
        "div",
        { class: "thumb" },
        channel.thumbnail
          ? h("img", {
              src: channel.thumbnail,
              alt: "",
              loading: "lazy",
              referrerpolicy: "no-referrer",
              // if Kick won't serve the thumbnail, show the channel's picture instead
              onerror: (e) => {
                const img = e.target as HTMLImageElement;
                if (channel.avatar && !img.dataset.fallback) {
                  img.dataset.fallback = "1";
                  img.src = channel.avatar;
                  img.classList.add("fallback");
                } else {
                  img.remove();
                }
              },
            })
          : channel.avatar
            ? h("img", { src: channel.avatar, alt: "", class: "fallback", referrerpolicy: "no-referrer" })
            : null,
        h("span", { class: "viewers kick" }, `● ${channel.viewers === null ? "Live" : channel.viewers.toLocaleString()}`),
      ),
      h("div", { class: "card-title" }, channel.title || "Untitled stream"),
      h("div", { class: "card-meta" }, h("strong", {}, channel.name), channel.category ? ` · ${channel.category}` : ""),
    ),

  );
}

function kickRow(slug: string, checked: KickChannel | undefined): HTMLElement {
  const f = state.kickFollowed.find((x) => x.slug === slug);
  const channel: KickChannel | undefined =
    checked ??
    (f
      ? { slug, name: f.name, live: false, title: "", category: "", viewers: null, thumbnail: null, avatar: f.avatar, startedAt: null, bio: null, followers: null, error: null }
      : undefined);
  const status = !channel
    ? state.kickLoading
      ? "Checking…"
      : ""
    : channel.error
      ? channel.error
      : "Offline";
  return h(
    "div",
    { class: "row" },
    channel?.avatar
      ? h("img", { class: "avatar", src: channel.avatar, alt: "", referrerpolicy: "no-referrer" })
      : h("span", { class: "avatar" }),
    h("strong", {}, channel?.name ?? slug),
    h("span", { class: channel?.error ? "row-error" : "muted" }, status),
    h(
      "span",
      { class: "muted push" },
      state.kickFollowed.some((f) => f.slug === slug) ? "Following" : "Added",
    ),
  );
}

function kickView(): HTMLElement {
  const bySlug = new Map(state.kickChannels.map((c) => [c.slug, c]));
  const live = kickLive();
  const liveSlugs = new Set(live.map((c) => c.slug));
  const all = allKickSlugs();
  const others = all.filter((slug) => !liveSlugs.has(slug));

  return h(
    "main",
    {},
    h(
      "div",
      { class: "toolbar" },
      h("h1", {}, "My Kick channels"),
      h(
        "button",
        { class: "small", onclick: () => void refreshKick(), disabled: state.kickLoading },
        state.kickLoading ? "Refreshing…" : "Refresh",
      ),
    ),
    state.kickError ? h("p", { class: "row-error" }, state.kickError) : null,
    all.length === 0
      ? h(
          "p",
          { class: "empty" },
          "No Kick channels yet. In Settings → Kick, sign in to Kick to see every channel you follow, or add channels yourself.",
        )
      : null,
    live.length > 0 ? h("div", { class: "grid" }, ...live.map(kickCard)) : null,
    live.length === 0 && all.length > 0 && !state.kickLoading
      ? h("p", { class: "empty" }, "None of your Kick channels are live right now.")
      : null,
    others.length > 0 ? h("h2", {}, "Offline") : null,
    others.length > 0 ? h("div", { class: "rows" }, ...others.map((slug) => kickRow(slug, bySlug.get(slug)))) : null,
  );
}

/** Settings → Kick: sign-in and the channels added by hand. */
function kickSettings(): HTMLElement[] {
  const account = state.kickAccount
    ? h(
        "div",
        { class: "kick-account" },
        state.kickAccount.avatar
          ? h("img", { class: "avatar", src: state.kickAccount.avatar, alt: "", referrerpolicy: "no-referrer" })
          : null,
        h("span", { class: "muted" }, "Signed in to Kick as "),
        h("strong", {}, state.kickAccount.username),
        h("span", { class: "muted" }, ` · ${state.kickFollowed.length} followed`),
        h("button", { class: "link", onclick: () => void kickSignOut() }, "Sign out"),
      )
    : h(
        "div",
        { class: "kick-account" },
        h("button", { class: "kick-signin", onclick: () => void kickSignIn() }, "Sign in to Kick"),
        h("span", { class: "muted" }, "to show every channel you follow, without adding them one by one"),
      );

  const input = h("input", {
    type: "text",
    placeholder: "Add Kick channels: names or kick.com links",
    spellcheck: "false",
  });
  const form = h(
    "form",
    {
      class: "add",
      onsubmit: (e) => {
        e.preventDefault();
        if (addKick(input.value)) input.value = "";
      },
    },
    input,
    h("button", { class: "small", type: "submit" }, "Add"),
  );


  const added = state.kickSlugs.length
    ? h(
        "div",
        { class: "rows" },
        ...state.kickSlugs.map((slug) => {
          const c = state.kickChannels.find((x) => x.slug === slug);
          return h(
            "div",
            { class: "row" },
            c?.avatar
              ? h("img", { class: "avatar", src: c.avatar, alt: "", referrerpolicy: "no-referrer" })
              : h("span", { class: "avatar" }),
            h("strong", {}, c?.name ?? slug),
            h("button", { class: "link push", onclick: () => removeKick(slug) }, "Remove"),
          );
        }),
      )
    : h("p", { class: "muted" }, "None yet.");

  return [
    h("h2", {}, "Kick"),
    account,
    state.kickError ? h("p", { class: "row-error" }, state.kickError) : h("span", {}),
    h("h3", {}, "Channels you added"),
    h("p", { class: "muted" }, "Kick channels to show under My channels even if you don't follow them (or aren't signed in)."),
    form,
    added,
  ];
}

function checkbox(label: string, help: string, key: keyof Settings): HTMLElement {
  return h(
    "label",
    { class: "check" },
    h("input", {
      type: "checkbox",
      checked: Boolean(state.settings[key]),
      onchange: (e) => {
        updateSettings({ [key]: (e.target as HTMLInputElement).checked } as Partial<Settings>);
        render();
      },
    }),
    h("span", {}, h("strong", {}, label), h("small", {}, help)),
  );
}

function textInput(label: string, key: "streamlinkPath" | "playerPath", placeholder: string): HTMLElement {
  return h(
    "label",
    { class: "field" },
    h("span", {}, label),
    h("input", {
      type: "text",
      value: state.settings[key],
      placeholder,
      spellcheck: "false",
      onchange: (e) => {
        updateSettings({ [key]: (e.target as HTMLInputElement).value.trim() });
        if (key === "streamlinkPath") void loadInfo();
      },
    }),
  );
}

type SettingsTab = "general" | "player" | "twitch" | "kick" | "youtube" | "crunchyroll" | "chat";

const SETTINGS_TABS: [SettingsTab, string][] = [
  ["general", "General"],
  ["player", "Player"],
  ["twitch", "Twitch"],
  ["kick", "Kick"],
  ["youtube", "YouTube"],
  ["crunchyroll", "Crunchyroll"],
  ["chat", "Chat"],
];

/** What StreamHub's player does when you go back to browsing (under Player and YouTube). */
function miniPlayerSelect(): HTMLElement {
  return select(
    "Small player",
    "miniPlayer",
    [
      ["corner", "Keep playing in a small player in the corner"],
      ["audio", "Off: hide the player, keep the sound playing"],
      ["pause", "Off: hide the player and pause it"],
    ],
    "What StreamHub's player does when you go back to browsing. Show, at the top of the page, brings it back.",
  );
}

function settingsView(): HTMLElement {
  const s = state.settings;
  const info = state.info;
  const quality = h(
    "select",
    { onchange: (e) => updateSettings({ quality: (e.target as HTMLSelectElement).value }) },
    ...QUALITIES.map((q) => h("option", { value: q, selected: q === s.quality }, q)),
  );
  const proxies = h("textarea", {
    rows: "5",
    spellcheck: "false",
    placeholder: (info?.defaultProxies ?? []).join("\n"),
    onchange: (e) =>
      updateSettings({
        proxies: (e.target as HTMLTextAreaElement).value
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean),
      }),
  });
  proxies.value = s.proxies.join("\n");

  return h(
    "main",
    { class: "settings" },
    h("h1", {}, "Settings"),
    h(
      "div",
      { class: "settings-layout" },
      h(
        "nav",
        { class: "settings-nav" },
        ...SETTINGS_TABS.map(([tab, label]) =>
          h(
            "button",
            {
              class: `settings-tab settings-tab-${tab}${state.settingsTab === tab ? " active" : ""}`,
              onclick: () => {
                state.settingsTab = tab;
                render();
              },
            },
            label,
          ),
        ),
      ),
      h(
        "div",
        { class: "settings-body" },
        ...(state.settingsTab === "general"
          ? [
          h("h2", {}, "Appearance"),
          select("Theme", "theme", [
            ["dark", "Dark"],
            ["light", "Light"],
            ["system", "Same as Windows"],
          ]),

          h("h2", {}, "Browse"),
          select("Stream language", "streamLanguage", LANGUAGES, "Top live streams and categories only show streams in this language."),

          h("h2", {}, "Notifications"),
          checkbox("Live notifications", "Notify me when a Twitch channel I follow or one of my Kick channels goes live.", "notifications"),

          h("h2", {}, "Updates"),
          checkbox("Check for updates", "Look for a new StreamHub version on GitHub when StreamHub starts and every few hours.", "checkUpdates"),
          checkbox(
            "Install updates automatically",
            "Download new versions in the background and install them when StreamHub restarts or you quit it. Not for the portable build.",
            "autoUpdate",
          ),
          h(
            "p",
            {},
            h("button", { class: "small", onclick: () => void checkUpdates(true) }, "Check now"),
            state.appVersion ? h("span", { class: "muted" }, `  You have StreamHub ${state.appVersion}.`) : null,
          ),

          h(
            "p",
            {},
            h(
              "button",
              {
                class: "link",
                onclick: () => {
                  state.settings = { ...DEFAULTS };
                  saveSettings(state.settings);
                  applyTheme(state.settings.theme);
                  browse.clearCache();
                  render();
                },
              },
              "Reset settings",
            ),
          ),
            ]
          : state.settingsTab === "player"
            ? [
                h("h2", {}, "Player"),
            select(
              "Play streams in",
              "playIn",
              [
                ["external", "My video player (VLC, mpv…)"],
                ["app", "StreamHub (beta)"],
              ],
              "StreamHub (beta): streams play inside StreamHub, with the same ad blocking.",
            ),
                miniPlayerSelect(),
            h("h2", {}, "Streamlink"),
            h(
              "p",
              { class: "muted" },
              info?.streamlink ? `Found: ${info.streamlink}` : "Streamlink wasn't found. Install it from streamlink.github.io or set its path.",
            ),
            textInput("Streamlink path (optional)", "streamlinkPath", "Found automatically"),
            textInput("Video player (optional)", "playerPath", "Streamlink's default (VLC)"),
            h("label", { class: "field" }, h("span", {}, "Quality"), quality),
            checkbox("Low latency", "Smaller delay, may buffer more often (Twitch).", "lowLatency"),
            select(
              "Smoother playback",
              "buffer",
              [
                ["normal", "Normal"],
                ["more", "More buffer (fewer stutters, a few seconds behind)"],
                ["most", "Most buffer (for unsteady connections)"],
              ],
              "Keeps more video buffered so short hiccups don't stutter. Not used with low latency.",
            ),
              ]
            : state.settingsTab === "twitch"
              ? [
            h("h2", {}, "Twitch ad blocking"),
            h(
              "p",
              { class: "muted" },
              info?.plugin
                ? `Plugin: ${info.plugin}${info.bundledPlugin ? " (bundled)" : ""}`
                : "The ad blocking plugin wasn't found. StreamHub won't play Twitch streams while it's missing.",
            ),
            checkbox("Block ads", "Play Twitch streams through ad-free proxies. If an ad gets through, StreamHub switches to the next proxy.", "proxyEnabled"),
            !s.proxyEnabled ? h("p", { class: "warning" }, "Ad blocking is off: Twitch streams will show ads.") : null,
            h("label", { class: "field" }, h("span", {}, "Proxies, one per line (empty: defaults)"), proxies),
            checkbox(
              "Direct through my VPN",
              "If no proxy works, play from Twitch directly. Only turn this on while a VPN in an ad-free country is connected.",
              "direct",
            ),
            checkbox(
              "Ad-free backup stream",
              "During an ad break, play a lower quality (usually 360p) ad-free stream instead of pausing. Needs the bundled plugin.",
              "backupStream",
            ),
            checkbox("Ad blocking badge", "Show the status in the corner of the player.", "badge"),
                ]
              : state.settingsTab === "kick"
                ? kickSettings()
                : state.settingsTab === "youtube"
                  ? [...ytSettings(), h("h2", {}, "Player"), miniPlayerSelect()]
                  : state.settingsTab === "crunchyroll"
                  ? [
                      h("h2", {}, "Crunchyroll"),
                      checkbox(
                        "Play episodes in a Crunchyroll window",
                        "Episodes open in their own window (Microsoft Edge without its address bar) instead of playing in the Crunchyroll tab. Sign in to Crunchyroll there once. Use it if an episode won't play in the tab.",
                        "crPlayInWindow",
                      ),
                    ]
                  : [
              h("h2", {}, "Chat"),
              checkbox("Chat", "Add a Chat button to playing streams.", "chatEnabled"),
              !s.chatEnabled
                ? null
                : h(
                "label",
                { class: "field" },
                h("span", {}, "Open chat in"),
                h(
                  "select",
                  {
                    onchange: (e) =>
                      updateSettings({ chatProvider: (e.target as HTMLSelectElement).value as Settings["chatProvider"] }),
                  },
                  ...(
                    [
                      ["panel", "StreamHub (right side)"],
                      ["browser", "My default browser"],
                      ["chatterino", "Chatterino (Twitch; Kick chat stays in StreamHub)"],
                    ] as const
                  ).map(([value, label]) => h("option", { value, selected: s.chatProvider === value }, label)),
                ),
              ),
              s.chatEnabled
                ? checkbox("Open chat with the stream", "Open the channel's chat when a stream starts.", "chatAutoOpen")
                : null,
                    ]),
      ),
    ),
  );
}

function signInView(): HTMLElement {
  return h(
    "main",
    { class: "signin" },
    h("h1", {}, "Ad-free Twitch, through Streamlink"),
    h("p", { class: "muted" }, "Sign in with Twitch to see the channels you follow."),
    h("button", { class: "primary", onclick: () => void signIn() }, "Sign in with Twitch"),
  );
}

// ---- update check ----

const DISMISSED_KEY = "streamhub.update.dismissed";
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;

function updateBanner(): HTMLElement | null {
  const u = state.update;
  if (u && state.updateReady === u.version) {
    return h(
      "div",
      { class: "banner update" },
      h("span", {}, h("strong", {}, `StreamHub ${u.version} is ready`), ". It installs when you close StreamHub, or now:"),
      h(
        "button",
        {
          class: "small primary-small",
          onclick: () =>
            void invoke("restart_to_update").catch((e) => {
              state.error = String(e);
              render();
            }),
        },
        "Restart to update",
      ),
    );
  }
  if (!u || localStorage.getItem(DISMISSED_KEY) === u.version) return null;
  return h(
    "div",
    { class: "banner update" },
    h("span", {}, h("strong", {}, `StreamHub ${u.version} is available`), ` (you have ${state.appVersion}).`),
    h(
      "button",
      { class: "small primary-small", onclick: () => void invoke("open_release_page", { url: u.url }) },
      "Download",
    ),
    h(
      "button",
      {
        class: "link",
        onclick: () => {
          localStorage.setItem(DISMISSED_KEY, u.version);
          render();
        },
      },
      "Later",
    ),
  );
}

async function checkUpdates(manual = false) {
  if (!state.settings.checkUpdates && !manual) return;
  try {
    state.appVersion ||= await getVersion();
    const update = await checkForUpdate(state.appVersion);
    const isNew = update && update.version !== state.update?.version;
    state.update = update;
    if (update && state.settings.autoUpdate && !state.updateReady && state.updateDownloading !== update.version) {
      void autoUpdate(update.version);
    }
    if (manual && !update) state.message = `StreamHub ${state.appVersion} is the newest version.`;
    if (manual && update) localStorage.removeItem(DISMISSED_KEY);
    if (isNew && localStorage.getItem(DISMISSED_KEY) !== update.version) {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted) sendNotification({ title: `StreamHub ${update.version} is available`, body: "Open StreamHub to download it." });
    }
  } catch (e) {
    if (manual) state.error = `Couldn't check for updates: ${String(e)}`;
  }
  render();
}

let updateSupported: boolean | null = null;

/** Download the new version in the background (installed copies only). */
async function autoUpdate(version: string) {
  updateSupported ??= await invoke<boolean>("update_supported").catch(() => false);
  if (!updateSupported) return;
  state.updateDownloading = version;
  try {
    await invoke("download_update", { version });
    state.updateReady = version;
  } catch (e) {
    // the "Download" banner stays as the way to update
    console.warn("Automatic update failed:", e);
  } finally {
    state.updateDownloading = "";
    render();
  }
}

/** Put the section's sub-navigation on top of a page. */
function withSubnav(site: Platform, page: HTMLElement): HTMLElement {
  const main = page.tagName === "MAIN" ? page : h("main", {}, page);
  main.prepend(subnav(site));
  return main;
}

let currentBody: HTMLElement | null = null;
let currentView: View | null = null;

function render() {
  // don't rebuild a form while the user is typing in it
  const active = document.activeElement;
  const searchFocused = active instanceof HTMLInputElement && active.id === "search";
  const caret = searchFocused ? active.selectionStart : null;
  const editing =
    currentView === state.view &&
    (state.view === "settings" || state.view === "kick") &&
    active instanceof HTMLElement &&
    ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName) &&
    Boolean(currentBody?.contains(active));
  const body =
    editing && currentBody
      ? currentBody
      : state.view === "settings"
        ? settingsView()
        : state.view === "crunchyroll"
          ? crunchyrollView()
          : state.view === "youtube"
          ? (() => {
              const main = h("main", {}, yt.content(ytCtx));
              main.prepend(ytSubnav());
              return main;
            })()
          : state.view === "kick"
          ? withSubnav("kick", browse.kickContent(ctx) ?? kickView())
          : state.user
            ? withSubnav("twitch", browse.twitchContent(ctx) ?? liveView())
            : signInView();
  document.body.classList.toggle("with-chat", Boolean(state.chat));
  const chatBar = state.chat
    ? h(
        "div",
        { class: "chat-bar" },
        h("span", { class: `chip ${state.chat.platform === "kick" ? "kick" : "info"}` }, state.chat.platform === "kick" ? "Kick" : "Twitch"),
        h("strong", {}, `${state.chat.channel} chat`),
        h("button", { class: "chat-close", title: "Close chat", onclick: () => void closeChat() }, "×"),
      )
    : null;
  // rebuilding the page keeps the scroll position (a feed growing while it's scrolled)
  const scroll = currentView === state.view ? window.scrollY : null;
  currentBody = body;
  currentView = state.view;
  app.replaceChildren(
    header(),
    state.error ? h("div", { class: "banner error" }, state.error) : "",
    state.message ? h("div", { class: "banner" }, state.message) : "",
    updateBanner() ?? "",
    playingBar() ?? "",
    body,
    chatBar ?? "",
  );
  if (scroll !== null && window.scrollY !== scroll) window.scrollTo(0, scroll);
  if (searchFocused) {
    const search = document.getElementById("search") as HTMLInputElement | null;
    search?.focus();
    if (search && caret !== null) search.setSelectionRange(caret, caret);
  }
}

// ---- events from the Rust side ----

void listen<StatusEvent>("adblock-status", ({ payload }) => {
  const p = state.playing.get(payload.id);
  if (p) {
    p.status = payload.status;
    render();
  }
});

void listen<EndedEvent>("stream-ended", ({ payload }) => {
  const p = state.playing.get(payload.id);
  if (p) closeChatOf(p.platform, p.channel);
  state.playing.delete(payload.id);
  if (payload.error) state.error = `${payload.channel}: ${payload.error}`;
  render();
});

window.setInterval(() => {
  void refresh();
  void refreshKick();
}, REFRESH_MS);
void listen("youtube-login-closed", async () => {
  state.message = "";
  yt.clearCache();
  await checkYtAccount();
  if (!state.ytAccount) state.error = "Not signed in to YouTube. Sign in on Google's page, then close the window.";
  render();
});

void listen("kick-login-closed", async () => {
  state.message = "";
  kickSignedOut = false;
  await checkKickAccount();
  if (!state.kickAccount) state.kickError = "Not signed in to Kick. Sign in on kick.com, then close the window.";
  await refreshKick();
});

player.init({
  settings: () => state.settings,
  closed: (id, error) => {
    const p = state.playing.get(id);
    if (p) closeChatOf(p.platform, p.channel);
    state.playing.delete(id);
    if (error) state.error = `${p?.channel ?? "Stream"}: ${error}`;
    render();
  },
  openExternal: (platform, channel) => void watch(platform, channel, "external"),
  chatEnabled: () => state.settings.chatEnabled,
  openChat: (platform, channel) => void openChat(platform, channel),
  closeChat: () => {
    if (state.chat) void closeChat();
  },
});

applyTheme(state.settings.theme);
followSystemTheme(() => state.settings.theme);
void start();
// Kick: show the last results at once, then check the account and refresh at the same time
loadKickCache();
void checkKickAccount();
void refreshKick();
try {
  if (localStorage.getItem("streamhub.youtube.used")) void checkYtAccount();
} catch {
  // storage unavailable
}
void getVersion().then((v) => {
  state.appVersion = v;
  void checkUpdates();
});
window.setInterval(() => void checkUpdates(), UPDATE_EVERY_MS);
