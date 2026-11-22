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

	test( "Prefers the bundled plugin", function( assert ) {
		assert.propEqual(
			findTwitchAdblockPlugin(
				{ APPDATA: appdata },
				execPath,
				existing([ userPlugin, bundledPlugin ])
			),
			{ pluginDir: bundledDir, bundled: true },
			"Points --plugin-dirs at the bundled plugin, which overrides the user's copy"
		);
		assert.propEqual(
			findTwitchAdblockPlugin( {}, execPath, existing([ bundledPlugin ]) ),
			{ pluginDir: bundledDir, bundled: true },
			"Works without an APPDATA env var"
		);
	});

	test( "Falls back to the user's own plugin", function( assert ) {
		assert.propEqual(
			findTwitchAdblockPlugin( { APPDATA: appdata }, execPath, existing([ userPlugin ]) ),
			{ pluginDir: null, bundled: false },
			"No --plugin-dirs needed: Streamlink loads the user's plugin itself"
		);
	});

	test( "No plugin available", function( assert ) {
		assert.strictEqual(
			findTwitchAdblockPlugin( { APPDATA: appdata }, execPath, existing([]) ),
			null,
			"Returns null, so no unknown parameters are passed to stock Streamlink"
		);
		assert.strictEqual(
			findTwitchAdblockPlugin( {}, "", existing([ userPlugin ]) ),
			null,
			"Returns null without an executable path or APPDATA"
		);
	});
});
