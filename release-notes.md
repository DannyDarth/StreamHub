# StreamHub Windows v2.4.1

## Crunchyroll
- Opens much faster: the first Crunchyroll tab starts loading quietly in the background a few seconds after StreamHub starts.
- No more bright white screen while it loads: StreamHub's dark loading screen stays up until the page is ready.

## Updates
- StreamHub now looks for a new version every 30 minutes and when you come back to it, instead of only at start and every 6 hours.

## Install
StreamHub updates itself: click **Restart to update** in the banner, or close StreamHub. If it doesn't install, run the installer below by hand; the update log is in `%TEMP%\StreamHub-update\update.log`.
- **StreamHub_2.4.1_x64-setup.exe**: installer (installs over 2.x, settings are kept)
- **StreamHub-2.4.1-Windows-x64-portable.zip**: unzip and run StreamHub.exe (keep the streamlink-plugins folder next to it)

Needs [Streamlink](https://streamlink.github.io/install.html) 8.3 or newer for Twitch and Kick (and a video player such as VLC unless you use Play in StreamHub). The installer isn't code-signed yet: if Windows SmartScreen warns when you install it by hand, choose More info → Run anyway.
