import { Show } from 'solid-js';
import { Button } from '@/components/ui/button';
import { useAutoCaptions } from './use-auto-captions';
export function ActionBar() {
  const captions = useAutoCaptions();
  return (
    <Show when={captions.hasScene()}>
      <div class="absolute bottom-20 left-1/2 -translate-x-1/2 z-10">
        <Button onClick={captions.generate}>Auto captions</Button>
      </div>
    </Show>
  );
}
