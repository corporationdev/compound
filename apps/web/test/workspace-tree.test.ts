import { describe, expect, test } from 'bun:test';
import { ancestorsOf, buildTree, findNode, flattenTree, withoutProjects } from '../src/components/workspace/tree-model';
import type { WorkspaceEntry } from '../../desktop/src/main-channels';

const file = (path: string): WorkspaceEntry => ({ path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'file', size: 1, mtime: 0 });
const dir = (path: string, project = false): WorkspaceEntry => ({ path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'directory', size: 0, mtime: 0, project });

const listing: WorkspaceEntry[] = [
  file('notes.md'),
  dir('ideas'),
  file('ideas/_table.yaml'),
  file('ideas/Hook 10.md'),
  file('ideas/Hook 2.md'),
  dir('projects'),
  dir('projects/film', true),
  file('projects/film/index.tsx'),
  file('projects/film/package.json'),
  file('AGENTS.md'),
];

describe('buildTree', () => {
  test('nests by path, folders first, natural order, marking projects and tables', () => {
    const tree = buildTree(listing);
    expect(tree.map((node) => [node.name, node.kind, node.project, node.table])).toEqual([
      ['ideas', 'directory', false, true],
      ['projects', 'directory', false, false],
      ['AGENTS.md', 'file', false, false],
      ['notes.md', 'file', false, false],
    ]);
    const ideas = tree[0]!;
    expect(ideas.children.map((node) => node.name)).toEqual(['Hook 2.md', 'Hook 10.md']);
    const film = tree[1]!.children[0]!;
    expect(film.project).toBe(true);
    expect(film.children.map((node) => node.name)).toEqual(['index.tsx', 'package.json']);
  });
});

describe('flattenTree', () => {
  test('shows children of expanded folders only', () => {
    const tree = buildTree(listing);
    expect(flattenTree(tree, new Set()).map((row) => row.node.path)).toEqual(['ideas', 'projects', 'AGENTS.md', 'notes.md']);
    expect(flattenTree(tree, new Set(['projects'])).map((row) => [row.node.path, row.depth])).toEqual([
      ['ideas', 0],
      ['projects', 0],
      ['projects/film', 1],
      ['AGENTS.md', 0],
      ['notes.md', 0],
    ]);
    expect(flattenTree(tree, new Set(['projects', 'projects/film'])).map((row) => row.node.path)).toContain('projects/film/index.tsx');
  });
});

describe('ancestorsOf and findNode', () => {
  test('lists the folders above a path', () => {
    expect(ancestorsOf('projects/film/index.tsx')).toEqual(['projects', 'projects/film']);
    expect(ancestorsOf('notes.md')).toEqual([]);
  });

  test('finds a node by path', () => {
    const tree = buildTree(listing);
    expect(findNode(tree, 'projects/film/index.tsx')?.name).toBe('index.tsx');
    expect(findNode(tree, 'ideas')?.table).toBe(true);
    expect(findNode(tree, 'missing')).toBeUndefined();
  });
});

describe('withoutProjects', () => {
  test('drops project folders and a folder that only held projects, keeps the rest', () => {
    const tree = withoutProjects(buildTree([...listing, dir('empty'), dir('clients'), dir('clients/acme', true), file('clients/brief.md')]));
    expect(tree.map((node) => node.path)).toEqual(['clients', 'empty', 'ideas', 'AGENTS.md', 'notes.md']);
    expect(findNode(tree, 'clients')?.children.map((node) => node.path)).toEqual(['clients/brief.md']);
    expect(findNode(tree, 'projects')).toBeUndefined();
  });
});
