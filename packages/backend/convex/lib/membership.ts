import { ConvexError } from 'convex/values';
import { components } from '../_generated/api';
import type { ActionCtx, MutationCtx, QueryCtx } from '../_generated/server';
import { authComponent } from '../auth';

type Ctx = QueryCtx | MutationCtx | ActionCtx;

export type Member = {
  _id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt: number;
};

export type AuthUser = Awaited<ReturnType<typeof authComponent.getAuthUser>>;

/** Better Auth stores multiple roles comma-separated ("owner,admin"). */
export function hasRole(member: Member, roles: string[]) {
  return member.role.split(',').some((role) => roles.includes(role.trim()));
}

export async function findMember(ctx: Ctx, organizationId: string, userId: string) {
  return (await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: 'member',
    where: [
      { field: 'organizationId', value: organizationId },
      { field: 'userId', value: userId },
    ],
  })) as Member | null;
}

/** Walks every page of an adapter findMany. Membership lists are small. */
export async function listAll<T>(
  ctx: Ctx,
  model: 'member' | 'organization',
  where: { field: string; value: string; operator?: 'eq' | 'in' }[],
): Promise<T[]> {
  const docs: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result: { page: T[]; isDone: boolean; continueCursor: string } = await ctx.runQuery(
      components.betterAuth.adapter.findMany,
      { model, where, paginationOpts: { numItems: 200, cursor } },
    );
    docs.push(...result.page);
    if (result.isDone) return docs;
    cursor = result.continueCursor;
  }
}

/** Authenticated user who is a member of the organization, else throws. */
export async function requireMember(
  ctx: Ctx,
  organizationId: string,
): Promise<{ user: AuthUser; member: Member }> {
  const user = await authComponent.getAuthUser(ctx);
  const member = await findMember(ctx, organizationId, user._id);
  if (!member) throw new ConvexError('Not a member of this organization');
  return { user, member };
}
