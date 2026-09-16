import { describe, expect, test } from 'bun:test';
import { awaitGenerationElsewhere, isAbandoned } from '../src/utils/generation-elsewhere';
import type { Asset, PartialAsset } from '@compound/assets';

const key = 'transcript:aligned-v2:scene:0';
const pending = (createdAt: string): PartialAsset => ({ id: 'p', path: 'generated/Captions 1.json', type: 'TRANSCRIPT', createdAt, generation: { key }, state: 'pending' });
const landed = { id: 'a', path: 'generated/Captions 1.json', source: 'assets/generated/Captions 1.json', type: 'TRANSCRIPT', mimeType: 'application/json', createdAt: '', generation: { key }, handle: { getFile: async () => new File([], 'x') } } as unknown as Asset;

describe('a generation another machine started', () => {
	test('is waited on until it lands as the asset', async () => {
		let entry: PartialAsset | Asset = pending(new Date().toISOString());
		const library = { generated: () => entry };
		const waiting = awaitGenerationElsewhere(library, key, { pollMs: 5 });
		setTimeout(() => { entry = landed; }, 20);
		expect(await waiting).toEqual({ kind: 'asset', asset: landed });
	});

	test('answers its recorded failure', async () => {
		const library = { generated: () => ({ ...pending(new Date().toISOString()), state: 'error' as const, error: 'No audio' }) };
		expect(await awaitGenerationElsewhere(library, key, { pollMs: 5 })).toEqual({ kind: 'error', error: 'No audio' });
	});

	test('is taken over once it has stood pending for longer than any run takes, or once its record is gone', async () => {
		const stale = pending(new Date(Date.now() - 11 * 60_000).toISOString());
		expect(isAbandoned(stale)).toBe(true);
		expect(isAbandoned(pending(new Date().toISOString()))).toBe(false);
		expect(await awaitGenerationElsewhere({ generated: () => stale }, key, { pollMs: 5 })).toEqual({ kind: 'abandoned' });
		expect(await awaitGenerationElsewhere({ generated: () => undefined }, key, { pollMs: 5 })).toEqual({ kind: 'abandoned' });
	});
});
