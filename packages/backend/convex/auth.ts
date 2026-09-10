import { createClient, type GenericCtx } from '@convex-dev/better-auth';
import { convex, crossDomain } from '@convex-dev/better-auth/plugins';
import { betterAuth } from 'better-auth/minimal';
import { bearer, emailOTP } from 'better-auth/plugins';
import { components, internal } from './_generated/api';
import type { DataModel } from './_generated/dataModel';
import { query } from './_generated/server';
import authConfig from './auth.config';

export const authComponent = createClient<DataModel>(components.betterAuth);
export function createAuth(ctx: GenericCtx<DataModel>) {
  const siteUrl = process.env.SITE_URL ?? 'http://localhost:5173';
  return betterAuth({
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
        async sendVerificationOTP({ email, otp }) {
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
      crossDomain({ siteUrl }),
      convex({ authConfig }),
    ],
  });
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
