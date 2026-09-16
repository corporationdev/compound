import { internalMutation } from './_generated/server';
import { sha256Hex } from './lib/sha256';

/**
 * Copies the legacy per-project rows into their organization's workspace,
 * each project under `projects/<folder name>/`. Run once per deployment
 * after the workspace release ships:
 *
 *   npx convex run migrations:projectsToWorkspace
 *
 * Idempotent, and safe alongside desktops that push their moved folders
 * up themselves: a project whose `package.json` (by `projectId`) is already
 * somewhere in the workspace is skipped whole, a path the workspace already
 * holds (in any letter case) is left alone, and `cloudProjectId` is dropped
 * from `package.json` the way the desktop drops it on disk, so the two
 * copies agree byte for byte. Legacy rows are not removed; the tables go
 * with a later schema change.
 */
export const projectsToWorkspace = internalMutation({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query('projects').collect();
    let copied = 0;
    let skipped = 0;
    let skippedProjects = 0;
    const existingByOrg = new Map<string, { paths: Set<string>; projectIds: Set<string> }>();
    const existing = async (organizationId: string) => {
      let known = existingByOrg.get(organizationId);
      if (known) return known;
      const rows = await ctx.db
        .query('files')
        .withIndex('by_org_path', (q) => q.eq('organizationId', organizationId))
        .collect();
      known = { paths: new Set(), projectIds: new Set() };
      for (const row of rows) {
        if (row.deleted) continue;
        known.paths.add(row.path.toLowerCase());
        if (row.path.endsWith('package.json')) {
          const id = recordedProjectId(row.text);
          if (id) known.projectIds.add(id);
        }
      }
      existingByOrg.set(organizationId, known);
      return known;
    };

    for (const project of projects) {
      if (project.archivedAt !== undefined) continue;
      const known = await existing(project.organizationId);
      const rows = (
        await ctx.db
          .query('projectFiles')
          .withIndex('by_project', (q) => q.eq('projectId', project._id))
          .collect()
      ).filter((row) => !row.deleted);
      const record = rows.find((row) => row.path === 'package.json');
      const projectId = record ? recordedProjectId(record.text) : null;
      if (projectId && known.projectIds.has(projectId)) {
        skippedProjects++;
        continue;
      }
      const folder = folderName(project.name);
      for (const row of rows) {
        const path = `projects/${folder}/${row.path}`;
        if (known.paths.has(path.toLowerCase())) {
          skipped++;
          continue;
        }
        const text = row.path === 'package.json' ? withoutCloudBinding(row.text) : row.text;
        await ctx.db.insert('files', {
          organizationId: project.organizationId,
          path,
          text,
          hash: text === row.text ? row.hash : sha256Hex(text),
          version: 1,
          deleted: false,
          updatedAt: row.updatedAt,
          updatedBy: row.updatedBy,
        });
        known.paths.add(path.toLowerCase());
        copied++;
      }
      if (projectId) known.projectIds.add(projectId);
    }
    return { projects: projects.length, copied, skipped, skippedProjects };
  },
});

/** The `projectId` a package.json names, or null. */
function recordedProjectId(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { projectId?: unknown };
    return typeof parsed.projectId === 'string' && parsed.projectId.trim() ? parsed.projectId.trim() : null;
  } catch {
    return null;
  }
}

/** package.json without `cloudProjectId`, written the way the desktop writes it (two-space indent, trailing newline). */
function withoutCloudBinding(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!('cloudProjectId' in parsed)) return text;
    delete parsed.cloudProjectId;
    return JSON.stringify(parsed, null, 2) + '\n';
  } catch {
    return text;
  }
}

/** Folder-safe project name, as the desktop names project folders: "Golden River 15 Aug" -> "golden-river-15-aug". */
function folderName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 64) || 'project'
  );
}
