import { ConvexError, v } from 'convex/values';
import { components } from './_generated/api';
import { action, mutation, query } from './_generated/server';
import { authComponent, createAuth } from './auth';
import { createPersonalOrganization } from './lib/organizations';
import { hasRole, listAll, requireMember, type Member } from './lib/membership';

type Organization = { _id: string; name: string; slug: string };

/** Organizations the caller belongs to. Empty for accounts created before personal organizations existed; call `ensurePersonal` then. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.getAuthUser(ctx);
    const members = await listAll<Member>(ctx, 'member', [{ field: 'userId', value: user._id }]);
    const result: { id: string; name: string; slug: string; role: string }[] = [];
    for (const member of members) {
      const organization = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: 'organization',
        where: [{ field: '_id', value: member.organizationId }],
      })) as Organization | null;
      if (!organization) continue;
      result.push({
        id: organization._id,
        name: organization.name,
        slug: organization.slug,
        role: member.role,
      });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  },
});

/**
 * Creates the caller's personal organization if they have none. New accounts
 * get one from the user-create trigger; accounts that predate organizations
 * call this once when `listMine` comes back empty.
 */
export const ensurePersonal = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.getAuthUser(ctx);
    const members = await listAll<Member>(ctx, 'member', [{ field: 'userId', value: user._id }]);
    if (members.length > 0) return { id: members[0]!.organizationId };
    return { id: await createPersonalOrganization(ctx, user) };
  },
});

function slugify(name: string) {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${base || 'org'}-${crypto.randomUUID().slice(0, 8)}`;
}

export const create = action({
  args: { name: v.string() },
  handler: async (ctx, { name }): Promise<{ id: string }> => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 100) throw new ConvexError('Organization name must be 1-100 characters');
    const user = await authComponent.getAuthUser(ctx);
    const auth = createAuth(ctx);
    // Server call with an explicit userId: the native bearer transport carries a signed token, so we do not replay session headers.
    const organization = await auth.api.createOrganization({
      body: { name: trimmed, slug: slugify(trimmed), userId: user._id },
    });
    if (!organization) throw new ConvexError('Could not create organization');
    return { id: organization.id };
  },
});

export const addMemberByEmail = action({
  args: {
    organizationId: v.string(),
    email: v.string(),
    role: v.optional(v.union(v.literal('member'), v.literal('admin'))),
  },
  handler: async (ctx, { organizationId, email, role }): Promise<void> => {
    const { member } = await requireMember(ctx, organizationId);
    if (!hasRole(member, ['owner', 'admin']))
      throw new ConvexError('Only owners and admins can add members');
    const target = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: 'email', value: email.trim().toLowerCase() }],
    })) as { _id: string } | null;
    if (!target) throw new ConvexError('No account exists for that email');
    if (target._id === member.userId) throw new ConvexError('You are already a member');
    const auth = createAuth(ctx);
    await auth.api.addMember({
      body: { userId: target._id, organizationId, role: role ?? 'member' },
    });
  },
});

/** Live member directory for the current organization. */
export const listMembers = query({
  args: { organizationId: v.string() },
  handler: async (ctx, { organizationId }) => {
    await requireMember(ctx, organizationId);
    const members = await listAll<Member>(ctx, 'member', [{ field: 'organizationId', value: organizationId }]);
    return Promise.all(members.map(async (member) => {
      const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: 'user',
        where: [{ field: '_id', value: member.userId }],
      });
      return {
        id: member._id,
        userId: member.userId,
        role: member.role,
        name: user?.name ?? 'Unknown member',
        email: user?.email ?? '',
      };
    }));
  },
});

export const removeMember = mutation({
  args: { organizationId: v.string(), memberId: v.string() },
  handler: async (ctx, { organizationId, memberId }) => {
    const { member } = await requireMember(ctx, organizationId);
    if (!hasRole(member, ['owner', 'admin']))
      throw new ConvexError('Only owners and admins can remove members');
    const target = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'member',
      where: [{ field: '_id', value: memberId }, { field: 'organizationId', value: organizationId }],
    }) as Member | null;
    if (!target) throw new ConvexError('Member not found in this organization');
    if (hasRole(target, ['owner'])) throw new ConvexError('Organization owners cannot be removed');
    if (target.userId === member.userId) throw new ConvexError('You cannot remove yourself');
    await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: { model: 'member', where: [{ field: '_id', value: target._id }] },
    });
  },
});
