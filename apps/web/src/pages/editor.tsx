/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show, createMemo, createSignal, onMount, batch } from "solid-js";
import { ChatPanel } from "@/components/chat/panel";
import { Canvas } from "@/components/canvas";
import { Timeline, Layers } from "@/components/timeline";
import { Soundboard, Inspector } from "@/components/sidebar-right";
import { FloatingProjectHeader, SidebarLeft } from "@/components/sidebar-left";
import { useLayout, MIN_TIMELINE_HEIGHT, DEFAULT_TIMELINE_HEIGHT } from "@/context/layout";
import { useEditorApi } from "@/context/dapi";
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
import { isCacheFile } from '@compound/assets';
import { createEditWriter } from '@/projects/edits';
import { compileProject, watchProject } from '@/projects/host';
import { captureProjectCover } from '@/projects/cover';
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
  const [chatOpen, setChatOpen] = createSignal(false);
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
      unlisten = editor.onEdit((edit) => writer?.push(edit));
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
  
    const unwatch = watchProject(dir, (path) => {
      if (isCacheFile(path)) return;
      if (isLibraryFile(path)) {
        library.load();
      } else {
        // package.json is the config and the record (`main`, `displayName`)
        // in one, so a hand edit to it reloads both; the app's own config
        // writes never reach here (main keeps them from the watcher).
        if (isProjectConfigFile(path)) {
          config.load();
          void project.refresh();
        }
        load();
      }
    });

    onCleanup(() => {
      disposed = true;
      captureProjectCover(dir, engine.snapshot());
      unwatch();
      unmount();
      config.dispose();
      library.dispose();
    });
  });

  const timelineStyles = createMemo(() => {
    if (!uiVisible()) return;

    const height = timelineMinimized() ? RULER_HEIGHT : timelineHeight();

    return {
      'grid-template-rows': `minmax(0,1fr) 1px ${height}px`,
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
        <div class="min-h-0 min-w-0 flex flex-col" classList={{ 'row-span-3': chatOpen() }}>
          <Show when={isDesktop}>
            <div class="h-10 shrink-0 flex items-center gap-1 px-3 border-b border-border relative z-30" style="-webkit-app-region: no-drag;" role="tablist" aria-label="Right sidebar">
              <button class="px-2 py-1 text-[11px] rounded hover:bg-accent" classList={{ 'text-muted-foreground': chatOpen() }} role="tab" aria-selected={!chatOpen()} onClick={() => setChatOpen(false)}>Inspector</button>
              <button class="px-2 py-1 text-[11px] rounded hover:bg-accent" classList={{ 'text-muted-foreground': !chatOpen() }} role="tab" aria-selected={chatOpen()} onClick={() => setChatOpen(true)}>Chat</button>
            </div>
          </Show>
          <div class="flex-1 min-h-0"><Show when={chatOpen()} fallback={<Inspector />}><ChatPanel /></Show></div>
        </div>
      </Show>
      <Show when={uiVisible()}>
        <div class="bg-border-strong relative" classList={{ "col-span-full": !chatOpen(), "col-span-4": chatOpen() }}>
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
        <Show when={!timelineMinimized() && !chatOpen()}>
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
