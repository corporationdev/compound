/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSearchParams } from "@solidjs/router";
import { createEffect, onCleanup } from "solid-js";
import { canEncodeVideo } from "mediabunny";
import { toast } from "somoto";
import { useTrait, useWorld } from "@compound/koota-solid";
import { computeOutputSize } from "@compound/encoder";
import { Computed, FrameRate, Project, Workarea, getActiveEntity } from "@compound/runtime";

import { useProject } from "@/context/project";
import { renderActive, renderScene } from "@/context/render";
import { useSocial, type RenderHooks } from "@/context/social";
import { useEngineContext } from "@/engine";
import { sceneConfigKey, type ExportConfig } from "@/engine/project-config";
import { ProjectConfig as ProjectConfigTrait } from "@/engine/traits";
import { getDefaultExportTemplate } from "@/components/sidebar-right/inspector/export-templates";
import { ElectronWritableFileHandle } from "@/lib/electron-file-writable";
import { mainBridge } from "@/lib/ipc";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { version } from "../../../package.json";

import type { Entity } from "koota";

/**
 * "Post" from the editor: render the scene to `<project>/exports/` with the
 * same machinery as Export, then hand the file to the social context, which
 * creates the post, opens the composer, and uploads. The render reports into
 * the composer instead of the export dialog, so the composer is the only
 * thing on screen while the caption gets written.
 */
export function usePostScene() {
  const engine = useEngineContext();
  const world = useWorld();
  const project = useProject();
  const social = useSocial();

  return async (scene: Entity, base?: ExportConfig) => {
    if (!scene?.isAlive()) return;
    if (!window.desktop) {
      toast("Posting from a project needs the desktop app");
      return;
    }
    if (renderActive()) {
      toast("An export is already running", { description: "Wait for it to finish, then press Post again." });
      return;
    }
    const chosen = base ?? world.get(ProjectConfigTrait)?.exportOf(scene) ?? getDefaultExportTemplate();
    // Platforms take H.264/H.265 MP4; anything else the scene's export entry
    // asks for is overridden for the post copy only.
    const codec = chosen.video?.codec === "hevc" ? "hevc" : "avc";
    const config: ExportConfig = {
      format: "mp4",
      video: { ...chosen.video, enabled: true, codec },
      audio: chosen.audio,
    };
    const computed = scene.get(Computed);
    const { width, height } = computeOutputSize(computed?.width || 1920, computed?.height || 1080, config.video?.resolution ?? 1080);
    if (!(await canEncodeVideo(codec, { width, height, bitrate: config.video?.bitrate ?? 10e6 }))) {
      toast.error("Cannot render for posting", {
        description: `This machine cannot encode ${codec.toUpperCase()} at ${width}×${height}. Lower the resolution in the export settings.`,
      });
      return;
    }
    const workarea = scene.get(Workarea);
    const frames = workarea ? workarea.end - workarea.start : (computed?.duration ?? 0);
    const durationMs = Math.round((frames / (world.get(FrameRate)?.value || 30)) * 1000);
    const key = sceneConfigKey(scene) ?? "scene";
    const name = `${key.replace(/[^\w.-]+/g, "-")}-post`;
    const dir = project.dir();
    const target = `${dir}/exports/${name}.mp4`;

    // Same project files, same export settings, same app: same bytes. The
    // hash decides whether the existing export and upload can be reused.
    const { hash, cached } = await mainBridge.call(MAIN_CHANNELS.RENDER_CACHE_LOOKUP, {
      dir,
      name,
      extra: JSON.stringify({ scene: key, config, version }),
    });

    const render = async ({ onProgress }: RenderHooks) => {
      if (cached) return { path: cached.path, durationMs: cached.durationMs, width: cached.width, height: cached.height };
      const handle = new ElectronWritableFileHandle(target);
      try {
        const result = await renderScene(engine, { scene, target: handle, config, dir, onProgress });
        if (result.type === "canceled") throw new Error("Render cancelled.");
        if (result.type === "error") throw result.error;
      } catch (error) {
        await handle.dispose().catch(() => {});
        throw error;
      }
      await mainBridge
        .call(MAIN_CHANNELS.RENDER_CACHE_STORE, { dir, name, entry: { hash, path: target, size: 0, durationMs, width, height, renderedAt: Date.now() } })
        .catch(() => {});
      return { path: target, durationMs, width, height };
    };
    await social.startPostFromRender({ projectId: project.id(), projectName: project.name(), sceneId: key, contentHash: hash, render });
  };
}

/**
 * Mounted in the editor: when the Posts tab sends a project here with
 * `?post=1`, post the active scene as soon as the world has loaded it.
 */
export function AutoPostOnOpen() {
  const [params, setParams] = useSearchParams();
  const world = useWorld();
  const project = useProject();
  const loaded = useTrait(world, Project);
  const postScene = usePostScene();
  let fired = false;
  createEffect(() => {
    if (fired || !params.post) return;
    if (loaded()?.id !== project.id()) return;
    const scene = getActiveEntity(world);
    if (!scene) return;
    fired = true;
    setParams({ post: undefined }, { replace: true });
    void postScene(scene);
  });
  onCleanup(() => {
    fired = true;
  });
  return null;
}
