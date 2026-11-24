# StreamHub Windows v2.0.2

## New
- **Automatic updates**: from this version on, StreamHub downloads new versions in the background, checks the installer against the release's SHA256SUMS.txt, and installs it when you restart or quit StreamHub ("Restart to update" in the banner). No SmartScreen warning for these updates. Turn it off in Settings → Updates → Install updates automatically. The portable build keeps the Download banner.

## Install
This is the last version to install by hand if you're on 2.0.0 or 2.0.1:
- **StreamHub_2.0.2_x64-setup.exe**: installer (installs over 2.0.x, settings are kept)
- **StreamHub-2.0.2-Windows-x64-portable.zip**: unzip and run StreamHub.exe (keep the streamlink-plugins folder next to it)

Needs [Streamlink](https://streamlink.github.io/install.html) 8.3 or newer (and a video player such as VLC unless you use Play in StreamHub). The installer isn't code-signed yet: if Windows SmartScreen warns, choose More info → Run anyway.

Everything from 2.0.1 is included: Play in StreamHub (beta) with the mini-player and quality menu, the update check, opening maximized and faster Kick loading.
