/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Which audio codec an encode can actually use here. Chromium ships an AAC
// encoder on macOS and Windows and none on Linux, so an export or a proxy
// asked for AAC fails at encoder setup there. Opus is encodable everywhere
// Chromium runs and is allowed in MP4 and WebM, so it stands in.

import { canEncodeAudio } from 'mediabunny';

import type { AudioCodec } from 'mediabunny';

export type AudioEncodeOptions = { numberOfChannels: number; sampleRate: number; bitrate: number };

/** What this machine can encode `preferred` as: itself, Opus when it cannot, or null when neither. */
export async function chooseAudioCodec(
	preferred: AudioCodec,
	options: AudioEncodeOptions,
	canEncode: (codec: AudioCodec, options: AudioEncodeOptions) => Promise<boolean> = canEncodeAudio,
): Promise<AudioCodec | null> {
	if (await canEncode(preferred, options)) return preferred;
	if (preferred !== 'opus' && (await canEncode('opus', options))) return 'opus';
	return null;
}
