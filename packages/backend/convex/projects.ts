import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireMember, requireProjectMember } from './lib/membership';

function validateName(name: string) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 200) throw new ConvexError('Project name must be 1-200 characters');
  return trimmed;
}
function validateEntry(entry: string) {
  if (!/^[A-Za-z0-9_.-]+\.(tsx|jsx|ts|js)$/.test(entry))
    throw new ConvexError('Entry must be a file name like index.tsx');
  return entry;
}

/** Active (non-archived) projects in the organization. */
export const list = query({
  args: { organizationId: v.string() },
  handler: async (ctx, { organizationId }) => {
    await requireMember(ctx, organizationId);
    const projects = await ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('organizationId', organizationId))
      .collect();
    return projects.filter((project) => project.archivedAt === undefined);
  },
});

export const get = query({
  args: { projectId: v.id('projects') },
  handler: async (ctx, { projectId }) => {
    const project = await ctx.db.get(projectId);
    if (!project) return null;
    await requireMember(ctx, project.organizationId);
    return project;
  },
});

/** Creates an empty project; the client publishes files with `files.writeMany`. */
export const create = mutation({
  args: { organizationId: v.string(), name: v.string(), entry: v.optional(v.string()) },
  handler: async (ctx, { organizationId, name, entry }) => {
    const { user } = await requireMember(ctx, organizationId);
    const now = Date.now();
    const projectId = await ctx.db.insert('projects', {
      organizationId,
      name: validateName(name),
      entry: validateEntry(entry ?? 'index.tsx'),
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    });
    return { projectId };
  },
});

export const rename = mutation({
  args: { projectId: v.id('projects'), name: v.string() },
  handler: async (ctx, { projectId, name }) => {
    await requireProjectMember(ctx, projectId);
    await ctx.db.patch(projectId, { name: validateName(name), updatedAt: Date.now() });
  },
});

export const archive = mutation({
  args: { projectId: v.id('projects') },
  handler: async (ctx, { projectId }) => {
    const { project } = await requireProjectMember(ctx, projectId);
    if (project.archivedAt !== undefined) return;
    const now = Date.now();
    await ctx.db.patch(projectId, { archivedAt: now, updatedAt: now });
  },
});
