import { describe, expect, test } from 'bun:test';
import { mergeText } from '../../desktop/src/sync/merge';
import type { WorkspaceWriteResult } from '../../desktop/src/main-channels';
import { createDocumentPersistence } from '../src/components/workspace/document-persistence';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function setup(initial = 'Title\n\nBody') {
  let draft = initial;
  let disk = initial;
  const writes: Array<{ text: string; base: string; result: ReturnType<typeof deferred<WorkspaceWriteResult>> }> = [];
  const applied: string[] = [];
  const errors: unknown[] = [];
  let conflicts = 0;
  const persistence = createDocumentPersistence(initial, {
    read: () => draft,
    apply: (text) => { draft = text; applied.push(text); },
    write: (text, base) => {
      const result = deferred<WorkspaceWriteResult>();
      writes.push({ text, base, result });
      return result.promise;
    },
    onError: (error) => errors.push(error),
    onConflict: () => { conflicts++; },
  });
  return {
    persistence, writes, applied, errors,
    get draft() { return draft; },
    get disk() { return disk; },
    get conflicts() { return conflicts; },
    edit(text: string) { draft = text; persistence.markDirty(); },
    external(text: string) { disk = text; },
    complete(index: number) {
      const write = writes[index]!;
      const merged = mergeText(write.base, write.text, disk);
      disk = merged.text;
      write.result.resolve(disk === write.text ? { status: 'ok' } : { status: 'merged', ...merged });
    },
  };
}

describe('document persistence races', () => {
  test('typing while a merged write is pending survives and keeps independent remote edits', async () => {
    const s = setup();
    s.edit('Title\n\nFirst edit');
    const saved = s.persistence.save();
    await tick();
    s.external('Remote title\n\nBody');
    s.edit('Title\n\nSecond edit');
    s.complete(0);
    await tick();
    expect(s.draft).toBe('Title\n\nSecond edit');
    expect(s.applied).toEqual([]);
    expect(s.writes[1]!.base).toBe('Title\n\nFirst edit');
    s.complete(1);
    expect(await saved).toBe(true);
    expect(s.draft).toBe('Remote title\n\nSecond edit');
    expect(s.disk).toBe(s.draft);
    expect(s.persistence.dirty).toBe(false);
  });

  test('save flushes newer edits even without a second debounce or save request', async () => {
    const s = setup();
    s.edit('One');
    const saved = s.persistence.save();
    await tick();
    s.edit('Two');
    s.complete(0);
    await tick();
    expect(s.persistence.dirty).toBe(true);
    s.complete(1);
    expect(await saved).toBe(true);
    expect(s.disk).toBe('Two');
  });

  test('deleting a page cancels follow-up and queued writes without interrupting normal flushes', async () => {
    const s = setup();
    s.edit('First edit');
    const active = s.persistence.save();
    await tick();
    s.edit('Later typing');
    const queued = s.persistence.save();
    s.persistence.stopWatching();
    s.persistence.cancelFutureWrites();
    s.complete(0);
    expect(await active).toBe(false);
    expect(await queued).toBe(false);
    expect(s.writes).toHaveLength(1);
    expect(s.draft).toBe('Later typing');
    expect(await s.persistence.save()).toBe(false);
    expect(s.writes).toHaveLength(1);
  });

  test('failed writes retain the draft and original merge base for retry', async () => {
    const s = setup();
    s.edit('My draft');
    const failed = s.persistence.save();
    await tick();
    s.writes[0]!.result.reject(new Error('Disk unavailable'));
    expect(await failed).toBe(false);
    expect(s.persistence.dirty).toBe(true);
    expect(s.draft).toBe('My draft');
    expect(s.errors).toHaveLength(1);
    const retried = s.persistence.save();
    await tick();
    expect(s.writes[1]!.base).toBe('Title\n\nBody');
    s.complete(1);
    expect(await retried).toBe(true);
  });

  test('an old watcher read cannot overwrite a newer completed save', async () => {
    const s = setup();
    const remote = deferred<string | null>();
    const refresh = s.persistence.refresh(() => remote.promise);
    await tick();
    s.edit('Latest edit');
    const saved = s.persistence.save();
    await tick();
    s.complete(0);
    await saved;
    remote.resolve('Old watcher snapshot');
    await refresh;
    expect(s.draft).toBe('Latest edit');
    expect(s.applied).toEqual([]);
  });

  test('only the newest watcher request applies, and unmounted pages ignore reads', async () => {
    const s = setup();
    const old = deferred<string | null>();
    const fresh = deferred<string | null>();
    const first = s.persistence.refresh(() => old.promise);
    await tick();
    const second = s.persistence.refresh(() => fresh.promise);
    await tick();
    fresh.resolve('Newest remote');
    await second;
    old.resolve('Older remote');
    await first;
    expect(s.draft).toBe('Newest remote');
    const late = deferred<string | null>();
    const third = s.persistence.refresh(() => late.promise);
    await tick();
    s.persistence.stopWatching();
    late.resolve('After leaving the page');
    await third;
    expect(s.draft).toBe('Newest remote');
  });

  test('watcher waits for writes and defers outside changes while a draft is dirty', async () => {
    const s = setup();
    s.edit('Local draft');
    let reads = 0;
    await s.persistence.refresh(async () => { reads++; return 'Remote'; });
    expect(reads).toBe(0);
    expect(s.draft).toBe('Local draft');
    const saved = s.persistence.save();
    await tick();
    const refresh = s.persistence.refresh(async () => { reads++; return s.disk; });
    expect(reads).toBe(0);
    s.complete(0);
    await saved;
    await refresh;
    expect(reads).toBe(1);
    expect(s.draft).toBe('Local draft');
  });
});
