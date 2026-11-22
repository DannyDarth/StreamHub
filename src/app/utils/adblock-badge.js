/**
 * A small badge in the top-right corner of the video player's window,
 * showing what Twitch ad blocking is doing (see assets/adblock-badge.html).
 * It fades out after a few seconds and reappears whenever the status changes.
 */

export const BADGE_FILE = "adblock-badge.html";
export const BADGE_WIDTH = 300;
export const BADGE_HEIGHT = 64;
export const BADGE_MARGIN = 16;
export const BADGE_DURATION = 6000;
export const BADGE_DURATION_WARNING = 12000;
const FADE_TIME = 300;


/**
 * Where to put the badge when the video player's window can't be found:
 * the top-right corner of the monitor StreamHub is on (or the first monitor).
 * @param {Object[]} screens NW.js screens: {bounds, work_area}
 * @param {{x, y}|null} point e.g. the center of StreamHub's window
 * @returns {{x: number, y: number}|null}
 */
export function placeBadge( screens, point ) {
	if ( !screens || !screens.length ) { return null; }

	const contains = ({ x, y, width, height }) =>
		   point.x >= x && point.x < x + width
		&& point.y >= y && point.y < y + height;
	const screen = point && screens.find( ({ bounds }) => contains( bounds ) ) || screens[0];
	const area = screen.work_area || screen.bounds;

	return {
		x: Math.round( area.x + area.width - BADGE_WIDTH - BADGE_MARGIN ),
		y: Math.round( area.y + BADGE_MARGIN )
	};
}


export class AdblockBadge {
	/**
	 * @param {Object} deps
	 * @param {Function} deps.openWindow (url, options, callback) => void, like nw.Window.open
	 * @param {Function} deps.getScreens () => NW.js screens
	 * @param {Function} deps.getFallbackPoint () => {x, y} center of StreamHub's window, or null
	 * @param {Function} [deps.moveToPlayer] (pid) => Promise<boolean>, moves the badge window
	 *   onto the video player's window
	 * @param {Function} [deps.setTimeout]
	 * @param {Function} [deps.clearTimeout]
	 */
	constructor({
		openWindow,
		getScreens,
		getFallbackPoint,
		moveToPlayer,
		setTimeout: st,
		clearTimeout: ct
	}) {
		this.openWindow = openWindow;
		this.moveToPlayer = moveToPlayer || null;
		this.renderId = 0;
		this.getScreens = getScreens;
		this.getFallbackPoint = getFallbackPoint || ( () => null );
		this.setTimeout = st || ( ( fn, ms ) => setTimeout( fn, ms ) );
		this.clearTimeout = ct || ( id => clearTimeout( id ) );
		this.win = null;
		this.ready = false;
		this.opening = false;
		this.status = null;
		this.timer = null;
	}

	/**
	 * @param {{level: string, label: string, detail: string, pid?: number}} status
	 */
	show( status ) {
		this.status = status;
		if ( this.ready ) {
			this._render();
		} else if ( !this.opening ) {
			this._open();
		}
	}

	hide() {
		this.status = null;
		this._clearTimer();
		if ( this.win ) {
			this.win.hide();
		}
	}

	close() {
		this.hide();
		if ( this.win ) {
			this.win.close( true );
		}
		this.win = null;
		this.ready = false;
		this.opening = false;
	}

	_open() {
		this.opening = true;
		this.openWindow( BADGE_FILE, {
			frame: false,
			transparent: true,
			always_on_top: true,
			show_in_taskbar: false,
			resizable: false,
			focus: false,
			show: false,
			width: BADGE_WIDTH,
			height: BADGE_HEIGHT
		}, win => {
			this.win = win;
			win.on( "closed", () => {
				this.win = null;
				this.ready = false;
				this.opening = false;
			});
			const onLoaded = () => {
				this.opening = false;
				this.ready = true;
				win.window.onBadgeClick = () => this.hide();
				if ( this.status ) {
					this._render();
				}
			};
			if ( win.window && win.window.document && win.window.document.readyState === "complete"
				&& typeof win.window.setStatus === "function" ) {
				onLoaded();
			} else {
				win.once( "loaded", onLoaded );
			}
		});
	}

	_render() {
		const { win, status } = this;
		if ( !win || !status ) { return; }

		const renderId = ++this.renderId;
		this._clearTimer();
		win.window.setStatus({ level: status.level, label: status.label, detail: status.detail });

		// first the monitor StreamHub is on, then (Windows) onto the video player's window
		const position = placeBadge( this.getScreens(), this.getFallbackPoint() );
		if ( position ) {
			win.moveTo( position.x, position.y );
		}
		if ( !status.pid || !this.moveToPlayer ) {
			this._reveal();
			return;
		}

		// stay hidden until moved, so the badge doesn't appear on the wrong monitor first
		Promise.resolve()
			.then( () => this.moveToPlayer( status.pid ) )
			.catch( () => false )
			.then( () => {
				if ( renderId === this.renderId && this.status === status ) {
					this._reveal();
				}
			});
	}

	_reveal() {
		const { win, status } = this;
		if ( !win || !status ) { return; }

		win.setAlwaysOnTop( true );
		win.show();

		this._clearTimer();
		const duration = status.level === "success" || status.level === "info"
			? BADGE_DURATION
			: BADGE_DURATION_WARNING;
		this.timer = this.setTimeout( () => {
			this.timer = null;
			win.window.fadeOut();
			this.timer = this.setTimeout( () => {
				this.timer = null;
				win.hide();
			}, FADE_TIME );
		}, duration );
	}

	_clearTimer() {
		if ( this.timer !== null ) {
			this.clearTimeout( this.timer );
			this.timer = null;
		}
	}
}


let instance = null;

/**
 * The app-wide badge, using NW.js (only loaded when first used)
 * @returns {AdblockBadge}
 */
export function getAdblockBadge() {
	if ( !instance ) {
		const { Window } = require( "nwjs/nwGui" );
		const { default: screen } = require( "nwjs/Screen" );
		const { moveBadgeToPlayerWhenReady } = require( "utils/player-window" );
		instance = new AdblockBadge({
			openWindow: ( url, options, callback ) => Window.open( url, options, callback ),
			getScreens: () => screen.screens || [],
			moveToPlayer: pid => moveBadgeToPlayerWhenReady( pid ),
			getFallbackPoint() {
				const main = Window.get();
				return main
					? { x: main.x + main.width / 2, y: main.y + main.height / 2 }
					: null;
			}
		});
	}

	return instance;
}
