import { module, test } from "qunit";
import { join } from "path";

import findTwitchAdblockPlugin from "services/streaming/provider/twitch-adblock";


module( "services/streaming/provider/twitch-adblock", function() {
	const appdata = join( "C:", "Users", "user", "AppData", "Roaming" );
	const execPath = join( "C:", "Program Files", "StreamHub", "streamlink-twitch-gui.exe" );
	const userPlugin = join( appdata, "streamlink", "plugins", "twitch.py" );
	const bundledDir = join( "C:", "Program Files", "StreamHub", "streamlink-plugins" );
	const bundledPlugin = join( bundledDir, "twitch.py" );

	const existing = files => path => files.includes( path );

	test( "Prefers the user's own plugin", function( assert ) {
		assert.propEqual(
			findTwitchAdblockPlugin(
				{ APPDATA: appdata },
				execPath,
				existing([ userPlugin, bundledPlugin ])
			),
			{ pluginDir: null },
			"No --plugin-dirs needed: Streamlink loads the user's plugin itself"
		);
	});

	test( "Falls back to the bundled plugin", function( assert ) {
		assert.propEqual(
			findTwitchAdblockPlugin( { APPDATA: appdata }, execPath, existing([ bundledPlugin ]) ),
			{ pluginDir: bundledDir },
			"Points --plugin-dirs at the bundled plugin's folder"
		);
		assert.propEqual(
			findTwitchAdblockPlugin( {}, execPath, existing([ bundledPlugin ]) ),
			{ pluginDir: bundledDir },
			"Works without an APPDATA env var"
		);
	});

	test( "No plugin available", function( assert ) {
		assert.strictEqual(
			findTwitchAdblockPlugin( { APPDATA: appdata }, execPath, existing([]) ),
			null,
			"Returns null, so no unknown parameters are passed to stock Streamlink"
		);
		assert.strictEqual(
			findTwitchAdblockPlugin( {}, "", existing([ bundledPlugin ]) ),
			null,
			"Returns null without an executable path"
		);
	});
});
