import { createAuthClient } from 'better-auth/solid';
import { emailOTPClient } from 'better-auth/client/plugins';
import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins';
import { ConvexClient } from 'convex/browser';
import { mainBridge } from './ipc';
import { createNativeSession } from './native-session';
import { MAIN_CHANNELS } from '@desktop/main-channels';

export type AppUser = {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  emailVerified?: boolean;
};
export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_CONVEX_SITE_URL || 'http://localhost:3211',
  plugins: [
    emailOTPClient(),
    convexClient(),
    crossDomainClient({
      storagePrefix: `compound:${import.meta.env.VITE_CONVEX_SITE_URL ?? 'unconfigured'}`,
    }),
  ],
});
export const convex = import.meta.env.VITE_CONVEX_URL
  ? new ConvexClient(import.meta.env.VITE_CONVEX_URL)
  : null;
export const nativeAuth = createNativeSession({
  storage: () => window.localStorage,
  authUrl: async () => (await mainBridge.call(MAIN_CHANNELS.CLOUD_CONFIG, undefined)).authUrl,
  request: (data) => mainBridge.call(MAIN_CHANNELS.CLOUD_AUTH, data),
});
export async function getToken(): Promise<string | null> {
  if (window.desktop)
    return ((await nativeAuth('token')) as { token?: string } | null)?.token ?? null;
  requireBrowserConfig();
  const { data, error } = await authClient.convex.token();
  if (error) throw new Error(error.message ?? 'Could not obtain session token');
  return data?.token ?? null;
}
export function requireBrowserConfig() {
  if (!import.meta.env.VITE_CONVEX_URL || !import.meta.env.VITE_CONVEX_SITE_URL)
    throw new Error(
      'Cloud is not configured. Run bun run setup after creating the Compound secrets.',
    );
}
export async function readUser(): Promise<AppUser | null> {
  if (window.desktop)
    return ((await nativeAuth('session')) as { user?: AppUser } | null)?.user ?? null;
  requireBrowserConfig();
  const { data, error } = await authClient.getSession();
  if (error) throw new Error(error.message);
  return data?.user ?? null;
}
