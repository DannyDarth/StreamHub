# StreamHub

Ad-free Twitch and Kick streams, YouTube without ads and with SponsorBlock, and Crunchyroll, in one app on Windows.

StreamHub 2 is rebuilt with [Tauri 2](https://tauri.app): a Rust core with a light web UI. StreamHub 1.x (NW.js + Ember) is kept on the [`v1` branch](https://github.com/DannyDarth/StreamHub/tree/v1). The iPhone app is [StreamHub-iOS](https://github.com/DannyDarth/StreamHub-iOS).

## Security

A dependency audit (npm audit and cargo audit) runs every week and on every change. StreamHub never sees your Twitch, Kick, YouTube or Crunchyroll passwords: you sign in on each site's own page. Updates and yt-dlp are checked against their release checksums before they run.

## Install

Download **StreamHub_…_x64-setup.exe** (installer) or **StreamHub-…-Windows-x64-portable.zip** from the [latest release](https://github.com/DannyDarth/StreamHub/releases/latest). You also need [Streamlink](https://streamlink.github.io/install.html) 8.3 or newer for Twitch and Kick, and a video player such as VLC unless you play streams in StreamHub. YouTube and Crunchyroll need nothing else.

The installer isn't code-signed yet, so Windows SmartScreen may warn about it: choose **More info → Run anyway**.

StreamHub 2 keeps its own settings: sign in to Twitch (and Kick) again after upgrading from 1.x.

## Hard rule: ads must not interrupt streams

- Twitch streams play through ad-free playlist proxies, using the bundled [streamlink-ttvlol](https://github.com/2bc4/streamlink-ttvlol) plugin (pinned and checksum-verified) with StreamHub's patch.
- If an ad gets through, StreamHub restarts Streamlink with the next proxy tried first. Each proxy is tried first once.
- **StreamHub never falls back to Twitch with ads by itself.** Playing directly from Twitch only happens if you turn on **Direct through my VPN**. If the plugin is missing, StreamHub refuses to play instead.
- **Ad-free backup stream** (optional, off by default): during an ad break, plays a lower-quality ad-free stream instead of pausing.
- The ad blocking badge shows the status in the corner of the player window. In StreamHub's own player, an ad switches to the next proxy right away.

## Features

### Twitch
- Sign in with Twitch (same Twitch app and redirect as StreamHub 1.x) to see the channels you follow that are live, with live notifications
- Browse and search: top categories and live streams, category pages and channel pages
- Ad blocking as described above (Settings → Twitch)

### Kick
- Sign in on kick.com from Settings → Kick, in a StreamHub window (StreamHub never sees your password), to see every channel you follow, plus any channels you add yourself
- Checked every minute, with live notifications
- Browse: top categories and live streams, category and channel pages (Kick has no channel search: StreamHub looks up the exact name)

### YouTube (beta)
- Sign in on Google's own page (StreamHub never sees your password)
- **Home**: your recommendations. **Subscriptions**: new videos grouped by day (Today, Yesterday, weekdays…), with live streams on top. Both keep loading as you scroll
- **Shorts**: one vertical Short at a time, looping; scroll, ↑ ↓ or the buttons for the next one (no ads, SponsorBlock too)
- Search videos and channels, and channel pages
- **History**: your watch history by day, with Remove; videos watched in StreamHub are added to it (Settings → YouTube)
- Picks up where you left off (StreamHub's saved position, or your progress on YouTube from any device)
- **Watch later** tab (+ Watch later on any video) and **Filter by channel** (any channel you're subscribed to)
- **Comments** beside the video, with replies and new comments posted as you (Settings → YouTube → Show comments)
- No ads: videos play in StreamHub's player through [yt-dlp](https://github.com/yt-dlp/yt-dlp), which StreamHub downloads and keeps up to date (checked against its release checksums)
- [SponsorBlock](https://sponsor.ajay.app) built in: segments are skipped (with Undo) or marked on the timeline, per category (Settings → YouTube); they load as the video opens and are remembered for a few hours
- English audio instead of dubs (Settings → YouTube → Audio language, or the audio menu in the player)

### Crunchyroll
- crunchyroll.com itself in a StreamHub tab: sign in on Crunchyroll's own page (StreamHub never sees your password), browse, search and watch in Crunchyroll's own player. Episodes are copy-protected, so they play only in Crunchyroll's player: no StreamHub player, downloading or ad blocking
- Several Crunchyroll tabs: + opens one, Ctrl+click or middle-click a link opens it in a new tab. Hidden tabs keep playing
- Full screen: the player's own button, or StreamHub's Full screen button (the video fills the screen; Esc leaves it)
- Optional: play episodes in a Crunchyroll window instead (Microsoft Edge without its address bar; Settings → Crunchyroll)

### Player
- Watch in your own player through Streamlink (VLC by default), or **in StreamHub** (beta, Settings → Player → Play streams in) with the same ad blocking, a quality menu and full screen
- **Small player**: going back to browsing keeps the stream playing in the corner, or turn it off and keep the sound playing or pause (Settings → Player or YouTube)
- Smoother playback (more buffering) and low latency options

### Chat
- Optional, off by default (Settings → Chat), for Twitch and Kick
- In a panel on the right of StreamHub (the sites' own popout chat: sign in there to send messages), your default browser, or Chatterino; optionally opened with the stream

### Settings and updates
- Settings are split into General, Player, Twitch, Kick, YouTube, Crunchyroll and Chat
- Theme: dark, light or the same as Windows; a language filter for browsing
- Automatic updates (Settings → General): StreamHub downloads new versions and installs them when you close or restart it, after checking the installer against the release's SHA256SUMS.txt. Each step is logged to `%TEMP%\StreamHub-update\update.log`. The portable build shows a Download banner instead
- Tray icon

Not yet in StreamHub 2: videos and clips (StreamHub 1.x has them).

Kick doesn't put ads into the streams Streamlink plays, so Kick streams don't need the proxy plugin. If Kick starts doing that, StreamHub will need its own Kick ad blocking.

## Releases

To release a new version, raise `version` in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, and write `release-notes.md` (it must mention `v<version>`). The first build of `master` with the new version publishes release **StreamHub Windows v<version>** with the installer and portable zip of that tested build.

## Test builds

Every push builds an installer and a portable build: open the latest successful run of [Build](../../actions/workflows/build.yml) and download **StreamHub-Windows-x64-portable** (unzip, run `StreamHub.exe`, keep `streamlink-plugins` next to it) or **StreamHub-Windows-x64-installer**.

## Development

Needs Node 24, Rust stable and Python 3.

```sh
npm install
npm run plugin        # builds src-tauri/resources/streamlink-plugins
npm run tauri dev
```

Tests: `cargo test` in `src-tauri/`, and `pytest plugin/tests` with `STREAMHUB_TWITCH_PLUGIN` set to the built `twitch.py`.

## Layout

| Path | What |
| --- | --- |
| `src/` | UI (TypeScript, no framework): `main.ts` (pages and settings), browse/search/channel pages `browse.ts`, the badge window `badge.ts` |
| `src-tauri/src/adblock.rs` | Streamlink log parsing, proxy rotation, badge status |
| `src-tauri/src/streamlink.rs` | Finding Streamlink and the plugin, launching, auto-switching proxies |
| `src-tauri/src/kick.rs` | Kick sign-in, followed channels and browsing (hidden kick.com page) |
| `src/player.ts` | StreamHub's player: hls.js, quality and audio menus, small player, SponsorBlock; ads switch proxies |
| `src-tauri/src/crunchyroll.rs` | The Crunchyroll tabs (crunchyroll.com in webviews inside StreamHub's window) |
| `src-tauri/src/fastplay.rs` | Finding the ad-free stream address quickly (all proxies at once), and the local `stream.localhost` proxy the player plays through |
| `src-tauri/src/updater.rs` | Automatic updates: download, checksum check, running the installer |
| `src-tauri/src/youtube.rs`, `src-tauri/src/ytdlp.rs`, `src/youtube.ts`, `src/sponsorblock.ts` | YouTube: sign-in, feed, search and channels (hidden youtube.com page), playback through yt-dlp, SponsorBlock |
| `src-tauri/src/chat.rs` | Chat panel (a second webview in the main window), browser, Chatterino |
| `src-tauri/src/auth.rs` | Twitch sign-in through `http://localhost:65432/redirect` |
| `src-tauri/src/badge.rs` | Badge window, placed on the player window |
| `plugin/` | Builds and tests the patched streamlink-ttvlol plugin |
| `ios/` | The earlier iOS app sources (the iOS app now lives in [StreamHub-iOS](https://github.com/DannyDarth/StreamHub-iOS)) |

## License

MIT, see [LICENSE](LICENSE). The bundled streamlink-ttvlol plugin is BSD-2-Clause (`plugin/LICENSE-streamlink-ttvlol.txt`).
