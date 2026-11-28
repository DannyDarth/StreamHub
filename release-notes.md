# StreamHub Windows v2.4.0

## YouTube comments
- A video's comments show in a panel beside the player, loading more as you scroll.
- **Reply** under a comment, or **Add a comment** at the top (Ctrl+Enter sends): posted publicly as your signed-in YouTube account, and shown straight away.
- **Hide comments** in the player bar hides them for now; Settings → YouTube → **Show comments** turns them off.

## Watch later
- A **Watch later** tab next to History: your Watch later list, with Remove on hover.
- **+ Watch later** on any video (hover) saves it.

## Filter by channel
- **Filter by channel** at the top of Home, Subscriptions, History and Watch later lists every channel you're subscribed to; picking one shows its latest videos. **Show all** goes back.

## Install
StreamHub updates itself: click **Restart to update** in the banner, or close StreamHub. If it doesn't install, run the installer below by hand; the update log is in `%TEMP%\StreamHub-update\update.log`.
- **StreamHub_2.4.0_x64-setup.exe**: installer (installs over 2.x, settings are kept)
- **StreamHub-2.4.0-Windows-x64-portable.zip**: unzip and run StreamHub.exe (keep the streamlink-plugins folder next to it)

Needs [Streamlink](https://streamlink.github.io/install.html) 8.3 or newer for Twitch and Kick (and a video player such as VLC unless you use Play in StreamHub). The installer isn't code-signed yet: if Windows SmartScreen warns when you install it by hand, choose More info → Run anyway.
