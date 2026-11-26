# StreamHub Windows v2.1.0

## New: YouTube (beta)
- **Sign in to YouTube** from the YouTube tab or Settings → YouTube, on Google's own page (StreamHub never sees your password).
- **Home** shows your recommendations and **Subscriptions** shows new videos grouped by day (Today, Yesterday, weekdays…), with live streams on top. Both keep loading as you scroll.
- **Search** videos and channels, and open channel pages.
- **No ads:** videos play in StreamHub's player through yt-dlp, which StreamHub downloads and keeps up to date.
- **SponsorBlock** built in: sponsors, self-promotion and "like and subscribe" reminders are skipped (with Undo), and other segments can be shown or skipped in Settings → YouTube.
- **English audio:** videos with dubbed audio play in English (or the original language). Change it in Settings → YouTube → Audio language, or with the audio menu in the player.

## Improved
- **Settings are split into sections:** General, Player, Twitch, Kick, YouTube and Chat.
- **Small player option** (Settings → Player or YouTube): keep the small player in the corner when you go back to browsing, or turn it off and keep the sound playing or pause.

## Fixed
- **Automatic updates** now start the installer directly when you close or restart StreamHub. Before, the update was downloaded but the installer sometimes never started. Each step is written to `%TEMP%\StreamHub-update\update.log`.

## Install
If you have 2.0.2 or newer with automatic updates on, StreamHub downloads this update by itself: click **Restart to update** in the banner, or close StreamHub. If it doesn't install, run the installer below by hand.
- **StreamHub_2.1.0_x64-setup.exe**: installer (installs over 2.x, settings are kept)
- **StreamHub-2.1.0-Windows-x64-portable.zip**: unzip and run StreamHub.exe (keep the streamlink-plugins folder next to it)

Needs [Streamlink](https://streamlink.github.io/install.html) 8.3 or newer (and a video player such as VLC unless you use Play in StreamHub). The installer isn't code-signed yet: if Windows SmartScreen warns when you install it by hand, choose More info → Run anyway.
