/** Coalesce token requests and reuse a valid token briefly during job polling. */
export function createAccessToken(load: () => Promise<string | null>, now = Date.now) {
  let generation = 0;
  let cached: { token: string; until: number } | undefined;
  let pending: Promise<string | null> | undefined;
  const invalidate = () => { generation++; cached = undefined; pending = undefined; };
  const get = () => {
    if (cached && cached.until > now()) return Promise.resolve(cached.token);
    if (pending) return pending;
    const current = generation;
    const request = load().then(token => {
      if (current !== generation) return null;
      if (token) {
        try {
          const payload = token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
          const { exp } = JSON.parse(atob(payload));
          const until = Math.min(now() + 60_000, Number(exp) * 1000 - 30_000);
          if (Number.isFinite(until) && until > now()) cached = { token, until };
        } catch { /* A token without a readable expiry is never cached. */ }
      }
      return token;
    }).finally(() => { if (pending === request) pending = undefined; });
    pending = request;
    return request;
  };
  return { get, invalidate };
}
