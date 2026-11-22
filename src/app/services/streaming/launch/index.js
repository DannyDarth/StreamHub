import { get, set, setProperties } from "@ember/object";
import { ExitCodeError, ExitSignalError, Warning } from "../errors";
import isAborted from "../is-aborted";
import spawn from "../spawn";
import { parameters } from "../provider/parameters";
import parseError from "./parse-error";
import parseAdblockEvent from "./adblock-events";
import StreamOutputBuffer from "utils/StreamOutputBuffer";
import Parameter from "utils/parameters/Parameter";


const { getParameters } = Parameter;

const reReplace = /^\[[^\]]+]\[[^\]]+]\s+/;
const rePlayerStarted = /^Starting player: \S+/;
// logged by Streamlink's Twitch plugin when Twitch stitches ads into the stream
const reAdBreak = /^Detected advertisement break of \d+ seconds?/;
const msgProxySwitch = "Ad detected, reconnecting through the next proxy server";


/**
 * @param {Stream} stream
 * @param {ExecObj} provider
 * @param {ExecObj} player
 * @param {Function} onSuccess
 * @returns {Promise}
 */
export default async function( stream, provider, player, onSuccess ) {
	isAborted( stream );

	let child;
	let switchingProxy = false;

	try {
		// the "watching" promise
		// resolve once the user finishes watching and reject on any kind of error
		await new Promise( ( resolve, reject ) => {
			function launch() {
				// reset stream record
				setProperties( stream, {
					isLaunching: true,
					error: null,
					warning: false,
					log: []
				});

				const spawnQuality = get( stream, "quality" );
				const context = { stream, player };
				const params = getParameters( context, parameters );

				// spawn the process
				child = spawn( provider, params, { detached: true } );

				child.once( "error", reject );
				child.once( "exit", ( ...args ) => onExit( spawnQuality, ...args ) );

				child.stdout.on( "data", new StreamOutputBuffer( onStdOut ) );
				child.stderr.on( "data", new StreamOutputBuffer( onStdErr ) );

				stream.spawn = child;
			}

			function onExit( spawnQuality, code, signal ) {
				// clear up some memory
				stream.spawn = child = null;

				// an ad got through the proxy: relaunch through the next proxy server
				if ( switchingProxy ) {
					switchingProxy = false;
					return launch();
				}

				// quality has been changed
				const currentQuality = get( stream, "quality" );
				if ( spawnQuality !== currentQuality ) {
					// launch again with new parameters
					return launch();
				}

				if ( code === 0 || code === 130 || signal === "SIGTERM" || signal === "SIGINT" ) {
					set( stream, "isCompleted", true );
					resolve();
				} else if ( signal ) {
					reject( new ExitSignalError( `Process exited with signal ${signal}` ) );
				} else {
					reject( new ExitCodeError( `Process exited with code ${code}` ) );
				}
			}

			function warnOrReject( line, error ) {
				stream.pushLog( "stdErr", line );

				if ( error instanceof Warning ) {
					set( stream, "warning", true );
				} else {
					reject( error || new Error( line ) );
				}
			}

			// reject promise on any error output
			function onStdErr( line ) {
				line = line.replace( reReplace, "" );

				const error = parseError( line );
				warnOrReject( line, error );
			}

			// fulfill promise as soon as the player has been launched
			function onStdOut( line ) {
				line = line.replace( reReplace, "" );

				const error = parseError( line );
				if ( error ) {
					return warnOrReject( line, error );
				}

				stream.pushLog( "stdOut", line );

				// show what Twitch ad blocking is doing in the stream window
				const adblockEvent = parseAdblockEvent( line );
				if ( adblockEvent && typeof stream.recordAdblockEvent === "function" ) {
					stream.recordAdblockEvent( adblockEvent );
				}

				// ads must not interrupt the stream: try the next playlist proxy instead
				if (
					   !switchingProxy
					&& reAdBreak.test( line )
					&& typeof stream.switchTwitchProxy === "function"
					&& stream.switchTwitchProxy()
				) {
					switchingProxy = true;
					stream.pushLog( "stdOut", msgProxySwitch );
					if ( typeof stream.recordAdblockEvent === "function" ) {
						stream.recordAdblockEvent({ type: "reconnecting" });
					}
					child.kill();
					return;
				}

				// succeed once player has been launched
				if ( rePlayerStarted.test( line ) ) {
					onSuccess();
				}
			}

			// spawn a new child process of the streaming provider and attach event listeners
			launch();
		});

	} finally {
		stream.spawn = null;

		// make sure to always kill the child process
		try {
			if ( child && !child.killed ) {
				child.kill();
			}
		} catch ( e ) {}
		child = null;
	}
}
