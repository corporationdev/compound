import { createContext, createSignal, onCleanup, onMount, useContext, type JSX } from 'solid-js';
import {
  authClient,
  convex,
  getToken,
  invalidateToken,
  nativeAuth,
  readUser,
  requireBrowserConfig,
  type AppUser,
} from '@/lib/auth-client';
import { mainBridge } from '@/lib/ipc';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { setCatalogCacheScope } from '@/lib/catalog-cache';

function createAuth() {
  const [user, setUser] = createSignal<AppUser | null>(null);
  const [isLoading, setLoading] = createSignal(true);
  const [headless, setHeadless] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let revision = 0;
  const refreshSession = async () => {
    const current = ++revision;
    try {
      const [next, namespace] = await Promise.all([
        readUser(),
        window.desktop ? mainBridge.call(MAIN_CHANNELS.CLOUD_CONFIG, undefined).then(config => config.authUrl) : Promise.resolve(import.meta.env.VITE_CONVEX_SITE_URL),
      ]);
      if (current !== revision) return;
      if (next?.id !== user()?.id) invalidateToken();
      await setCatalogCacheScope(next ? JSON.stringify([namespace, next.id]) : null);
      if (current !== revision) return;
      setUser(next);
      setError(null);
      if (next) convex?.setAuth(getToken);
      else convex?.setAuth(async () => null);
    } catch (err) {
      if (current === revision)
        setError(err instanceof Error ? err.message : 'Could not restore session');
    } finally {
      if (current === revision) setLoading(false);
    }
  };
  const call = async (
    native: () => Promise<unknown>,
    browser: () => Promise<{ error: { message?: string } | null }>,
  ) => {
    if (window.desktop) {
      await native();
      return;
    }
    requireBrowserConfig();
    const result = await browser();
    if (result.error) throw new Error(result.error.message ?? 'Authentication failed');
  };
  const sendCode = (email: string) =>
    call(
      () => nativeAuth('sendCode', { email, type: 'sign-in' }),
      () => authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' }),
    );
  const verifyCode = async (email: string, otp: string) => {
    invalidateToken();
    await call(
      () => nativeAuth('verifyCode', { email, otp }),
      () => authClient.signIn.emailOtp({ email, otp }),
    );
    invalidateToken();
    await refreshSession();
  };
  const signOut = async () => {
    invalidateToken();
    await call(
      () => nativeAuth('signOut'),
      () => authClient.signOut(),
    );
    invalidateToken();
    revision++;
    void setCatalogCacheScope(null);
    setUser(null);
    convex?.setAuth(async () => null);
  };
  const updateProfile = async (name: string, image?: string) => {
    await call(
      () => nativeAuth('updateUser', { name, ...(image !== undefined ? { image } : {}) }),
      () => authClient.updateUser({ name, image }),
    );
    await refreshSession();
  };
  const deleteAccount = async () => {
    invalidateToken();
    await call(
      () => nativeAuth('deleteUser'),
      () => authClient.deleteUser(),
    );
    invalidateToken();
    revision++;
    void setCatalogCacheScope(null);
    setUser(null);
    convex?.setAuth(async () => null);
  };
  onMount(() => {
    void refreshSession();
    const restore = () => {
      void refreshSession();
    };
    window.addEventListener('online', restore);
    window.addEventListener('focus', restore);
    const interval = setInterval(restore, 5 * 60 * 1000);
    onCleanup(() => {
      clearInterval(interval);
      window.removeEventListener('online', restore);
      window.removeEventListener('focus', restore);
    });
    if (window.desktop) {
      void mainBridge.call(MAIN_CHANNELS.HEADLESS_GET_MODE, undefined).then(setHeadless);
      onCleanup(
        mainBridge.handle(MAIN_CHANNELS.HEADLESS_MODE, ({ active }) => setHeadless(active)),
      );
    }
  });
  return {
    user,
    isAuthenticated: () => !!user(),
    isLoading,
    headless,
    error,
    refreshSession,
    sendCode,
    verifyCode,
    signOut,
    updateProfile,
    deleteAccount,
  };
}
const AuthContext = createContext<ReturnType<typeof createAuth>>();
export function AuthProvider(props: { children: JSX.Element }) {
  return <AuthContext.Provider value={createAuth()}>{props.children}</AuthContext.Provider>;
}
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('Missing AuthProvider');
  return value;
}
