// Turns Streamlink log lines (without the "[plugin][level] " prefix)
// into Twitch ad-blocking events.
// The messages come from the bundled streamlink-ttvlol plugin and StreamHub's patch of it.

/** @typedef {{type: string, server?: string, playerType?: string}} AdblockEvent */

const reProxy = /^Using (?:HTTP proxy|playlist proxy) '(?:[a-z]+:\/\/)?([^'\/]+)/;
const reDirect = /^No playlist proxies available, falling back to Twitch servers/;
const reBackupChosen = /^Using ad-free backup stream \(([^)]+)\)/;
const reAdCovered = /^Playing ad-free backup stream during advertisement break/;
const reAdDetected = /^Detected advertisement break of \d+ seconds?/;


/**
 * @param {string} line
 * @returns {AdblockEvent|null}
 */
export default function parseAdblockEvent( line ) {
	let match;
	if ( ( match = reProxy.exec( line ) ) ) {
		return { type: "proxy", server: match[1] };
	}
	if ( reDirect.test( line ) ) {
		return { type: "direct" };
	}
	if ( ( match = reBackupChosen.exec( line ) ) ) {
		return { type: "backup", playerType: match[1] };
	}
	if ( reAdCovered.test( line ) ) {
		return { type: "ad-covered" };
	}
	if ( reAdDetected.test( line ) ) {
		return { type: "ad-detected" };
	}

	return null;
}
