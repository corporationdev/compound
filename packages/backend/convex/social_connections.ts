import { ConvexError, type Infer, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from './_generated/server';
import { authComponent } from './auth';
import {
  isSocialPlatform,
  PENDING_STATUSES,
  SOCIAL_RETURN_HOST,
  SOCIAL_RETURN_SCHEME,
  socialPlatform,
} from './social_model';
import { hashToken, ProviderError, providerId, record, string, zernio } from './social_provider';

const ATTEMPT_TTL_MS = 30 * 60_000;

/**
 * The signed-in user's connected accounts. Reactive: the Settings view
 * subscribes to this, so a connection completed in the browser shows up
 * without any return trip into the app.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return [];
    const accounts = await ctx.db
      .query('socialAccounts')
      .withIndex('by_owner', (q) => q.eq('ownerId', user._id))
      .take(50);
    return accounts
      .filter((a) => a.active)
      .map((a) => ({
        id: a._id,
        platform: a.platform,
        username: a.username,
        avatarUrl: a.avatarUrl ?? null,
        updatedAt: a.updatedAt,
      }));
  },
});
export const access = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ ownerId: string; profile: Doc<'socialProfiles'> | null }> => {
    const user = await authComponent.getAuthUser(ctx);
    return {
      ownerId: user._id,
      profile: await ctx.db
        .query('socialProfiles')
        .withIndex('by_owner', (q) => q.eq('ownerId', user._id))
        .unique(),
    };
  },
});
export const saveProfile = internalMutation({
  args: { ownerId: v.string(), providerId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('socialProfiles')
      .withIndex('by_owner', (q) => q.eq('ownerId', args.ownerId))
      .unique();
    if (existing) return existing.providerId;
    await ctx.db.insert('socialProfiles', args);
    return args.providerId;
  },
});
export const beginAttempt = internalMutation({
  args: {
    ownerId: v.string(),
    profileId: v.string(),
    stateHash: v.string(),
    platform: socialPlatform,
    returnUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('socialConnections', {
      ...args,
      expiresAt: Date.now() + ATTEMPT_TTL_MS,
      completed: false,
    });
    return null;
  },
});
/**
 * Where the callback page sends the browser after the connection is saved.
 * Only the desktop deep link or a page on our own site is accepted, so the
 * provider redirect can never be turned into an open redirect.
 */
export function validateReturnUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConvexError('Return URL is not valid');
  }
  if (url.protocol === SOCIAL_RETURN_SCHEME && url.host === SOCIAL_RETURN_HOST) return url.toString();
  const site = process.env.SITE_URL;
  if (site && (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === new URL(site).origin)
    return url.toString();
  throw new ConvexError('Return URL is not allowed');
}
export const connect = action({
  args: { platform: socialPlatform, returnUrl: v.optional(v.string()) },
  handler: async (ctx, { platform, returnUrl }): Promise<{ url: string }> => {
    const safeReturn = validateReturnUrl(returnUrl);
    const access = await ctx.runQuery(internal.social_connections.access, {});
    let profileId = access.profile?.providerId;
    if (!profileId) {
      const response = await zernio('/profiles', {
        method: 'POST',
        body: JSON.stringify({ name: `Compound ${access.ownerId}` }),
      });
      const created = providerId(response.profile);
      if (!created) throw new Error('Posting service did not create a profile');
      profileId = await ctx.runMutation(internal.social_connections.saveProfile, {
        ownerId: access.ownerId,
        providerId: created,
      });
    }
    const state = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    await ctx.runMutation(internal.social_connections.beginAttempt, {
      ownerId: access.ownerId,
      profileId,
      stateHash: await hashToken(state),
      platform,
      returnUrl: safeReturn,
    });
    const site = process.env.CONVEX_SITE_URL;
    if (!site) throw new Error('Missing Convex site URL');
    const callback = new URL('/social/callback', site);
    callback.searchParams.set('state', state);
    const params = new URLSearchParams({ profileId, redirect_url: callback.toString() });
    const response = await zernio(`/connect/${platform}?${params}`);
    const url = string(response.authUrl);
    if (!url || new URL(url).protocol !== 'https:')
      throw new Error('Posting service returned an invalid sign-in URL');
    return { url };
  },
});
export const attempt = internalQuery({
  args: { stateHash: v.string() },
  handler: async (ctx, args): Promise<Doc<'socialConnections'>> => {
    const attempt = await ctx.db
      .query('socialConnections')
      .withIndex('by_state_hash', (q) => q.eq('stateHash', args.stateHash))
      .unique();
    if (!attempt || attempt.expiresAt < Date.now() || attempt.completed)
      throw new ConvexError('This connection link expired. Connect again from Settings.');
    return attempt;
  },
});
const accountData = v.object({
  providerId: v.string(),
  platform: socialPlatform,
  username: v.string(),
  avatarUrl: v.optional(v.string()),
  active: v.boolean(),
});
/**
 * Make our rows match Zernio's account list for this profile. Accounts Zernio
 * no longer lists become inactive; the rest are upserted. When an attempt id
 * is given the attempt is consumed in the same transaction.
 */
export const syncRows = internalMutation({
  args: {
    ownerId: v.string(),
    profileId: v.string(),
    accounts: v.array(accountData),
    attemptId: v.optional(v.id('socialConnections')),
  },
  handler: async (ctx, args) => {
    if (args.attemptId) {
      const attempt = await ctx.db.get(args.attemptId);
      if (
        !attempt ||
        attempt.completed ||
        attempt.expiresAt < Date.now() ||
        attempt.ownerId !== args.ownerId ||
        attempt.profileId !== args.profileId
      )
        throw new ConvexError('Connection expired');
      await ctx.db.patch(attempt._id, { completed: true });
    }
    const now = Date.now();
    const existing = await ctx.db
      .query('socialAccounts')
      .withIndex('by_owner', (q) => q.eq('ownerId', args.ownerId))
      .take(50);
    for (const a of existing) {
      if (a.active && !args.accounts.some((b) => b.providerId === a.providerId))
        await ctx.db.patch(a._id, { active: false, updatedAt: now });
    }
    for (const a of args.accounts) {
      const previous = await ctx.db
        .query('socialAccounts')
        .withIndex('by_provider', (q) => q.eq('providerId', a.providerId))
        .unique();
      if (previous && previous.ownerId !== args.ownerId)
        throw new ConvexError('This account is connected to another Compound user');
      const values = { ...a, ownerId: args.ownerId, profileId: args.profileId, updatedAt: now };
      if (previous) await ctx.db.patch(previous._id, values);
      else await ctx.db.insert('socialAccounts', values);
    }
    return null;
  },
});
async function providerAccounts(profileId: string) {
  const response = await zernio(`/accounts?${new URLSearchParams({ profileId, includeOverLimit: 'true' })}`);
  if (!Array.isArray(response.accounts)) throw new Error('Posting service did not return accounts');
  return response.accounts.flatMap<Infer<typeof accountData>>((value) => {
    const a = record(value);
    const id = providerId(a._id);
    if (!id || !isSocialPlatform(a.platform)) return [];
    if (providerId(a.profileId) && providerId(a.profileId) !== profileId)
      throw new Error('Connection profile mismatch');
    return [
      {
        providerId: id,
        platform: a.platform,
        username: string(a.username) ?? string(a.displayName) ?? a.platform,
        avatarUrl: string(a.profilePicture),
        active: a.isActive !== false && a.enabled !== false,
      },
    ];
  });
}
export const complete = internalAction({
  args: {
    state: v.string(),
    accountId: v.optional(v.string()),
    profileId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ platform: string; username: string; returnUrl?: string }> => {
    const attempt = await ctx.runQuery(internal.social_connections.attempt, {
      stateHash: await hashToken(args.state),
    });
    if (args.profileId && args.profileId !== attempt.profileId) throw new Error('Connection profile mismatch');
    const accounts = await providerAccounts(attempt.profileId);
    const connected = accounts.find(
      (a) => a.platform === attempt.platform && a.active && (!args.accountId || a.providerId === args.accountId),
    );
    if (!connected) throw new Error('No connected account was found. Please try again.');
    await ctx.runMutation(internal.social_connections.syncRows, {
      ownerId: attempt.ownerId,
      profileId: attempt.profileId,
      accounts,
      attemptId: attempt._id,
    });
    return { platform: connected.platform, username: connected.username, returnUrl: attempt.returnUrl };
  },
});
export const refresh = action({
  args: {},
  handler: async (ctx) => {
    const { ownerId, profile } = await ctx.runQuery(internal.social_connections.access, {});
    if (profile) {
      await ctx.runMutation(internal.social_connections.syncRows, {
        ownerId,
        profileId: profile.providerId,
        accounts: await providerAccounts(profile.providerId),
      });
    }
    return null;
  },
});
export const disconnectAccess = internalMutation({
  args: { accountId: v.id('socialAccounts') },
  handler: async (ctx, { accountId }): Promise<Doc<'socialAccounts'>> => {
    const user = await authComponent.getAuthUser(ctx);
    const account = await ctx.db.get(accountId);
    if (!account || account.ownerId !== user._id) throw new ConvexError('Account not found');
    for (const status of PENDING_STATUSES) {
      const pending = await ctx.db
        .query('socialPostTargets')
        .withIndex('by_account_and_status', (q) => q.eq('accountId', accountId).eq('status', status))
        .first();
      if (pending) throw new ConvexError("Cancel or finish this account's pending posts before disconnecting.");
    }
    await ctx.db.patch(accountId, { active: false, updatedAt: Date.now() });
    return account;
  },
});
export const disconnect = action({
  args: { accountId: v.id('socialAccounts') },
  handler: async (ctx, args) => {
    const account = await ctx.runMutation(internal.social_connections.disconnectAccess, args);
    await deleteProviderAccount(account.providerId);
    return null;
  },
});
async function deleteProviderAccount(id: string) {
  try {
    await zernio(`/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (error) {
    if (!(error instanceof ProviderError && error.status === 404)) throw error;
  }
}
/** Account deletion: drop our rows now, detach Zernio accounts with retries. */
export const removeForUser = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => {
    const accounts = await ctx.db
      .query('socialAccounts')
      .withIndex('by_owner', (q) => q.eq('ownerId', ownerId))
      .collect();
    const providerIds = accounts.map((a) => a.providerId);
    for (const a of accounts) await ctx.db.delete(a._id);
    for (const table of ['socialConnections', 'socialProfiles'] as const) {
      const rows = await ctx.db.query(table).withIndex('by_owner', (q) => q.eq('ownerId', ownerId)).collect();
      for (const row of rows) await ctx.db.delete(row._id);
    }
    await ctx.runMutation(internal.social_posts.removeForUser, { ownerId });
    await ctx.runMutation(internal.social_media.removeForUser, { ownerId });
    if (providerIds.length)
      await ctx.scheduler.runAfter(0, internal.social_connections.deleteExternalAccounts, {
        accountIds: providerIds,
        attempt: 0,
      });
    return null;
  },
});
export const deleteExternalAccounts = internalAction({
  args: { accountIds: v.array(v.string()), attempt: v.number() },
  handler: async (ctx, args) => {
    const remaining: string[] = [];
    for (const id of args.accountIds) {
      try {
        await deleteProviderAccount(id);
      } catch {
        remaining.push(id);
      }
    }
    if (remaining.length)
      await ctx.scheduler.runAfter(
        Math.min(3_600_000, 10_000 * 2 ** Math.min(args.attempt, 9)),
        internal.social_connections.deleteExternalAccounts,
        { accountIds: remaining, attempt: args.attempt + 1 },
      );
    return null;
  },
});
