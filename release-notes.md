# StreamHub Windows v2.0.3

## Improved
- **Kick followed channels load almost instantly**: the list shows page by page as it arrives (live channels first) instead of after every page has loaded, and most live channels no longer need a second request for their picture
- A Kick channel that just went offline no longer lingers as live

## Install
If you have 2.0.2 installed, StreamHub downloads this update by itself and installs it when you restart or quit it ("Restart to update").
- **StreamHub_2.0.3_x64-setup.exe**: installer (installs over 2.0.x, settings are kept)
- **StreamHub-2.0.3-Windows-x64-portable.zip**: unzip and run StreamHub.exe (keep the streamlink-plugins folder next to it)

Needs [Streamlink](https://streamlink.github.io/install.html) 8.3 or newer (and a video player such as VLC unless you use Play in StreamHub). The installer isn't code-signed yet: if Windows SmartScreen warns when you install it by hand, choose More info → Run anyway.
