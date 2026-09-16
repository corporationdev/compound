/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show, createMemo, createSignal, onMount, batch } from "solid-js";
import { Canvas } from "@/components/canvas";
import { RightSidebar } from "@/agent-chat";
import { Timeline, Layers } from "@/components/timeline";
import { Soundboard, Inspector } from "@/components/sidebar-right";
import { FloatingProjectHeader, SidebarLeft } from "@/components/sidebar-left";
import { useLayout, MIN_TIMELINE_HEIGHT, DEFAULT_TIMELINE_HEIGHT } from "@/context/layout";
import { useEditorApi } from "@/dapi";
import { RULER_HEIGHT } from "@/engine/timeline";
import { createEffect, onCleanup, untrack } from 'solid-js';
import { toast } from 'somoto';
import { useWorld } from '@compound/koota-solid';
import { mount } from '@compound/reconciler';
import { getDocumentEditor } from '@/engine/editor';
import { getEditHistory } from '@/engine/history';
import { setInspectEntries } from '@/engine/inspect';
import { attachLibrary, isLibraryFile } from '@/engine/library';
import { attachAi } from '@/utils/gen-ai';
import { attachProjectConfig, isProjectConfigFile } from '@/engine/project-config';
import { loadProjectBundle, rememberProjectBundle } from '@/lib/db';
import { createViewStore, VIEW_PROPS } from '@/engine/view-state';
import { isCacheFile } from '@compound/assets';
import { createEditWriter } from '@/projects/edits';
import { compileProject, refreshProject, watchProject } from '@/projects/host';
import { captureProjectCover } from '@/projects/cover';
import { attachCloudAssets } from '@/engine/cloud-assets';
import { cloudUserId } from '@/lib/organizations';
import { isInWorkspace, workspace } from '@/lib/workspace';
import { Library } from '@compound/runtime';
import { useProject } from "@/context/project";
import { useEngineContext } from "@/engine";

import type { Mount } from '@compound/reconciler';
import type { EditWriter } from '@/projects/edits';

import { PanelResizeHandle } from '@/components/ui/panel-resize-handle';
import { DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_CANVAS_WIDTH, fitSidebarWidths } from '@/lib/panel-sizing';

const MIN_CANVAS_HEIGHT = 200;

export function EditorPage() {
  const { uiVisible, timelineMinimized, timelineHeight, setTimelineHeight, leftSidebarWidth, rightSidebarWidth, setLeftSidebarWidth, setRightSidebarWidth } = useLayout();
  const { isDesktop, isFullscreen } = useEditorApi();
  const [windowSize, setWindowSize] = createSignal({ width: window.innerWidth, height: window.innerHeight });
  onMount(() => {
    const resize = () => setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    onCleanup(() => window.removeEventListener('resize', resize));
  });
  const sidebars = createMemo(() => fitSidebarWidths(windowSize().width, leftSidebarWidth(), rightSidebarWidth()));
  const sidebarMax = (other: number) => Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, windowSize().width - other - MIN_CANVAS_WIDTH - 2));
  const resizeLeft = (width: number) => { const right = sidebars().right; batch(() => { setRightSidebarWidth(right); setLeftSidebarWidth(width); }); };
  const resizeRight = (width: number) => { const left = sidebars().left; batch(() => { setLeftSidebarWidth(left); setRightSidebarWidth(width); }); };
  const project = useProject();
  const world = useWorld();
  const engine = useEngineContext();

  // Keyed on the folder, not the project: a rename moves it, and everything
  // below holds a path — the watcher, the library, the writer — so all of it
  // is torn down and re-attached where the project now is.
  createEffect(() => {
    const dir = project.dir();
    if (!dir) return;

    let mounted: Mount | undefined;
    let mountedCode: string | undefined;
    let writer: EditWriter | undefined;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let generation = 0;

    // The library first: a mounted project's `src` values name its assets.
    const library = attachLibrary(world, dir);
    // The generation service over it: what `generate.*` sources resolve through.
    attachAi(world, library, dir);
    // The project's own settings (package.json `compound`), next to the scene.
    const config = attachProjectConfig(world, dir);
    // Where the editor was looking last time: playhead, selection, camera,
    // timeline, expanded rows. Kept here rather than in the file, and put
    // back on the stage after every mount.
    const view = createViewStore(untrack(project.id), world);

    const unmount = (): void => {
      // Before the entities go: what the editor changed is still owed to the
      // file, whatever happens to the scene that showed it.
      unlisten?.();
      unlisten = undefined;
      writer?.dispose();
      writer = undefined;
      mounted?.dispose();
      mounted = undefined;
      mountedCode = undefined;
      // The entries hold the dead mount's signals; the inspector must not.
      setInspectEntries(world, []);
    };

    /** Puts `code` on the stage, unless it is what is there already. */
    const applyBundle = (code: string): void => {
      if (code === mountedCode) return;
      // The old render goes first: there is only one stage per world.
      unmount();
      mounted = mount(code, world);
      mountedCode = code;
      // The `@inspect` variables this mount declared, for the inspector.
      setInspectEntries(world, mounted.inspect);
      // The rendered scene knows which element every entity came from, so
      // from here on an edit in the editor can find its way back.
      writer = createEditWriter(dir, world);
      const editor = getDocumentEditor(world);
      // Pointing and viewing stay local; everything else is the file's.
      unlisten = editor.onEdit((edit) => {
        if (edit.kind === 'prop' && VIEW_PROPS.has(edit.name)) view.push(edit);
        else writer?.push(edit);
      });
      // The file's values are the defaults; what this editor did with them
      // since goes back on top — once the record has been read, and only if
      // this is still the mount it was meant for.
      const current = mounted;
      view.ready.then(() => {
        if (!disposed && mounted === current) view.applyToWorld();
      });
      // A mount comes from the file: edits recorded against the document it
      // replaced cannot be replayed against this one.
      getEditHistory(world).reset();
    };

    const loadProject = async (): Promise<void> => {
      const current = ++generation;
      const compiling = compileProject(dir);
      const loading = library.load();

      // First open only: the bundle the last session mounted, straight from
      // the app's database, goes on the stage while the compile chews
      // through the sources — unless the compile wins the race outright. A
      // bundle the sources have outgrown can fail against today's assets;
      // the compile that is already running replaces it either way.
      if (current === 1) {
        // Neither arm may reject: the loser would be an unhandled rejection,
        // and the compile's real failure is dealt with below.
        const cached = await Promise.race([
          Promise.all([loadProjectBundle(untrack(project.id)), loading])
            .then(([code]) => code, () => null),
          compiling.then(() => null, () => null),
        ]);
        if (disposed || current !== generation) return;
        if (cached && mountedCode === undefined) {
          try {
            applyBundle(cached);
          } catch {
            // The compile lands next, with a toast of its own if it must.
          }
        }
      }

      const [result] = await Promise.all([compiling, loading]);
      if (disposed || current !== generation) return;

      // A broken edit keeps the last good render on the canvas.
      if (!result.ok) {
        console.error('[projects] compile failed:', result.error);
        toast.error('Project failed to compile', { description: result.error });
        return;
      }

      try {
        applyBundle(result.code);
        // What an export renders a second time, and the next open's head
        // start (see `rememberProjectBundle`) — recorded only once it has
        // actually mounted, so the record never runs ahead of the canvas.
        rememberProjectBundle(untrack(project.id), result.code).catch((error) =>
          console.error('[projects] could not save the bundle', error));
      } catch (error) {
        console.error('[projects] render failed:', error);
        toast.error('Project failed to render', { description: (error as Error).message });
      }
    };

    const load = (): void => {
      loadProject().catch((error) => {
        console.error('[projects] load failed:', error);
        toast.error('Project failed to load', { description: (error as Error).message });
      });
    };

    load();
  
    // A burst arrives as the whole set of files it touched, so a checkout that
    // rewrites the library and the sources at once reloads both — reading only
    // the last path of a burst would answer for one of them and drop the rest.
    const unwatch = watchProject(dir, (paths) => {
      const changed = paths.filter((path) => !isCacheFile(path));
      if (changed.some(isLibraryFile)) library.load();

      const source = changed.filter((path) => !isLibraryFile(path));
      if (!source.length) return;
      // package.json is the config and the record (`main`, `displayName`)
      // in one, so a hand edit to it reloads both; the app's own config
      // writes never reach here (main keeps them from the watcher).
      if (source.some(isProjectConfigFile)) {
        config.load();
        project.refresh();
      }
      load();
    });

    onCleanup(() => {
      disposed = true;
      captureProjectCover(dir, engine.snapshot());
      refreshProject(dir);
      unwatch();
      unmount();
      view.dispose();
      config.dispose();
      library.dispose();
    });
  });

  // Cloud originals for a project inside the workspace, keyed on the folder
  // like the mount above. Text sync is the workspace's (see lib/workspace);
  // this attaches the library the mount effect above set up so this
  // machine's bytes go up and a teammate's come down on first use.
  createEffect(() => {
    const dir = project.dir();
    const current = workspace();
    if (!dir || !current || !cloudUserId() || !isInWorkspace(dir)) return;
    const library = untrack(() => world.get(Library));
    const detachAssets = library ? attachCloudAssets(library, { dir, organizationId: current.organizationId }) : undefined;
    onCleanup(() => detachAssets?.());
  });

  const timelineStyles = createMemo(() => {
    if (!uiVisible()) return;

    const height = timelineMinimized() ? RULER_HEIGHT : timelineHeight();

    return {
      'grid-template-rows': `minmax(0,1fr) 1px ${height}px`,
      // Both sidebars are user-resizable and their widths persist, so the
      // Editor/Chat tabs share one right column rather than animating between
      // two fixed widths: a transition here would lag behind a drag.
      'grid-template-columns': `${sidebars().left}px 1px minmax(0,1fr) 1px ${sidebars().right}px`,
    };
  });

  return (
    <div
      class="bg-sidebar h-screen w-full overflow-hidden grid relative"
      classList={{
        'grid-cols-[1fr]': !uiVisible(),
        'grid-rows-[1fr]': !uiVisible(),
      }}
      style={timelineStyles()}
    >
      <Show when={isDesktop && !isFullscreen()}>
        <div class="fixed top-0 left-0 right-0 h-10 z-20" style="-webkit-app-region: drag;" />
      </Show>
      <Show when={uiVisible()}>
        <SidebarLeft />
        <div class="bg-border-strong" />
      </Show>
      <Canvas />
      <Show when={uiVisible()}>
        <div class="bg-border-strong" />
        <RightSidebar editor={() => <Inspector />} />
      </Show>
      <Show when={uiVisible()}>
        <div class="col-span-full bg-border-strong relative">
          <Show when={!timelineMinimized()}>
            <PanelResizeHandle label="Resize timeline" axis="y" reverse value={timelineHeight()} min={MIN_TIMELINE_HEIGHT} max={Math.max(MIN_TIMELINE_HEIGHT, windowSize().height - MIN_CANVAS_HEIGHT - 1)} defaultValue={DEFAULT_TIMELINE_HEIGHT} onChange={setTimelineHeight} style={{ top: '0px' }} />
          </Show>
        </div>
      </Show>
      <Show when={uiVisible()}>
        <Layers />
        <div class="bg-border-strong" />
      </Show>
      <Show when={uiVisible()}>
        <Timeline />
      </Show>
      <Show when={uiVisible()}>
        <div class="bg-border-strong" />
        <Show when={!timelineMinimized()}>
          <Soundboard />
        </Show>
      </Show>
      <Show when={uiVisible()}>
        <PanelResizeHandle label="Resize left sidebar" axis="x" value={sidebars().left} min={MIN_SIDEBAR_WIDTH} max={sidebarMax(sidebars().right)} defaultValue={DEFAULT_SIDEBAR_WIDTH} onChange={resizeLeft} style={{ left: `${sidebars().left}px` }} />
        <PanelResizeHandle label="Resize right sidebar" axis="x" reverse value={sidebars().right} min={MIN_SIDEBAR_WIDTH} max={sidebarMax(sidebars().left)} defaultValue={DEFAULT_SIDEBAR_WIDTH} onChange={resizeRight} style={{ left: `calc(100% - ${sidebars().right}px - 1px)` }} />
      </Show>
      <Show when={!uiVisible()}>
        <FloatingProjectHeader />
      </Show>
    </div>
  );
}
