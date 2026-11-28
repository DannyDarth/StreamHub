//! Crunchyroll: crunchyroll.com itself in StreamHub's window, in tabs (each a webview below
//! StreamHub's header and the tab bar, like the chat panel). Crunchyroll's videos are
//! DRM-protected (Widevine), so they play in Crunchyroll's own player inside the page, never
//! through StreamHub's player. You sign in on Crunchyroll's own page; StreamHub never sees the
//! password.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};
use tauri_plugin_opener::OpenerExt;

use crate::chat;

const PREFIX: &str = "crunchyroll-";
const HOME: &str = "https://www.crunchyroll.com/";
/// Below StreamHub's header and the Crunchyroll tab bar.
const TOP: f64 = 52.0 + 48.0;
const MAX_TABS: usize = 8;
/// The page tells StreamHub things (full screen, links to open in a new tab) by putting a
/// `#streamhub-…` marker on its address with history.replaceState, which StreamHub reads and
/// clears. Unlike a navigation, that never interrupts the page or its player.
const MARK: &str = "streamhub-";

const SCRIPT: &str = r##"
(() => {
  if (window.top !== window) return;
  const replace = history.replaceState.bind(history);
  const mark = (tag) => replace(history.state, "", location.pathname + location.search + "#streamhub-" + tag);
  document.addEventListener("fullscreenchange", () => mark(document.fullscreenElement ? "fs1" : "fs0"));
  // Esc leaves StreamHub's full screen (its Full screen button) too
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.fullscreenElement) mark("fs0");
  }, true);
  // Ctrl+click, middle click and new-window links open a StreamHub tab
  const open = (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a) return;
    if (!(e.button === 1 || e.ctrlKey || e.metaKey || a.target === "_blank")) return;
    e.preventDefault();
    e.stopPropagation();
    mark("newtab=" + encodeURIComponent(a.href));
  };
  window.addEventListener("click", open, true);
  window.addEventListener("auxclick", open, true);
  // with "Play episodes in a Crunchyroll window" on: episode links open there
  const isEpisode = (href) => { try { return new URL(href, location.href).pathname.split("/").includes("watch"); } catch (e) { return false; } };
  window.addEventListener("click", (e) => {
    if (!window.__streamhubEpisodesInWindow || e.defaultPrevented) return;
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a || !isEpisode(a.href)) return;
    e.preventDefault();
    e.stopPropagation();
    mark("episode=" + encodeURIComponent(a.href));
  }, true);
  const push = history.pushState.bind(history);
  history.pushState = function (state, title, url) {
    if (window.__streamhubEpisodesInWindow && url && isEpisode(url) && !isEpisode(location.href)) {
      mark("episode=" + encodeURIComponent(new URL(url, location.href).href));
      return;
    }
    return push(state, title, url);
  };
})();
"##;

#[derive(Clone, Serialize)]
pub struct Tab {
    id: u32,
    title: String,
}

struct Tabs {
    list: Vec<Tab>,
    active: Option<u32>,
}

static TABS: Mutex<Tabs> = Mutex::new(Tabs {
    list: Vec::new(),
    active: None,
});
static NEXT: AtomicU32 = AtomicU32::new(1);
static SHOWN: AtomicBool = AtomicBool::new(false);
/// Episodes open in a Crunchyroll window (Microsoft Edge's app mode, where Crunchyroll's player
/// works) instead of the tab.
static EPISODES_IN_WINDOW: AtomicBool = AtomicBool::new(false);
static FULLSCREEN: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
pub struct TabsEvent {
    tabs: Vec<Tab>,
    active: Option<u32>,
    fullscreen: bool,
}

fn label(id: u32) -> String {
    format!("{PREFIX}{id}")
}

fn snapshot() -> TabsEvent {
    let tabs = TABS.lock().unwrap();
    TabsEvent {
        tabs: tabs.list.clone(),
        active: tabs.active,
        fullscreen: FULLSCREEN.load(Ordering::SeqCst),
    }
}

fn changed(app: &AppHandle) {
    let _ = app.emit("crunchyroll-tabs", snapshot());
}

/// Pages a Crunchyroll tab may show itself: Crunchyroll and its sign-in providers.
/// Everything else opens in the default browser.
pub fn allowed(url: &Url) -> bool {
    if url.scheme() == "about" {
        return true;
    }
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let under = |domain: &str| host == domain || host.ends_with(&format!(".{domain}"));
    under("crunchyroll.com") || host == "accounts.google.com" || host == "appleid.apple.com"
}

/// Where the shown tab goes: below the tab bar (or the whole window in full screen).
fn shown_bounds(app: &AppHandle) -> Option<(f64, f64, f64)> {
    let window = app.get_window("main")?;
    let size = window
        .inner_size()
        .ok()?
        .to_logical::<f64>(window.scale_factor().ok()?);
    let fullscreen = FULLSCREEN.load(Ordering::SeqCst);
    let right = if !fullscreen && app.get_webview(chat::PANEL).is_some() {
        chat::PANEL_WIDTH
    } else {
        0.0
    };
    let (top, width) = if fullscreen {
        (0.0, size.width)
    } else {
        (TOP, (size.width - right).max(0.0))
    };
    Some((top, width, (size.height - top).max(0.0)))
}

/// Place every tab: the active one below the tab bar (or the whole window in full screen), the
/// others off-screen, where they keep playing.
pub fn layout(app: &AppHandle) {
    let Some((top, width, height)) = shown_bounds(app) else {
        return;
    };
    let (ids, active) = {
        let tabs = TABS.lock().unwrap();
        (
            tabs.list.iter().map(|t| t.id).collect::<Vec<_>>(),
            tabs.active,
        )
    };
    let shown = SHOWN.load(Ordering::SeqCst);
    for id in ids {
        let Some(page) = app.get_webview(&label(id)) else {
            continue;
        };
        // a tab stays out of sight until its first page has loaded: StreamHub's own dark
        // "Loading Crunchyroll…" shows meanwhile, instead of a blank white page
        let ready = LOADED.lock().unwrap().contains(&id);
        let x = if shown && ready && Some(id) == active {
            0.0
        } else {
            -(width + 10_000.0)
        };
        let _ = page.set_position(LogicalPosition::new(x, top));
        let _ = page.set_size(LogicalSize::new(width, height));
    }
}

/// Full screen: StreamHub's window goes full screen first, then the tab fills it once the
/// window has its new size (placing it during the change left it black).
/// StreamHub's Full screen button: the video (or its player frame) fills the page, which fills the
/// screen. Undone by FILL_VIDEO_OFF.
const FILL_VIDEO_ON: &str = r##"
(() => {
  const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
  const players = [...document.querySelectorAll("video, iframe")]
    .filter((el) => area(el) > 40000 && (el.tagName === "VIDEO" || /player|vilos/i.test(el.src || el.id || el.className)));
  if (!players.length) return;
  let box = players.sort((a, b) => area(b) - area(a))[0];
  // the player's controls sit on top of the video in the same-sized box
  const size = box.getBoundingClientRect();
  while (box.parentElement && box.parentElement !== document.body) {
    const r = box.parentElement.getBoundingClientRect();
    if (Math.abs(r.width - size.width) > 4 || Math.abs(r.height - size.height) > 60) break;
    box = box.parentElement;
  }
  box.dataset.streamhubFill = box.getAttribute("style") || "";
  box.style.cssText += ";position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;z-index:2147483647!important;background:#000!important;margin:0!important";
  document.documentElement.style.overflow = "hidden";
  window.dispatchEvent(new Event("resize"));
})();
"##;

const FILL_VIDEO_OFF: &str = r##"
(() => {
  for (const box of document.querySelectorAll("[data-streamhub-fill]")) {
    box.setAttribute("style", box.dataset.streamhubFill);
    delete box.dataset.streamhubFill;
  }
  document.documentElement.style.overflow = "";
  window.dispatchEvent(new Event("resize"));
})();
"##;

fn active_page(app: &AppHandle) -> Option<tauri::Webview> {
    let active = TABS.lock().unwrap().active?;
    app.get_webview(&label(active))
}

fn set_fullscreen(app: &AppHandle, on: bool) {
    if FULLSCREEN.swap(on, Ordering::SeqCst) == on {
        return;
    }
    if !on {
        for id in TABS
            .lock()
            .unwrap()
            .list
            .iter()
            .map(|t| t.id)
            .collect::<Vec<_>>()
        {
            if let Some(page) = app.get_webview(&label(id)) {
                let _ = page.eval(FILL_VIDEO_OFF);
            }
        }
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(window) = app.get_window("main") {
            let _ = window.set_fullscreen(on);
        }
        for delay in [150, 400, 900] {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            layout(&app);
        }
        // keys (Esc) go to the page, not to StreamHub's hidden bar
        if let Some(page) = active_page(&app) {
            let _ = page.set_focus();
        }
        changed(&app);
    });
}

fn navigation(app: &AppHandle, url: &Url) -> bool {
    if allowed(url) {
        if EPISODES_IN_WINDOW.load(Ordering::SeqCst) && is_episode(url) {
            if let Err(e) = open_window(url) {
                let _ = app.emit("crunchyroll-error", e);
            }
            return false;
        }
        return true;
    }
    if url.scheme() == "https" || url.scheme() == "http" {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
    false
}

/// A tab's name from its address: the show or episode name in Crunchyroll's links
/// (/series/ID/the-apothecary-diaries), else the section (Home, Simulcasts…).
fn title_from(url: &Url) -> String {
    let parts: Vec<&str> = url
        .path_segments()
        .map(|p| p.filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    let words = |slug: &str| {
        slug.split('-')
            .filter(|w| !w.is_empty())
            .map(|w| {
                let mut c = w.chars();
                c.next()
                    .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(" ")
    };
    if let Some(i) = parts.iter().position(|p| matches!(*p, "series" | "watch")) {
        if let Some(slug) = parts.get(i + 2) {
            return words(slug).chars().take(60).collect();
        }
    }
    match parts.last() {
        None => "Home".into(),
        Some(last) => words(last).chars().take(60).collect(),
    }
}

/// Each tab is checked a few times a second: its name, and any `#streamhub-…` marker the page set.
fn watch_tab(app: AppHandle, id: u32) {
    tauri::async_runtime::spawn(async move {
        let mut last = String::new();
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let Some(page) = app.get_webview(&label(id)) else {
                break;
            };
            let Ok(url) = page.url() else { continue };
            if let Some(tag) = url.fragment().and_then(|f| f.strip_prefix(MARK)) {
                let tag = tag.to_string();
                let _ = page.eval(
                    "history.replaceState(history.state, '', location.pathname + location.search)",
                );
                let link = |prefix: &str| {
                    tag.strip_prefix(prefix)
                        .and_then(|u| {
                            url::form_urlencoded::parse(format!("u={u}").as_bytes())
                                .next()
                                .map(|(_, v)| v.into_owned())
                        })
                        .and_then(|u| u.parse::<Url>().ok())
                };
                if tag == "fs1" || tag == "fs0" {
                    set_fullscreen(&app, tag == "fs1");
                } else if let Some(link) = link("newtab=") {
                    if allowed(&link) {
                        let _ = new_tab(&app, link);
                    } else if link.scheme() == "https" || link.scheme() == "http" {
                        let _ = app.opener().open_url(link.as_str(), None::<&str>);
                    }
                } else if let Some(link) = link("episode=") {
                    if let Err(e) = open_window(&link) {
                        let _ = app.emit("crunchyroll-error", e);
                    }
                }
                continue;
            }
            let title = title_from(&url);
            if title != last {
                last = title.clone();
                let mut tabs = TABS.lock().unwrap();
                if let Some(tab) = tabs.list.iter_mut().find(|t| t.id == id) {
                    tab.title = title;
                }
                drop(tabs);
                changed(&app);
            }
        }
    });
}

/// An episode or movie page: crunchyroll.com/watch/… (with or without a language prefix).
fn is_episode(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("www.crunchyroll.com" | "crunchyroll.com")
    ) && url
        .path_segments()
        .is_some_and(|mut parts| parts.any(|p| p == "watch"))
}

fn find_edge() -> Option<std::path::PathBuf> {
    ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|base| std::path::Path::new(&base).join("Microsoft\\Edge\\Application\\msedge.exe"))
        .find(|path| path.is_file())
}

/// Open a Crunchyroll page in a Crunchyroll window: Microsoft Edge in app mode (no address bar or
/// tabs), signed in with Edge's own Crunchyroll sign-in.
fn open_window(url: &Url) -> Result<(), String> {
    if !allowed(url) {
        return Err("Only Crunchyroll pages open in the Crunchyroll window".into());
    }
    let edge =
        find_edge().ok_or("Microsoft Edge wasn't found, so the Crunchyroll window can't open")?;
    let mut command = std::process::Command::new(edge);
    command.arg(format!("--app={url}")).arg("--start-maximized");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open the Crunchyroll window: {e}"))
}

/// Where episodes play: true for the Crunchyroll window, false for the tab (beta).
#[tauri::command]
pub async fn cr_episodes_in_window(app: AppHandle, on: bool) -> Result<(), String> {
    EPISODES_IN_WINDOW.store(on, Ordering::SeqCst);
    let ids: Vec<u32> = TABS.lock().unwrap().list.iter().map(|t| t.id).collect();
    for id in ids {
        if let Some(page) = app.get_webview(&label(id)) {
            let _ = page.eval(&format!("window.__streamhubEpisodesInWindow = {on};"));
        }
    }
    Ok(())
}

/// Tabs whose first page has loaded (until then they stay out of sight).
static LOADED: Mutex<Vec<u32>> = Mutex::new(Vec::new());

/// The first page of a tab has loaded: bring it into view, and nudge its size so it repaints
/// (a page that loaded out of sight could otherwise stay blank).
fn first_load_done(app: &AppHandle, id: u32) {
    {
        let mut loaded = LOADED.lock().unwrap();
        if loaded.contains(&id) {
            return;
        }
        loaded.push(id);
    }
    layout(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let (Some(page), Some((_, width, height))) =
            (app.get_webview(&label(id)), shown_bounds(&app))
        {
            let _ = page.set_size(LogicalSize::new(width - 1.0, height));
            tokio::time::sleep(Duration::from_millis(60)).await;
            let _ = page.set_size(LogicalSize::new(width, height));
            let _ = page.eval("window.dispatchEvent(new Event('resize'))");
        }
    });
}

/// Open the first Crunchyroll tab in the background a few seconds after StreamHub starts, so the
/// Crunchyroll tab is ready when you open it (Crunchyroll's site is slow to load the first time).
pub fn preload(app: &AppHandle) {
    if !TABS.lock().unwrap().list.is_empty() {
        return;
    }
    if let Ok(home) = HOME.parse() {
        let shown = SHOWN.load(Ordering::SeqCst);
        let _ = new_tab(app, home);
        // preloading doesn't show it
        SHOWN.store(shown, Ordering::SeqCst);
        layout(app);
        changed(app);
    }
}

fn new_tab(app: &AppHandle, url: Url) -> Result<u32, String> {
    if TABS.lock().unwrap().list.len() >= MAX_TABS {
        return Err(format!(
            "Up to {MAX_TABS} Crunchyroll tabs. Close one first."
        ));
    }
    let window = app
        .get_window("main")
        .ok_or("StreamHub's window is missing")?;
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let nav_app = app.clone();
    let builder = WebviewBuilder::new(label(id), WebviewUrl::External(url))
        .initialization_script(&format!(
            "window.__streamhubEpisodesInWindow = {};\n{SCRIPT}",
            EPISODES_IN_WINDOW.load(Ordering::SeqCst)
        ))
        .on_navigation(move |url| navigation(&nav_app, url))
        // dark while a page loads, instead of bright white
        .background_color(tauri::window::Color(14, 14, 20, 255))
        .on_page_load(move |page, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let app = page.app_handle().clone();
                tauri::async_runtime::spawn(async move { first_load_done(&app, id) });
            }
        });
    // made out of sight at its full size; it comes into view when its first page has loaded
    let (top, width, height) = shown_bounds(app).ok_or("Couldn't size the Crunchyroll page")?;
    window
        .add_child(
            builder,
            LogicalPosition::new(-(width + 10_000.0), top),
            LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;
    // never wait forever for the first page
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(15)).await;
            first_load_done(&app, id);
        });
    }
    {
        let mut tabs = TABS.lock().unwrap();
        tabs.list.push(Tab {
            id,
            title: "Crunchyroll".into(),
        });
        tabs.active = Some(id);
    }
    SHOWN.store(true, Ordering::SeqCst);
    layout(app);
    changed(app);
    watch_tab(app.clone(), id);
    Ok(id)
}

/// Show the Crunchyroll tabs (the first one is opened the first time).
#[tauri::command]
pub async fn cr_show(app: AppHandle) -> Result<TabsEvent, String> {
    SHOWN.store(true, Ordering::SeqCst);
    if TABS.lock().unwrap().list.is_empty() {
        new_tab(&app, HOME.parse().map_err(|e| format!("{e}"))?)?;
    }
    layout(&app);
    Ok(snapshot())
}

/// Hide the Crunchyroll tabs (another StreamHub tab was opened). They keep playing.
#[tauri::command]
pub async fn cr_hide(app: AppHandle) -> Result<(), String> {
    SHOWN.store(false, Ordering::SeqCst);
    set_fullscreen(&app, false);
    layout(&app);
    Ok(())
}

/// Open a new Crunchyroll tab at the home page.
#[tauri::command]
pub async fn cr_new_tab(app: AppHandle) -> Result<TabsEvent, String> {
    new_tab(&app, HOME.parse().map_err(|e| format!("{e}"))?)?;
    Ok(snapshot())
}

/// Switch to a Crunchyroll tab.
#[tauri::command]
pub async fn cr_select(app: AppHandle, id: u32) -> Result<TabsEvent, String> {
    {
        let mut tabs = TABS.lock().unwrap();
        if !tabs.list.iter().any(|t| t.id == id) {
            return Err("That tab is closed".into());
        }
        tabs.active = Some(id);
    }
    layout(&app);
    changed(&app);
    Ok(snapshot())
}

/// Close a Crunchyroll tab (stops what it's playing).
#[tauri::command]
pub async fn cr_close_tab(app: AppHandle, id: u32) -> Result<TabsEvent, String> {
    {
        let mut tabs = TABS.lock().unwrap();
        let Some(index) = tabs.list.iter().position(|t| t.id == id) else {
            return Ok(snapshot_locked(&tabs));
        };
        tabs.list.remove(index);
        if tabs.active == Some(id) {
            tabs.active = tabs
                .list
                .get(index)
                .or_else(|| tabs.list.last())
                .map(|t| t.id);
        }
    }
    if let Some(page) = app.get_webview(&label(id)) {
        let _ = page.close();
    }
    if TABS.lock().unwrap().list.is_empty() {
        set_fullscreen(&app, false);
    }
    layout(&app);
    changed(&app);
    Ok(snapshot())
}

fn snapshot_locked(tabs: &Tabs) -> TabsEvent {
    TabsEvent {
        tabs: tabs.list.clone(),
        active: tabs.active,
        fullscreen: FULLSCREEN.load(Ordering::SeqCst),
    }
}

/// The tab bar's buttons for the active tab: "back", "forward", "home", "reload", "fullscreen".
#[tauri::command]
pub async fn cr_action(app: AppHandle, action: String) -> Result<(), String> {
    if action == "fullscreen" {
        let on = !FULLSCREEN.load(Ordering::SeqCst);
        if on {
            if let Some(page) = active_page(&app) {
                let _ = page.eval(FILL_VIDEO_ON);
            }
        }
        set_fullscreen(&app, on);
        return Ok(());
    }
    let active = TABS
        .lock()
        .unwrap()
        .active
        .ok_or("No Crunchyroll tab is open")?;
    let page = app
        .get_webview(&label(active))
        .ok_or("That tab is closed")?;
    match action.as_str() {
        "back" => page.eval("history.back()").map_err(|e| e.to_string()),
        "forward" => page.eval("history.forward()").map_err(|e| e.to_string()),
        "reload" => page.eval("location.reload()").map_err(|e| e.to_string()),
        "home" => page
            .navigate(HOME.parse().map_err(|e| format!("{e}"))?)
            .map_err(|e| e.to_string()),
        "window" => {
            let url = page.url().map_err(|e| e.to_string())?;
            open_window(&url)
        }
        "browser" => {
            let url = page.url().map_err(|e| e.to_string())?;
            if !allowed(&url) {
                return Err("This page can't be opened".into());
            }
            app.opener()
                .open_url(url.as_str(), None::<&str>)
                .map_err(|e| e.to_string())
        }
        _ => Err("Unknown action".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(url: &str) -> bool {
        allowed(&url.parse().unwrap())
    }

    #[test]
    fn stays_on_crunchyroll() {
        assert!(ok("https://www.crunchyroll.com/watch/abc"));
        assert!(ok("https://sso.crunchyroll.com/login"));
        assert!(ok("https://accounts.google.com/o/oauth2"));
        assert!(!ok("http://www.crunchyroll.com/"));
        assert!(!ok("https://evilcrunchyroll.com/"));
        assert!(!ok("https://crunchyroll.com.example.com/"));
        assert!(!ok("https://example.com/"));
    }

    #[test]
    fn titles() {
        let t = |u: &str| title_from(&u.parse().unwrap());
        assert_eq!(t("https://www.crunchyroll.com/"), "Home");
        assert_eq!(
            t("https://www.crunchyroll.com/series/GY5P48XEY/the-apothecary-diaries"),
            "The Apothecary Diaries"
        );
        assert_eq!(
            t("https://www.crunchyroll.com/watch/GR3VWXP96/resurrection-f"),
            "Resurrection F"
        );
        assert_eq!(t("https://www.crunchyroll.com/simulcasts"), "Simulcasts");
    }

    #[test]
    fn episodes() {
        assert!(is_episode(
            &"https://www.crunchyroll.com/watch/GR3VWXP96/abc"
                .parse()
                .unwrap()
        ));
        assert!(is_episode(
            &"https://www.crunchyroll.com/de/watch/GR3VWXP96/abc"
                .parse()
                .unwrap()
        ));
        assert!(!is_episode(
            &"https://www.crunchyroll.com/series/GY5P48XEY/abc"
                .parse()
                .unwrap()
        ));
        assert!(!is_episode(
            &"https://sso.crunchyroll.com/watch".parse().unwrap()
        ));
    }
}
