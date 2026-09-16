import { expect, test } from 'bun:test';
import { chooseAudioCodec } from '../src/utils/audio-codec';

const options = { numberOfChannels: 2, sampleRate: 48000, bitrate: 128_000 };

test('the preferred codec when this machine encodes it, Opus when it does not, nothing when neither', async () => {
	expect(await chooseAudioCodec('aac', options, async () => true)).toBe('aac');
	expect(await chooseAudioCodec('aac', options, async (codec) => codec === 'opus')).toBe('opus');
	expect(await chooseAudioCodec('aac', options, async () => false)).toBeNull();
	expect(await chooseAudioCodec('opus', options, async () => false)).toBeNull();
});
