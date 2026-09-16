import { describe, expect, test } from 'bun:test';
import { compareDatabaseRows, compareDatabaseValues, createFileQueue, selectDatabaseRows } from '../src/components/workspace/database-model';

describe('database row selection', () => {
  const paths = ['alpha.md', 'bravo.md', 'charlie.md', 'delta.md'];
  test('toggles individual rows without changing the original set', () => {
    const selected = new Set(['alpha.md']);
    expect([...selectDatabaseRows(selected, paths, 'bravo.md', null, false)]).toEqual(['alpha.md', 'bravo.md']);
    expect([...selectDatabaseRows(selected, paths, 'alpha.md', null, false)]).toEqual([]);
    expect([...selected]).toEqual(['alpha.md']);
  });
  test('shift selection follows the visible sorted order in either direction', () => {
    const order = ['delta.md', 'bravo.md', 'alpha.md', 'charlie.md'];
    expect([...selectDatabaseRows(new Set(['charlie.md']), order, 'bravo.md', 'charlie.md', true)]).toEqual(['charlie.md', 'bravo.md', 'alpha.md']);
  });
  test('shift deselection clears the range and keeps unrelated selected rows', () => {
    expect([...selectDatabaseRows(new Set(paths), paths, 'charlie.md', 'alpha.md', true)]).toEqual(['delta.md']);
  });
  test('filtered out anchors do not select invisible rows', () => {
    expect([...selectDatabaseRows(new Set(['alpha.md']), ['bravo.md', 'delta.md'], 'delta.md', 'alpha.md', true)]).toEqual(['alpha.md', 'delta.md']);
  });
});

describe('database writes', () => {
  test('serializes read-modify-write operations to avoid dropping another property', async () => {
    const queue = createFileQueue();
    let file = { status: 'Draft', score: 0 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue('page.md', async () => {
      const snapshot = { ...file };
      await gate;
      file = { ...snapshot, status: 'Published' };
    });
    const second = queue('page.md', async () => { file = { ...file, score: 10 }; });
    release();
    await Promise.all([first, second]);
    expect(file).toEqual({ status: 'Published', score: 10 });
  });
  test('a failed write rejects its caller but does not prevent the next edit', async () => {
    const queue = createFileQueue();
    const failed = queue('page.md', async () => { throw new Error('offline'); });
    const next = queue('page.md', async () => 'saved');
    await expect(failed).rejects.toThrow('offline');
    expect(await next).toBe('saved');
  });
  test('writes to a different page do not wait on a blocked page', async () => {
    const queue = createFileQueue();
    let release!: () => void;
    const first = queue('one.md', () => new Promise<void>((resolve) => { release = resolve; }));
    expect(await queue('two.md', async () => 'saved')).toBe('saved');
    release();
    await first;
  });
});


describe('database sorting', () => {
  test('sorts numbers numerically even when the column starts with empty cells', () => {
    expect(['', 20, -2, 3, 1.5].sort(compareDatabaseValues)).toEqual(['', -2, 1.5, 3, 20]);
  });
  test('uses natural case-insensitive names and checkbox order', () => {
    expect(['Page 10', 'page 2', 'Page 1'].sort(compareDatabaseValues)).toEqual(['Page 1', 'page 2', 'Page 10']);
    expect([true, false, false].sort(compareDatabaseValues)).toEqual([false, false, true]);
  });
});


test('an optimistic new page and the subsequent watcher listing have identical row order', () => {
  const row = (name: string) => ({ name, path: `database/${name}.md` });
  const existing = [row('Untitled'), row('Untitled 2'), row('Untitled 10')];
  const added = row('Untitled 3');
  const optimistic = [...existing, added].sort(compareDatabaseRows);
  const watcher = [added, existing[2]!, existing[0]!, existing[1]!].sort(compareDatabaseRows);
  expect(optimistic.map((item) => item.path)).toEqual(watcher.map((item) => item.path));
  expect(optimistic.map((item) => item.name)).toEqual(['Untitled', 'Untitled 2', 'Untitled 3', 'Untitled 10']);
});
