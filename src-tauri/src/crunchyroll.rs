//! Crunchyroll: crunchyroll.com itself in StreamHub's window (a second webview below the header,
//! like the chat panel). Crunchyroll's videos are DRM-protected (Widevine), so they play in
//! Crunchyroll's own player inside the page, never through StreamHub's player. You sign in on
//! Crunchyroll's own page; StreamHub never sees the password.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};
use tauri_plugin_opener::OpenerExt;

use crate::chat;

pub const LABEL: &str = "crunchyroll";
const HOME: &str = "https://www.crunchyroll.com/";
/// Below StreamHub's header and the Crunchyroll bar (Back, Home, Reload, Full screen).
const TOP: f64 = 52.0 + 48.0;
/// The page asks for full screen by navigating here; the navigation is cancelled.
const SIGNAL_HOST: &str = "streamhub-crunchyroll.invalid";

/// Crunchyroll's player going full screen (or leaving it) tells StreamHub, so the page can fill
/// the whole window.
const SCRIPT: &str = r#"
(() => {
  if (window.top !== window) return;
  const signal = (on) => { location.href = "https://streamhub-crunchyroll.invalid/fullscreen?on=" + (on ? 1 : 0); };
  document.addEventListener("fullscreenchange", () => signal(Boolean(document.fullscreenElement)));
  // Esc leaves StreamHub's full screen too (the Full screen button in StreamHub's bar)
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.fullscreenElement) signal(false);
  }, true);
})();
"#;

static SHOWN: AtomicBool = AtomicBool::new(false);
static FULLSCREEN: AtomicBool = AtomicBool::new(false);

/// Pages the Crunchyroll tab may show itself: Crunchyroll and its sign-in providers.
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

fn bounds(window: &tauri::Window) -> Option<(LogicalPosition<f64>, LogicalSize<f64>)> {
    let scale = window.scale_factor().ok()?;
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    if FULLSCREEN.load(Ordering::SeqCst) {
        return Some((LogicalPosition::new(0.0, 0.0), size));
    }
    // leave room for the chat panel when it's open
    let right = if window.app_handle().get_webview(chat::PANEL).is_some() {
        chat::PANEL_WIDTH
    } else {
        0.0
    };
    let width = (size.width - right).max(0.0);
    let height = (size.height - TOP).max(0.0);
    if SHOWN.load(Ordering::SeqCst) {
        Some((
            LogicalPosition::new(0.0, TOP),
            LogicalSize::new(width, height),
        ))
    } else {
        // hidden off-screen rather than closed: the page (and its sound) keeps going
        Some((
            LogicalPosition::new(-(width + 10_000.0), TOP),
            LogicalSize::new(width, height),
        ))
    }
}

/// Place the Crunchyroll page (on resize, show/hide, full screen).
pub fn layout(app: &AppHandle) {
    let (Some(window), Some(page)) = (app.get_window("main"), app.get_webview(LABEL)) else {
        return;
    };
    if let Some((position, size)) = bounds(&window) {
        let _ = page.set_position(position);
        let _ = page.set_size(size);
    }
}

fn set_fullscreen(app: &AppHandle, on: bool) {
    FULLSCREEN.store(on, Ordering::SeqCst);
    if let Some(window) = app.get_window("main") {
        let _ = window.set_fullscreen(on);
    }
    layout(app);
}

fn navigation(app: &AppHandle, url: &Url) -> bool {
    if url.host_str() == Some(SIGNAL_HOST) {
        let on = url.query_pairs().any(|(k, v)| k == "on" && v == "1");
        let app = app.clone();
        tauri::async_runtime::spawn(async move { set_fullscreen(&app, on) });
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

/// Show the Crunchyroll tab's page (created the first time).
#[tauri::command]
pub async fn cr_show(app: AppHandle) -> Result<(), String> {
    SHOWN.store(true, Ordering::SeqCst);
    if app.get_webview(LABEL).is_some() {
        layout(&app);
        return Ok(());
    }
    let window = app
        .get_window("main")
        .ok_or("StreamHub's window is missing")?;
    let (position, size) = bounds(&window).ok_or("Couldn't size the Crunchyroll page")?;
    let nav_app = app.clone();
    let url: Url = HOME.parse().map_err(|e| format!("{e}"))?;
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .initialization_script(SCRIPT)
        .on_navigation(move |url| navigation(&nav_app, url));
    window
        .add_child(builder, position, size)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Hide the Crunchyroll page (another tab was opened). It keeps playing.
#[tauri::command]
pub async fn cr_hide(app: AppHandle) -> Result<(), String> {
    SHOWN.store(false, Ordering::SeqCst);
    if FULLSCREEN.load(Ordering::SeqCst) {
        set_fullscreen(&app, false);
    }
    layout(&app);
    Ok(())
}

/// The Crunchyroll bar's buttons: "back", "home", "reload", "fullscreen".
#[tauri::command]
pub async fn cr_action(app: AppHandle, action: String) -> Result<(), String> {
    let page = app.get_webview(LABEL).ok_or("Crunchyroll isn't open")?;
    match action.as_str() {
        "back" => page.eval("history.back()").map_err(|e| e.to_string()),
        "reload" => page.eval("location.reload()").map_err(|e| e.to_string()),
        "home" => page
            .navigate(HOME.parse().map_err(|e| format!("{e}"))?)
            .map_err(|e| e.to_string()),
        "fullscreen" => {
            set_fullscreen(&app, !FULLSCREEN.load(Ordering::SeqCst));
            Ok(())
        }
        _ => Err("Unknown action".into()),
    }
}

/// Close the Crunchyroll page (stops whatever is playing).
#[tauri::command]
pub async fn cr_close(app: AppHandle) -> Result<(), String> {
    SHOWN.store(false, Ordering::SeqCst);
    if FULLSCREEN.load(Ordering::SeqCst) {
        set_fullscreen(&app, false);
    }
    if let Some(page) = app.get_webview(LABEL) {
        page.close().map_err(|e| e.to_string())?;
    }
    Ok(())
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
