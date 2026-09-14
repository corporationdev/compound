/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MAX_AUDIO_SECONDS, TRANSCRIPTION_VERSION } from "@compound/config/transcription";

import { parseSource } from '@compound/jsx';
import {
  Ai,
  AssetId,
  Audio,
  Computed,
  FrameRate,
  framesToSeconds,
  GenAi,
  getEntityTree,
  Hidden,
  Muted,
  Paint,
  PaintType,
  Source,
} from '@compound/runtime';
import { createEncoder } from '@compound/encoder';
import { createCapture } from '@/engine/capture';
import { assetName, GENERATED_DIR, isPartialAsset } from '@compound/assets';
import { assert } from '@/utils';
import { uploadBlob } from '@/lib/uploads';
import { transcribe } from '@/lib/media-api';
import { toast } from 'somoto';
import type { AssetRef } from '@compound/jsx';
import type { Asset, AssetLibrary, PartialAsset } from '@compound/assets';
import type { ExportResult } from '@compound/encoder';
import type { Entity, World } from 'koota';

/**
 * A failure the user has already been told of — as a toast when it happened,
 * and in the library's record from then on. Asking again answers with it
 * rather than running the work a second time.
 */
class ReportedError extends Error {}

export function attachAi(world: World, library: AssetLibrary, dir?: string): EditorGenAi {
  const ai = new EditorGenAi(library, dir);
  world.set(Ai, ai);
  return ai;
}

/** Cloud assistance is limited to transcription; editing and caption assets stay local. */
export class EditorGenAi extends GenAi {
  private readonly library: AssetLibrary;
  private readonly dir?: string;
  /** Runs in flight, keyed by generation key. */
  private readonly inflight = new Map<string, Promise<Asset>>();

  constructor(library: AssetLibrary, dir?: string) {
    super();
    this.library = library;
    this.dir = dir;
  }

  /**
   * `generate.*` and `transform.*` declarations have no backend here: media
   * generation is not part of this build, so a declaration says so rather
   * than standing pending forever.
   */
  public async resolve(_ref: AssetRef): Promise<Asset> {
    throw new Error('Media generation is unavailable. Import media from your computer instead.');
  }

  /**
   * Transcribes the scene's audible mix for a `<captions>` element (see the
   * runtime's asset system). Keyed by scene id + seed: the same pair is the
   * same transcript asset across sessions, and a new seed transcribes the
   * scene again.
   */
  public transcribe(world: World, scene: Entity, seed: number): Promise<Asset> {
    const key = transcriptKey(scene, seed);
    return this.generated(
      key,
      () => ({ type: 'TRANSCRIPT' as const, name: `${this.nextCaptionsName()}.json` }),
      (partial) => this.runTranscription(world, scene, key, partial),
    );
  }

  /**
   * The library's answer for `key`, or the run that produces one. An asset
   * the key landed as is returned; a key standing in error rejects with the
   * recorded reason — answered, not run again, and not toasted again either;
   * a run in flight is joined. Otherwise the run starts against a partial
   * document reserved for it, and ends either as the asset that replaces the
   * partial or as the partial's recorded failure.
   */
  private async generated(
    key: string,
    describe: () => { type: 'TRANSCRIPT'; name: string },
    run: (partial: PartialAsset) => Promise<Asset>,
  ): Promise<Asset> {
    const known = this.library.generated(key);
    if (known && !isPartialAsset(known)) return known;
    if (known?.state === 'error') throw new ReportedError(known.error || 'Caption generation failed');

    // Transcripts taken before the version bump are the same transcript.
    const legacyKey = key.replace(`transcript:${TRANSCRIPTION_VERSION}:`, 'transcript:v1:');
    const legacy = this.library.generated(legacyKey);
    if (legacy && !isPartialAsset(legacy)) return legacy;

    const running = this.inflight.get(key);
    if (running) return await running;

    const promise = this.library
      .reserve({ key, folder: GENERATED_DIR, ...describe() })
      .then(async (reserved) => {
        try {
          return await run(reserved);
        } catch (error) {
          const failure = reportFailure(error, 'Caption generation failed');
          this.library.fail(reserved, failure.message);
          throw failure;
        }
      });

    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Encodes the scene's audio, transcribes it, and stores the transcript. */
  private async runTranscription(
    world: World,
    scene: Entity,
    key: string,
    partial: PartialAsset,
  ): Promise<Asset> {
    assert(
      sceneHasAudio(world, scene),
      'No audio found. Add an audio or video clip to the scene to generate captions.',
    );

    // The scene's own capture world: the project rendered again, reduced to
    // this scene, with nothing drawn — see `createCapture`.
    const duration = framesToSeconds(scene.get(Computed)?.duration ?? 0, world.get(FrameRate)?.value ?? 30);
    assert(duration <= MAX_AUDIO_SECONDS, 'Prepared audio exceeds 100 MiB. Choose a shorter clip.');
    const capture = await createCapture(world, scene, { mode: 'offline-audio', dir: this.dir });
    let result: ExportResult;
    try {
      const encoder = await createEncoder(capture.world, {
        format: 'wav',
        video: { enabled: false },
        audio: { enabled: true, codec: 'pcm-s16', sampleRate: 16000, numberOfChannels: 1 },
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
    const audioFile = new File([result.data], `${uploadId}.wav`, { type: 'audio/wav' });
    console.log(`[gen-ai] uploading scene audio for ${key} (${audioFile.size} bytes)`);
    const fileRef = await uploadBlob(audioFile, key);
    assert(fileRef, 'Failed to upload the scene audio for transcription');

    console.log(`[gen-ai] transcribing scene audio for ${key}`);
    const transcript = await transcribe(fileRef);
    assert(
      transcript.length > 0 && transcript.some((segment) => segment.words.length > 0),
      'No speech detected. The audio does not appear to contain recognizable speech.',
    );

    const blob = new Blob([JSON.stringify(transcript)], { type: 'application/json' });
    const asset = await this.library.store(blob, {
      name: assetName(partial),
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

  /** The next free `Captions N`, counting the takes still in flight. */
  private nextCaptionsName(): string {
    let max = 0;
    for (const entry of [...this.library.list(), ...this.library.partials()]) {
      const match = assetName(entry).match(/^Captions (\d+)\.json$/);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return `Captions ${max + 1}`;
  }
}

function reportFailure(error: unknown, title: string): ReportedError {
  if (error instanceof ReportedError) return error;

  const message = error instanceof Error ? error.message : String(error);

  console.error(`[gen-ai] ${title}:`, error);
  toast.error(title, {
    id: `gen-ai:${title}:${message}`,
    description: message,
  });

  return new ReportedError(message);
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
  return `transcript:${TRANSCRIPTION_VERSION}:${sceneId}:${seed}`;
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
