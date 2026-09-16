/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A cloud project's media, on top of the library. The manifest is shared
// across machines and never rewritten for this: an asset whose source is on
// a teammate's disk keeps its record and only gets another handle.
//
// The renderer decides nothing about when bytes move; the main process's
// transfer manager does (apps/desktop/src/assets-transfers.ts). What lives
// here: telling it which assets have bytes on this machine, making the
// proxies it asks for (a 720p MP4 of each local video, since the codecs are
// in the renderer), handing out lazy handles for assets missing here, and
// keeping its state where the UI can read it.
//
// A missing asset plays from its proxy when the cloud has one, so a project
// is usable on a second machine long before its originals are down. An
// export asks for the originals first (see `ensureOriginals`).

import { assetName, isUrlSource } from '@compound/assets';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { forgetAssetFile, forgetAudioSync, forgetAudioTrack, forgetKeyframeIndex, forgetVideoTrack, getAssetFile } from '@compound/runtime';
import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output } from 'mediabunny';
import { createEffect, createRoot, createSignal, on, untrack } from 'solid-js';

import { ElectronFileHandle } from '@/lib/electron-file-handle';
import { chooseAudioCodec } from '@/utils/audio-codec';
import { mainBridge } from '@/lib/ipc';

import type { Asset, AssetFileHandle, AssetLibrary, AssetRecord, VideoAsset } from '@compound/assets';
import type { AssetsSnapshot, AssetTransfer, LocalAssetInfo } from '@desktop/assets-transfers';

export type { AssetsSnapshot, AssetTransfer };

export interface CloudAssetsOptions {
	/** The project folder on this machine. */
	dir: string;
	/** The organization whose workspace the project sits in. */
	organizationId: string;
}

// ---------------------------------------------------------------------------
// State the UI reads

const [state, setState] = createSignal<AssetsSnapshot | null>(null);

/** The transfer manager's latest word on the open project's cloud assets; null outside a cloud project. */
export const cloudAssets = state;

/** The transfer under way (or waiting, or failed) for an asset, if any; uploads before downloads. */
export function assetTransfer(sampleId: string): AssetTransfer | undefined {
	const transfers = state()?.transfers.filter((transfer) => transfer.sampleId === sampleId && transfer.phase !== 'done') ?? [];
	return transfers.find((transfer) => transfer.kind === 'upload') ?? transfers[0];
}

/** Whether the cloud holds the original of an asset. */
export function assetInCloud(sampleId: string): boolean {
	return state()?.cloud[sampleId]?.original === 'ready';
}

/** Puts a failed transfer of the open project back in the queue. */
export function retryAssetTransfer(sampleId: string): void {
	const current = state();
	if (current) void mainBridge.call(MAIN_CHANNELS.CLOUD_ASSETS_RETRY, { dir: current.dir, sampleId });
}

// ---------------------------------------------------------------------------
// Preference: originals in the background

const EAGER_KEY = 'compound.cloud-assets.eager-originals';
const [eagerOriginals, setEager] = createSignal<boolean>(readEager());

function readEager(): boolean {
	try {
		return window.localStorage.getItem(EAGER_KEY) === 'true';
	} catch {
		return false;
	}
}

/** Whether originals missing here come down in the background once the proxies have; off by default. */
export { eagerOriginals };

export function setEagerOriginals(value: boolean): void {
	try {
		window.localStorage.setItem(EAGER_KEY, String(value));
	} catch (error) {
		console.warn('[cloud-assets] could not store the preference', error);
	}
	setEager(value);
}

// ---------------------------------------------------------------------------
// Handles for assets missing here

/**
 * The bytes of an asset another machine imported: the proxy until told to
 * use the original. The main process brings whichever is asked for into the
 * project's cache and waits on the other machine's upload if it has to.
 */
export class CloudAssetHandle implements AssetFileHandle {
	private prefer: 'proxy' | 'original' = 'proxy';

	constructor(private readonly dir: string, readonly sampleId: string) {}

	async getFile(): Promise<File> {
		const result = await mainBridge.call(MAIN_CHANNELS.CLOUD_ASSET_FETCH, { dir: this.dir, sampleId: this.sampleId, prefer: this.prefer });
		if (!result) throw new Error(`${this.sampleId} is not in the cloud yet`);
		return new ElectronFileHandle(result.path, result.name).getFile();
	}

	/**
	 * Brings the original down and hands it out from now on. Everything the
	 * runtime remembered about the proxy's bytes under this asset's id (the
	 * read, the tracks, the keyframes, audio sync) is dropped with it.
	 */
	async useOriginal(): Promise<void> {
		this.prefer = 'original';
		const result = await mainBridge.call(MAIN_CHANNELS.CLOUD_ASSET_FETCH, { dir: this.dir, sampleId: this.sampleId, prefer: 'original' });
		if (!result) throw new Error(`${this.sampleId} is not in the cloud yet`);
		forgetAssetFile(this);
		forgetVideoTrack(this.sampleId);
		forgetAudioTrack(this.sampleId);
		forgetKeyframeIndex(this.sampleId);
		forgetAudioSync(this.sampleId);
	}
}

/**
 * Brings the originals of every asset missing here down, so an export reads
 * full quality. `onProgress` is told how many are done of how many.
 */
export async function ensureOriginals(library: AssetLibrary, onProgress?: (done: number, total: number) => void): Promise<void> {
	const remote = untrack(library.assets).filter((asset) => asset.handle instanceof CloudAssetHandle);
	let done = 0;
	onProgress?.(done, remote.length);
	// Two at a time, matching the manager's download concurrency.
	const queue = [...remote];
	const worker = async () => {
		for (let asset = queue.shift(); asset; asset = queue.shift()) {
			await (asset.handle as CloudAssetHandle).useOriginal();
			onProgress?.(++done, remote.length);
		}
	};
	await Promise.all([worker(), worker()]);
}

// ---------------------------------------------------------------------------
// Proxies

/** Widest a proxy is; a smaller original is re-encoded at its own width. */
const PROXY_MAX_WIDTH = 1280;
const PROXY_VIDEO_BITRATE = 2_500_000;
const PROXY_AUDIO_BITRATE = 128_000;

/** A 720p MP4 of a video asset, written to the project's `cache/proxies/`. */
async function makeProxy(library: AssetLibrary, asset: VideoAsset): Promise<void> {
	const file = await getAssetFile(asset);
	const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
	const width = Math.min(PROXY_MAX_WIDTH, Math.floor(asset.width / 2) * 2);
	try {
		// Linux Chromium has no AAC encoder; Opus is fine in MP4 and plays everywhere the app does.
		const audioCodec = (await chooseAudioCodec('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: PROXY_AUDIO_BITRATE })) ?? 'opus';
		const conversion = await Conversion.init({
			input,
			output,
			video: { width, bitrate: PROXY_VIDEO_BITRATE, codec: 'avc' },
			audio: { codec: audioCodec, bitrate: PROXY_AUDIO_BITRATE },
		});
		if (!conversion.isValid || conversion.utilizedTracks.length === 0) throw new Error('The video has no track a proxy can be made from');
		await conversion.execute();
	} finally {
		input.dispose();
	}
	const buffer = output.target.buffer;
	if (!buffer) throw new Error('The proxy came out empty');
	await library.fs.write(`cache/proxies/${asset.id}.mp4`, new Blob([buffer], { type: 'video/mp4' }));
}

// ---------------------------------------------------------------------------
// Attaching a project

let attached: { dir: string; unbind: () => void } | undefined;

/**
 * Attaches cloud media to `library`: reports this machine's assets to the
 * transfer manager as the library changes, makes the proxies it asks for,
 * and installs the resolver for sources missing here. Returns a disposer.
 */
export function attachCloudAssets(library: AssetLibrary, options: CloudAssetsOptions): () => void {
	const { dir, organizationId } = options;
	let stopped = false;

	attached?.unbind();
	const unbind = mainBridge.handle(MAIN_CHANNELS.CLOUD_ASSETS_STATE, (snapshot) => {
		if (snapshot.dir === dir) setState(snapshot);
	});
	attached = { dir, unbind };

	library.setMissingResolver(async (record: AssetRecord): Promise<AssetFileHandle | null> =>
		stopped || record.type === 'SEQUENCE' ? null : new CloudAssetHandle(dir, record.id),
	);
	// The library loaded before this attached: what was missing then is
	// attached to an absent source and gets its cloud handle now.
	void library.resolveMissingSources().catch((error) => console.warn('[cloud-assets] could not resolve missing sources:', error));

	const localAssets = (): LocalAssetInfo[] =>
		library.assets()
			.filter((asset) => asset.type !== 'SEQUENCE' && !isUrlSource(asset.source) && library.hasLocalBytes(asset.id))
			.map((asset) => ({
				sampleId: asset.id,
				source: library.fs.absolute?.(asset.source) ?? asset.source,
				mimeType: asset.mimeType,
				name: assetName(asset),
				type: asset.type,
			}));

	// Proxies under way or given up on this session; a failure is retried on the next open.
	const making = new Set<string>();
	const failed = new Set<string>();
	let proxyQueue: Promise<void> = Promise.resolve();
	const makeWanted = (wanted: string[]) => {
		for (const sampleId of wanted) {
			if (making.has(sampleId) || failed.has(sampleId)) continue;
			const asset = untrack(library.assets).find((candidate): candidate is VideoAsset => candidate.id === sampleId && candidate.type === 'VIDEO');
			if (!asset) continue;
			making.add(sampleId);
			proxyQueue = proxyQueue.then(async () => {
				if (stopped) return;
				try {
					await makeProxy(library, asset);
					// The manager sees the file on its next look at the library.
					await mainBridge.call(MAIN_CHANNELS.CLOUD_ASSETS_UPDATE, { dir, local: untrack(localAssets), eagerOriginals: untrack(eagerOriginals) });
				} catch (error) {
					failed.add(sampleId);
					console.warn(`[cloud-assets] could not make a proxy of ${asset.path}:`, error);
				} finally {
					making.delete(sampleId);
				}
			});
		}
	};

	const dispose = createRoot((dispose) => {
		let first = true;
		createEffect(on([localAssets, eagerOriginals], ([local, eager]) => {
			if (stopped) return;
			if (first) {
				first = false;
				mainBridge.call(MAIN_CHANNELS.CLOUD_ASSETS_ATTACH, { dir, organizationId, local, eagerOriginals: eager })
					.then((snapshot) => { if (!stopped) setState(snapshot); })
					.catch((error) => console.warn('[cloud-assets] could not attach:', error));
			} else {
				mainBridge.call(MAIN_CHANNELS.CLOUD_ASSETS_UPDATE, { dir, local, eagerOriginals: eager })
					.catch((error) => console.warn('[cloud-assets] could not update:', error));
			}
		}));
		createEffect(on(() => state()?.proxyWanted ?? [], (wanted) => makeWanted(wanted)));
		return dispose;
	});

	return () => {
		stopped = true;
		dispose();
		if (attached?.dir === dir) {
			attached.unbind();
			attached = undefined;
		}
		library.setMissingResolver(undefined);
		setState(null);
		void mainBridge.call(MAIN_CHANNELS.CLOUD_ASSETS_DETACH, { dir }).catch(() => {});
	};
}

/** For the badge: an asset whose bytes are only in the cloud, as far as this machine is concerned. */
export function isRemoteAsset(library: AssetLibrary, asset: Asset): boolean {
	return asset.handle instanceof CloudAssetHandle && !library.hasLocalBytes(asset.id);
}
