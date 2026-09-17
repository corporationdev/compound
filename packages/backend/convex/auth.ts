import { getStageKind } from '@compound/config/stage-kind';
import { createClient, type AuthFunctions, type GenericCtx } from '@convex-dev/better-auth';
import { convex, crossDomain } from '@convex-dev/better-auth/plugins';
import { betterAuth, type BetterAuthOptions } from 'better-auth/minimal';
import { bearer, emailOTP } from 'better-auth/plugins';
import { organization } from 'better-auth/plugins/organization';
import { components, internal } from './_generated/api';
import type { DataModel } from './_generated/dataModel';
import { query } from './_generated/server';
import authConfig from './auth.config';
import authSchema from './betterAuth/schema';
import { createPersonalOrganization } from './lib/organizations';

/**
 * Whether this deployment accepts the fixed sign-in code. Only a developer's
 * own stage does: the machine dev deployment, a worktree sandbox, or a test
 * stage. Previews are reachable from the internet and production is
 * production; both keep the emailed code. A deployment with no STAGE set is
 * treated as production, so a missing variable never opens sign-in.
 */
export const SANDBOX_OTP = '000000';
export function acceptsSandboxOtp(stage = process.env.STAGE): boolean {
  return ['dev', 'sandbox', 'test'].includes(getStageKind(stage ?? ''));
}

// Typed up front to break the type cycle between this module and the generated api.
const authFunctions: AuthFunctions = internal.auth;
export const authComponent = createClient<DataModel, typeof authSchema>(components.betterAuth, {
  local: { schema: authSchema },
  authFunctions,
  triggers: {
    user: {
      // Runs inside the component's create mutation, so the user, their
      // personal organization and the owner membership commit together.
      onCreate: async (ctx, user) => {
        await createPersonalOrganization(ctx, user);
      },
    },
  },
});
export const { onCreate, onUpdate, onDelete } = authComponent.triggersApi();

/** Options only; the local component's adapter uses these to derive Better Auth's table set. */
export function createAuthOptions(ctx: GenericCtx<DataModel>) {
  const siteUrl = process.env.SITE_URL ?? 'http://localhost:5173';
  return {
    baseURL: process.env.CONVEX_SITE_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    trustedOrigins: [siteUrl, 'compound://'],
    database: authComponent.adapter(ctx),
    user: {
      deleteUser: {
        enabled: true,
        afterDelete: async (user) => {
          if (!('runMutation' in ctx))
            throw new Error('Account cleanup requires an action context');
          await ctx.runMutation(internal.uploads.removeForUser, { ownerId: user.id });
          await ctx.runMutation(internal.catalog.removeForUser, { ownerId: user.id });
          await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
            input: { model: 'member', where: [{ field: 'userId', value: user.id }] },
            paginationOpts: { numItems: 200, cursor: null },
          });
        },
      },
    },
    plugins: [
      // Native transport persists the signed session header, never a raw JWT.
      bearer({ requireSignature: true }),
      emailOTP({
        expiresIn: 600,
        allowedAttempts: 5,
        resendStrategy: 'reuse',
        changeEmail: { enabled: true, verifyCurrentEmail: true },
        // A developer stage issues the fixed code so agents and scripts can
        // sign in as any address without a mailbox; see acceptsSandboxOtp.
        ...(acceptsSandboxOtp() ? { generateOTP: () => SANDBOX_OTP } : {}),
        async sendVerificationOTP({ email, otp }) {
          if (acceptsSandboxOtp()) {
            console.log(`[auth] ${process.env.STAGE}: sign-in code for ${email} is ${otp} (not emailed on a developer stage)`);
            return;
          }
          const key = process.env.RESEND_API_KEY;
          const from = process.env.RESEND_FROM_EMAIL;
          if (!key || !from) throw new Error('Email delivery is not configured');
          const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from,
              to: email,
              subject: 'Your Compound verification code',
              text: `Your code is ${otp}. It expires in 10 minutes.`,
            }),
          });
          if (!response.ok) throw new Error('Could not send verification email');
        },
      }),
      organization({ allowUserToCreateOrganization: true }),
      crossDomain({ siteUrl }),
      convex({ authConfig }),
    ],
  } satisfies BetterAuthOptions;
}
export function createAuth(ctx: GenericCtx<DataModel>) {
  return betterAuth(createAuthOptions(ctx));
}
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    return user
      ? { id: user._id, email: user.email, name: user.name, image: user.image ?? null }
      : null;
  },
});
