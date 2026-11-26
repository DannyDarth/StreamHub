//! YouTube playback without ads: yt-dlp finds a video's stream (YouTube only adds ads in its own
//! player) and StreamHub's player plays it.
//!
//! StreamHub downloads yt-dlp.exe itself from yt-dlp's GitHub releases (checked against the
//! release's SHA2-256SUMS) into its app data folder, and looks for a newer one once a day, since
//! YouTube changes often and yt-dlp follows within days.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

const LATEST: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const DOWNLOADS: &str = "https://github.com/yt-dlp/yt-dlp/releases/download/";
const EXE: &str = "yt-dlp.exe";
const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);

pub fn valid_video_id(id: &str) -> bool {
    id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("StreamHub")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct Release {
    assets: Vec<Asset>,
}

fn checksum_for(sums: &str, file: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        (name == file && hash.len() == 64).then(|| hash.to_ascii_lowercase())
    })
}

async fn download_latest(path: &Path) -> Result<(), String> {
    let client = client()?;
    let release: Release = client
        .get(LATEST)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let url = |name: &str| {
        release
            .assets
            .iter()
            .find(|a| a.name == name && a.browser_download_url.starts_with(DOWNLOADS))
            .map(|a| a.browser_download_url.clone())
    };
    let exe_url = url(EXE).ok_or("yt-dlp's release has no yt-dlp.exe")?;
    let sums_url = url("SHA2-256SUMS").ok_or("yt-dlp's release has no SHA2-256SUMS")?;
    let sums = client.get(sums_url).send().await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
    let expected = checksum_for(&sums, EXE).ok_or("SHA2-256SUMS doesn't list yt-dlp.exe")?;
    let bytes = client.get(exe_url).send().await.map_err(|e| e.to_string())?.bytes().await.map_err(|e| e.to_string())?;
    if format!("{:x}", Sha256::digest(&bytes)) != expected {
        return Err("The downloaded yt-dlp doesn't match its checksum".into());
    }
    let tmp = path.with_extension("download");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// yt-dlp.exe, downloaded or refreshed if needed.
async fn ensure(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(EXE);
    let fresh = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age < CHECK_EVERY);
    if fresh {
        return Ok(path);
    }
    match download_latest(&path).await {
        Ok(()) => Ok(path),
        // keep using the copy we have if the check fails (offline, GitHub down)
        Err(_) if path.is_file() => {
            let _ = std::fs::File::options().append(true).open(&path).and_then(|f| f.set_modified(SystemTime::now()));
            Ok(path)
        }
        Err(e) => Err(format!("Couldn't get yt-dlp (needed for YouTube): {e}")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeStream {
    /// "hls": an HLS playlist (with qualities); "file": a single video file.
    pub kind: &'static str,
    pub url: String,
    pub title: String,
    pub channel: String,
    pub live: bool,
    pub duration: Option<f64>,
    pub qualities: Vec<crate::fastplay::Quality>,
}

/// Pick what to play from yt-dlp's JSON: an HLS playlist (YouTube offers one to some clients, with
/// all qualities and the sound in it), else the best single file with both picture and sound.
pub fn choose(info: &Value) -> Option<(&'static str, String)> {
    let formats = info["formats"].as_array()?;
    let hls = formats
        .iter()
        .filter(|f| f["protocol"].as_str().is_some_and(|p| p.starts_with("m3u8")))
        .find_map(|f| f["manifest_url"].as_str().or_else(|| f["url"].as_str()));
    if let Some(url) = hls {
        return Some(("hls", url.to_string()));
    }
    formats
        .iter()
        .filter(|f| {
            f["vcodec"].as_str().is_some_and(|v| v != "none")
                && f["acodec"].as_str().is_some_and(|a| a != "none")
                && f["protocol"].as_str().is_some_and(|p| p == "https")
        })
        .max_by_key(|f| f["height"].as_u64().unwrap_or(0))
        .and_then(|f| f["url"].as_str())
        .map(|u| ("file", u.to_string()))
}

/// Find a YouTube video's stream with yt-dlp.
#[tauri::command]
pub async fn yt_stream(app: AppHandle, id: String, quality: Option<String>) -> Result<YoutubeStream, String> {
    if !valid_video_id(&id) {
        return Err("Invalid video".into());
    }
    let exe = ensure(&app).await?;
    let url = format!("https://www.youtube.com/watch?v={id}");
    let output = tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(exe);
        command
            .args([
                "-J",
                "--no-warnings",
                "--no-playlist",
                "--extractor-args",
                "youtube:player_client=default,web_safari",
                &url,
            ])
            .stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        command.output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Couldn't run yt-dlp: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let line = err.lines().rev().find(|l| l.contains("ERROR")).unwrap_or("yt-dlp couldn't play this video");
        return Err(line.trim_start_matches("ERROR:").trim().to_string());
    }
    let info: Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    let (kind, url) = choose(&info).ok_or("No playable format for this video")?;
    // YouTube's HLS keeps the sound in separate audio playlists, so the player gets the whole
    // master playlist and switches qualities itself
    let _ = quality;
    let qualities = Vec::new();
    Ok(YoutubeStream {
        kind,
        url: crate::fastplay::proxied(&url),
        title: info["title"].as_str().unwrap_or_default().to_string(),
        channel: info["channel"].as_str().or_else(|| info["uploader"].as_str()).unwrap_or_default().to_string(),
        live: info["is_live"].as_bool().unwrap_or(false),
        duration: info["duration"].as_f64(),
        qualities,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn video_ids() {
        assert!(valid_video_id("dQw4w9WgXcQ"));
        assert!(!valid_video_id("dQw4w9WgXc"));
        assert!(!valid_video_id("dQw4w9WgXc&"));
    }

    #[test]
    fn prefers_hls() {
        let info = json!({ "formats": [
            { "protocol": "https", "vcodec": "avc1", "acodec": "mp4a", "height": 360, "url": "https://g/360.mp4" },
            { "protocol": "m3u8_native", "vcodec": "avc1", "acodec": "none", "height": 1080, "url": "https://g/1080.m3u8", "manifest_url": "https://manifest.googlevideo.com/master.m3u8" }
        ]});
        assert_eq!(choose(&info), Some(("hls", "https://manifest.googlevideo.com/master.m3u8".to_string())));
        let info = json!({ "formats": [
            { "protocol": "https", "vcodec": "avc1", "acodec": "mp4a", "height": 360, "url": "https://g/360.mp4" },
            { "protocol": "https", "vcodec": "avc1", "acodec": "mp4a", "height": 720, "url": "https://g/720.mp4" },
            { "protocol": "https", "vcodec": "avc1", "acodec": "none", "height": 1080, "url": "https://g/1080.mp4" }
        ]});
        assert_eq!(choose(&info), Some(("file", "https://g/720.mp4".to_string())));
    }
}
