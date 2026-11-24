# StreamHub Windows v2.0.1

## New
- **Play in StreamHub (beta)**: watch streams inside StreamHub instead of VLC. Turn it on in Settings → Streamlink → Play streams in. Same rule as always: ads must not interrupt streams. On Twitch, an ad switches to the next ad-free server before it plays; with none left, the ad is hidden and muted.
  - **Back** keeps the stream playing in a mini-player in the corner while you browse; click it to bring it back
  - Quality menu, chat, full screen (Esc to leave), Open in player, Stop
  - Streams start in about a second
- **Update check**: StreamHub tells you when a new version is out (notification and banner with Download). Settings → Updates to turn it off or check now.

## Improved
- StreamHub opens maximized
- Kick channels show faster at start-up: your last results show at once, the sign-in check and channel lists load together

## Install
- **StreamHub_2.0.1_x64-setup.exe**: installer (installs over 2.0.0, settings are kept)
- **StreamHub-2.0.1-Windows-x64-portable.zip**: unzip and run StreamHub.exe (keep the streamlink-plugins folder next to it)

Needs [Streamlink](https://streamlink.github.io/install.html) 8.3 or newer (and a video player such as VLC unless you use Play in StreamHub). The installer isn't code-signed yet: if Windows SmartScreen warns, choose More info → Run anyway.
