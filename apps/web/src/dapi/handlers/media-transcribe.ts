/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { transcodeForTranscription } from "@compound/runtime";
import { transcribe } from "@/lib/media-api";
import { uploadBlob } from "@/lib/uploads";
import { requireAssetType, resolveAsset } from "../lib/assets";

import type { TranscriptSegment } from "@compound/dapi";
import type { ToolHandler } from "../handler";

// Transcripts are remembered per asset for the app's lifetime: the audio
// does not change, and the transcription is the expensive part.
const transcripts = new Map<string, TranscriptSegment[]>();

export const mediaTranscribe: ToolHandler<"media_transcribe"> = async ({ path }, ctx) => {
  const asset = await resolveAsset(ctx, path);
  requireAssetType(asset, ["AUDIO", "VIDEO"], "a video or audio asset");

  let transcript = transcripts.get(asset.id);
  if (!transcript) {
    const audioFile = await transcodeForTranscription(asset);
    const fileRef = await uploadBlob(audioFile);
    if (!fileRef) throw new Error(`Failed to upload asset ${asset.id} for transcription.`);

    // Deepgram, through our Worker (see @/lib/media-api), not the upstream API.
    transcript = await transcribe(fileRef);
    if (!transcript.length || transcript.every((s) => s.words.length === 0)) {
      throw new Error("No speech detected. The audio does not appear to contain recognizable speech.");
    }

    transcripts.set(asset.id, transcript);
  }

  return { segments: transcript };
};
