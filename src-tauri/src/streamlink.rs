//! Launching Twitch streams through Streamlink with the bundled ad blocking plugin.
//!
//! When Twitch gets an ad through the current proxy, Streamlink is restarted with the next proxy
//! tried first. StreamHub never falls back to Twitch's own servers (with ads) on its own: playing
//! directly is only allowed when the user turned on "direct through my VPN".

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::adblock::{self, Event, Level, ProxyRotation, Status, Tracker};
use crate::badge;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Twitch,
    Kick,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSettings {
    #[serde(default)]
    pub streamlink_path: Option<String>,
    #[serde(default)]
    pub player_path: Option<String>,
    #[serde(default = "default_quality")]
    pub quality: String,
    #[serde(default)]
    pub low_latency: bool,
    #[serde(default = "yes")]
    pub proxy_enabled: bool,
    #[serde(default)]
    pub proxies: Vec<String>,
    #[serde(default)]
    pub direct: bool,
    #[serde(default)]
    pub backup_stream: bool,
    #[serde(default = "yes")]
    pub badge: bool,
    /// "normal", "more" or "most": how many seconds of video Streamlink keeps buffered.
    #[serde(default)]
    pub buffer: Option<String>,
    /// "Play in StreamHub": the stream goes to StreamHub's own player instead of an external one.
    #[serde(default)]
    pub play_in_app: bool,
}

/// Streamlink's buffering options for the "Smoother playback" setting. More buffer means fewer
/// stutters on unsteady connections, a few seconds further behind live.
pub fn buffer_args(buffer: Option<&str>, low_latency: bool) -> &'static [&'static str] {
    if low_latency {
        return &[];
    }
    match buffer {
        Some("more") => &["--hls-live-edge", "6", "--stream-segment-threads", "2"],
        Some("most") => &["--hls-live-edge", "10", "--stream-segment-threads", "3"],
        _ => &[],
    }
}

fn default_quality() -> String {
    "best".into()
}

fn yes() -> bool {
    true
}

/// Where the ad blocking plugin is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plugin {
    /// Passed to `--plugin-dirs`. None: the plugin is in Streamlink's own plugins folder.
    pub dir: Option<PathBuf>,
    /// StreamHub's bundled build, which has the backup stream option.
    pub bundled: bool,
}

#[derive(Default)]
struct Session {
    child: Mutex<Option<Child>>,
    stopped: AtomicBool,
}

impl Session {
    /// Stop Streamlink together with the video player it started.
    fn kill(&self) {
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            kill_tree(child);
        }
    }
}

/// Killing only Streamlink leaves its player running, so kill the whole process tree.
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .status();
    }
    let _ = child.kill();
}

#[derive(Default)]
pub struct Streams {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<u64, Arc<Session>>>,
}

impl Streams {
    pub fn stop_all(&self) {
        for session in self.sessions.lock().unwrap().values() {
            session.stopped.store(true, Ordering::SeqCst);
            session.kill();
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusEvent<'a> {
    id: u64,
    channel: &'a str,
    status: &'a Status,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EndedEvent<'a> {
    id: u64,
    channel: &'a str,
    code: Option<i32>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamlinkInfo {
    streamlink: Option<String>,
    plugin: Option<String>,
    bundled_plugin: bool,
    default_proxies: Vec<&'static str>,
}

pub fn valid_channel(channel: &str) -> bool {
    !channel.is_empty() && channel.len() <= 25 && channel.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Kick channel slugs also allow dashes.
pub fn valid_kick_slug(slug: &str) -> bool {
    !slug.is_empty() && slug.len() <= 64 && slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn valid_quality(quality: &str) -> bool {
    !quality.is_empty() && quality.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ',')
}

fn is_file(path: &Path) -> bool {
    path.is_file()
}

/// Find Streamlink: the path from the settings, then PATH, then the installer's folders.
pub fn find_streamlink(custom: Option<&str>) -> Option<PathBuf> {
    if let Some(custom) = custom.map(str::trim).filter(|s| !s.is_empty()) {
        let path = PathBuf::from(custom);
        return is_file(&path).then_some(path);
    }

    let names: &[&str] = if cfg!(windows) { &["streamlink.exe", "streamlinkw.exe"] } else { &["streamlink"] };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if cfg!(windows) {
        for (var, sub) in [
            ("PROGRAMFILES", "Streamlink\\bin"),
            ("PROGRAMFILES(X86)", "Streamlink\\bin"),
            ("LOCALAPPDATA", "Programs\\Streamlink\\bin"),
        ] {
            if let Some(base) = std::env::var_os(var) {
                dirs.push(Path::new(&base).join(sub));
            }
        }
    }
    names
        .iter()
        .flat_map(|name| dirs.iter().map(move |dir| dir.join(name)))
        .find(|path| is_file(path))
}

/// Find the ad blocking plugin: the bundled build (installer resources or next to the portable
/// exe), then a streamlink-ttvlol install in Streamlink's own plugins folder.
pub fn find_plugin(app: &AppHandle) -> Option<Plugin> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("streamlink-plugins"));
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) {
        candidates.push(dir.join("streamlink-plugins"));
    }
    if let Some(dir) = candidates.into_iter().find(|dir| dir.join("twitch.py").is_file()) {
        return Some(Plugin { dir: Some(dir), bundled: true });
    }

    let appdata = std::env::var_os("APPDATA")?;
    Path::new(&appdata)
        .join("streamlink")
        .join("plugins")
        .join("twitch.py")
        .is_file()
        .then_some(Plugin { dir: None, bundled: false })
}

/// Cut the long query strings (access tokens) out of URLs in an error message.
pub fn shorten_urls(message: &str) -> String {
    message
        .split(' ')
        .map(|word| match word.find('?') {
            Some(i) if word.contains('/') => {
                let tail = word[i..].rfind(')').map_or("", |j| &word[i + j..]);
                format!("{}…{}", &word[..i], tail)
            }
            _ => word.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The error shown when a stream ends with an error.
pub fn explain_error(error: &str, ad_free_only: bool) -> String {
    let error = shorten_urls(error);
    if ad_free_only && error.starts_with("No playable streams found") {
        return "No ad-free proxy could play this stream right now, so StreamHub didn't play it \
                (it would have ads). The channel may also have just gone offline. Try again in a minute."
            .into();
    }
    error
}

/// Streamlink's arguments for one launch.
pub fn build_args(
    platform: Platform,
    channel: &str,
    settings: &WatchSettings,
    plugin: Option<&Plugin>,
    rotation: &ProxyRotation,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["--loglevel".into(), "info".into()];
    if settings.play_in_app {
        // StreamHub's own player plays the stream: Streamlink only finds its (ad-free) address
        args.push("--stream-url".into());
    } else {
        if let Some(player) = settings.player_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            args.push("--player".into());
            args.push(player.into());
        }
        args.push("--title".into());
        args.push(format!("{channel} - StreamHub").into());
    }
    let low_latency = platform == Platform::Twitch && settings.low_latency;
    if low_latency {
        args.push("--twitch-low-latency".into());
    }
    args.extend(buffer_args(settings.buffer.as_deref(), low_latency).iter().map(OsString::from));
    if let Some(plugin) = plugin {
        if let Some(dir) = &plugin.dir {
            args.push("--plugin-dirs".into());
            args.push(dir.clone().into_os_string());
        }
        args.push("--twitch-proxy-playlist".into());
        args.push(rotation.playlist().into());
        if settings.direct {
            args.push("--twitch-proxy-playlist-fallback".into());
        }
        if settings.backup_stream && plugin.bundled {
            args.push("--twitch-backup-stream".into());
        }
    }
    args.push(match platform {
        Platform::Twitch => format!("twitch.tv/{channel}").into(),
        Platform::Kick => format!("https://kick.com/{channel}").into(),
    });
    // fall back to the best quality when the chosen one doesn't exist (Kick names them differently)
    let quality = match settings.quality.as_str() {
        "best" | "worst" => settings.quality.clone(),
        q => format!("{q},best"),
    };
    args.push(quality.into());
    args
}

fn spawn_reader<R: Read + Send + 'static>(reader: R, tx: mpsc::Sender<String>) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
}

struct Runner {
    app: AppHandle,
    platform: Platform,
    id: u64,
    channel: String,
    settings: WatchSettings,
    exe: PathBuf,
    plugin: Option<Plugin>,
    session: Arc<Session>,
}

impl Runner {
    fn emit_status(&self, pid: u32, status: &Status) {
        let _ = self.app.emit(
            "adblock-status",
            StatusEvent { id: self.id, channel: &self.channel, status },
        );
        if self.settings.badge && self.plugin.is_some() {
            badge::show(&self.app, pid, status);
        }
    }

    fn run(self) {
        let mut rotation = ProxyRotation::new(if self.settings.proxies.is_empty() {
            adblock::DEFAULT_PROXIES.iter().map(|s| s.to_string()).collect()
        } else {
            self.settings.proxies.clone()
        });
        let mut tracker = Tracker::default();
        let mut last_error: Option<String> = None;

        let code = loop {
            let mut command = Command::new(&self.exe);
            command
                .args(build_args(self.platform, &self.channel, &self.settings, self.plugin.as_ref(), &rotation))
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            }

            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(e) => {
                    last_error = Some(format!("Couldn't start Streamlink: {e}"));
                    break None;
                }
            };
            let pid = child.id();
            let (tx, rx) = mpsc::channel();
            if let Some(out) = child.stdout.take() {
                spawn_reader(out, tx.clone());
            }
            if let Some(err) = child.stderr.take() {
                spawn_reader(err, tx);
            }
            *self.session.child.lock().unwrap() = Some(child);
            if self.session.stopped.load(Ordering::SeqCst) {
                self.session.kill();
            }

            if self.plugin.is_some() {
                let detail = match rotation.first() {
                    Some(server) => format!("Trying {}", server.split_once("://").map_or(server, |(_, h)| h)),
                    None => String::new(),
                };
                self.emit_status(pid, &tracker.status(Level::Info, "Finding ad-free stream", detail));
            }

            let mut switching = false;
            for line in rx {
                let message = adblock::strip_log_prefix(&line);
                if let Some(cli_error) = message.strip_prefix("error:") {
                    // Streamlink's final error wins over the plugin's per-proxy errors
                    last_error = Some(cli_error.trim().to_string());
                } else if line.contains("][error]") && last_error.is_none() {
                    last_error = Some(message.to_string());
                }
                let Some(event) = adblock::parse_event(&line) else { continue };
                if event != Event::AdDetected {
                    if let Some(status) = tracker.record(&event) {
                        self.emit_status(pid, &status);
                    }
                    continue;
                }
                if switching {
                    continue;
                }
                if self.plugin.is_some() && !tracker.direct && rotation.switch() {
                    // restart Streamlink with the next proxy tried first
                    switching = true;
                    let next = rotation.first().unwrap_or_default();
                    let next = next.split_once("://").map_or(next, |(_, h)| h).to_string();
                    let status = tracker.status(Level::Warn, "Switching proxy", format!("Ad detected, trying {next}"));
                    self.emit_status(pid, &status);
                    self.session.kill();
                } else {
                    // Streamlink filters the ad out (the stream pauses instead of showing it)
                    tracker.ads_got_through += 1;
                    let detail = if self.plugin.is_some() {
                        "Ad filtered out: every proxy has been tried".to_string()
                    } else {
                        "Ad filtered out by Streamlink".to_string()
                    };
                    self.emit_status(pid, &tracker.status(Level::Warn, "Ad break", detail));
                }
            }

            let child = self.session.child.lock().unwrap().take();
            let status = child.and_then(|mut c| c.wait().ok());
            if switching && !self.session.stopped.load(Ordering::SeqCst) {
                last_error = None;
                continue;
            }
            break status.and_then(|s| s.code());
        };

        let error = match code {
            Some(0) => None,
            _ if self.session.stopped.load(Ordering::SeqCst) => None,
            _ => Some(explain_error(
                last_error.as_deref().unwrap_or("Streamlink stopped unexpectedly"),
                self.plugin.is_some() && !self.settings.direct,
            )),
        };
        let _ = self.app.emit(
            "stream-ended",
            EndedEvent { id: self.id, channel: &self.channel, code, error },
        );
        let streams = self.app.state::<Streams>();
        let mut sessions = streams.sessions.lock().unwrap();
        sessions.remove(&self.id);
        if sessions.is_empty() {
            badge::hide(&self.app);
        }
    }
}

/// Start watching a channel in the external player. Returns the stream's id.
#[tauri::command]
pub fn watch(
    app: AppHandle,
    streams: State<'_, Streams>,
    platform: Platform,
    channel: String,
    settings: WatchSettings,
) -> Result<u64, String> {
    let channel = channel.to_ascii_lowercase();
    let valid = match platform {
        Platform::Twitch => valid_channel(&channel),
        Platform::Kick => valid_kick_slug(&channel),
    };
    if !valid {
        return Err("Invalid channel name".into());
    }
    if !valid_quality(&settings.quality) {
        return Err("Invalid stream quality".into());
    }
    let exe = find_streamlink(settings.streamlink_path.as_deref()).ok_or(
        "Streamlink wasn't found. Install it from streamlink.github.io or set its path in Settings.",
    )?;
    // the ad blocking plugin is for Twitch: Kick doesn't put ads into the streams Streamlink plays
    let plugin = if platform == Platform::Twitch && settings.proxy_enabled {
        Some(find_plugin(&app).ok_or(
            "The ad blocking plugin is missing, so StreamHub won't play this stream (it would have ads). \
             Reinstall StreamHub or install streamlink-ttvlol.",
        )?)
    } else {
        None
    };

    let id = streams.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let session = Arc::new(Session::default());
    streams.sessions.lock().unwrap().insert(id, session.clone());

    if settings.play_in_app {
        return Err("Use resolve_stream for StreamHub's own player".into());
    }
    let runner = Runner { app, platform, id, channel, settings, exe, plugin, session };
    std::thread::spawn(move || runner.run());
    Ok(id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedStream {
    /// The stream's HLS playlist: through an ad-free proxy for Twitch.
    url: String,
    /// The proxy server used (Twitch).
    server: Option<String>,
    /// True when there's no other proxy to try after this one.
    last: bool,
    /// True when Twitch is played directly (no proxy worked and "Direct through my VPN" is on).
    direct: bool,
    /// Index in the proxy list of the server used: after an ad, StreamHub asks again from the next.
    index: usize,
}

fn first_url(lines: &[String]) -> Option<String> {
    lines
        .iter()
        .map(|l| l.trim())
        .find(|l| l.starts_with("https://") || l.starts_with("http://"))
        .map(str::to_string)
}

/// Play in StreamHub: find the stream's (ad-free) playlist address with Streamlink, without
/// starting a player. `attempt` picks the proxy tried first (0 = the first in the list): after
/// an ad, StreamHub's player asks again with the next one.
#[tauri::command]
pub async fn resolve_stream(
    app: AppHandle,
    platform: Platform,
    channel: String,
    mut settings: WatchSettings,
    attempt: usize,
) -> Result<ResolvedStream, String> {
    let channel = channel.to_ascii_lowercase();
    let valid = match platform {
        Platform::Twitch => valid_channel(&channel),
        Platform::Kick => valid_kick_slug(&channel),
    };
    if !valid {
        return Err("Invalid channel name".into());
    }
    if !valid_quality(&settings.quality) {
        return Err("Invalid stream quality".into());
    }
    settings.play_in_app = true;

    // Fast start: find the address directly (about a second); Streamlink below is the fallback.
    match platform {
        Platform::Kick => match crate::kick::playback(&app, &channel).await {
            Ok(url) => {
                return Ok(ResolvedStream { url: crate::fastplay::proxied(&url), server: None, last: true, direct: false, index: 0 })
            }
            Err(e) if e == "offline" => return Err("This channel isn't live.".into()),
            Err(_) => {}
        },
        Platform::Twitch if settings.proxy_enabled && find_plugin(&app).is_some() => {
            match crate::fastplay::twitch(&channel, &settings.quality, &settings.proxies, attempt, settings.direct).await {
                Ok(found) => {
                    return Ok(ResolvedStream {
                        url: crate::fastplay::proxied(&found.url),
                        server: found.server,
                        last: found.last,
                        direct: found.direct,
                        index: found.index,
                    })
                }
                Err(e) if e == "offline" => return Err("This channel isn't live.".into()),
                Err(e) if e == "no-ad-free" => {
                    return Err("No ad-free stream is available right now: every proxy failed or served ads. \
                                StreamHub won't play the stream with ads."
                        .into())
                }
                Err(_) => {}
            }
        }
        Platform::Twitch => {}
    }

    let exe = find_streamlink(settings.streamlink_path.as_deref()).ok_or(
        "Streamlink wasn't found. Install it from streamlink.github.io or set its path in Settings.",
    )?;
    let plugin = if platform == Platform::Twitch && settings.proxy_enabled {
        Some(find_plugin(&app).ok_or(
            "The ad blocking plugin is missing, so StreamHub won't play this stream (it would have ads). \
             Reinstall StreamHub or install streamlink-ttvlol.",
        )?)
    } else {
        None
    };
    let mut rotation = ProxyRotation::new(if settings.proxies.is_empty() {
        adblock::DEFAULT_PROXIES.iter().map(|s| s.to_string()).collect()
    } else {
        settings.proxies.clone()
    });
    for _ in 0..attempt {
        if !rotation.switch() {
            return Err("No ad-free stream is available right now: every proxy has been tried. \
                        StreamHub won't play the stream with ads."
                .into());
        }
    }
    let args = build_args(platform, &channel, &settings, plugin.as_ref(), &rotation);

    let output = tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(&exe);
        command.args(args).stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        command.output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Couldn't start Streamlink: {e}"))?;

    let lines: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .chain(String::from_utf8_lossy(&output.stderr).lines())
        .map(str::to_string)
        .collect();
    let mut tracker = Tracker::default();
    let mut error: Option<String> = None;
    for line in &lines {
        let message = adblock::strip_log_prefix(line);
        if let Some(cli_error) = message.strip_prefix("error:") {
            error = Some(cli_error.trim().to_string());
        }
        if let Some(event) = adblock::parse_event(line) {
            tracker.record(&event);
        }
    }
    let ad_free_only = plugin.is_some() && !settings.direct;
    match first_url(&lines) {
        Some(url) if output.status.success() => {
            let mut next = rotation.clone();
            Ok(ResolvedStream {
                url: crate::fastplay::proxied(&url),
                server: tracker.server,
                last: !next.switch(),
                direct: tracker.direct,
                index: attempt,
            })
        }
        _ => Err(explain_error(error.as_deref().unwrap_or("Streamlink couldn't find the stream"), ad_free_only)),
    }
}

/// Stop a stream started with `watch`.
#[tauri::command]
pub fn stop(streams: State<'_, Streams>, id: u64) {
    if let Some(session) = streams.sessions.lock().unwrap().get(&id) {
        session.stopped.store(true, Ordering::SeqCst);
        session.kill();
    }
}

/// What the settings page shows: where Streamlink and the ad blocking plugin were found.
#[tauri::command]
pub fn streamlink_info(app: AppHandle, streamlink_path: Option<String>) -> StreamlinkInfo {
    let plugin = find_plugin(&app);
    StreamlinkInfo {
        streamlink: find_streamlink(streamlink_path.as_deref()).map(|p| p.display().to_string()),
        plugin: plugin.as_ref().map(|p| match &p.dir {
            Some(dir) => dir.join("twitch.py").display().to_string(),
            None => "%APPDATA%\\streamlink\\plugins\\twitch.py".into(),
        }),
        bundled_plugin: plugin.is_some_and(|p| p.bundled),
        default_proxies: adblock::DEFAULT_PROXIES.to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> WatchSettings {
        serde_json::from_str(r#"{"quality":"best"}"#).unwrap()
    }

    fn strings(args: Vec<OsString>) -> Vec<String> {
        args.into_iter().map(|a| a.into_string().unwrap()).collect()
    }

    #[test]
    fn defaults_block_ads() {
        let s = settings();
        assert!(s.proxy_enabled && s.badge && !s.direct && !s.backup_stream);
    }

    #[test]
    fn validates_input() {
        assert!(valid_channel("some_channel42"));
        assert!(!valid_channel("bad channel"));
        assert!(!valid_channel("x&calc"));
        assert!(!valid_channel(""));
        assert!(valid_quality("720p60,best"));
        assert!(!valid_quality("best --player=calc"));
    }

    #[test]
    fn buffer_settings() {
        assert!(buffer_args(None, false).is_empty());
        assert!(buffer_args(Some("normal"), false).is_empty());
        assert_eq!(buffer_args(Some("more"), false)[..2], ["--hls-live-edge", "6"]);
        assert!(buffer_args(Some("most"), true).is_empty(), "low latency keeps its own buffer");
        let mut s = settings();
        s.buffer = Some("most".into());
        let args = strings(build_args(Platform::Kick, "x", &s, None, &ProxyRotation::new(vec![])));
        assert!(args.windows(2).any(|w| w == ["--hls-live-edge", "10"]));
    }

    #[test]
    fn in_app_args() {
        let mut s = settings();
        s.play_in_app = true;
        s.player_path = Some("vlc.exe".into());
        let args = strings(build_args(Platform::Kick, "x", &s, None, &ProxyRotation::new(vec![])));
        assert_eq!(args, ["--loglevel", "info", "--stream-url", "https://kick.com/x", "best"]);
        let lines = vec!["[plugins.twitch][info] Using playlist proxy 'https://a/'".to_string(), "https://cdn/x.m3u8".to_string()];
        assert_eq!(first_url(&lines).as_deref(), Some("https://cdn/x.m3u8"));
    }

    #[test]
    fn kick_args() {
        let mut s = settings();
        s.quality = "720p60".into();
        s.low_latency = true;
        let rotation = ProxyRotation::new(vec![]);
        let args = strings(build_args(Platform::Kick, "some-streamer", &s, None, &rotation));
        assert_eq!(
            args,
            ["--loglevel", "info", "--title", "some-streamer - StreamHub", "https://kick.com/some-streamer", "720p60,best"]
        );
        assert!(valid_kick_slug("some-streamer_1"));
        assert!(!valid_kick_slug("a/b"));
    }

    #[test]
    fn explains_errors() {
        let raw = "Unable to open URL: https://usher.ttvnw.net/api/v2/channel/hls/x.m3u8?sig=abc&token=%7B%7D \
                   (HTTPSConnectionPool(host='usher.ttvnw.net', port=443): Max retries exceeded with url: \
                   /api/v2/channel/hls/x.m3u8?sig=abc&token=%7B%7D (Caused by ProxyError('Unable to connect to proxy')))";
        assert_eq!(
            explain_error(raw, true),
            "Unable to open URL: https://usher.ttvnw.net/api/v2/channel/hls/x.m3u8… \
             (HTTPSConnectionPool(host='usher.ttvnw.net', port=443): Max retries exceeded with url: \
             /api/v2/channel/hls/x.m3u8… (Caused by ProxyError('Unable to connect to proxy')))"
        );
        assert!(explain_error("No playable streams found on this URL: twitch.tv/x", true).starts_with("No ad-free proxy"));
        assert_eq!(
            explain_error("No playable streams found on this URL: twitch.tv/x", false),
            "No playable streams found on this URL: twitch.tv/x"
        );
    }

    #[test]
    fn args_with_bundled_plugin() {
        let mut s = settings();
        s.backup_stream = true;
        let plugin = Plugin { dir: Some(PathBuf::from("plugins")), bundled: true };
        let rotation = ProxyRotation::new(vec!["https://a".into(), "https://b".into()]);
        let args = strings(build_args(Platform::Twitch, "chan", &s, Some(&plugin), &rotation));
        assert_eq!(
            args,
            [
                "--loglevel", "info", "--title", "chan - StreamHub", "--plugin-dirs", "plugins",
                "--twitch-proxy-playlist", "https://a,https://b", "--twitch-backup-stream",
                "twitch.tv/chan", "best",
            ]
        );
    }

    #[test]
    fn never_falls_back_unless_direct_is_on() {
        let mut s = settings();
        let plugin = Plugin { dir: None, bundled: false };
        let rotation = ProxyRotation::new(vec!["https://a".into()]);
        let args = strings(build_args(Platform::Twitch, "chan", &s, Some(&plugin), &rotation));
        assert!(!args.contains(&"--twitch-proxy-playlist-fallback".to_string()));
        assert!(!args.contains(&"--plugin-dirs".to_string()));

        s.direct = true;
        s.backup_stream = true; // needs the bundled plugin
        let args = strings(build_args(Platform::Twitch, "chan", &s, Some(&plugin), &rotation));
        assert!(args.contains(&"--twitch-proxy-playlist-fallback".to_string()));
        assert!(!args.contains(&"--twitch-backup-stream".to_string()));
    }
}
