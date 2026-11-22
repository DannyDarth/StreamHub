import { existsSync } from "fs";
import { dirname, join } from "path";
import { streaming as streamingConfig } from "config";


const {
	"twitch-adblock": {
		"plugin-dir": pluginDirName,
		"plugin-file": pluginFileName
	}
} = streamingConfig;


/**
 * Locate the streamlink-ttvlol Twitch plugin, which adds the --twitch-proxy-playlist parameters.
 * Stock Streamlink doesn't know these parameters and would refuse to launch, so they may only be
 * set when this returns a result.
 *
 * The plugin bundled with StreamHub's installer is preferred: it's a pinned release with
 * StreamHub's additions (the ad-free backup stream), loaded via --plugin-dirs, which overrides
 * any plugin in Streamlink's own plugins folder.
 * Otherwise, a plugin the user installed into Streamlink's plugins folder is used
 * (Streamlink loads it automatically).
 *
 * @param {Object} [env]
 * @param {string} [execPath]
 * @param {Function} [exists]
 * @returns {({pluginDir: string|null, bundled: boolean})|null}
 *   pluginDir is null if no --plugin-dirs is required;
 *   bundled means StreamHub's additions are available
 */
export default function findTwitchAdblockPlugin(
	env = process.env,
	execPath = process.execPath,
	exists = existsSync
) {
	if ( execPath ) {
		const bundledDir = join( dirname( execPath ), pluginDirName );
		if ( exists( join( bundledDir, pluginFileName ) ) ) {
			return { pluginDir: bundledDir, bundled: true };
		}
	}

	if ( env.APPDATA ) {
		const userPlugin = join( env.APPDATA, "streamlink", "plugins", pluginFileName );
		if ( exists( userPlugin ) ) {
			return { pluginDir: null, bundled: false };
		}
	}

	return null;
}
