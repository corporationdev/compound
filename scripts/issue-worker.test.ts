import { describe, expect, test } from 'bun:test';
import { branchName, firstMessage, planClaims, threadIdFor, type Issue } from './issue-worker';
import { projectScriptsFromT3Json } from './lib/t3code';

const issue = (number: number, labels: string[] = ['ready']): Issue => ({ number, title: `Issue ${number}`, body: '', labels });

describe('branchName', () => {
  test('slugs the title under issue/<number>-', () => {
    expect(branchName(12, 'Issue worker smoke test')).toBe('issue/12-issue-worker-smoke-test');
  });

  test('drops punctuation, accents and case', () => {
    expect(branchName(7, '  Fix: Café crash when `exporting` (4K)!! ')).toBe('issue/7-fix-cafe-crash-when-exporting-4k');
  });

  test('cuts long titles at a word boundary', () => {
    const branch = branchName(3, 'Make the timeline scrubber snap to clip boundaries while dragging with the keyboard');
    expect(branch).toBe('issue/3-make-the-timeline-scrubber-snap-to-clip');
    expect(branch.length - 'issue/3-'.length).toBeLessThanOrEqual(48);
  });

  test('falls back to the number when nothing is left', () => {
    expect(branchName(9, '🚀 !!!')).toBe('issue/9');
  });
});

describe('planClaims', () => {
  test('claims oldest first up to the free slots', () => {
    const plan = planClaims({ ready: [issue(5), issue(2), issue(9)], inProgressCount: 1, started: new Set() });
    expect(plan.claim.map((i) => i.number)).toEqual([2, 5]);
    expect(plan.skip.map((s) => [s.issue.number, s.reason])).toEqual([[9, '3 issues already in progress']]);
  });

  test('claims nothing at capacity', () => {
    const plan = planClaims({ ready: [issue(1)], inProgressCount: 3, started: new Set() });
    expect(plan.claim).toEqual([]);
  });

  test('tolerates more in progress than the limit', () => {
    expect(planClaims({ ready: [issue(1)], inProgressCount: 5, started: new Set() }).claim).toEqual([]);
  });

  test('never claims an issue twice', () => {
    const plan = planClaims({ ready: [issue(1), issue(1), issue(2)], inProgressCount: 0, started: new Set([2]) });
    expect(plan.claim.map((i) => i.number)).toEqual([1]);
    expect(plan.skip.map((s) => [s.issue.number, s.reason])).toEqual([[2, 'already has a thread']]);
  });

  test('skips issues that also carry a later label without using a slot', () => {
    const plan = planClaims({ ready: [issue(1, ['ready', 'in-review']), issue(2)], inProgressCount: 2, started: new Set() });
    expect(plan.claim.map((i) => i.number)).toEqual([2]);
    expect(plan.skip[0]?.reason).toBe('also labeled in-review');
  });
});

test('an issue always maps to the same thread id', () => {
  expect(threadIdFor(4)).toBe(threadIdFor(4));
  expect(threadIdFor(4)).not.toBe(threadIdFor(5));
  expect(threadIdFor(4)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('the first message names the skill and carries the issue', () => {
  const text = firstMessage({ number: 4, title: 'Add a line', body: 'Details here.', labels: [] }, 'issue/4-add-a-line', 'main');
  expect(text.split('\n')[0]).toContain('issue-worker skill');
  expect(text).toContain('# Add a line');
  expect(text).toContain('Details here.');
  expect(text).toContain('`issue/4-add-a-line`');
});

test('t3.json scripts become T3 Code project scripts', () => {
  const scripts = projectScriptsFromT3Json(
    JSON.stringify({ scripts: [{ name: 'Sandbox setup', command: 'bun run setup', icon: 'configure', runOnWorktreeCreate: true }, { name: 'Dev', command: 'bun dev', icon: 'wrench' }] }),
  );
  expect(scripts).toEqual([
    { id: 'sandbox-setup', name: 'Sandbox setup', command: 'bun run setup', icon: 'configure', runOnWorktreeCreate: true },
    { id: 'dev', name: 'Dev', command: 'bun dev', icon: 'play', runOnWorktreeCreate: false },
  ]);
});
