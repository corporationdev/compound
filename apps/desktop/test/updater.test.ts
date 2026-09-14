import { test, expect, mock } from 'bun:test';

// The prompt logic under test never touches electron; the module only needs it to load.
mock.module('electron', () => ({ app: {}, autoUpdater: {}, dialog: {} }));
const { UpdateStatus } = await import('../src/updater');
type UpdateOutcome = import('../src/updater').UpdateOutcome;

function track() {
  const shown: UpdateOutcome[] = [];
  return { shown, status: new UpdateStatus((outcome) => shown.push(outcome)) };
}

test('background checks only speak up once a download is ready', () => {
  const { shown, status } = track();
  status.report({ kind: 'current' });
  status.report({ kind: 'error', message: 'offline' });
  status.report({ kind: 'available' });
  expect(shown).toEqual([]);
  status.report({ kind: 'downloaded', name: 'v1.2.3' });
  expect(shown).toEqual([{ kind: 'downloaded', name: 'v1.2.3' }]);
});

test('a menu check reports its own outcome once', () => {
  const { shown, status } = track();
  expect(status.requestCheck()).toBe(true);
  expect(status.requestCheck()).toBe(false);
  status.report({ kind: 'current' });
  expect(shown).toEqual([{ kind: 'current' }]);
  // The check is over; the next background result is quiet again.
  status.report({ kind: 'current' });
  expect(shown).toHaveLength(1);
});

test('a menu check follows its download through to the restart prompt or failure', () => {
  const { shown, status } = track();
  status.requestCheck();
  status.report({ kind: 'available' });
  status.report({ kind: 'error', message: 'checksum' });
  expect(shown).toEqual([{ kind: 'available' }, { kind: 'error', message: 'checksum' }]);
  status.report({ kind: 'error', message: 'later background failure' });
  expect(shown).toHaveLength(2);
});

test('once downloaded, the menu re-offers the restart instead of checking again', () => {
  const { shown, status } = track();
  status.report({ kind: 'downloaded', name: 'v2.0.0' });
  expect(status.requestCheck()).toBe(false);
  expect(shown).toEqual([
    { kind: 'downloaded', name: 'v2.0.0' },
    { kind: 'downloaded', name: 'v2.0.0' },
  ]);
});
