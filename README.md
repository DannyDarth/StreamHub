# StreamHub

Ad-free Twitch and Kick streams on Windows, through [Streamlink](https://streamlink.github.io).

StreamHub 2 is rebuilt with [Tauri 2](https://tauri.app): a Rust core with a light web UI. StreamHub 1.x (NW.js + Ember) is kept on the [`v1` branch](https://github.com/DannyDarth/StreamHub/tree/v1). The iPhone app is [StreamHub-iOS](https://github.com/DannyDarth/StreamHub-iOS).

## Install

Download **StreamHub_…_x64-setup.exe** (installer) or **StreamHub-…-Windows-x64-portable.zip** from the [latest release](https://github.com/DannyDarth/StreamHub/releases/latest). You also need [Streamlink](https://streamlink.github.io/install.html) 8.3 or newer and a video player (VLC by default).

The installer isn't code-signed yet, so Windows SmartScreen may warn about it: choose **More info → Run anyway**.

StreamHub 2 keeps its own settings: sign in to Twitch (and Kick) again after upgrading from 1.x.

## Hard rule: ads must not interrupt streams

- Twitch streams play through ad-free playlist proxies, using the bundled [streamlink-ttvlol](https://github.com/2bc4/streamlink-ttvlol) plugin (pinned and checksum-verified) with StreamHub's patch.
- If an ad gets through, StreamHub restarts Streamlink with the next proxy tried first. Each proxy is tried first once.
- **StreamHub never falls back to Twitch with ads by itself.** Playing directly from Twitch only happens if you turn on **Direct through my VPN**. If the plugin is missing, StreamHub refuses to play instead.
- **Ad-free backup stream** (optional, off by default): during an ad break, plays a lower-quality ad-free stream instead of pausing.
- The ad blocking badge shows the status in the corner of the player window.

## Features

- Twitch sign-in (same Twitch app and redirect as StreamHub 1.x)
- Followed channels that are live, with live notifications
- Kick: sign in on kick.com from Settings → Kick (in a StreamHub window; StreamHub never sees your password) to show every channel you follow, plus any channels you add yourself; checked every minute, with live notifications; watch through Streamlink
- Watching through Streamlink, with the ad blocking above and a status bar per stream
- Chat (optional, off by default: Settings → Chat) for Twitch and Kick: in a panel on the right of StreamHub (the sites' own popout chat; sign in there to send messages), your default browser, or Chatterino; optionally opened with the stream
- Browse and search: top categories and live streams, category pages and channel pages for Twitch and Kick (Kick has no channel search: StreamHub looks up the exact name)
- Play in StreamHub (beta, Settings → Streamlink → Play streams in): streams play inside StreamHub with the same ad blocking; Back keeps the stream playing in a mini-player while you browse
- Update check: tells you when a new StreamHub version is out (Settings → Updates)
- Settings: theme (dark, light, same as Windows), smoother playback (more buffering), browse language filter, Streamlink path, player, quality, low latency, proxies, VPN mode, backup stream, badge
- Tray icon (closing the window keeps StreamHub running)

Not yet in StreamHub 2: videos and clips (StreamHub 1.x has them).

Kick doesn't put ads into the streams Streamlink plays, so Kick streams don't need the proxy plugin. If Kick starts doing that, StreamHub will need its own Kick ad blocking.

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
| `src/` | UI (TypeScript, no framework): `main.ts`, browse/search/channel pages `browse.ts`, the badge window `badge.ts` |
| `src-tauri/src/adblock.rs` | Streamlink log parsing, proxy rotation, badge status |
| `src-tauri/src/streamlink.rs` | Finding Streamlink and the plugin, launching, auto-switching proxies |
| `src-tauri/src/kick.rs` | Live status of your Kick channels |
| `src-tauri/src/in_app.rs`, `src/player.ts` | Play in StreamHub: Streamlink's output served locally to the in-app player (mpegts.js) |
| `src-tauri/src/chat.rs` | Chat panel (a second webview in the main window), browser, Chatterino |
| `src-tauri/src/auth.rs` | Twitch sign-in through `http://localhost:65432/redirect` |
| `src-tauri/src/badge.rs` | Badge window, placed on the player window |
| `plugin/` | Builds and tests the patched streamlink-ttvlol plugin |
| `ios/` | The earlier iOS app sources (the iOS app now lives in [StreamHub-iOS](https://github.com/DannyDarth/StreamHub-iOS)) |

## License

MIT, see [LICENSE](LICENSE). The bundled streamlink-ttvlol plugin is BSD-2-Clause (`plugin/LICENSE-streamlink-ttvlol.txt`).
