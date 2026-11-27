# StreamHub Windows v2.3.1

## YouTube: pick up where you left off
- YouTube videos start where you stopped watching. StreamHub remembers where you stopped each video, and also reads how far you got on YouTube itself (on your phone, youtube.com or StreamHub iOS: the red bar on the thumbnail), using whichever is further.
- "Resumed at 12:34" shows when it happens, with **Undo** to start from the beginning.
- Not for live streams, videos under 2 minutes, or a video you'd nearly finished.

## Install
StreamHub updates itself: click **Restart to update** in the banner, or close StreamHub. If it doesn't install, run the installer below by hand; the update log is in `%TEMP%\StreamHub-update\update.log`.
- **StreamHub_2.3.1_x64-setup.exe**: installer (installs over 2.x, settings are kept)
- **StreamHub-2.3.1-Windows-x64-portable.zip**: unzip and run StreamHub.exe (keep the streamlink-plugins folder next to it)

Needs [Streamlink](https://streamlink.github.io/install.html) 8.3 or newer for Twitch and Kick (and a video player such as VLC unless you use Play in StreamHub). The installer isn't code-signed yet: if Windows SmartScreen warns when you install it by hand, choose More info → Run anyway.
