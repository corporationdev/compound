/**
 * Where installers and the update feed live: the releases of a public GitHub
 * repository, separate from the private source so the app and the landing
 * page can fetch them without credentials. Every release carries the DMG for
 * people, the zip for Squirrel.Mac, checksums, and the feed document.
 */
const repository = { owner: 'corporationdev', name: 'compound-releases' } as const;
const url = `https://github.com/${repository.owner}/${repository.name}`;
export const release = {
  repository,
  url,
  dmg: 'Compound-mac-universal.dmg',
  zip: 'Compound-mac-universal.zip',
  checksums: 'checksums.txt',
  /** The Squirrel.Mac feed attached to each release; `latest/download` serves the newest stable one. */
  feed: 'latest-mac.json',
  /** A release's asset by version; GitHub redirects to its CDN. */
  asset: (version: string, name: string) => `${url}/releases/download/v${version}/${name}`,
  /** The newest stable (non-prerelease) release's asset. */
  latest: (name: string) => `${url}/releases/latest/download/${name}`,
  downloadUrl: `${url}/releases/latest/download/Compound-mac-universal.dmg`,
  feedUrl: `${url}/releases/latest/download/latest-mac.json`,
} as const;

/** What `latest-mac.json` holds: Squirrel.Mac's fields plus what people and scripts want to know. */
export type ReleaseFeed = {
  version: string;
  /** Squirrel.Mac reads `url` (the zip), `name`, `notes`, and `pub_date`. */
  url: string;
  name: string;
  notes: string;
  pub_date: string;
  dmg: string;
  sha256: { [file: string]: string };
};

export function releaseVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    throw new Error('A release requires a stable x.y.z version');
  return value;
}

/** Orders two stable x.y.z versions: negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const left = releaseVersion(a).split('.').map(Number);
  const right = releaseVersion(b).split('.').map(Number);
  return left[0]! - right[0]! || left[1]! - right[1]! || left[2]! - right[2]!;
}
