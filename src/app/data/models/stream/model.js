import { get, set, setProperties, computed, observer } from "@ember/object";
import { alias } from "@ember/object/computed";
import { inject as service } from "@ember/service";
import attr from "ember-data/attr";
import Model from "ember-data/model";
import { belongsTo } from "ember-data/relationships";
import { twitch as twitchConfig } from "config";
import findTwitchAdblockPlugin from "services/streaming/provider/twitch-adblock";
import { getAdblockBadge } from "utils/adblock-badge";
import qualities from "./-qualities";


const { "stream-url": twitchStreamUrl } = twitchConfig;

const { hasOwnProperty } = {};


const STATUS_PREPARING = 0;
const STATUS_ABORTED = 1;
const STATUS_LAUNCHING = 2;
const STATUS_WATCHING = 3;
const STATUS_COMPLETED = 4;


const qualitiesById = qualities.reduce( ( presets, preset ) => {
	presets[ preset.id ] = preset;
	return presets;
}, {} );


function computedStatus( status ) {
	return computed( "status", {
		get() {
			return get( this, "status" ) === status;
		},
		set( value ) {
			if ( value ) {
				set( this, "status", status );
				return true;
			}
		}
	});
}

function cpQualityFromPresetOrCustomValue( key ) {
	/** @this {Stream} */
	return function() {
		const { id, [ key ]: defaultValue } = this.streamQualityPreset;
		const custom = this.settings.content.streaming.qualities.toJSON();

		if ( hasOwnProperty.call( custom, id ) ) {
			const customValue = String( custom[ id ][ key ] || "" ).trim();
			if ( customValue.length ) {
				return customValue;
			}
		}

		return defaultValue;
	};
}

function settingsBool( attr ) {
	return computed( attr, function() {
		return get( this, attr ) ? "true" : "false";
	});
}


// TODO: refactor this module / export
export {
	qualities
};


export default Model.extend( /** @class Stream */ {
	/** @type {AuthService} */
	auth: service(),
	/** @type {SettingsService} */
	settings: service(),
	/** @type {StreamingService} */
	streaming: service(),
	/** @type {IntlService} */
	intl: service(),

	/** @type {TwitchStream} */
	stream: belongsTo( "twitch-stream", { async: false } ),
	/** @type {TwitchUser} */
	user: belongsTo( "twitch-user", { async: false } ),
	quality: attr( "string" ),
	low_latency: attr( "boolean" ),
	chat_open: attr( "boolean" ),
	started: attr( "date" ),


	// passthrough type (twitch streams are HLS)
	playerInputPassthrough: "hls",

	/** @property {String} status */
	status: STATUS_PREPARING,

	/** @property {ChildProcess} spawn */
	spawn: null,

	/** @property {Error} error */
	error: null,
	warning: false,

	/** @property {Object[]} log */
	log: null,
	showLog: false,

	session: alias( "auth.session" ),


	isPreparing: computedStatus( STATUS_PREPARING ),
	isAborted: computedStatus( STATUS_ABORTED ),
	isLaunching: computedStatus( STATUS_LAUNCHING ),
	isWatching: computedStatus( STATUS_WATCHING ),
	isCompleted: computedStatus( STATUS_COMPLETED ),

	hasEnded: computed( "status", "error", function() {
		const status = get( this, "status" );
		const error = get( this, "error" );

		return !!error || status === STATUS_ABORTED || status === STATUS_COMPLETED;
	}),


	customParameters: computed(function() {
		const provider  = get( this, "settings.streaming.provider" );
		const providers = get( this, "settings.streaming.providers" );

		return get( providers, `${provider}.params` ) || "";
	}).volatile(),

	webbrowser: settingsBool( "settings.streaming.webbrowser" ),
	webbrowser_headless: settingsBool( "settings.streaming.webbrowser_headless" ),

	// Twitch ad-blocking via the streamlink-ttvlol plugin's playlist proxies.
	// Empty (no parameters set) if disabled, if no proxies are configured,
	// or if the plugin isn't available, since stock Streamlink would reject the parameters.
	twitchAdblockPlugin: computed(function() {
		return findTwitchAdblockPlugin();
	}).volatile(),

	twitchProxyServers: computed(function() {
		if ( !get( this, "settings.streaming.twitch_proxy" ) ) { return []; }
		if ( !get( this, "twitchAdblockPlugin" ) ) { return []; }
		return String( get( this, "settings.streaming.twitch_proxy_playlist" ) || "" )
			.split( "," )
			.map( server => server.trim() )
			.filter( server => server.length );
	}).volatile(),

	// number of times an ad got through and the stream was relaunched via the next proxy
	twitchProxySwitches: 0,

	// the proxy list, rotated so that the next proxy is tried first after each switch
	twitchProxyPlaylist: computed(function() {
		const servers = get( this, "twitchProxyServers" );
		const offset = this.twitchProxySwitches % ( servers.length || 1 );

		return [ ...servers.slice( offset ), ...servers.slice( 0, offset ) ].join( "," );
	}).volatile(),

	/**
	 * Called when Streamlink reports an ad break: switch to the next proxy server.
	 * Each server gets the first position once per stream, so a stream can't restart forever.
	 * @returns {boolean} whether the stream should be relaunched
	 */
	switchTwitchProxy() {
		const servers = get( this, "twitchProxyServers" );
		if ( servers.length < 2 || this.twitchProxySwitches >= servers.length - 1 ) {
			return false;
		}
		this.twitchProxySwitches += 1;
		return true;
	},

	// what Twitch ad blocking is doing, shown in the stream window (see recordAdblockEvent)
	adblockServer: null,
	adblockDirect: false,
	adblockBackup: null,
	adblockReconnecting: false,
	adsCovered: 0,
	adsGotThrough: 0,

	/**
	 * @param {{type: string, server?: string, playerType?: string}} event
	 */
	recordAdblockEvent( event ) {
		switch ( event.type ) {
			case "proxy":
				setProperties( this, {
					adblockServer: event.server,
					adblockDirect: false,
					adblockReconnecting: false
				});
				break;
			case "direct":
				setProperties( this, {
					adblockServer: null,
					adblockDirect: true,
					adblockReconnecting: false
				});
				break;
			case "backup":
				set( this, "adblockBackup", event.playerType );
				break;
			case "ad-covered":
				set( this, "adsCovered", this.adsCovered + 1 );
				break;
			case "ad-detected":
				set( this, "adsGotThrough", this.adsGotThrough + 1 );
				break;
			case "reconnecting":
				set( this, "adblockReconnecting", true );
				break;
		}
	},

	adblockStatus: computed(
		"adblockServer",
		"adblockDirect",
		"adblockReconnecting",
		"adsCovered",
		"adsGotThrough",
		function() {
			const { adblockServer, adblockDirect, adsCovered, adsGotThrough } = this;
			let key, level;

			if ( this.adblockReconnecting ) {
				key = "reconnecting";
				level = "warning";
			} else if ( adblockServer ) {
				key = "proxy";
				level = adsGotThrough ? "warning" : "success";
			} else if ( adblockDirect ) {
				key = "direct";
				level = "warning";
			} else {
				key = "inactive";
				level = "danger";
			}

			return { key, level, server: adblockServer, adsCovered, adsGotThrough };
		}
	),

	// show the status as a badge in the corner of the screen, above the video player
	adblockBadgeObserver: observer( "adblockStatus", "isWatching", "hasEnded", function() {
		const badge = getAdblockBadge();
		if ( !get( this, "settings.streaming.twitch_adblock_badge" ) || get( this, "hasEnded" ) ) {
			if ( badge.status && badge.status.stream === this ) {
				badge.hide();
			}
			return;
		}
		if ( !get( this, "isWatching" ) ) { return; }

		const status = get( this, "adblockStatus" );
		const { intl } = this;
		const lastCovered = this.adsCovered > this._badgeCovered;
		const lastGotThrough = this.adsGotThrough > this._badgeGotThrough;
		this._badgeCovered = this.adsCovered;
		this._badgeGotThrough = this.adsGotThrough;

		let key = status.key;
		let level = status.level;
		if ( lastGotThrough && key !== "reconnecting" ) {
			key = "got-through";
			level = "warning";
		} else if ( lastCovered ) {
			key = "covered";
			level = "info";
		}

		badge.show({
			stream: this,
			level,
			label: intl.t( `modal.streaming.adblock.badge.${key}` ),
			detail: intl.t( "modal.streaming.adblock.badge.detail", {
				channel: get( this, "user.display_name" ) || get( this, "stream.user_login" ) || "",
				server: status.server || "",
				hasServer: status.server ? "yes" : "no"
			})
		});
	}),
	_badgeCovered: 0,
	_badgeGotThrough: 0,

	// optional: connect directly if every proxy fails
	// (only ad-free with a VPN in an ad-free country)
	twitchProxyDirect: computed(function() {
		return !!get( this, "twitchProxyPlaylist" )
			&& !!get( this, "settings.streaming.twitch_proxy_direct" );
	}).volatile(),

	// optional: ad-free lower quality backup stream during ad breaks
	// (StreamHub's bundled plugin only)
	twitchBackupStream: computed(function() {
		const plugin = get( this, "twitchAdblockPlugin" );
		return !!plugin && plugin.bundled
			&& !!get( this, "settings.streaming.twitch_backup_stream" );
	}).volatile(),

	twitchPluginDir: computed(function() {
		const plugin = get( this, "twitchAdblockPlugin" );
		if ( !plugin || !plugin.pluginDir ) { return ""; }
		const proxies = get( this, "twitchProxyPlaylist" );
		if ( !proxies && !get( this, "twitchBackupStream" ) ) { return ""; }
		return plugin.pluginDir;
	}).volatile(),

	kill() {
		if ( this.spawn ) {
			this.spawn.kill( "SIGTERM" );
		}
	},

	pushLog( type, line ) {
		get( this, "log" ).pushObject({ type, line });
	},


	qualityObserver: observer( "quality", function() {
		// the StreamingService knows that it has to spawn a new child process
		this.kill();
	}),


	// get the default quality object of the selected quality and streaming provider
	streamQualityPreset: computed( "quality", function() {
		const quality = get( this, "quality" );

		return qualitiesById[ quality ]
		    || qualitiesById[ "source" ];
	}),

	// get the --stream-sorting-excludes parameter value
	streamQualitiesExclude: computed(
		"streamQualityPreset",
		"settings.content.streaming.qualities",
		cpQualityFromPresetOrCustomValue( "exclude" )
	),

	// get the stream quality selection
	streamQuality: computed(
		"streamQualityPreset",
		"settings.content.streaming.qualities",
		cpQualityFromPresetOrCustomValue( "quality" )
	),

	streamUrl: computed(
		"stream.user_login",
		/** @this {Stream} */
		function() {
			return twitchStreamUrl.replace( "{channel}", this.stream.user_login );
		}
	)

}).reopenClass({
	toString() { return "Stream"; }
});
