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
/// The page talks to StreamHub by navigating here (the navigation is cancelled): full screen,
/// its title, and links to open in a new tab.
const SIGNAL_HOST: &str = "streamhub-crunchyroll.invalid";
const MAX_TABS: usize = 8;

/// In every frame: Crunchyroll's player picks PlayReady when the browser offers it, and protected
/// PlayReady video (decoded in hardware) shows black in an embedded webview. Offering only
/// Widevine makes the player use Widevine, which draws normally. Nothing is decrypted or
/// bypassed: Crunchyroll's own player and licence server still do all of that.
const DRM_SCRIPT: &str = r#"
(() => {
  const eme = navigator.requestMediaKeySystemAccess && navigator.requestMediaKeySystemAccess.bind(navigator);
  if (!eme) return;
  navigator.requestMediaKeySystemAccess = (keySystem, configs) =>
    /playready/i.test(keySystem)
      ? Promise.reject(new DOMException("Unsupported keySystem", "NotSupportedError"))
      : eme(keySystem, configs);
})();
"#;

const SCRIPT: &str = r#"
(() => {
  if (window.top !== window) return;
  const signal = (path, params) =>
    { location.href = "https://streamhub-crunchyroll.invalid/" + path + "?" + new URLSearchParams(params); };
  document.addEventListener("fullscreenchange", () => signal("fullscreen", { on: document.fullscreenElement ? 1 : 0 }));
  // Esc leaves StreamHub's full screen (its Full screen button) too
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.fullscreenElement) signal("fullscreen", { on: 0 });
  }, true);
  // the tab's name
  let last = "";
  const title = () => {
    const t = document.title.replace(/\s*[-|]\s*Crunchyroll\s*$/i, "").trim();
    if (t && t !== last) { last = t; signal("title", { t }); }
  };
  setInterval(title, 1500);
  // Ctrl+click, middle click and new-window links open a StreamHub tab
  const open = (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a) return;
    if (!(e.button === 1 || e.ctrlKey || e.metaKey || a.target === "_blank")) return;
    e.preventDefault();
    e.stopPropagation();
    signal("newtab", { u: a.href });
  };
  window.addEventListener("click", open, true);
  window.addEventListener("auxclick", open, true);
  // what StreamHub shows when a video stays black: is Widevine there, and did the video fail?
  const config = [{
    initDataTypes: ["cenc"],
    videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
    audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
  }];
  setTimeout(() => {
    (navigator.requestMediaKeySystemAccess
      ? navigator.requestMediaKeySystemAccess("com.widevine.alpha", config).then(() => "yes", (e) => "no: " + (e && e.message || e))
      : Promise.resolve("no: EME missing")
    ).then((wv) => signal("drm", { widevine: wv }));
  }, 2500);
  document.addEventListener("error", (e) => {
    const v = e.target;
    if (v instanceof HTMLMediaElement && v.error) signal("drm", { error: "Video error " + v.error.code + (v.error.message ? ": " + v.error.message : "") });
  }, true);
})();
"#;

#[derive(Clone, Serialize)]
pub struct Tab {
    id: u32,
    title: String,
}

struct Tabs {
    list: Vec<Tab>,
    active: Option<u32>,
}

/// What the pages reported about protected video (shown in the tab bar).
#[derive(Clone, Default, Serialize)]
pub struct Drm {
    widevine: Option<String>,
    error: Option<String>,
}

static DRM: Mutex<Drm> = Mutex::new(Drm { widevine: None, error: None });
static TABS: Mutex<Tabs> = Mutex::new(Tabs { list: Vec::new(), active: None });
static NEXT: AtomicU32 = AtomicU32::new(1);
static SHOWN: AtomicBool = AtomicBool::new(false);
static FULLSCREEN: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
pub struct TabsEvent {
    tabs: Vec<Tab>,
    active: Option<u32>,
    fullscreen: bool,
    drm: Drm,
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
        drm: DRM.lock().unwrap().clone(),
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
    let Some(host) = url.host_str() else { return false };
    let under = |domain: &str| host == domain || host.ends_with(&format!(".{domain}"));
    under("crunchyroll.com") || host == "accounts.google.com" || host == "appleid.apple.com"
}

/// Place every tab: the active one below the tab bar (or the whole window in full screen), the
/// others off-screen, where they keep playing.
pub fn layout(app: &AppHandle) {
    let Some(window) = app.get_window("main") else { return };
    let (Ok(scale), Ok(inner)) = (window.scale_factor(), window.inner_size()) else { return };
    let size = inner.to_logical::<f64>(scale);
    let fullscreen = FULLSCREEN.load(Ordering::SeqCst);
    let right = if !fullscreen && app.get_webview(chat::PANEL).is_some() { chat::PANEL_WIDTH } else { 0.0 };
    let (top, width) = if fullscreen { (0.0, size.width) } else { (TOP, (size.width - right).max(0.0)) };
    let height = (size.height - top).max(0.0);
    let (ids, active) = {
        let tabs = TABS.lock().unwrap();
        (tabs.list.iter().map(|t| t.id).collect::<Vec<_>>(), tabs.active)
    };
    let shown = SHOWN.load(Ordering::SeqCst);
    for id in ids {
        let Some(page) = app.get_webview(&label(id)) else { continue };
        let x = if shown && Some(id) == active { 0.0 } else { -(width + 10_000.0) };
        let _ = page.set_position(LogicalPosition::new(x, top));
        let _ = page.set_size(LogicalSize::new(width, height));
    }
}

/// Full screen: StreamHub's window goes full screen first, then the tab fills it once the
/// window has its new size (placing it during the change left it black).
fn set_fullscreen(app: &AppHandle, on: bool) {
    if FULLSCREEN.swap(on, Ordering::SeqCst) == on {
        return;
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
        changed(&app);
    });
}

fn navigation(app: &AppHandle, id: u32, url: &Url) -> bool {
    if url.host_str() == Some(SIGNAL_HOST) {
        let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
        match url.path() {
            "/fullscreen" => set_fullscreen(app, param("on").as_deref() == Some("1")),
            "/title" => {
                if let Some(title) = param("t") {
                    let title: String = title.chars().take(80).collect();
                    let mut tabs = TABS.lock().unwrap();
                    if let Some(tab) = tabs.list.iter_mut().find(|t| t.id == id) {
                        tab.title = title;
                    }
                    drop(tabs);
                    changed(app);
                }
            }
            "/drm" => {
                let mut drm = DRM.lock().unwrap();
                if let Some(widevine) = param("widevine") {
                    drm.widevine = Some(widevine.chars().take(120).collect());
                }
                if let Some(error) = param("error") {
                    drm.error = Some(error.chars().take(160).collect());
                }
                drop(drm);
                changed(app);
            }
            "/newtab" => {
                if let Some(link) = param("u").and_then(|u| u.parse::<Url>().ok()) {
                    if allowed(&link) {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = new_tab(&app, link);
                        });
                    } else if link.scheme() == "https" || link.scheme() == "http" {
                        let _ = app.opener().open_url(link.as_str(), None::<&str>);
                    }
                }
            }
            _ => {}
        }
        return false;
    }
    if allowed(url) {
        return true;
    }
    if url.scheme() == "https" || url.scheme() == "http" {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
    false
}

fn new_tab(app: &AppHandle, url: Url) -> Result<u32, String> {
    if TABS.lock().unwrap().list.len() >= MAX_TABS {
        return Err(format!("Up to {MAX_TABS} Crunchyroll tabs. Close one first."));
    }
    let window = app.get_window("main").ok_or("StreamHub's window is missing")?;
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let nav_app = app.clone();
    let builder = WebviewBuilder::new(label(id), WebviewUrl::External(url))
        .initialization_script_for_all_frames(DRM_SCRIPT)
        .initialization_script(SCRIPT)
        .on_navigation(move |url| navigation(&nav_app, id, url));
    // created off-screen, then placed
    window
        .add_child(builder, LogicalPosition::new(-20_000.0, TOP), LogicalSize::new(800.0, 600.0))
        .map_err(|e| e.to_string())?;
    {
        let mut tabs = TABS.lock().unwrap();
        tabs.list.push(Tab { id, title: "Crunchyroll".into() });
        tabs.active = Some(id);
    }
    SHOWN.store(true, Ordering::SeqCst);
    layout(app);
    changed(app);
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
        let Some(index) = tabs.list.iter().position(|t| t.id == id) else { return Ok(snapshot_locked(&tabs)) };
        tabs.list.remove(index);
        if tabs.active == Some(id) {
            tabs.active = tabs.list.get(index).or_else(|| tabs.list.last()).map(|t| t.id);
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
        drm: DRM.lock().unwrap().clone(),
    }
}

/// The tab bar's buttons for the active tab: "back", "forward", "home", "reload", "fullscreen".
#[tauri::command]
pub async fn cr_action(app: AppHandle, action: String) -> Result<(), String> {
    if action == "fullscreen" {
        set_fullscreen(&app, !FULLSCREEN.load(Ordering::SeqCst));
        return Ok(());
    }
    let active = TABS.lock().unwrap().active.ok_or("No Crunchyroll tab is open")?;
    let page = app.get_webview(&label(active)).ok_or("That tab is closed")?;
    match action.as_str() {
        "back" => page.eval("history.back()").map_err(|e| e.to_string()),
        "forward" => page.eval("history.forward()").map_err(|e| e.to_string()),
        "reload" => page.eval("location.reload()").map_err(|e| e.to_string()),
        "home" => page.navigate(HOME.parse().map_err(|e| format!("{e}"))?).map_err(|e| e.to_string()),
        "browser" => {
            let url = page.url().map_err(|e| e.to_string())?;
            if !allowed(&url) {
                return Err("This page can't be opened".into());
            }
            app.opener().open_url(url.as_str(), None::<&str>).map_err(|e| e.to_string())
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
}
