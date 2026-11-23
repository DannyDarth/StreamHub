//! Fast start for "Play in StreamHub": finds the stream's ad-free HLS address directly, in about
//! a second, instead of starting Streamlink (a Python program that takes several seconds to start).
//!
//! Twitch works like streamlink-ttvlol and the iOS app: the playback token and master playlist are
//! requested from a country where Twitch doesn't serve ads, through the same proxy list
//! (`httpproxy://` entries are HTTP CONNECT proxies, `https://` entries TTV.LOL-style playlist
//! proxies). All proxies are tried at once and the first in the list that works is used, so a
//! dead proxy doesn't hold things up. A stream that starts with ads is skipped. It never falls
//! back to Twitch directly unless "Direct through my VPN" is on.

use std::time::Duration;

use serde::Serialize;
use tokio::task::JoinSet;

use crate::adblock;

const GQL_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const TOKEN_HASH: &str = "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9";
const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// HTTP CONNECT proxy: the token and master playlist go through it.
    Forward { host: String, port: u16 },
    /// TTV.LOL-style API: `{base}/playlist/{channel}.m3u8` returns the master playlist.
    Playlist { base: String },
    /// Twitch itself (only for "Direct through my VPN").
    Direct,
}

impl Route {
    pub fn parse(entry: &str) -> Option<Route> {
        let entry = entry.trim().trim_end_matches('/');
        if let Some(rest) = entry.strip_prefix("httpproxy://").or_else(|| entry.strip_prefix("http://")) {
            let (host, port) = rest.rsplit_once(':')?;
            return Some(Route::Forward { host: host.to_string(), port: port.parse().ok()? });
        }
        entry.starts_with("https://").then(|| Route::Playlist { base: entry.to_string() })
    }

    pub fn label(&self) -> String {
        match self {
            Route::Forward { host, port } => format!("{host}:{port}"),
            Route::Playlist { base } => base.trim_start_matches("https://").to_string(),
            Route::Direct => "Twitch".into(),
        }
    }
}

/// Twitch's ad markers in a media playlist (same checks as the plugin and the iOS app).
pub fn has_ads(playlist: &str) -> bool {
    let lower = playlist.to_ascii_lowercase();
    lower.contains("twitch-stitched-ad")
        || lower.contains("\"stitched-ad-")
        || lower.contains("x-tv-twitch-ad-")
        || playlist.lines().any(|l| l.starts_with("#EXTINF") && l.contains("Amazon"))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Variant {
    uri: String,
    video: String,
    height: u32,
    fps: f32,
}

fn attr<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let start = line.find(&format!("{name}="))? + name.len() + 1;
    let rest = &line[start..];
    if let Some(quoted) = rest.strip_prefix('"') {
        quoted.split('"').next()
    } else {
        rest.split(',').next()
    }
}

/// The video variants of a master playlist (audio-only skipped), in the playlist's order.
fn variants(master: &str, master_url: &str) -> Vec<Variant> {
    let lines: Vec<&str> = master.lines().map(str::trim).collect();
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if !line.starts_with("#EXT-X-STREAM-INF") {
            continue;
        }
        let Some(resolution) = attr(line, "RESOLUTION") else { continue };
        let Some(uri) = lines.get(i + 1).filter(|u| !u.is_empty() && !u.starts_with('#')) else { continue };
        let uri = if uri.starts_with("http") {
            uri.to_string()
        } else {
            match reqwest::Url::parse(master_url).and_then(|base| base.join(uri)) {
                Ok(url) => url.to_string(),
                Err(_) => continue,
            }
        };
        out.push(Variant {
            uri,
            video: attr(line, "VIDEO").unwrap_or_default().to_string(),
            height: resolution.split('x').nth(1).and_then(|h| h.parse().ok()).unwrap_or(0),
            fps: attr(line, "FRAME-RATE").and_then(|f| f.parse().ok()).unwrap_or(30.0),
        });
    }
    out
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Quality {
    pub name: String,
    pub url: String,
}

/// The qualities to choose from in the player, best first ("1080p60", "720p", ...).
pub fn qualities(variants: &[Variant]) -> Vec<Quality> {
    let mut sorted: Vec<&Variant> = variants.iter().collect();
    sorted.sort_by(|a, b| (b.height, b.fps as u32).cmp(&(a.height, a.fps as u32)));
    let mut out: Vec<Quality> = Vec::new();
    for v in sorted {
        let fps = if v.fps >= 45.0 { format!("{}", v.fps.round() as u32) } else { String::new() };
        let name = if v.height > 0 { format!("{}p{fps}", v.height) } else { v.video.clone() };
        if !out.iter().any(|q| q.name == name) {
            out.push(Quality { name, url: proxied(&v.uri) });
        }
    }
    out
}

/// Fetch a master playlist (Kick) and pick the quality; returns (media address, qualities).
pub async fn from_master(master_url: &str, quality: &str) -> Result<(String, Vec<Quality>), String> {
    let res = proxy_client().get(master_url).send().await.map_err(|e| e.to_string())?;
    let base = res.url().to_string();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !valid_master(&text) {
        return Err("no playlist".into());
    }
    let v = variants(&text, &base);
    let media = pick(&v, quality).ok_or("no video")?;
    Ok((media, qualities(&v)))
}

/// Pick the variant for a quality setting ("best", "worst", "720p60", "480p", or a list "720p60,best").
fn pick(variants: &[Variant], quality: &str) -> Option<String> {
    let mut sorted: Vec<&Variant> = variants.iter().collect();
    sorted.sort_by(|a, b| (b.height, b.fps as u32).cmp(&(a.height, a.fps as u32)));
    for q in quality.split(',').map(str::trim) {
        let found = match q {
            "best" | "source" => sorted.first().copied(),
            "worst" => sorted.last().copied(),
            _ => {
                let (h, fps) = match q.split_once('p') {
                    Some((h, f)) => (h.parse::<u32>().ok(), f.parse::<u32>().ok()),
                    None => (None, None),
                };
                sorted.iter().copied().find(|v| v.video == q).or_else(|| {
                    let h = h?;
                    sorted.iter().copied().find(|v| {
                        v.height == h && fps.map_or(v.fps < 45.0, |f| (v.fps - f as f32).abs() < 2.0)
                    })
                })
            }
        };
        if let Some(v) = found {
            return Some(v.uri.clone());
        }
    }
    sorted.first().map(|v| v.uri.clone())
}

fn client(proxy: Option<(&str, u16)>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(9));
    if let Some((host, port)) = proxy {
        builder = builder.proxy(reqwest::Proxy::all(format!("http://{host}:{port}")).map_err(|e| e.to_string())?);
    }
    builder.build().map_err(|e| e.to_string())
}

fn valid_master(text: &str) -> bool {
    text.trim_start().starts_with("#EXTM3U") && text.contains("#EXT-X-STREAM-INF")
}

async fn token_and_master(client: &reqwest::Client, channel: &str) -> Result<(String, String), String> {
    let body = serde_json::json!({
        "operationName": "PlaybackAccessToken",
        "variables": { "isLive": true, "login": channel, "isVod": false, "vodID": "", "playerType": "embed", "platform": "site" },
        "extensions": { "persistedQuery": { "version": 1, "sha256Hash": TOKEN_HASH } }
    });
    let token: serde_json::Value = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-ID", GQL_CLIENT_ID)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let t = &token["data"]["streamPlaybackAccessToken"];
    let (Some(value), Some(signature)) = (t["value"].as_str(), t["signature"].as_str()) else {
        return Err("offline".into());
    };
    let mut url = reqwest::Url::parse(&format!("https://usher.ttvnw.net/api/channel/hls/{channel}.m3u8")).unwrap();
    url.query_pairs_mut()
        .append_pair("sig", signature)
        .append_pair("token", value)
        .append_pair("allow_source", "true")
        .append_pair("allow_audio_only", "true")
        .append_pair("fast_bread", "true")
        .append_pair("player_backend", "mediaplayer")
        .append_pair("supported_codecs", "h264")
        .append_pair("p", &(std::process::id() % 999_983).to_string());
    let master = client
        .get(url.clone())
        .header("Referer", "https://player.twitch.tv")
        .header("Origin", "https://player.twitch.tv")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if master.status().as_u16() == 404 {
        return Err("offline".into());
    }
    let text = master.text().await.map_err(|e| e.to_string())?;
    if !valid_master(&text) {
        return Err("no playlist".into());
    }
    Ok((url.to_string(), text))
}

/// One route: the media playlist address for this quality, or why it failed.
async fn try_route(route: Route, channel: String, quality: String) -> Result<(String, Vec<Quality>), String> {
    let (master_url, master) = match &route {
        Route::Forward { host, port } => token_and_master(&client(Some((host, *port)))?, &channel).await?,
        Route::Direct => token_and_master(&client(None)?, &channel).await?,
        Route::Playlist { base } => {
            let mut url = reqwest::Url::parse(&format!("{base}/playlist/{channel}.m3u8")).map_err(|e| e.to_string())?;
            url.query_pairs_mut()
                .append_pair("platform", "web")
                .append_pair("allow_source", "true")
                .append_pair("allow_audio_only", "true")
                .append_pair("fast_bread", "true")
                .append_pair("supported_codecs", "h264");
            let res = client(None)?.get(url.clone()).send().await.map_err(|e| e.to_string())?;
            if res.status().as_u16() == 404 {
                return Err("offline".into());
            }
            let text = res.text().await.map_err(|e| e.to_string())?;
            if !valid_master(&text) {
                return Err("no playlist".into());
            }
            (url.to_string(), text)
        }
    };
    let all = variants(&master, &master_url);
    let media = pick(&all, &quality).ok_or("no video")?;
    // skip a server whose stream starts with ads
    let playlist = client(None)?.get(&media).send().await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
    if has_ads(&playlist) {
        return Err("ads".into());
    }
    Ok((media, qualities(&all)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub url: String,
    pub qualities: Vec<Quality>,
    pub server: Option<String>,
    /// Index in the proxy list of the server used: after an ad, ask again from the next one.
    pub index: usize,
    pub last: bool,
    pub direct: bool,
}

/// Find an ad-free Twitch stream, trying the proxies from `start` on (all at once; the first in
/// the list that works wins). Err("offline") when the channel isn't live.
pub async fn twitch(channel: &str, quality: &str, proxies: &[String], start: usize, direct: bool) -> Result<Found, String> {
    let mut list: Vec<String> = proxies.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if list.is_empty() {
        list = adblock::DEFAULT_PROXIES.iter().map(|s| s.to_string()).collect();
    }
    let routes: Vec<(usize, Route)> = list
        .iter()
        .enumerate()
        .skip(start)
        .filter_map(|(i, entry)| Route::parse(entry).map(|r| (i, r)))
        .collect();
    let count = routes.len();
    let mut results: Vec<Option<Result<(String, Vec<Quality>), String>>> = vec![None; count];
    let mut set = JoinSet::new();
    for (pos, (_, route)) in routes.iter().enumerate() {
        let (route, channel, quality) = (route.clone(), channel.to_string(), quality.to_string());
        set.spawn(async move { (pos, try_route(route, channel, quality).await) });
    }
    while let Some(joined) = set.join_next().await {
        let Ok((pos, result)) = joined else { continue };
        results[pos] = Some(result);
        // the first route in the list that isn't still pending decides
        for (pos, result) in results.iter().enumerate() {
            match result {
                None => break,
                Some(Ok((url, qualities))) => {
                    let (index, route) = &routes[pos];
                    return Ok(Found {
                        url: url.clone(),
                        qualities: qualities.clone(),
                        server: Some(route.label()),
                        index: *index,
                        last: pos + 1 >= count,
                        direct: false,
                    });
                }
                Some(Err(_)) => continue,
            }
        }
    }
    let all_offline = !results.is_empty() && results.iter().all(|r| matches!(r, Some(Err(e)) if e == "offline"));
    if all_offline {
        return Err("offline".into());
    }
    if direct {
        let (url, qualities) = try_route(Route::Direct, channel.to_string(), quality.to_string()).await?;
        return Ok(Found { url, qualities, server: None, index: list.len(), last: true, direct: true });
    }
    Err("no-ad-free".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MASTER: &str = "#EXTM3U\n\
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"chunked\",NAME=\"1080p60\"\n\
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS=\"avc1\",VIDEO=\"chunked\",FRAME-RATE=60.000\n\
https://cdn/chunked.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,VIDEO=\"720p60\",FRAME-RATE=60.000\n\
https://cdn/720p60.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=852x480,VIDEO=\"480p30\",FRAME-RATE=30.000\n\
480p30.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS=\"mp4a.40.2\",VIDEO=\"audio_only\"\n\
https://cdn/audio.m3u8\n";

    #[test]
    fn parses_routes() {
        assert_eq!(
            Route::parse("httpproxy://firefox.api.cdn-perfprod.com:2023"),
            Some(Route::Forward { host: "firefox.api.cdn-perfprod.com".into(), port: 2023 })
        );
        assert_eq!(Route::parse("https://eu.luminous.dev/"), Some(Route::Playlist { base: "https://eu.luminous.dev".into() }));
        assert_eq!(Route::parse("ftp://x"), None);
    }

    #[test]
    fn picks_qualities() {
        let v = variants(MASTER, "https://proxy/playlist/x.m3u8?a=1");
        assert_eq!(v.len(), 3, "audio-only skipped");
        assert_eq!(v[2].uri, "https://proxy/playlist/480p30.m3u8");
        assert_eq!(pick(&v, "best").as_deref(), Some("https://cdn/chunked.m3u8"));
        assert_eq!(pick(&v, "720p60,best").as_deref(), Some("https://cdn/720p60.m3u8"));
        assert_eq!(pick(&v, "480p").as_deref(), Some("https://proxy/playlist/480p30.m3u8"));
        assert_eq!(pick(&v, "worst").as_deref(), Some("https://proxy/playlist/480p30.m3u8"));
        assert_eq!(pick(&v, "160p").as_deref(), Some("https://cdn/chunked.m3u8"), "falls back to best");
        let names: Vec<String> = qualities(&v).into_iter().map(|q| q.name).collect();
        assert_eq!(names, ["1080p60", "720p60", "480p"]);
    }

    #[test]
    fn finds_ads() {
        assert!(has_ads("#EXT-X-DATERANGE:ID=\"stitched-ad-1\",CLASS=\"twitch-stitched-ad\""));
        assert!(has_ads("#EXTINF:2.000,Amazon|123\nseg.ts"));
        assert!(!has_ads("#EXTINF:2.000,live\nseg.ts"));
    }
}

// ---- stream proxy for the in-app player ----
//
// Twitch's and Kick's video servers don't all allow requests from StreamHub's window (cross-origin
// rules), which stopped the in-app player. The player loads playlists and video through
// `http://stream.localhost/p?u=<address>` instead: StreamHub fetches them itself and rewrites the
// playlists so their video segments come through here too. Only Twitch/Kick video hosts.

const PROXY_BASE: &str = "http://stream.localhost/p?u=";

fn allowed_video_host(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    let under = |d: &str| host == d || host.ends_with(&format!(".{d}"));
    url.scheme() == "https"
        && (under("ttvnw.net")
            || under("twitch.tv")
            || under("jtvnw.net")
            || under("live-video.net")
            || under("kick.com")
            || under("cdn-perfprod.com")
            || under("luminous.dev"))
}

/// The address the in-app player loads a stream URL through.
pub fn proxied(url: &str) -> String {
    let encoded: String = url::form_urlencoded::byte_serialize(url.as_bytes()).collect();
    format!("{PROXY_BASE}{encoded}")
}

/// Point a playlist's entries (variants, segments, EXT-X-MAP) at the proxy.
pub fn rewrite_playlist(text: &str, base: &reqwest::Url) -> String {
    let absolute = |uri: &str| base.join(uri).map(|u| proxied(u.as_str())).unwrap_or_else(|_| uri.to_string());
    let mut out = String::with_capacity(text.len() * 2);
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            out.push('\n');
            continue;
        }
        if trimmed.starts_with('#') {
            if let Some(start) = trimmed.find("URI=\"") {
                let rest = &trimmed[start + 5..];
                if let Some(end) = rest.find('"') {
                    out.push_str(&trimmed[..start + 5]);
                    out.push_str(&absolute(&rest[..end]));
                    out.push_str(&rest[end..]);
                    out.push('\n');
                    continue;
                }
            }
            out.push_str(trimmed);
        } else {
            out.push_str(&absolute(trimmed));
        }
        out.push('\n');
    }
    out
}

fn proxy_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(20))
            .build()
            .expect("HTTP client")
    })
}

fn respond(status: u16, content_type: &str, body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store")
        .body(body)
        .unwrap()
}

/// Handle a request to `stream.localhost`.
pub async fn proxy(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    if request.method() == tauri::http::Method::OPTIONS {
        return tauri::http::Response::builder()
            .status(204)
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "GET, OPTIONS")
            .header("Access-Control-Allow-Headers", "*")
            .body(Vec::new())
            .unwrap();
    }
    let query = request.uri().query().unwrap_or_default();
    let target = url::form_urlencoded::parse(query.as_bytes())
        .find(|(k, _)| k == "u")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    let Ok(url) = reqwest::Url::parse(&target) else { return respond(400, "text/plain", b"bad address".to_vec()) };
    if !allowed_video_host(&url) {
        return respond(403, "text/plain", b"not a video host".to_vec());
    }
    let mut upstream = proxy_client().get(url.clone());
    if let Some(range) = request.headers().get("Range") {
        upstream = upstream.header("Range", range);
    }
    let res = match upstream.send().await {
        Ok(res) => res,
        Err(e) => return respond(502, "text/plain", e.to_string().into_bytes()),
    };
    let status = res.status().as_u16();
    let content_type = res
        .headers()
        .get("Content-Type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let final_url = res.url().clone();
    let body = match res.bytes().await {
        Ok(b) => b.to_vec(),
        Err(e) => return respond(502, "text/plain", e.to_string().into_bytes()),
    };
    let is_playlist = content_type.contains("mpegurl") || final_url.path().ends_with(".m3u8") || body.starts_with(b"#EXTM3U");
    if is_playlist && status < 400 {
        let text = String::from_utf8_lossy(&body);
        return respond(status, "application/vnd.apple.mpegurl", rewrite_playlist(&text, &final_url).into_bytes());
    }
    respond(status, &content_type, body)
}

#[cfg(test)]
mod proxy_tests {
    use super::*;

    #[test]
    fn rewrites_playlists() {
        let base = reqwest::Url::parse("https://video-weaver.fra05.hls.ttvnw.net/v1/playlist/abc.m3u8").unwrap();
        let text = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2.000,live\nhttps://video-edge-1.abs.hls.ttvnw.net/seg1.ts\nseg2.ts\n";
        let out = rewrite_playlist(text, &base);
        assert!(out.contains("#EXT-X-MAP:URI=\"http://stream.localhost/p?u=https%3A%2F%2Fvideo-weaver.fra05.hls.ttvnw.net%2Fv1%2Fplaylist%2Finit.mp4\""));
        assert!(out.contains("http://stream.localhost/p?u=https%3A%2F%2Fvideo-edge-1.abs.hls.ttvnw.net%2Fseg1.ts\n"));
        assert!(out.contains("#EXTINF:2.000,live\n"));
    }

    #[test]
    fn only_video_hosts() {
        let ok = |u: &str| allowed_video_host(&reqwest::Url::parse(u).unwrap());
        assert!(ok("https://video-weaver.fra05.hls.ttvnw.net/x.m3u8"));
        assert!(ok("https://fa723fc1b171.us-west-2.playback.live-video.net/api/video/v1/x.m3u8"));
        assert!(!ok("https://example.com/x"));
        assert!(!ok("http://usher.ttvnw.net/x"));
    }
}
