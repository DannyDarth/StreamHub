//! Automatic updates: download the new version's installer from the GitHub release, check it
//! against the release's SHA256SUMS.txt, and run it silently when StreamHub restarts or quits.
//!
//! Only for installed copies of StreamHub (the portable build keeps the "Download" banner).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

const RELEASES: &str = "https://api.github.com/repos/DannyDarth/StreamHub/releases/tags/streamhub-windows-v";
const DOWNLOADS: &str = "https://github.com/DannyDarth/StreamHub/releases/download/";

/// The downloaded, checked installer waiting to be run.
#[derive(Default)]
pub struct Update {
    ready: Mutex<Option<PathBuf>>,
}

pub fn valid_version(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.len() <= 5 && p.chars().all(|c| c.is_ascii_digit()))
}

/// An installed copy has the installer's uninstall.exe next to it; the portable build doesn't.
pub fn is_installed() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("uninstall.exe").is_file()))
        .unwrap_or(false)
}

/// The checksum for `file` in a SHA256SUMS.txt ("<hex>  <name>" lines).
pub fn checksum_for(sums: &str, file: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        (name == file && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())).then(|| hash.to_ascii_lowercase())
    })
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct Release {
    assets: Vec<Asset>,
    draft: bool,
    prerelease: bool,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("StreamHub updater")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())
}

async fn download_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let res = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("GitHub returned {}", res.status()));
    }
    res.text().await.map_err(|e| e.to_string())
}

/// Is automatic updating possible for this copy of StreamHub?
#[tauri::command]
pub fn update_supported() -> bool {
    cfg!(windows) && is_installed()
}

/// Download and check the installer of `version`; it runs on restart or quit.
#[tauri::command]
pub async fn download_update(app: AppHandle, version: String) -> Result<(), String> {
    if !valid_version(&version) {
        return Err("Invalid version".into());
    }
    if !is_installed() {
        return Err("This is the portable build: download the new version from the release page".into());
    }
    let client = client()?;
    let release: Release = serde_json::from_str(&download_text(&client, &format!("{RELEASES}{version}")).await?)
        .map_err(|e| e.to_string())?;
    if release.draft || release.prerelease {
        return Err("Not a published release".into());
    }
    let installer_name = format!("StreamHub_{version}_x64-setup.exe");
    let find = |name: &str| {
        release
            .assets
            .iter()
            .find(|a| a.name == name && a.browser_download_url.starts_with(DOWNLOADS))
            .map(|a| a.browser_download_url.clone())
    };
    let installer_url = find(&installer_name).ok_or("The release has no installer")?;
    let sums_url = find("SHA256SUMS.txt").ok_or("The release has no SHA256SUMS.txt")?;
    let expected = checksum_for(&download_text(&client, &sums_url).await?, &installer_name)
        .ok_or("SHA256SUMS.txt doesn't list the installer")?;

    let res = client.get(&installer_url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("GitHub returned {}", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != expected {
        return Err("The downloaded installer doesn't match the release's checksum; it wasn't installed".into());
    }

    let dir = std::env::temp_dir().join("StreamHub-update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&installer_name);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    *app.state::<Update>().ready.lock().unwrap() = Some(path);
    Ok(())
}

/// Run the downloaded installer (with its progress window, no questions) once StreamHub has
/// closed, then start StreamHub again. Returns false when no update is ready.
pub fn apply(app: &AppHandle) -> bool {
    let Some(installer) = app.state::<Update>().ready.lock().unwrap().take() else { return false };
    let Ok(exe) = std::env::current_exe() else { return false };
    run_installer(&installer, &exe).is_ok()
}

#[cfg(windows)]
fn run_installer(installer: &Path, exe: &Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    // single quotes for PowerShell; paths can't contain them here (temp dir, install dir)
    let script = format!(
        "Start-Sleep -Seconds 2; Start-Process -FilePath '{}' -ArgumentList '/P' -Wait; Start-Process -FilePath '{}'",
        installer.display().to_string().replace('\'', "''"),
        exe.display().to_string().replace('\'', "''"),
    );
    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .map(|_| ())
}

#[cfg(not(windows))]
fn run_installer(_installer: &Path, _exe: &Path) -> std::io::Result<()> {
    Err(std::io::Error::other("automatic updates are for Windows"))
}

/// "Restart to update": quit StreamHub and install the update.
#[tauri::command]
pub fn restart_to_update(app: AppHandle) -> Result<(), String> {
    if !apply(&app) {
        return Err("No update is ready".into());
    }
    app.state::<crate::streamlink::Streams>().stop_all();
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert!(valid_version("2.0.2"));
        assert!(!valid_version("2.0"));
        assert!(!valid_version("2.0.2-beta"));
        assert!(!valid_version("2.0.2;calc"));
    }

    #[test]
    fn checksums() {
        let sums = "0b8f8a0e3b1a6b7c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e  StreamHub-2.0.2-Windows-x64-portable.zip\n\
                    AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899  StreamHub_2.0.2_x64-setup.exe\n";
        assert_eq!(
            checksum_for(sums, "StreamHub_2.0.2_x64-setup.exe").as_deref(),
            Some("aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899")
        );
        assert_eq!(checksum_for(sums, "other.exe"), None);
    }
}
