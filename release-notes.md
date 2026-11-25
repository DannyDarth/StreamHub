# StreamHub Windows v2.0.4

## Fixed
- **Automatic updates now install when you close StreamHub's window.** Before, closing the window only hid StreamHub in the tray, so a downloaded update waited until you chose Quit in the tray or clicked "Restart to update".
- The update installer now waits until StreamHub has fully closed, keeps running after StreamHub exits, and writes each step to `%TEMP%\StreamHub-update\update.log`.

## Install
If you have 2.0.2 or 2.0.3 installed, StreamHub downloads this update by itself: click **Restart to update** in the banner, or quit StreamHub from the tray icon.
- **StreamHub_2.0.4_x64-setup.exe**: installer (installs over 2.0.x, settings are kept)
- **StreamHub-2.0.4-Windows-x64-portable.zip**: unzip and run StreamHub.exe (keep the streamlink-plugins folder next to it)

Needs [Streamlink](https://streamlink.github.io/install.html) 8.3 or newer (and a video player such as VLC unless you use Play in StreamHub). The installer isn't code-signed yet: if Windows SmartScreen warns when you install it by hand, choose More info → Run anyway.
