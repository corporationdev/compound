/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createEffect, createContext, useContext, onCleanup } from "solid-js";
import { useBeforeLeave, useNavigate } from "@solidjs/router";
import { useWorld } from '@compound/koota-solid';
import { Project } from '@compound/runtime';
import { useProject } from '@/context/project';
import { useAuth } from '@/context/auth';
import { useEngineContext } from '@/engine';
import { t, q, q0, m } from "@/lib/cli-rpc";
import { setEditorSession } from "./session";
import { resolveTarget, attachedSession, targetContext, withTargetRenderer, hasRendererJobs, waitForRendererJobs } from "./project-target";
import { createProjectFS } from "@/projects/fs";
import { AssetLibrary } from "@compound/assets";
import type { CliProjectTarget, CaptureRequest, CheckRequest, ExportRequest } from "@compound/cli/channels";
import { handleContextGet } from "./context";
import { createAssetResolver, handleMediaProbe, handleMediaFrame, handleMediaTranscribe, handleMediaFilmstrip, handleMediaWaveform, handleMediaListen } from "./media";
import { handleCapture } from "./capture";
import { handleCheck } from "./check";
import { handleExport } from "./export";
import { handleLogs } from "./logs";
import { handleModels } from "./models";
import { handleVoices } from "./voices";
import { cliBridge } from '@/lib/ipc';
import { createRouterCaller } from '@/lib/cli-rpc';
import { openProjectFolder, listKnownProjects } from '@/projects';
import { projectRoute } from '@/hooks/use-project-route';
import { assert } from "@/utils/common";
import { handleWindowScreenshot } from "./window";
import { useFullscreenState } from "@/hooks/use-fullscreen-state";

import type { JSX, Accessor } from 'solid-js';
import type { Navigator } from '@solidjs/router';
import type { AppUser as User } from '@/lib/auth-client';

type EditorApiProviderProps = {
  children: JSX.Element;
};

type EditorApiContextValue = {
  isFullscreen: Accessor<boolean>;
  isDesktop: boolean;
};

const EditorApiContext = createContext<EditorApiContextValue>();

/**
 * The one CLI router, registered for as long as the app runs. Every endpoint
 * is reachable whether or not a project is open; the ones that need one read
 * the session slot (see ./session) per request and fail with a clear error —
 * or, for `context`, report that nothing is open. Renders nothing; must sit
 * inside the router tree for `useNavigate` and inside the auth provider.
 */
export function EditorApi() {
  const navigate = useNavigate();
  const auth = useAuth();
  let navigation = 0;
  useBeforeLeave(event => {
    if (!hasRendererJobs()) return;
    event.preventDefault();
    const current = ++navigation;
    void waitForRendererJobs().then(() => { if (current === navigation) event.retry(); });
  });

  const requireAuth = <I, O>(fn: (data: I) => Promise<O>) => (data: I) => {
    assert(auth.isAuthenticated(), "Sign in required: AI generation needs a Compound account.");
    return fn(data);
  };

  const getUser = () => {
    const user = auth.user();
    assert(user, "User not found");
    return user;
  };

  const router = createAppRouter({ navigate, getUser, requireAuth });
  onCleanup(cliBridge.register(createRouterCaller(router)));
  return null;
}

/**
 * Publishes the editor session for the CLI router while the project is open,
 * and provides the editor UI's own view of the app shell (fullscreen state,
 * desktop-ness). Mounted per project page.
 */
export function EditorApiProvider(props: EditorApiProviderProps) {
  const project = useProject();
  const isFullscreen = useFullscreenState();
  const world = useWorld();
  const engine = useEngineContext();

  createEffect(() => {
    if (!window.desktop || project.id() !== world.get(Project)?.id) return;

    setEditorSession({ world, project, engine });
    onCleanup(() => setEditorSession(null));
  });

  return (
    <EditorApiContext.Provider
      value={{
        isFullscreen,
        isDesktop: !!window.desktop,
      }}
    >
      {props.children}
    </EditorApiContext.Provider>
  );
}


type AppRouterDeps = {
  navigate: Navigator;
  getUser: () => User;
  requireAuth: <I, O>(fn: (data: I) => Promise<O>) => (data: I) => Promise<O>;
};

function createAppRouter({ navigate, getUser, requireAuth }: AppRouterDeps) {
  const resolveAsset = (target?: CliProjectTarget) => async (path: string) => {
    if (!target?.dir && !target?.ref) return createAssetResolver(() => null)(path);
    const project = await resolveTarget(target);
    const session = await attachedSession(project);
    if (session) return createAssetResolver(() => session)(path);
    const library = new AssetLibrary(createProjectFS(project.dir));
    await library.load();
    return library.resolve(path);
  };

  return t.router({
    ping: t.procedure.query(() => {}),
    open: m(async ({ dir }: { dir: string }) => {
      const project = await openProjectFolder(dir);
      navigate(projectRoute(project.id || project.name));
      return { id: project.id, name: project.displayName, dir: project.dir };
    }),
    whoami: t.procedure.query(() => getUser()),
    projects: t.router({ list: q0(listKnownProjects) }),
    context: q0(async ({ target }) => {
      const { session, base } = await targetContext(target);
      if (!session) return { ...base, currentTime: null, fontFamilies: null, generations: null };
      return { ...await handleContextGet(() => session)(), ...base };
    }),
    capture: q((data: CaptureRequest, { target }) => withTargetRenderer(target, session => handleCapture(() => session)(data))),
    check: q((data: CheckRequest, { target }) => withTargetRenderer(target, session => handleCheck(() => session)(data))),
    export: m((data: ExportRequest, { target }) => withTargetRenderer(target, session => handleExport(() => session)(data))),
    models: q(handleModels()),
    logs: q(handleLogs()),
    screenshot: q0(handleWindowScreenshot()),
    voices: q0(handleVoices()),
    media: t.router({
      probe: q((data: Parameters<ReturnType<typeof handleMediaProbe>>[0], { target }) => handleMediaProbe(resolveAsset(target))(data)),
      frame: q((data: Parameters<ReturnType<typeof handleMediaFrame>>[0], { target }) => handleMediaFrame(resolveAsset(target))(data)),
      transcribe: q((data: Parameters<ReturnType<typeof handleMediaTranscribe>>[0], { target }) => handleMediaTranscribe(resolveAsset(target))(data)),
      filmstrip: q((data: Parameters<ReturnType<typeof handleMediaFilmstrip>>[0], { target }) => handleMediaFilmstrip(resolveAsset(target))(data)),
      waveform: q((data: Parameters<ReturnType<typeof handleMediaWaveform>>[0], { target }) => handleMediaWaveform(resolveAsset(target))(data)),
      listen: q((data: Parameters<ReturnType<typeof handleMediaListen>>[0], { target }) => requireAuth(handleMediaListen(resolveAsset(target)))(data)),
    }),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

export function useEditorApi() {
  const ctx = useContext(EditorApiContext);
  assert(ctx, "useEditorApi must be used within EditorApiProvider");
  return ctx;
}
