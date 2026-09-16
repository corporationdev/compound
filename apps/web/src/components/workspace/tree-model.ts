/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The workspace listing as a tree, and the tree as the rows the sidebar
// shows: folders first, a folder's children under it when it is expanded.
// Pure, so it can be tested without a window.

import type { WorkspaceEntry } from '@desktop/main-channels';

import { TABLE_SCHEMA_FILE } from './markdown';

export type TreeNode = {
  /** Workspace-relative path; the node's identity. */
  path: string;
  name: string;
  kind: 'file' | 'directory';
  /** A folder holding a project. */
  project: boolean;
  /** A folder holding a `_table.yaml`. */
  table: boolean;
  children: TreeNode[];
};

/** A row of the flattened tree: the node and how deep it sits. */
export type TreeRow = { node: TreeNode; depth: number; expanded: boolean };

/** Builds the tree from a depth-first listing. Folders sort before files at every level. */
export function buildTree(entries: readonly WorkspaceEntry[]): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const entry of entries) {
    const node: TreeNode = {
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      project: entry.kind === 'directory' && !!entry.project,
      table: false,
      children: [],
    };
    byPath.set(entry.path, node);
    const parent = entry.path.includes('/') ? byPath.get(entry.path.slice(0, entry.path.lastIndexOf('/'))) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const finish = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      if (node.kind !== 'directory') continue;
      node.table = node.children.some((child) => child.kind === 'file' && child.name === TABLE_SCHEMA_FILE);
      // The schema file is the table's own; the folder stands for it.
      node.children = node.children.filter((child) => !(child.kind === 'file' && child.name === TABLE_SCHEMA_FILE));
      finish(node.children);
    }
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
  };
  finish(roots);
  return roots;
}

/** The rows on screen for `expanded` folders, depth first. */
export function flattenTree(nodes: readonly TreeNode[], expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (list: readonly TreeNode[], depth: number): void => {
    for (const node of list) {
      const open = node.kind === 'directory' && expanded.has(node.path);
      rows.push({ node, depth, expanded: open });
      if (open) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return rows;
}

/** Every folder above `path`, nearest last, so a selected file's ancestors can be expanded. */
export function ancestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  let index = path.indexOf('/');
  while (index !== -1) {
    ancestors.push(path.slice(0, index));
    index = path.indexOf('/', index + 1);
  }
  return ancestors;
}

/** The node at `path`, or undefined. */
export function findNode(nodes: readonly TreeNode[], path: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.kind === 'directory' && path.startsWith(`${node.path}/`)) return findNode(node.children, path);
  }
  return undefined;
}

/**
 * The tree without projects: they have the Projects view and the editor,
 * and the sidebar's workspace is for everything else. A folder left with
 * nothing in it because it only held projects (the starter `projects/`)
 * goes too; an empty folder the user made stays.
 */
export function withoutProjects(nodes: readonly TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    if (node.project) continue;
    if (node.kind !== 'directory') {
      result.push(node);
      continue;
    }
    const children = withoutProjects(node.children);
    const heldOnlyProjects = node.children.length > 0 && children.length === 0 && node.children.every((child) => child.project);
    if (heldOnlyProjects) continue;
    result.push({ ...node, children });
  }
  return result;
}
