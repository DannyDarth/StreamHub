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
 * A plugin the user installed into Streamlink's own plugins folder is preferred, since Streamlink
 * loads it automatically and it's the one the user keeps up to date.
 * Otherwise, the plugin bundled with StreamHub's installer is used via --plugin-dirs.
 *
 * @param {Object} [env]
 * @param {string} [execPath]
 * @param {Function} [exists]
 * @returns {({pluginDir: string|null})|null} pluginDir is null if no --plugin-dirs is required
 */
export default function findTwitchAdblockPlugin(
	env = process.env,
	execPath = process.execPath,
	exists = existsSync
) {
	if ( env.APPDATA ) {
		const userPlugin = join( env.APPDATA, "streamlink", "plugins", pluginFileName );
		if ( exists( userPlugin ) ) {
			return { pluginDir: null };
		}
	}

	if ( execPath ) {
		const bundledDir = join( dirname( execPath ), pluginDirName );
		if ( exists( join( bundledDir, pluginFileName ) ) ) {
			return { pluginDir: bundledDir };
		}
	}

	return null;
}
