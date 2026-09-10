import { AwsClient } from 'aws4fetch';
import { requestProvider } from './providers';

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing transcription configuration: ${name}`);
  return value;
}
function objectUrl(key: string): string {
  return `https://${requireEnv('CLOUDFLARE_ACCOUNT_ID')}.r2.cloudflarestorage.com/${requireEnv('MEDIA_BUCKET_NAME')}/${key.split('/').map(encodeURIComponent).join('/')}`;
}
function signer() {
  return new AwsClient({
    accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
    service: 's3',
    region: 'auto',
  });
}
export async function signedAudioUrl(key: string): Promise<string> {
  return (
    await signer().sign(`${objectUrl(key)}?X-Amz-Expires=600`, {
      aws: { signQuery: true },
      method: 'GET',
    })
  ).url;
}
async function request(key: string, init: RequestInit = {}): Promise<Response> {
  const signed = await signer().sign(objectUrl(key), init);
  return requestProvider(
    signed.url,
    { ...init, headers: signed.headers },
    30000,
  );
}
export async function head(
  key: string,
): Promise<{ size: number; contentType: string }> {
  const response = await request(key, { method: 'HEAD' });
  if (!response.ok) throw new Error('Uploaded audio is unavailable');
  return {
    size: Number(response.headers.get('content-length')),
    contentType: response.headers.get('content-type') ?? '',
  };
}
export async function readRange(
  key: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 1 ||
    length > 180 * 32000
  )
    throw new Error('Invalid audio byte range');
  const response = await request(key, {
    headers: { Range: `bytes=${offset}-${offset + length - 1}` },
  });
  if (
    response.status !== 206 ||
    Number(response.headers.get('content-length')) !== length
  ) {
    await response.body?.cancel();
    throw new Error('Audio range download was not bounded');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== length) throw new Error('Audio range was truncated');
  return bytes;
}
export async function readArtifact<T>(key: string): Promise<T | null> {
  const response = await request(key);
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) throw new Error('Transcription artifact is unavailable');
  const declared = response.headers.get('content-length');
  const limit = 16 * 1024 * 1024;
  if (declared && Number(declared) > limit) {
    await response.body?.cancel();
    throw new Error('Transcription artifact exceeds its limit');
  }
  // R2/Convex can omit Content-Length on streamed or decoded JSON responses.
  // Enforce the bound on actual bytes, not the presence of that header.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty transcription artifact');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error('Transcription artifact exceeds its limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}
export async function writeArtifact(
  key: string,
  value: unknown,
): Promise<void> {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 16 * 1024 * 1024)
    throw new Error('Transcript exceeds its limit');
  const response = await request(key, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!response.ok) throw new Error('Could not save transcription artifact');
  await response.body?.cancel();
}
