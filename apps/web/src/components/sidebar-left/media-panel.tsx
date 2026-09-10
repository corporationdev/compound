import { createSignal } from 'solid-js';
import { Assets } from './assets';
import { Catalog } from './catalog';

export function MediaPanel() {
  const [view, setView] = createSignal<'project' | 'library'>('project');
  const navigation = () => <div class="flex items-center gap-1 text-xs leading-4 font-medium" role="tablist" aria-label="Media location">
    <button type="button" role="tab" aria-selected={view() === 'project'} aria-controls="project-media" onClick={() => setView('project')} class="rounded px-2 py-1.5 text-xs font-medium data-[selected=true]:bg-accent data-[selected=false]:text-muted-foreground" data-selected={view() === 'project'}>Project</button>
    <button type="button" role="tab" aria-selected={view() === 'library'} aria-controls="library-media" onClick={() => setView('library')} class="rounded px-2 py-1.5 text-xs font-medium data-[selected=true]:bg-accent data-[selected=false]:text-muted-foreground" data-selected={view() === 'library'}>Library</button>
  </div>;
  return <>
    <div id="project-media" role="tabpanel" aria-label="Project assets" class="flex-1 min-h-0 flex flex-col" classList={{ hidden: view() !== 'project' }}><Assets active={view() === 'project'} navigation={navigation()} onBrowseLibrary={() => setView('library')} /></div>
    <div id="library-media" role="tabpanel" aria-label="Media library" class="flex-1 min-h-0 flex flex-col" classList={{ hidden: view() !== 'library' }}><Catalog active={view() === 'library'} navigation={navigation()} /></div>
  </>;
}
