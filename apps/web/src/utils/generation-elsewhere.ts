/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A generation another machine is running. The manifest is shared, so a
// partial record that stands `pending` for a key and is not this session's
// own run is one a teammate's app (or a session here that has since died)
// started. Running it again would pay for the same transcript twice and
// have two apps editing the same lines of the manifest at once. So this
// machine waits for the record to become the asset, or fail, and only takes
// the run over once the record has stood pending for longer than any run
// takes — the sign of a session that died with it.

import { isPartialAsset } from '@compound/assets';

import type { Asset, AssetLibrary, PartialAsset } from '@compound/assets';

/** How long a pending record stands before it is taken for abandoned. */
export const PENDING_STALE_MS = 10 * 60_000;
const POLL_MS = 500;

export type ElsewhereOutcome =
	| { kind: 'asset'; asset: Asset }
	| { kind: 'error'; error: string }
	| { kind: 'abandoned' };

/** Whether a pending record has stood long enough to count as abandoned. */
export function isAbandoned(partial: PartialAsset, now = Date.now(), staleMs = PENDING_STALE_MS): boolean {
	const started = Date.parse(partial.createdAt);
	return !Number.isFinite(started) || now - started > staleMs;
}

/**
 * Waits on a generation someone else started: answers the asset once it
 * lands, the recorded failure, or `abandoned` once the record has stood
 * pending too long (or vanished) for anyone to be on it.
 */
export async function awaitGenerationElsewhere(
	library: Pick<AssetLibrary, 'generated'>,
	key: string,
	options: { pollMs?: number; staleMs?: number; now?: () => number } = {},
): Promise<ElsewhereOutcome> {
	const poll = options.pollMs ?? POLL_MS;
	const now = options.now ?? Date.now;
	for (;;) {
		const known = library.generated(key);
		if (!known) return { kind: 'abandoned' };
		if (!isPartialAsset(known)) return { kind: 'asset', asset: known };
		if (known.state === 'error') return { kind: 'error', error: known.error || 'Caption generation failed' };
		if (isAbandoned(known, now(), options.staleMs)) return { kind: 'abandoned' };
		await new Promise((resolve) => setTimeout(resolve, poll));
	}
}
