/**
 * Zernio is a plain HTTPS API; this is the whole client. Ported from PostBob's
 * social_provider.ts so response handling matches a tested integration.
 */
export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function string(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
/** Zernio returns ids either bare or as `{ _id }` depending on the endpoint. */
export function providerId(value: unknown): string | undefined {
  return string(value) ?? string(record(value)._id);
}
export class ProviderError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly retryAfterMs: number;
  constructor(message: string, status: number, body: Record<string, unknown>, retryAfterMs = 0) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
  get retryable() {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}
function retryAfterMilliseconds(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}
export const ZERNIO_BASE_URL = 'https://zernio.com/api/v1';
export async function zernio(path: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
  const key = process.env.ZERNIO_API_KEY?.trim();
  if (!key) throw new ProviderError('Social posting is not configured for this deployment.', 503, {});
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${key}`);
  if (options.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${ZERNIO_BASE_URL}${path}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(25_000),
  });
  const result = record(await response.json().catch(() => null));
  if (!response.ok) {
    throw new ProviderError(
      string(result.error) ?? string(result.message) ?? `Posting service returned ${response.status}`,
      response.status,
      result,
      retryAfterMilliseconds(response.headers.get('retry-after')),
    );
  }
  return result;
}
export async function hashToken(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
