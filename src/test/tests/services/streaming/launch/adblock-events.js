import { module, test } from "qunit";

import parseAdblockEvent from "services/streaming/launch/adblock-events";


module( "services/streaming/launch/adblock-events", function() {
	test( "Proxy servers", function( assert ) {
		assert.propEqual(
			parseAdblockEvent( "Using HTTP proxy 'httpproxy://firefox.api.cdn-perfprod.com:2023'" ),
			{ type: "proxy", server: "firefox.api.cdn-perfprod.com:2023" },
			"HTTP proxy"
		);
		assert.propEqual(
			parseAdblockEvent( "Using playlist proxy 'https://lb-na.cdn-perfprod.com'" ),
			{ type: "proxy", server: "lb-na.cdn-perfprod.com" },
			"Playlist proxy"
		);
	});

	test( "Direct connection", function( assert ) {
		assert.propEqual(
			parseAdblockEvent( "No playlist proxies available, falling back to Twitch servers" ),
			{ type: "direct" }
		);
	});

	test( "Ad breaks", function( assert ) {
		assert.propEqual(
			parseAdblockEvent( "Detected advertisement break of 30 seconds" ),
			{ type: "ad-detected" },
			"Ad got through"
		);
		assert.propEqual(
			parseAdblockEvent(
				"Playing ad-free backup stream during advertisement break of 1 second"
			),
			{ type: "ad-covered" },
			"Ad covered by the backup stream"
		);
		assert.propEqual(
			parseAdblockEvent(
				"Using ad-free backup stream (picture-by-picture) during ad breaks"
			),
			{ type: "backup", playerType: "picture-by-picture" },
			"Backup stream chosen"
		);
	});

	test( "Other lines", function( assert ) {
		assert.strictEqual( parseAdblockEvent( "Starting player: vlc" ), null );
		assert.strictEqual( parseAdblockEvent( "Will skip ad segments" ), null );
	});
});
