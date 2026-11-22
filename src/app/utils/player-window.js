import { execFile } from "child_process";


export const BADGE_TITLE = "StreamHub ad blocking badge";


// Finds the first visible top-level window of Streamlink or its descendants (Streamlink starts the
// video player as a child process) and moves the badge window (found by its title) to the player
// window's top-right corner, kept inside that monitor's work area.
// Everything is done by Windows in physical pixels, so monitors with different scaling work too.
// Prints "moved", "no-player" or "no-badge".
/* eslint-disable max-len */
const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class StreamHubWin32 {
	[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
	[StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
	[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
	[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
	[DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
	[DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO info);
	[DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
	[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
	[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
}
'@
[StreamHubWin32]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$badge = [StreamHubWin32]::FindWindow($null, $env:STREAMHUB_BADGE_TITLE)
if ($badge -eq [IntPtr]::Zero) { 'no-badge'; exit }
$ids = @([int]$env:STREAMHUB_PID)
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
for ($i = 0; $i -lt 4; $i++) {
	$ids = @($ids + @($all | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId }) | Select-Object -Unique)
}
$player = [IntPtr]::Zero
foreach ($id in $ids) {
	$p = Get-Process -Id $id
	if ($p -and $p.MainWindowHandle -ne 0 -and [StreamHubWin32]::IsWindowVisible($p.MainWindowHandle)) { $player = $p.MainWindowHandle; break }
}
if ($player -eq [IntPtr]::Zero) { 'no-player'; exit }
$pr = New-Object StreamHubWin32+RECT
[StreamHubWin32]::GetWindowRect($player, [ref]$pr) | Out-Null
$info = New-Object StreamHubWin32+MONITORINFO
$info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
[StreamHubWin32]::GetMonitorInfo([StreamHubWin32]::MonitorFromWindow($player, 2), [ref]$info) | Out-Null
$work = $info.rcWork
$dpi = [StreamHubWin32]::GetDpiForWindow($player); if (-not $dpi) { $dpi = 96 }
$margin = [int](16 * $dpi / 96)
# twice: Windows may rescale the badge when it moves to a monitor with different scaling
for ($pass = 0; $pass -lt 2; $pass++) {
	$br = New-Object StreamHubWin32+RECT
	[StreamHubWin32]::GetWindowRect($badge, [ref]$br) | Out-Null
	$w = $br.R - $br.L; $h = $br.B - $br.T
	$x = [Math]::Min($pr.R, $work.R) - $w - $margin
	$y = [Math]::Max($pr.T, $work.T) + $margin
	$x = [Math]::Max($work.L, [Math]::Min($x, $work.R - $w))
	$y = [Math]::Max($work.T, [Math]::Min($y, $work.B - $h))
	# HWND_TOPMOST, SWP_NOSIZE | SWP_NOACTIVATE
	[StreamHubWin32]::SetWindowPos($badge, [IntPtr](-1), $x, $y, 0, 0, 0x0011) | Out-Null
}
'moved'
`;
/* eslint-enable max-len */


/**
 * Move the badge window onto the video player's window (Windows only).
 * @param {number} pid Streamlink's process ID
 * @param {Function} [exec] execFile
 * @param {string} [platform]
 * @returns {Promise<string>} "moved", "no-player", "no-badge", "unsupported" or "error"
 */
export default function moveBadgeToPlayer( pid, exec = execFile, platform = process.platform ) {
	if ( platform !== "win32" || !pid ) {
		return Promise.resolve( "unsupported" );
	}

	return new Promise( resolve => {
		exec(
			"powershell.exe",
			[ "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT ],
			{
				windowsHide: true,
				timeout: 6000,
				env: Object.assign( {}, process.env, {
					STREAMHUB_PID: String( pid ),
					STREAMHUB_BADGE_TITLE: BADGE_TITLE
				})
			},
			( error, stdout ) => {
				if ( error ) { return resolve( "error" ); }
				const result = String( stdout || "" ).trim().split( /\r?\n/ ).pop();
				resolve( result || "error" );
			}
		);
	});
}


/**
 * The player's window may not exist yet right after Streamlink starts the player:
 * retry a few times.
 * @param {number} pid
 * @param {Object} [options]
 * @param {number} [options.attempts]
 * @param {number} [options.delay]
 * @param {Function} [options.move]
 * @returns {Promise<boolean>} whether the badge was moved onto the player's window
 */
export async function moveBadgeToPlayerWhenReady(
	pid,
	{ attempts = 4, delay = 1500, move = moveBadgeToPlayer } = {}
) {
	for ( let attempt = 1; attempt <= attempts; attempt++ ) {
		const result = await move( pid );
		if ( result === "moved" ) {
			return true;
		}
		if ( result !== "no-player" || attempt === attempts ) {
			return false;
		}
		await new Promise( resolve => setTimeout( resolve, delay ) );
	}

	return false;
}
