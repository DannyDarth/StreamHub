import { module, test } from "qunit";
import sinon from "sinon";

import moveBadgeToPlayer, { BADGE_TITLE, moveBadgeToPlayerWhenReady } from "utils/player-window";


module( "utils/player-window", function() {
	test( "moveBadgeToPlayer", async function( assert ) {
		const exec = sinon.stub().callsFake( ( file, args, options, callback ) => {
			callback( null, "moved\r\n" );
		});

		assert.strictEqual( await moveBadgeToPlayer( 1234, exec, "win32" ), "moved", "Moved" );
		const [ file, , options ] = exec.firstCall.args;
		assert.strictEqual( file, "powershell.exe", "Uses PowerShell" );
		assert.strictEqual( options.env.STREAMHUB_PID, "1234", "Passes Streamlink's PID" );
		assert.strictEqual( options.env.STREAMHUB_BADGE_TITLE, BADGE_TITLE, "Passes the title" );
		assert.ok( options.windowsHide, "Without a console window" );

		assert.strictEqual(
			await moveBadgeToPlayer( 1234, exec, "linux" ),
			"unsupported",
			"Windows only"
		);
		assert.strictEqual( await moveBadgeToPlayer( null, exec, "win32" ), "unsupported" );

		const failing = ( file, args, options, callback ) => callback( new Error( "fail" ), "" );
		assert.strictEqual( await moveBadgeToPlayer( 1, failing, "win32" ), "error", "Errors" );
	});

	test( "moveBadgeToPlayerWhenReady", async function( assert ) {
		const move = sinon.stub();
		move.onFirstCall().resolves( "no-player" );
		move.onSecondCall().resolves( "moved" );
		assert.strictEqual(
			await moveBadgeToPlayerWhenReady( 1, { attempts: 3, delay: 0, move } ),
			true,
			"Retries until the player's window exists"
		);
		assert.strictEqual( move.callCount, 2 );

		const never = sinon.stub().resolves( "no-player" );
		assert.strictEqual(
			await moveBadgeToPlayerWhenReady( 1, { attempts: 3, delay: 0, move: never } ),
			false,
			"Gives up after the last attempt"
		);
		assert.strictEqual( never.callCount, 3 );

		const noBadge = sinon.stub().resolves( "no-badge" );
		assert.strictEqual(
			await moveBadgeToPlayerWhenReady( 1, { attempts: 3, delay: 0, move: noBadge } ),
			false,
			"Doesn't retry other failures"
		);
		assert.strictEqual( noBadge.callCount, 1 );
	});
});
