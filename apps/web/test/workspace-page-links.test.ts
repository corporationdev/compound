import { describe, expect, test } from 'bun:test';
import type { WorkspaceEntry } from '@desktop/main-channels';
import { workspaceLinkPages } from '../src/components/workspace/page-link-items';

const entry = (path: string, kind: 'file' | 'directory' = 'file', project = false): WorkspaceEntry => ({ path, name: path.split('/').pop()!, kind, ...(project ? { project: true } : {}) });

describe('workspace page destinations', () => {
  test('only offers actual workspace pages, excluding projects, instructions, and internal paths', () => {
    const pages = workspaceLinkPages([
      entry('Current.md'), entry('Roadmap.md'), entry('AGENTS.md'), entry('README.md'), entry('CLAUDE.md'),
      entry('Notes', 'directory'), entry('Notes/Ideas.md'), entry('Notes/README.md'),
      entry('Video', 'directory', true), entry('Video/Script.md'),
      entry('.compound', 'directory'), entry('.compound/Internal.md'),
      entry('_internal', 'directory'), entry('_internal/Guide.md'), entry('Image.png'),
    ], 'Current.md');
    expect(pages.map((page) => page.path)).toEqual(['Notes/Ideas.md', 'Roadmap.md']);
  });

  test('supports uppercase Markdown extensions, database rows, and Unicode page names', () => {
    const pages = workspaceLinkPages([
      entry('Tasks', 'directory'), entry('Tasks/_table.yaml'), entry('Tasks/Plan #1 %.MD'), entry('Résumé.md'),
    ], 'Other.md');
    expect(pages.map((page) => page.path)).toEqual(['Tasks/Plan #1 %.MD', 'Résumé.md']);
  });
});
