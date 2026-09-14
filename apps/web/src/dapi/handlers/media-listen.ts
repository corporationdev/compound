/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { transcodeForAnalysis } from "@compound/runtime";
import { analyze } from "@/lib/media-api";
import { collectEncodedMedia, uploadBlob } from "@/lib/uploads";
import { requireAssetType, resolveAsset } from "../lib/assets";

import type { ToolHandler } from "../handler";

export const mediaListen: ToolHandler<"media_listen"> = async ({ path, prompt, start, end }, ctx) => {
  ctx.app.requireUser();
  const asset = await resolveAsset(ctx, path);
  requireAssetType(asset, ["AUDIO", "VIDEO"], "a video or audio asset");

  // A video is stripped to its audio track: the model listens, it does not watch.
  const stripVideo = asset.type === "VIDEO";
  const contentType = "audio/ogg";

  const transcoder = await transcodeForAnalysis(asset, { start, end, stripVideo });
  const blob = await collectEncodedMedia(transcoder.readable, transcoder.run, contentType);
  const fileRef = await uploadBlob(blob);
  const result = await analyze(fileRef, prompt);

  return { result, start, end };
};
