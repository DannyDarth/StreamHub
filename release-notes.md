# StreamHub Windows v2.3.0

## New: YouTube History
- A **History** tab in YouTube (signed in): your YouTube watch history, grouped by day, loading more as you scroll.
- **Remove** (hover a video) takes it out of your YouTube watch history, the same as YouTube's own "Remove from watch history".
- Videos you watch in StreamHub now show up in your YouTube history too, as if you watched them on YouTube: StreamHub sends the same playback report YouTube's player does (no ads are involved). Turn it off in Settings → YouTube → **Add videos I watch to my YouTube history**.

## Faster SponsorBlock
- Segments load as soon as you open a video, alongside finding its stream, instead of after it starts playing.
- StreamHub uses SponsorBlock's faster lookup (the one its browser extension uses), with a short time limit before falling back, and remembers each video's segments for 6 hours.
- If SponsorBlock is down, the player says so instead of "Loading SponsorBlock…".

## Install
If you have 2.1.0 or newer with automatic updates on, StreamHub downloads this update by itself: click **Restart to update** in the banner, or close StreamHub. If it doesn't install, run the installer below by hand; the update log is in `%TEMP%\StreamHub-update\update.log`.
- **StreamHub_2.3.0_x64-setup.exe**: installer (installs over 2.x, settings are kept)
- **StreamHub-2.3.0-Windows-x64-portable.zip**: unzip and run StreamHub.exe (keep the streamlink-plugins folder next to it)

Needs [Streamlink](https://streamlink.github.io/install.html) 8.3 or newer for Twitch and Kick (and a video player such as VLC unless you use Play in StreamHub). The installer isn't code-signed yet: if Windows SmartScreen warns when you install it by hand, choose More info → Run anyway.
