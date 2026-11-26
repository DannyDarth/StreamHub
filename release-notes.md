# StreamHub Windows v2.2.0

## New: Crunchyroll
- A **Crunchyroll** tab with crunchyroll.com itself: sign in on Crunchyroll's own page (StreamHub never sees your password), then browse, search, use your watchlist and watch in Crunchyroll's player.
- **Tabs:** + opens a new one, Ctrl+click or middle-click a show or episode opens it in a new tab, × closes one. Tabs you aren't looking at keep playing.
- **Full screen:** the player's own button, or StreamHub's **Full screen** button, which makes the video fill the screen. Esc leaves it.
- **Optional Crunchyroll window:** Settings → Crunchyroll can play episodes in their own window (Microsoft Edge without its address bar) instead.
- Episodes are copy-protected, so they play in Crunchyroll's own player: StreamHub's player, downloading and ad blocking don't apply to Crunchyroll.

## New look
- A new StreamHub icon: a split ring in the service colors around a play button. It no longer uses other companies' logos.
- The installer refreshes Windows' icon cache, so the new icon shows on the desktop shortcut and taskbar right away.

## Security
- The in-app player's local stream proxy only follows redirects to video sites, and only StreamHub itself can read what it fetches, not the web pages shown inside StreamHub.
- A weekly dependency audit (npm audit and cargo audit). The first audit found no known vulnerabilities.

## Install
If you have 2.1.0 with automatic updates on, StreamHub downloads this update by itself: click **Restart to update** in the banner, or close StreamHub. If it doesn't install, run the installer below by hand. The update log is in `%TEMP%\StreamHub-update\update.log`.
- **StreamHub_2.2.0_x64-setup.exe**: installer (installs over 2.x, settings are kept)
- **StreamHub-2.2.0-Windows-x64-portable.zip**: unzip and run StreamHub.exe (keep the streamlink-plugins folder next to it)

Needs [Streamlink](https://streamlink.github.io/install.html) 8.3 or newer for Twitch and Kick (and a video player such as VLC unless you use Play in StreamHub). The installer isn't code-signed yet: if Windows SmartScreen warns when you install it by hand, choose More info → Run anyway.
