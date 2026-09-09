/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { parseSource } from '@compound/jsx';
import {
  Ai,
  AssetId,
  Audio,
  GenAi,
  getEntityTree,
  Hidden,
  Muted,
  Paint,
  PaintType,
  Source,
} from '@compound/runtime';
import type { SourceModifierValues } from '@compound/runtime';
import { createEncoder } from '@compound/encoder';
import { createCapture } from '@/engine/capture';
import { assetName, GENERATED_DIR } from '@compound/assets';
import { assert } from '@/utils';
import { uploadBlob } from '@/lib/uploads';
import { transcribe } from '@/lib/media-api';
import { toast } from 'somoto';
import type { AssetRef } from '@compound/jsx';
import type { Asset, AssetLibrary } from '@compound/assets';
import type { ExportResult } from '@compound/encoder';
import type { Entity, World } from 'koota';

export function attachAi(world: World, library: AssetLibrary, dir?: string): EditorGenAi {
  const ai = new EditorGenAi(library, dir);
  world.set(Ai, ai);
  return ai;
}

/** Cloud assistance is limited to transcription; editing and caption assets stay local. */
export class EditorGenAi extends GenAi {
  private readonly library: AssetLibrary;
  private readonly dir?: string;
  private readonly inflight = new Map<string, Promise<Asset>>();
  constructor(library: AssetLibrary, dir?: string) {
    super();
    this.library = library;
    this.dir = dir;
  }
  public async resolve(_ref: AssetRef): Promise<Asset> {
    throw new Error('Media generation is unavailable. Import media from your computer instead.');
  }
  public async derive(asset: Asset, modifiers: SourceModifierValues): Promise<Asset> {
    if (modifiers.removeBackground || modifiers.upscale > 1 || modifiers.addAudio) {
      throw new Error(
        'Cloud media transforms are unavailable. Remove the source modifier to use the original asset.',
      );
    }
    return asset;
  }
  public async transcribe(world: World, scene: Entity, seed: number): Promise<Asset> {
    const key = transcriptKey(scene, seed);

    const cached = this.library.list().find((asset) => asset.generation?.key === key);
    if (cached) return cached;

    const running = this.inflight.get(key);
    if (running) return await running;

    const promise = this.runTranscription(world, scene, key);
    this.inflight.set(key, promise);
    try {
      return await promise;
    } catch (error) {
      throw reportFailure(error, 'Caption generation failed');
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Encodes the scene's audio, transcribes it, and stores the transcript. */
  private async runTranscription(world: World, scene: Entity, key: string): Promise<Asset> {
    assert(
      sceneHasAudio(world, scene),
      'No audio found. Add an audio or video clip to the scene to generate captions.',
    );

    // The scene's own capture world: the project rendered again, reduced to
    // this scene, with nothing drawn — see `createCapture`.
    const capture = await createCapture(world, scene, { mode: 'offline-audio', dir: this.dir });
    let result: ExportResult;
    try {
      const encoder = await createEncoder(capture.world, {
        format: 'ogg',
        video: { enabled: false },
        audio: { enabled: true, codec: 'opus', sampleRate: 24000 },
      });
      result = await encoder.render();
    } finally {
      capture.dispose();
    }
    assert(
      result.type === 'success' && result.data !== undefined,
      'Failed to encode the scene audio',
    );

    const uploadId = crypto.randomUUID();
    const audioFile = new File([result.data], `${uploadId}.ogg`, { type: 'audio/ogg' });
    console.log(`[gen-ai] uploading scene audio for ${key} (${audioFile.size} bytes)`);
    const fileRef = await uploadBlob(audioFile);
    assert(fileRef, 'Failed to upload the scene audio for transcription');

    console.log(`[gen-ai] transcribing scene audio for ${key}`);
    const transcript = await transcribe(fileRef);
    assert(
      transcript.length > 0 && transcript.some((segment) => segment.words.length > 0),
      'No speech detected. The audio does not appear to contain recognizable speech.',
    );

    const blob = new Blob([JSON.stringify(transcript)], { type: 'application/json' });
    const asset = await this.library.store(blob, {
      name: `${this.nextCaptionsName()}.json`,
      folder: GENERATED_DIR,
      generation: { key },
    });

    // A re-take of unchanged speech comes back byte-identical, and the library
    // dedups by content: `store` then hands back the earlier take still keyed
    // by its old seed. Re-key it, or the authored seed misses the cache and
    // transcribes again on every load.
    if (asset.generation?.key !== key) {
      this.library.update(asset, { generation: { key } });
    }

    return asset;
  }

  private nextCaptionsName(): string {
    let max = 0;
    for (const asset of this.library.list()) {
      const match = assetName(asset).match(/^Captions (\d+)\.json$/);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return `Captions ${max + 1}`;
  }
}

function reportFailure(error: unknown, title: string): Error {
  const failure = error instanceof Error ? error : new Error(String(error));

  console.error(`[gen-ai] ${title}:`, failure);
  toast.error(title, {
    id: `gen-ai:${title}:${failure.message}`,
    description: failure.message,
  });

  return failure;
}

/**
 * The transcript cache key: scene id + seed. The scene's durable name is the
 * id in its source stamp (`<file>:<id>`, stamped once by the compiler — the
 * same identity the project config keys by); a scene without one falls back
 * to its entity id, which only holds within the session.
 */
function transcriptKey(scene: Entity, seed: number): string {
  const source = scene.get(Source)?.value;
  const locator = source ? parseSource(source)?.locator : undefined;
  const sceneId = typeof locator === 'string' ? locator : (source ?? String(scene.id()));
  return `transcript:v1:${sceneId}:${seed}`;
}

/**
 * Whether anything in the scene contributes to its audible mix: an unmuted,
 * unhidden audio clip, video, or video paint with its asset bound.
 */
function sceneHasAudio(world: World, scene: Entity): boolean {
  for (const entity of getEntityTree(world, scene)) {
    if (entity.has(Hidden) || entity.has(Muted) || !entity.has(AssetId)) continue;
    if (entity.has(Audio) || entity.get(Paint)?.value === PaintType.VIDEO) return true;
  }
  return false;
}
