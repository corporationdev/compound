/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { WorkspaceEntry } from '@desktop/main-channels';
import { buildTree, withoutProjects, type TreeNode } from './tree-model';

/** Page destinations follow the workspace sidebar, excluding project and system documents. */
export function workspaceLinkPages(entries: readonly WorkspaceEntry[], currentPath: string): TreeNode[] {
  const pages: TreeNode[] = [];
  const walk = (nodes: readonly TreeNode[]) => {
    for (const node of nodes) {
      if (node.name.startsWith('.') || node.name.startsWith('_')) continue;
      if (node.kind === 'directory') walk(node.children);
      else if (/\.md$/i.test(node.name) && !/^(AGENTS|README|CLAUDE)\.md$/i.test(node.name) && node.path !== currentPath) pages.push(node);
    }
  };
  walk(withoutProjects(buildTree(entries)));
  return pages;
}
