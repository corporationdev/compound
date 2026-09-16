import type { GenericMutationCtx } from 'convex/server';
import { components } from '../_generated/api';
import type { DataModel } from '../_generated/dataModel';

type MutationCtx = GenericMutationCtx<DataModel>;

/** Slug for the organization every user gets on sign-up. Unique per user. */
export function personalSlug(userId: string) {
  return `personal-${userId}`;
}

/**
 * Creates the user's personal organization (named after the email local part)
 * and makes them its owner. Idempotent: returns the existing organization id
 * when the slug is already taken. Runs through the component adapter so it
 * works both from the user-create trigger and from `organizations.ensurePersonal`.
 */
export async function createPersonalOrganization(
  ctx: MutationCtx,
  user: { _id: string; email: string },
): Promise<string> {
  const slug = personalSlug(user._id);
  const existing = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: 'organization',
    where: [{ field: 'slug', value: slug }],
  });
  if (existing) return existing._id as string;
  const now = Date.now();
  const name = user.email.split('@')[0] || 'Personal';
  const organization = await ctx.runMutation(components.betterAuth.adapter.create, {
    input: { model: 'organization', data: { name, slug, createdAt: now, updatedAt: now } },
  });
  await ctx.runMutation(components.betterAuth.adapter.create, {
    input: {
      model: 'member',
      data: {
        organizationId: organization._id as string,
        userId: user._id,
        role: 'owner',
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return organization._id as string;
}
