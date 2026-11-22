import { module, test } from "qunit";
import sinon from "sinon";
import { EventEmitter } from "events";

import {
	AdblockBadge,
	BADGE_FILE,
	BADGE_WIDTH,
	BADGE_MARGIN,
	BADGE_DURATION,
	BADGE_DURATION_WARNING
} from "utils/adblock-badge";


module( "utils/adblock-badge", {
	beforeEach() {
		this.clock = sinon.useFakeTimers({ global: window });

		class FakeWin extends EventEmitter {
			constructor() {
				super();
				this.window = {
					document: { readyState: "loading" },
					setStatus: sinon.spy(),
					fadeOut: sinon.spy()
				};
				this.moveTo = sinon.spy();
				this.show = sinon.spy();
				this.hide = sinon.spy();
				this.close = sinon.spy();
				this.setAlwaysOnTop = sinon.spy();
			}
		}

		this.win = new FakeWin();
		this.openWindow = sinon.stub()
			.callsFake( ( url, options, callback ) => callback( this.win ) );
		this.badge = new AdblockBadge({
			openWindow: this.openWindow,
			getWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1040 })
		});
	},
	afterEach() {
		this.clock.restore();
	}
});


test( "Opens the badge window once and shows the status", function( assert ) {
	const status = { level: "success", label: "Ad-free", detail: "channel · via proxy" };
	this.badge.show( status );

	assert.ok( this.openWindow.calledOnce, "Opens a window" );
	const [ url, options ] = this.openWindow.firstCall.args;
	assert.strictEqual( url, BADGE_FILE, "Loads the badge page" );
	assert.propContains(
		options,
		{
			frame: false,
			transparent: true,
			always_on_top: true,
			show_in_taskbar: false,
			focus: false
		},
		"Frameless, transparent, always on top, not in the taskbar, without focus"
	);
	assert.notOk( this.win.show.called, "Waits for the page to load" );

	this.win.emit( "loaded" );
	assert.ok(
		this.win.moveTo.calledWithExactly( 1920 - BADGE_WIDTH - BADGE_MARGIN, BADGE_MARGIN ),
		"Moves to the top-right corner"
	);
	assert.ok( this.win.window.setStatus.calledWithExactly( status ), "Renders the status" );
	assert.ok( this.win.show.calledOnce, "Shows the window" );

	this.badge.show({ level: "warning", label: "Ad got through", detail: "" });
	assert.ok( this.openWindow.calledOnce, "Reuses the window" );
	assert.ok( this.win.window.setStatus.calledTwice, "Renders the new status" );
});

test( "Fades out and hides after a while", function( assert ) {
	this.badge.show({ level: "success", label: "Ad-free", detail: "" });
	this.win.emit( "loaded" );

	this.clock.tick( BADGE_DURATION - 1 );
	assert.notOk( this.win.window.fadeOut.called, "Still visible" );
	this.clock.tick( 1 );
	assert.ok( this.win.window.fadeOut.calledOnce, "Fades out" );
	this.clock.tick( 300 );
	assert.ok( this.win.hide.calledOnce, "Hides the window so it doesn't block clicks" );
});

test( "Warnings stay longer", function( assert ) {
	this.badge.show({ level: "warning", label: "Ad got through", detail: "" });
	this.win.emit( "loaded" );

	this.clock.tick( BADGE_DURATION );
	assert.notOk( this.win.window.fadeOut.called, "Still visible after the normal duration" );
	this.clock.tick( BADGE_DURATION_WARNING - BADGE_DURATION );
	assert.ok( this.win.window.fadeOut.calledOnce, "Fades out later" );
});

test( "Hide and click", function( assert ) {
	this.badge.show({ level: "success", label: "Ad-free", detail: "" });
	this.win.emit( "loaded" );

	this.win.window.onBadgeClick();
	assert.ok( this.win.hide.calledOnce, "Clicking the badge hides it" );
	assert.strictEqual( this.badge.status, null, "Clears the status" );

	this.clock.tick( BADGE_DURATION_WARNING );
	assert.ok( this.win.hide.calledOnce, "No pending timers after hiding" );
});

test( "Reopens after the window was closed", function( assert ) {
	this.badge.show({ level: "success", label: "Ad-free", detail: "" });
	this.win.emit( "loaded" );
	this.win.emit( "closed" );

	this.badge.show({ level: "success", label: "Ad-free", detail: "" });
	assert.ok( this.openWindow.calledTwice, "Opens a new window" );
});
