// Update check: is there a newer StreamHub Windows release on GitHub?

const RELEASES = "https://api.github.com/repos/DannyDarth/StreamHub/releases?per_page=30";
const TAG = /^streamhub-windows-v(\d+)\.(\d+)\.(\d+)$/;
export const RELEASE_PAGE = "https://github.com/DannyDarth/StreamHub/releases/";

export interface Update {
  version: string;
  url: string;
}

type Version = [number, number, number];

export function parseVersion(version: string): Version | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(candidate: Version, current: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (candidate[i] !== current[i]) return candidate[i] > current[i];
  }
  return false;
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

/** The newest Windows release if it's newer than `current`, else null. */
export async function checkForUpdate(current: string): Promise<Update | null> {
  const mine = parseVersion(current);
  if (!mine) return null;
  const res = await fetch(RELEASES, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const releases = (await res.json()) as GitHubRelease[];
  let best: { v: Version; release: GitHubRelease } | null = null;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const m = TAG.exec(release.tag_name);
    if (!m) continue;
    const v: Version = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!best || isNewer(v, best.v)) best = { v, release };
  }
  if (!best || !isNewer(best.v, mine) || !best.release.html_url.startsWith(RELEASE_PAGE)) return null;
  return { version: best.v.join("."), url: best.release.html_url };
}
