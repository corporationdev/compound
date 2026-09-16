import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { applyViewEdit, emptyView, reconcileWithFile, renameViewSources, type ProjectView } from '../src/engine/view-state';
import { forgetProjectView, loadProjectView, saveProjectView } from '../src/lib/db';

const A = 'index.tsx:1';
const B = 'index.tsx:2';

const fold = (view: ProjectView, ...edits: [source: string, name: string, value: unknown][]): ProjectView =>
  edits.reduce((view, [source, name, value]) => applyViewEdit(view, { source, name, value }), view);

describe('applyViewEdit', () => {
  test('is pure: the view it is given is left alone', () => {
    const view = emptyView();
    const next = fold(view, [A, 'selected', true], [A, 'playhead', 2], [A, 'expanded', true], [A, 'clipHeight', 40], [A, 'active', true]);
    expect(view).toEqual(emptyView());
    expect(next).not.toBe(view);
  });

  test('active: true names the source, false clears it only when it still matches', () => {
    let view = fold(emptyView(), [A, 'active', true]);
    expect(view.active).toBe(A);
    // Activating B reports A false, then B true — in that order.
    view = fold(view, [A, 'active', false], [B, 'active', true]);
    expect(view.active).toBe(B);
    // A late false for the one that already lost it changes nothing.
    view = fold(view, [A, 'active', false]);
    expect(view.active).toBe(B);
    view = fold(view, [B, 'active', false]);
    expect(view.active).toBeUndefined();
    expect('active' in view).toBe(false);
  });

  test('selected adds and removes sources without duplicates', () => {
    let view = fold(emptyView(), [A, 'selected', true], [B, 'selected', true], [A, 'selected', true]);
    expect(view.selected).toEqual([A, B]);
    view = fold(view, [A, 'selected', false]);
    expect(view.selected).toEqual([B]);
    // Deselecting what is not selected is a no-op, and the same object.
    expect(fold(view, [A, 'selected', false])).toBe(view);
  });

  test('playhead keeps seconds and drops the entry on false or the first frame', () => {
    let view = fold(emptyView(), [A, 'playhead', 1.5], [B, 'playhead', 3]);
    expect(view.playhead).toEqual({ [A]: 1.5, [B]: 3 });
    view = fold(view, [A, 'playhead', false]);
    expect(view.playhead).toEqual({ [B]: 3 });
    view = fold(view, [B, 'playhead', 0]);
    expect(view.playhead).toEqual({});
    expect(fold(view, [A, 'playhead', 'soon']).playhead).toEqual({});
  });

  test('timeline keeps [zoom, x, y] and drops anything else', () => {
    let view = fold(emptyView(), [A, 'timeline', [120, 2.5, 30]]);
    expect(view.timeline).toEqual({ [A]: [120, 2.5, 30] });
    view = fold(view, [A, 'timeline', [140, 0, 0]]);
    expect(view.timeline).toEqual({ [A]: [140, 0, 0] });
    view = fold(view, [A, 'timeline', false]);
    expect(view.timeline).toEqual({});
    expect(fold(view, [A, 'timeline', [1, 2]]).timeline).toEqual({});
    expect(fold(view, [A, 'timeline', [1, NaN, 2]]).timeline).toEqual({});
  });

  test('expanded records both states, so a closed row stays closed over a file that opens it', () => {
    let view = fold(emptyView(), [A, 'expanded', true]);
    expect(view.expanded).toEqual({ [A]: true });
    view = fold(view, [A, 'expanded', false]);
    expect(view.expanded).toEqual({ [A]: false });
  });

  test('clipHeight keeps numbers and drops the entry for anything else', () => {
    let view = fold(emptyView(), [A, 'clipHeight', 64]);
    expect(view.clipHeight).toEqual({ [A]: 64 });
    view = fold(view, [A, 'clipHeight', false]);
    expect(view.clipHeight).toEqual({});
    expect(fold(view, [A, 'clipHeight', '64']).clipHeight).toEqual({});
  });

  test('camera keeps a six-number matrix and ignores anything else', () => {
    const stage = 'index.tsx:0';
    let view = fold(emptyView(), [stage, 'camera', [0.5, 0, 0, 0.5, 10, 20]]);
    expect(view.camera).toEqual([0.5, 0, 0, 0.5, 10, 20]);
    expect(fold(view, [stage, 'camera', [1, 2, 3]])).toBe(view);
    expect(fold(view, [stage, 'camera', false])).toBe(view);
    view = fold(view, [stage, 'camera', [1, 0, 0, 1, 0, 0]]);
    expect(view.camera).toEqual([1, 0, 0, 1, 0, 0]);
  });

  test('a prop that is not a view prop is ignored', () => {
    const view = fold(emptyView(), [A, 'selected', true]);
    expect(fold(view, [A, 'x', 10])).toBe(view);
    expect(fold(view, [A, 'start', 2])).toBe(view);
  });
});

describe('renameViewSources', () => {
  test('rekeys every map and the active source', () => {
    const pending = 'pending:1';
    const view = fold(emptyView(),
      [pending, 'active', true], [pending, 'selected', true], [pending, 'playhead', 2],
      [pending, 'timeline', [100, 0, 0]], [pending, 'expanded', true], [pending, 'clipHeight', 30],
      [A, 'selected', true]);
    const renamed = renameViewSources(view, { [pending]: B });
    expect(renamed.active).toBe(B);
    expect(renamed.selected).toEqual([B, A]);
    expect(renamed.playhead).toEqual({ [B]: 2 });
    expect(renamed.timeline).toEqual({ [B]: [100, 0, 0] });
    expect(renamed.expanded).toEqual({ [B]: true });
    expect(renamed.clipHeight).toEqual({ [B]: 30 });
    expect(view.active).toBe(pending);
  });
});

describe('reconcileWithFile', () => {
  const CAM: number[] = [0.3, 0, 0, 0.3, 85, 150];
  const MOVED: number[] = [0.5, 0, 0, 0.5, 10, 20];
  const MINE: number[] = [1, 0, 0, 1, 0, 0];

  test('is pure, and answers the same object when nothing in the record changed', () => {
    const view: ProjectView = { ...fold(emptyView(), [B, 'active', true]), fileActive: A, fileCamera: CAM };
    const before = structuredClone(view);
    const result = reconcileWithFile(view, { active: A, camera: CAM });
    expect(view).toEqual(before);
    expect(result.view).toBe(view);
    expect(result).toMatchObject({ overrideActive: true, overrideCamera: false });
  });

  test('a record without file values (an old one) overrides this once and learns what the file says', () => {
    const view = fold(emptyView(), [B, 'active', true], ['index.tsx:0', 'camera', MINE]);
    const result = reconcileWithFile(view, { active: A, camera: CAM });
    expect(result.overrideActive).toBe(true);
    expect(result.overrideCamera).toBe(true);
    expect(result.view.active).toBe(B);
    expect(result.view.camera).toEqual(MINE);
    expect(result.view.fileActive).toBe(A);
    expect(result.view.fileCamera).toEqual(CAM);
    expect(result.view.fileCamera).not.toBe(CAM);
  });

  test('the record stands over a file that says what it said last time', () => {
    const view: ProjectView = { ...fold(emptyView(), [B, 'active', true], ['index.tsx:0', 'camera', MINE]), fileActive: A, fileCamera: CAM };
    const result = reconcileWithFile(view, { active: A, camera: [...CAM] });
    expect(result).toMatchObject({ overrideActive: true, overrideCamera: true });
    expect(result.view).toBe(view);
  });

  test('the file wins when it marks another scene active: no override, and the view follows', () => {
    const C = 'index.tsx:3';
    const view: ProjectView = { ...fold(emptyView(), [B, 'active', true]), fileActive: A, fileCamera: CAM };
    const result = reconcileWithFile(view, { active: C, camera: CAM });
    expect(result.overrideActive).toBe(false);
    expect(result.view.active).toBe(C);
    expect(result.view.fileActive).toBe(C);
    // Next mount, same file: the followed scene is what goes back on.
    const again = reconcileWithFile(result.view, { active: C, camera: CAM });
    expect(again.overrideActive).toBe(true);
    expect(again.view).toBe(result.view);
  });

  test('a file that stops marking any scene active clears the recorded one', () => {
    const view: ProjectView = { ...fold(emptyView(), [B, 'active', true]), fileActive: A, fileCamera: CAM };
    const result = reconcileWithFile(view, { camera: CAM });
    expect(result.overrideActive).toBe(false);
    expect('active' in result.view).toBe(false);
    expect(result.view.fileActive).toBe('');
    // ...and marking one again later is a change too, told apart from "unknown".
    const marked = reconcileWithFile({ ...result.view, active: B }, { active: A, camera: CAM });
    expect(marked.overrideActive).toBe(false);
    expect(marked.view.active).toBe(A);
  });

  test('the file wins when its camera moved, compared by value', () => {
    const view: ProjectView = { ...fold(emptyView(), ['index.tsx:0', 'camera', MINE]), fileActive: A, fileCamera: CAM };
    const result = reconcileWithFile(view, { active: A, camera: MOVED });
    expect(result.overrideCamera).toBe(false);
    expect(result.overrideActive).toBe(false);
    expect(result.view.camera).toEqual(MOVED);
    expect(result.view.fileCamera).toEqual(MOVED);
    expect(result.view.active).toBeUndefined();
  });

  test('active and camera are decided apart', () => {
    const view: ProjectView = { ...fold(emptyView(), [B, 'active', true], ['index.tsx:0', 'camera', MINE]), fileActive: A, fileCamera: CAM };
    const result = reconcileWithFile(view, { active: A, camera: MOVED });
    expect(result).toMatchObject({ overrideActive: true, overrideCamera: false });
    expect(result.view.active).toBe(B);
    expect(result.view.camera).toEqual(MOVED);
  });

  test('nothing recorded means nothing to override, whatever the file says', () => {
    const result = reconcileWithFile(emptyView(), { active: A, camera: CAM });
    expect(result).toMatchObject({ overrideActive: false, overrideCamera: false });
    expect(result.view).toEqual({ ...emptyView(), fileActive: A, fileCamera: CAM });
  });
});

describe('renameViewSources', () => {
  test('follows the file active too', () => {
    const pending = 'pending:1';
    const view: ProjectView = { ...emptyView(), fileActive: pending };
    expect(renameViewSources(view, { [pending]: B }).fileActive).toBe(B);
    expect(renameViewSources({ ...emptyView(), fileActive: '' }, { [pending]: B }).fileActive).toBe('');
  });
});

describe('project view records', () => {
  test('round-trip: save, load, forget', async () => {
    const view = fold(emptyView(),
      ['index.tsx:0', 'camera', [0.3, 0, 0, 0.3, 85, 150]],
      [A, 'active', true], [A, 'selected', true], [A, 'playhead', 1.25],
      [A, 'timeline', [120, 1, 0]], [B, 'expanded', true], [B, 'clipHeight', 48]);
    view.fileActive = A;
    view.fileCamera = [0.3, 0, 0, 0.3, 85, 150];

    expect(await loadProjectView('project-1')).toBeNull();
    await saveProjectView('project-1', view);
    expect(await loadProjectView('project-1')).toEqual(view);

    // A save replaces the record whole.
    const later = fold(view, [A, 'selected', false]);
    await saveProjectView('project-1', later);
    expect(await loadProjectView('project-1')).toEqual(later);

    await forgetProjectView('project-1');
    expect(await loadProjectView('project-1')).toBeNull();
  });

  test('an empty project id is neither saved nor loaded', async () => {
    await saveProjectView('', emptyView());
    expect(await loadProjectView('')).toBeNull();
  });
});
