/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A cloud project's originals, on top of the library: every asset whose
// bytes are on this machine is sent up, and one whose source is on a
// teammate's disk is brought down when something first asks for its bytes.
// The manifest is shared across machines and is never rewritten for this —
// a missing source keeps its record and only gets another handle.
//
// The renderer only decides what moves; the main process moves it
// (see apps/desktop/src/assets-cloud.ts), with the destinations and the
// credentials obtained from the authenticated server.

import { assetName, isUrlSource } from '@compound/assets';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { createEffect, createRoot, untrack } from 'solid-js';

import { ElectronFileHandle } from '@/lib/electron-file-handle';
import { mainBridge } from '@/lib/ipc';

import type { Asset, AssetFileHandle, AssetLibrary, AssetRecord } from '@compound/assets';

export interface CloudAssetsOptions {
	/** The project folder on this machine. */
	dir: string;
	/** The cloud project (a `projects` row id). */
	projectId: string;
	/** A Convex JWT for the signed-in user, or null when signed out. */
	getToken: () => Promise<string | null>;
}

/** How many originals go up at once. */
const UPLOAD_CONCURRENCY = 2;

/**
 * Attaches cloud originals to `library`: installs the resolver for sources
 * missing here (fetched into `cache/originals/` on first use) and uploads
 * every local original as the library reports its assets, at most two at a
 * time, each once per session. Returns a disposer.
 */
export function attachCloudAssets(library: AssetLibrary, options: CloudAssetsOptions): () => void {
	const { dir, projectId, getToken } = options;
	let stopped = false;

	// Down. The handle is lazy so a load with many remote assets does not wait
	// on a download each; the fetch happens when the bytes are first wanted,
	// and a failed one is forgotten so the next ask tries again.
	const fetched = new Map<string, Promise<File>>();
	const remoteFile = (record: AssetRecord): Promise<File> => {
		let promise = fetched.get(record.id);
		if (!promise) {
			promise = (async () => {
				const token = await getToken();
				const result = await mainBridge.call(MAIN_CHANNELS.CLOUD_ASSET_FETCH, { dir, projectId, sampleId: record.id, token });
				if (!result) throw new Error(`${record.path} is not in the cloud yet`);
				return new ElectronFileHandle(result.path, result.name).getFile();
			})();
			fetched.set(record.id, promise);
			promise.catch(() => fetched.delete(record.id));
		}
		return promise;
	};
	library.setMissingResolver(async (record): Promise<AssetFileHandle | null> =>
		stopped ? null : { getFile: () => remoteFile(record) },
	);

	// Up.
	const uploaded = new Set<string>();
	const active = new Set<string>();
	const queue: Asset[] = [];
	let running = 0;

	const upload = async (asset: Asset): Promise<void> => {
		if (stopped) return;
		try {
			const token = await getToken();
			if (!token) return;
			const absolute = library.fs.absolute?.(asset.source) ?? asset.source;
			await mainBridge.call(MAIN_CHANNELS.CLOUD_ASSET_UPLOAD, {
				dir, projectId, sampleId: asset.id, source: absolute, mimeType: asset.mimeType, name: assetName(asset), token,
			});
			uploaded.add(asset.id);
		} catch (error) {
			// Left out of `uploaded`: the next change to the library tries again.
			console.warn(`[cloud-assets] could not upload ${asset.path}:`, error);
		}
	};
	const pump = (): void => {
		while (!stopped && running < UPLOAD_CONCURRENCY && queue.length) {
			const asset = queue.shift()!;
			running++;
			void upload(asset).finally(() => {
				running--;
				active.delete(asset.id);
				pump();
			});
		}
	};
	const uploadAll = (): void => {
		if (stopped) return;
		for (const asset of untrack(library.assets)) {
			if (asset.type === 'SEQUENCE' || isUrlSource(asset.source)) continue;
			if (!library.hasLocalBytes(asset.id) || uploaded.has(asset.id) || active.has(asset.id)) continue;
			active.add(asset.id);
			queue.push(asset);
		}
		pump();
	};
	const dispose = createRoot((dispose) => {
		// `assets()` is published after every load and every change, so the
		// effect runs whenever there could be something new to send.
		createEffect(() => {
			library.assets();
			uploadAll();
		});
		return dispose;
	});

	return () => {
		stopped = true;
		dispose();
		queue.length = 0;
		library.setMissingResolver(undefined);
	};
}
