/**
 * A small badge in the top-right corner of the main screen, above the video player,
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


export class AdblockBadge {
	/**
	 * @param {Object} deps
	 * @param {Function} deps.openWindow (url, options, callback) => void, like nw.Window.open
	 * @param {Function} deps.getWorkArea () => {x, y, width, height} of the main screen
	 * @param {Function} [deps.setTimeout]
	 * @param {Function} [deps.clearTimeout]
	 */
	constructor({ openWindow, getWorkArea, setTimeout: st, clearTimeout: ct }) {
		this.openWindow = openWindow;
		this.getWorkArea = getWorkArea;
		this.setTimeout = st || ( ( fn, ms ) => setTimeout( fn, ms ) );
		this.clearTimeout = ct || ( id => clearTimeout( id ) );
		this.win = null;
		this.ready = false;
		this.opening = false;
		this.status = null;
		this.timer = null;
	}

	/**
	 * @param {{level: string, label: string, detail: string}} status
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

		const area = this.getWorkArea();
		if ( area ) {
			win.moveTo(
				Math.round( area.x + area.width - BADGE_WIDTH - BADGE_MARGIN ),
				Math.round( area.y + BADGE_MARGIN )
			);
		}
		win.window.setStatus( status );
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
		instance = new AdblockBadge({
			openWindow: ( url, options, callback ) => Window.open( url, options, callback ),
			getWorkArea() {
				const main = screen.screens && screen.screens[0];
				return main ? main.work_area : null;
			}
		});
	}

	return instance;
}
