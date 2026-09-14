import { getToken } from './auth-client';
import { mainBridge } from './ipc';
import { MAIN_CHANNELS } from '@desktop/main-channels';
export type TranscriptSegment = {
  text: string;
  words: { text: string; start: number; end: number }[];
};
export type FileRef = { uploadId: string };
export async function mediaRequest<T>(
  path:
    | 'transcribe'
    | 'transcribe-status'
    | 'transcribe-cancel'
    | 'analyze'
    | `catalog-${'list' | 'get' | 'artwork' | 'search' | 'search-status' | 'resolve' | 'prepare' | 'playback' | 'save' | 'remove'}`,
  body: Record<string, unknown>,
  accessToken?: string,
): Promise<T> {
  const token = accessToken ?? (await getToken());
  if (!token) throw new Error('Sign in required');
  if (window.desktop)
    return (await mainBridge.call(MAIN_CHANNELS.CLOUD_MEDIA, {
      path: `/media/${path}`,
      body,
      token,
    })) as T;
  const server = import.meta.env.VITE_SERVER_URL;
  if (!server) throw new Error('Media service is not configured');
  const response = await fetch(`${server}/media/${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(255000),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Media request failed');
  return result as T;
}
export async function transcribe(file: FileRef): Promise<TranscriptSegment[]> {
  // Reuse the short-lived JWT while polling so concurrent jobs do not hit the
  // email-auth endpoint's request limit. Every Worker request still checks the
  // backing session, so sign-out/account deletion revoke access immediately.
  let token = await getToken();
  if (!token) throw new Error('Sign in required');
  let refreshAt = tokenRefreshTime(token);
  const result = await mediaRequest<{
    segments?: TranscriptSegment[];
    jobId?: string;
  }>('transcribe', file, token);
  // Old clients/uploads can still use the direct Deepgram route during rollout.
  if (result.segments) return result.segments;
  if (!result.jobId) throw new Error('Transcription did not start');
  for (;;) {
    if (Date.now() >= refreshAt) {
      token = await getToken();
      if (!token) throw new Error('Sign in required');
      refreshAt = tokenRefreshTime(token);
    }
    const job = await mediaRequest<{
      status: string;
      segments?: TranscriptSegment[];
      error?: string;
    }>('transcribe-status', { jobId: result.jobId }, token);
    if (job.status === 'ready' && job.segments) return job.segments;
    if (job.status === 'failed' || job.status === 'canceled')
      throw new Error(job.error ?? 'Transcription was canceled');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
export const analyze = async (file: FileRef, prompt?: string) =>
  (await mediaRequest<{ result: string }>('analyze', { ...file, prompt }))
    .result;

function tokenRefreshTime(token: string): number {
  const nextMinute = Date.now() + 60000;
  try {
    const payload = JSON.parse(
      atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')),
    );
    return typeof payload.exp === 'number'
      ? Math.min(nextMinute, payload.exp * 1000 - 30000)
      : nextMinute;
  } catch {
    return nextMinute;
  }
}
