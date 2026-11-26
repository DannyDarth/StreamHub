//! YouTube: sign-in, subscriptions feed, search and channel pages.
//!
//! Like Kick, the data comes from a hidden youtube.com page, using YouTube's own web API
//! (InnerTube, unofficial) with the session of the sign-in window: you sign in on YouTube's own
//! page, StreamHub never sees the password. The hidden page has no access to StreamHub's
//! commands: its script hands results back by navigating to a special URL that StreamHub cancels
//! and reads. Videos are played by `ytdlp.rs` (no ads) with SponsorBlock in the player.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

const FETCHER: &str = "youtube-fetcher";
const PAGE: &str = "https://www.youtube.com/robots.txt";
const RESULT_HOST: &str = "streamhub-youtube.invalid";

pub struct YoutubeFetcher {
    next_id: AtomicU64,
    ready: tokio::sync::watch::Sender<bool>,
    pending: Mutex<HashMap<u64, oneshot::Sender<String>>>,
}

impl Default for YoutubeFetcher {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(0),
            ready: tokio::sync::watch::channel(false).0,
            pending: Mutex::new(HashMap::new()),
        }
    }
}

/// Helpers for every script: YouTube's web API, the signed-in session's auth header, and a walker
/// that collects videos and channels from YouTube's (deeply nested, often changing) responses.
const WRAPPER: &str = r#"
(async () => {
  const VERSION = "2.20251120.01.00";
  const context = { client: { clientName: "WEB", clientVersion: VERSION, hl: "en", gl: "US" } };
  const cookie = (name) => {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
    return m ? decodeURIComponent(m[1]) : null;
  };
  const auth = async () => {
    const sid = cookie("SAPISID") || cookie("__Secure-3PAPISID");
    if (!sid) return null;
    const ts = Math.floor(Date.now() / 1000);
    const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`${ts} ${sid} https://www.youtube.com`));
    return `SAPISIDHASH ${ts}_${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  };
  const api = async (endpoint, body, signedIn) => {
    const headers = {
      "Content-Type": "application/json",
      "X-Origin": "https://www.youtube.com",
      "X-Youtube-Client-Name": "1",
      "X-Youtube-Client-Version": VERSION,
    };
    if (signedIn) {
      const a = await auth();
      if (!a) return { status: 401 };
      headers.Authorization = a;
      headers["X-Goog-AuthUser"] = "0";
    }
    const res = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify({ context, ...body }),
    });
    if (!res.ok) return { status: res.status };
    return { status: 200, data: await res.json() };
  };
  const text = (t) => (!t ? "" : typeof t === "string" ? t : t.simpleText || t.content || (t.runs || []).map((r) => r.text).join("") || "");
  const firstId = (node, prefix) => {
    let found = null;
    const walk = (n) => {
      if (found || !n || typeof n !== "object") return;
      if (n.browseEndpoint && typeof n.browseEndpoint.browseId === "string" && n.browseEndpoint.browseId.startsWith(prefix)) {
        found = n.browseEndpoint.browseId;
        return;
      }
      for (const k in n) walk(n[k]);
    };
    walk(node);
    return found;
  };
  const firstThumb = (node) => {
    let found = null;
    const walk = (n) => {
      if (found || !n || typeof n !== "object") return;
      if (Array.isArray(n.thumbnails) && n.thumbnails.length) {
        const t = n.thumbnails[n.thumbnails.length - 1].url || "";
        found = t.startsWith("//") ? "https:" + t : t;
        return;
      }
      if (Array.isArray(n.sources) && n.sources.length && n.sources[0].url) {
        found = n.sources[n.sources.length - 1].url;
        return;
      }
      for (const k in n) walk(n[k]);
    };
    walk(node);
    return found;
  };
  const collect = (root) => {
    const videos = [];
    const channels = [];
    const seenV = new Set();
    const seenC = new Set();
    const walk = (n) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      const v = n.videoRenderer || n.gridVideoRenderer || n.compactVideoRenderer;
      if (v && v.videoId && !seenV.has(v.videoId)) {
        seenV.add(v.videoId);
        const badges = JSON.stringify(v.badges || []) + JSON.stringify(v.thumbnailOverlays || []);
        const live = /LIVE/.test(badges) || /watching/i.test(text(v.viewCountText));
        const owner = v.ownerText || v.longBylineText || v.shortBylineText;
        videos.push({
          id: v.videoId,
          title: text(v.title),
          channel: text(owner),
          channelId: firstId(owner, "UC"),
          live,
          duration: text(v.lengthText) || "",
          published: text(v.publishedTimeText),
          views: text(v.shortViewCountText) || text(v.viewCountText),
          avatar: firstThumb(v.channelThumbnailSupportedRenderers || v.channelThumbnail || null),
        });
      }
      const l = n.lockupViewModel;
      if (l && l.contentId && /VIDEO/.test(String(l.contentType || "")) && !seenV.has(l.contentId)) {
        seenV.add(l.contentId);
        const meta = (l.metadata && l.metadata.lockupMetadataViewModel) || {};
        const rows = ((meta.metadata && meta.metadata.contentMetadataViewModel && meta.metadata.contentMetadataViewModel.metadataRows) || [])
          .map((r) => (r.metadataParts || []).map((p) => text(p.text)).filter(Boolean));
        const flat = JSON.stringify(l.contentImage || {});
        const badgeTexts = [...flat.matchAll(/"thumbnailBadgeViewModel":\{"text":"([^"]*)"/g)].map((m) => m[1]);
        const live = /LIVE/.test(flat) || rows.flat().some((t) => /watching/i.test(t));
        videos.push({
          id: l.contentId,
          title: text(meta.title),
          channel: (rows[0] || [])[0] || "",
          channelId: firstId(meta, "UC"),
          live,
          duration: live ? "" : badgeTexts.find((t) => /^\d+(:\d+)+$/.test(t)) || "",
          published: (rows[1] || []).find((t) => /ago|Streamed|Scheduled|Premieres/i.test(t)) || "",
          views: (rows[1] || []).find((t) => /view|watching/i.test(t)) || "",
          avatar: firstThumb(meta.image || null),
        });
      }
      const c = n.channelRenderer;
      if (c && c.channelId && !seenC.has(c.channelId)) {
        seenC.add(c.channelId);
        channels.push({
          id: c.channelId,
          name: text(c.title),
          avatar: firstThumb(c.thumbnail),
          subscribers: text(c.videoCountText) || text(c.subscriberCountText),
        });
      }
      for (const k in n) if (k !== "frameworkUpdates") walk(n[k]);
    };
    walk(root);
    return { videos, channels };
  };
  // The token for the next page of a feed (YouTube's "continuation"), or null at the end
  const nextPage = (root) => {
    let token = null;
    const walk = (n) => {
      if (!n || typeof n !== "object") return;
      // the token sits in the continuation item's endpoint, sometimes wrapped in a
      // commandExecutorCommand, so look anywhere inside it
      if (n.continuationItemRenderer) {
        const m = JSON.stringify(n.continuationItemRenderer).match(/"continuationCommand":\{"token":"([^"]+)"/);
        if (m) token = m[1];
        return;
      }
      for (const k in n) if (k !== "frameworkUpdates") walk(n[k]);
    };
    walk(root);
    return token;
  };
  let result;
  try {
    result = await (async () => {
__BODY__
    })();
  } catch (e) {
    result = { status: 0, error: String(e) };
  }
  location.href = "https://__HOST__/yt?id=__ID__&data=" + encodeURIComponent(JSON.stringify(result));
})();
"#;

const ACCOUNT: &str = r#"
  const r = await api("account/account_menu", {}, true);
  if (r.status !== 200) return { status: r.status };
  let name = "", photo = null;
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.activeAccountHeaderRenderer) {
      name = text(n.activeAccountHeaderRenderer.accountName);
      photo = firstThumb(n.activeAccountHeaderRenderer.accountPhoto);
      return;
    }
    for (const k in n) walk(n[k]);
  };
  walk(r.data);
  if (!name) return { status: 401 };
  return { status: 200, items: { name, avatar: photo } };
"#;

const FEED: &str = r#"
  const token = __TOKEN__;
  const r = await api("browse", token ? { continuation: token } : { browseId: "FEsubscriptions" }, true);
  if (r.status !== 200) return { status: r.status };
  const { videos } = collect(r.data);
  if (!token && !videos.length && /signInEndpoint|Sign in/.test(JSON.stringify(r.data).slice(0, 20000))) return { status: 401 };
  return { status: 200, items: { videos, next: nextPage(r.data) } };
"#;

const HOME: &str = r#"
  const token = __TOKEN__;
  const signedIn = Boolean(cookie("SAPISID") || cookie("__Secure-3PAPISID"));
  const r = await api("browse", token ? { continuation: token } : { browseId: "FEwhat_to_watch" }, signedIn);
  if (r.status !== 200) return { status: r.status };
  return { status: 200, items: { videos: collect(r.data).videos, next: nextPage(r.data) } };
"#;

const SEARCH: &str = r#"
  const r = await api("search", { query: __QUERY__ }, false);
  if (r.status !== 200) return { status: r.status };
  return { status: 200, items: collect(r.data) };
"#;

const CHANNEL: &str = r#"
  const id = __CHANNEL__;
  const [videosTab, liveTab] = await Promise.all([
    api("browse", { browseId: id, params: "EgZ2aWRlb3PyBgQKAjoA" }, false),
    api("browse", { browseId: id, params: "EgdzdHJlYW1z8gYECgJ6AA==" }, false),
  ]);
  if (videosTab.status !== 200) return { status: videosTab.status };
  const meta = (videosTab.data.metadata && videosTab.data.metadata.channelMetadataRenderer) || {};
  const videos = collect(videosTab.data).videos;
  const live = liveTab.status === 200 ? collect(liveTab.data).videos.filter((v) => v.live) : [];
  return {
    status: 200,
    items: {
      id,
      name: meta.title || "",
      description: meta.description || "",
      avatar: firstThumb(meta.avatar || null),
      videos: [...live, ...videos.filter((v) => !live.some((l) => l.id === v.id))].map((v) => ({ ...v, channel: v.channel || meta.title || "", channelId: v.channelId || id })),
    },
  };
"#;

fn fetcher_navigation(app: &AppHandle, url: &tauri::Url) -> bool {
    if url.host_str() == Some(RESULT_HOST) {
        let mut id = None;
        let mut data = None;
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "id" => id = value.parse::<u64>().ok(),
                "data" => data = Some(value.into_owned()),
                _ => {}
            }
        }
        if let (Some(id), Some(data)) = (id, data) {
            let fetcher = app.state::<YoutubeFetcher>();
            let tx = fetcher.pending.lock().unwrap().remove(&id);
            if let Some(tx) = tx {
                let _ = tx.send(data);
            }
        }
        return false;
    }
    url.scheme() == "https" && url.host_str() == Some("www.youtube.com")
}

fn ensure_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(FETCHER) {
        return Ok(window);
    }
    let nav_app = app.clone();
    let load_app = app.clone();
    WebviewWindowBuilder::new(app, FETCHER, WebviewUrl::External(PAGE.parse().unwrap()))
        .title("StreamHub YouTube")
        .visible(false)
        .skip_taskbar(true)
        .focused(false)
        .inner_size(400.0, 300.0)
        .on_navigation(move |url| fetcher_navigation(&nav_app, url))
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) && payload.url().host_str() == Some("www.youtube.com") {
                let _ = load_app.state::<YoutubeFetcher>().ready.send_replace(true);
            }
        })
        .build()
        .map_err(|e| e.to_string())
}

async fn run(app: &AppHandle, body: &str) -> Result<Value, String> {
    let window = ensure_window(app)?;
    let fetcher = app.state::<YoutubeFetcher>();
    let mut ready = fetcher.ready.subscribe();
    tokio::time::timeout(Duration::from_secs(30), ready.wait_for(|ready| *ready))
        .await
        .map_err(|_| "YouTube didn't load in time".to_string())?
        .map_err(|e| e.to_string())?;

    let id = fetcher.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = oneshot::channel();
    fetcher.pending.lock().unwrap().insert(id, tx);
    let script = WRAPPER
        .replace("__BODY__", body)
        .replace("__HOST__", RESULT_HOST)
        .replace("__ID__", &id.to_string());
    if let Err(e) = window.eval(&script) {
        fetcher.pending.lock().unwrap().remove(&id);
        return Err(e.to_string());
    }
    let data = match tokio::time::timeout(Duration::from_secs(45), rx).await {
        Ok(Ok(data)) => data,
        _ => {
            fetcher.pending.lock().unwrap().remove(&id);
            let _ = fetcher.ready.send_replace(false);
            let _ = window.eval(&format!("location.href = {}", serde_json::to_string(PAGE).unwrap()));
            return Err("YouTube didn't answer in time".into());
        }
    };
    let value: Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    match value["status"].as_u64() {
        Some(200) => Ok(value["items"].clone()),
        Some(401) | Some(403) => Err("not-signed-in".into()),
        Some(0) => Err(format!("Couldn't reach YouTube: {}", value["error"].as_str().unwrap_or_default())),
        Some(code) => Err(format!("YouTube returned {code}")),
        None => Err("Unexpected answer from YouTube".into()),
    }
}

pub fn valid_channel_id(id: &str) -> bool {
    id.len() == 24 && id.starts_with("UC") && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The signed-in YouTube account: `{ name, avatar }` (Err("not-signed-in") when there is none).
#[tauri::command]
pub async fn yt_account(app: AppHandle) -> Result<Value, String> {
    run(&app, ACCOUNT).await
}

/// Put a feed's page token (None for the first page) into a script.
fn with_token(script: &str, token: Option<String>) -> Result<String, String> {
    let token = match token {
        Some(t) if t.is_empty() || t.len() > 4000 || !t.chars().all(|c| c.is_ascii_graphic()) => {
            return Err("Invalid page".into())
        }
        t => t,
    };
    Ok(script.replace("__TOKEN__", &serde_json::to_string(&token).unwrap()))
}

/// New videos and live streams from the signed-in account's subscriptions, a page at a time:
/// `{ videos, next }` (`next` is the token for the next page, or null).
#[tauri::command]
pub async fn yt_feed(app: AppHandle, token: Option<String>) -> Result<Value, String> {
    run(&app, &with_token(FEED, token)?).await
}

/// The Home page's recommended videos (personal when signed in), a page at a time: `{ videos, next }`.
#[tauri::command]
pub async fn yt_home(app: AppHandle, token: Option<String>) -> Result<Value, String> {
    run(&app, &with_token(HOME, token)?).await
}

/// Search YouTube: `{ videos, channels }`.
#[tauri::command]
pub async fn yt_search(app: AppHandle, query: String) -> Result<Value, String> {
    let query = query.trim();
    if query.is_empty() || query.len() > 200 {
        return Err("Enter something to search for".into());
    }
    run(&app, &SEARCH.replace("__QUERY__", &serde_json::to_string(query).unwrap())).await
}

/// A channel's page: `{ id, name, description, avatar, videos }` (live streams first).
#[tauri::command]
pub async fn yt_channel(app: AppHandle, id: String) -> Result<Value, String> {
    if !valid_channel_id(&id) {
        return Err("Invalid channel".into());
    }
    run(&app, &CHANNEL.replace("__CHANNEL__", &serde_json::to_string(&id).unwrap())).await
}

/// Open youtube.com in a StreamHub window to sign in (or out). You sign in on Google's own page;
/// StreamHub never sees the password. Emits "youtube-login-closed" when the window closes.
#[tauri::command]
pub async fn yt_login(app: AppHandle) -> Result<(), String> {
    const LABEL: &str = "youtube-login";
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let browser = app.clone();
    let start = "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F";
    let window = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(start.parse().unwrap()))
        .title("Sign in to YouTube - StreamHub")
        .inner_size(1000.0, 780.0)
        .center()
        .on_navigation(move |url| {
            let host = url.host_str().unwrap_or_default();
            let under = |d: &str| host == d || host.ends_with(&format!(".{d}"));
            let allowed = url.scheme() == "https" && (under("youtube.com") || under("google.com") || under("gstatic.com"));
            if !allowed && (url.scheme() == "https" || url.scheme() == "http") {
                use tauri_plugin_opener::OpenerExt;
                let _ = browser.opener().open_url(url.as_str(), None::<&str>);
            }
            allowed || url.scheme() == "about"
        })
        .build()
        .map_err(|e| e.to_string())?;
    let closed = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            let _ = tauri::Emitter::emit(&closed, "youtube-login-closed", ());
        }
    });
    Ok(())
}

/// Sign out of YouTube in StreamHub (opens YouTube's own sign-out in the sign-in window).
#[tauri::command]
pub async fn yt_logout(app: AppHandle) -> Result<(), String> {
    let body = r#"
  await fetch("/logout", { credentials: "include" }).catch(() => {});
  for (const name of document.cookie.split("; ").map((c) => c.split("=")[0])) {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=.youtube.com`;
  }
  return { status: 200, items: null };
"#;
    run(&app, body).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_ids() {
        assert!(valid_channel_id("UCX6OQ3DkcsbYNE6H8uQQuVA"));
        assert!(!valid_channel_id("UCX6OQ3Dkcs"));
        assert!(!valid_channel_id("@mrbeast"));
    }
}
