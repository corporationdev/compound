import { getToken } from './auth-client';
import { mainBridge } from './ipc';
import { MAIN_CHANNELS } from '@desktop/main-channels';
export type TranscriptSegment = {
  text: string;
  words: { text: string; start: number; end: number }[];
};
export type FileRef = { uploadId: string };
export async function mediaRequest<T>(
  path: 'upload-url' | 'transcribe' | 'analyze',
  body: Record<string, unknown>,
): Promise<T> {
  if (window.desktop)
    return (await mainBridge.call(MAIN_CHANNELS.CLOUD_MEDIA, { path, body })) as T;
  const server = import.meta.env.VITE_SERVER_URL;
  if (!server) throw new Error('Media service is not configured');
  const token = await getToken();
  if (!token) throw new Error('Sign in required');
  const response = await fetch(`${server}/media/${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(255000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Media request failed');
  return result as T;
}
export const transcribe = async (file: FileRef) =>
  (await mediaRequest<{ segments: TranscriptSegment[] }>('transcribe', file)).segments;
export const analyze = async (file: FileRef, prompt?: string) =>
  (await mediaRequest<{ result: string }>('analyze', { ...file, prompt })).result;
