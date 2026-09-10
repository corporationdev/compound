import { AwsClient } from 'aws4fetch';
import { fetchBytes } from '../convex/catalog_providers/http';
import { MAX_CATALOG_UPLOAD_BYTES } from '../catalog';

function value(key: string) {
  const result = process.env[key]?.trim();
  if (!result) throw new Error(`Missing library configuration: ${key}`);
  return result;
}
function location(key: string) {
  if (!key.startsWith('library/') && !key.startsWith('library-staging/')) throw new Error('Invalid library object');
  return `https://${value('CLOUDFLARE_ACCOUNT_ID')}.r2.cloudflarestorage.com/${value('MEDIA_BUCKET_NAME')}/${key.split('/').map(encodeURIComponent).join('/')}`;
}
function signer() {
  return new AwsClient({ accessKeyId: value('R2_ACCESS_KEY_ID'), secretAccessKey: value('R2_SECRET_ACCESS_KEY'), service: 's3', region: 'auto' });
}
export async function catalogUrl(key: string, method: 'GET' | 'PUT' = 'GET', mimeType?: string) {
  return (await signer().sign(`${location(key)}?X-Amz-Expires=900`, { method, ...(mimeType ? { headers: { 'Content-Type': mimeType } } : {}), aws: { signQuery: true } })).url;
}
export async function readCatalogObject(key: string) {
  const url = await catalogUrl(key);
  return fetchBytes(url, { hosts: [new URL(url).hostname], maxBytes: MAX_CATALOG_UPLOAD_BYTES, timeoutMs: 120000 });
}
export async function writeCatalogObject(key: string, bytes: Uint8Array, mimeType: string) {
  const body = bytes as Uint8Array<ArrayBuffer>;
  const request = await signer().sign(location(key), { method: 'PUT', headers: { 'Content-Type': mimeType }, body });
  const response = await fetch(request, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('Could not store library audio');
  await response.body?.cancel();
}
export async function deleteCatalogObject(key: string) {
  const request = await signer().sign(location(key), { method: 'DELETE' });
  const response = await fetch(request, { signal: AbortSignal.timeout(30000) });
  if (!response.ok && response.status !== 404) throw new Error('Could not remove library audio');
  await response.body?.cancel();
}
