import { computed } from "@ember/object";
import attr from "ember-data/attr";
import Model from "ember-data/model";


export default Model.extend( /** @class GithubReleases */ {
	assets: attr(),
	assets_url: attr(),
	author: attr(),
	body: attr(),
	created_at: attr(),
	draft: attr( "boolean" ),
	html_url: attr( "string" ),
	name: attr(),
	prerelease: attr(),
	published_at: attr(),
	tag_name: attr( "string" ),
	tarball_url: attr(),
	target_commitish: attr(),
	upload_url: attr(),
	url: attr(),
	zipball_url: attr(),

	/**
	 * Desktop version of this release, e.g. "1.0.2" for "streamhub-windows-v1.0.2" or "v1.0.2".
	 * Null for releases of other apps (e.g. iOS builds), so they're never offered as updates.
	 */
	version: computed( "tag_name", function() {
		const match = /^(?:streamhub-windows-)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)$/
			.exec( this.tag_name || "" );

		return match ? match[ 1 ] : null;
	})

}).reopenClass({
	toString() { return "releases"; }
});
