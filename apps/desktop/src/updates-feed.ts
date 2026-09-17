/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { compareVersions, releaseVersion, type ReleaseFeed } from '@compound/config/release';

/**
 * Reads the update feed (`latest-mac.json` on the newest stable release) and
 * answers the release it names when that is newer than `current`, else null.
 * Squirrel.Mac installs whatever a feed names without comparing versions, so
 * this decision is made here before it is ever pointed at the feed.
 */
export function newerRelease(document: unknown, current: string): ReleaseFeed | null {
  if (!document || typeof document !== 'object') throw new Error('The update feed is not a JSON document');
  const feed = document as Partial<ReleaseFeed>;
  const version = releaseVersion(feed.version);
  if (typeof feed.url !== 'string' || !feed.url.startsWith('https://')) throw new Error('The update feed names no https download');
  if (compareVersions(version, current) <= 0) return null;
  return {
    version,
    url: feed.url,
    name: typeof feed.name === 'string' ? feed.name : `v${version}`,
    notes: typeof feed.notes === 'string' ? feed.notes : '',
    pub_date: typeof feed.pub_date === 'string' ? feed.pub_date : '',
    dmg: typeof feed.dmg === 'string' ? feed.dmg : '',
    sha256: feed.sha256 && typeof feed.sha256 === 'object' ? feed.sha256 : {},
  };
}
