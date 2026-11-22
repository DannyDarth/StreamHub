import { module, test } from "qunit";
import sinon from "sinon";
import { EventEmitter } from "events";

import {
	AdblockBadge,
	placeBadge,
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
			getScreens: () => [{
				bounds: { x: 0, y: 0, width: 1920, height: 1080 },
				work_area: { x: 0, y: 0, width: 1920, height: 1040 },
				scaleFactor: 1
			}]
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
	const { frame, transparent, always_on_top, show_in_taskbar, focus } = options;
	assert.propEqual(
		{ frame, transparent, always_on_top, show_in_taskbar, focus },
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
	assert.ok(
		this.win.window.setStatus.calledWithExactly( status ),
		"Renders the status"
	);
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



test( "Moves onto the video player's window before showing", async function( assert ) {
	let moved;
	const moveToPlayer = sinon.stub().returns( new Promise( resolve => { moved = resolve; } ) );
	const badge = new AdblockBadge({
		openWindow: this.openWindow,
		getScreens: () => [],
		moveToPlayer
	});

	badge.show({ level: "success", label: "Ad-free", detail: "", pid: 1234 });
	this.win.emit( "loaded" );
	await Promise.resolve();

	assert.ok( moveToPlayer.calledWithExactly( 1234 ), "Moves the badge to Streamlink's player" );
	assert.notOk( this.win.show.called, "Stays hidden while moving" );

	moved( true );
	for ( let i = 0; i < 10; i++ ) { await Promise.resolve(); }
	assert.ok( this.win.show.calledOnce, "Shows the badge once moved" );
});

test( "Shows the badge even if the player's window can't be found", async function( assert ) {
	const badge = new AdblockBadge({
		openWindow: this.openWindow,
		getScreens: () => [],
		moveToPlayer: sinon.stub().rejects( new Error( "fail" ) )
	});

	badge.show({ level: "success", label: "Ad-free", detail: "", pid: 1234 });
	this.win.emit( "loaded" );
	for ( let i = 0; i < 10; i++ ) { await Promise.resolve(); }

	assert.ok( this.win.show.calledOnce, "Shows the badge" );
});


module( "utils/adblock-badge placeBadge", function() {
	const screens = [
		{
			bounds: { x: 0, y: 0, width: 1920, height: 1080 },
			work_area: { x: 0, y: 0, width: 1920, height: 1040 }
		},
		{
			bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
			work_area: { x: 1920, y: 0, width: 2560, height: 1400 }
		}
	];

	test( "Monitor StreamHub is on", function( assert ) {
		assert.propEqual(
			placeBadge( screens, { x: 3000, y: 500 } ),
			{ x: 1920 + 2560 - BADGE_WIDTH - BADGE_MARGIN, y: BADGE_MARGIN },
			"Top-right of the second monitor"
		);
		assert.propEqual(
			placeBadge( screens, { x: 500, y: 500 } ),
			{ x: 1920 - BADGE_WIDTH - BADGE_MARGIN, y: BADGE_MARGIN },
			"Top-right of the first monitor"
		);
	});

	test( "Fallbacks", function( assert ) {
		assert.propEqual(
			placeBadge( screens, null ),
			{ x: 1920 - BADGE_WIDTH - BADGE_MARGIN, y: BADGE_MARGIN },
			"First monitor without a point"
		);
		assert.strictEqual( placeBadge( [], null ), null, "No screens" );
	});
});
