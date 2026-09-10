import { test, expect, mock, jest, afterEach } from 'bun:test';
let token = '';
let handle: (request: any) => Promise<unknown>;
mock.module('../src/lib/auth-client', () => ({ getToken: async () => token }));
mock.module('../src/lib/ipc', () => ({ mainBridge: { call: async (_channel: string, request: unknown) => handle(request) } }));
mock.module('@desktop/main-channels', () => ({ MAIN_CHANNELS: { CLOUD_MEDIA: 'cloud:media', CLOUD_UPLOAD: 'cloud:upload' } }));
const { transcribe } = await import('../src/lib/media-api');
const { uploadBlob } = await import('../src/lib/uploads');
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'window', { value: { desktop: true }, configurable: true });
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
}, configurable: true });
const segments = [{ text: 'Hello.', words: [{ text: 'Hello.', start: .1, end: .4 }] }];
afterEach(() => { jest.useRealTimers(); storage.clear(); });

test('the existing transcribe function returns unchanged captions after waiting on a job', async () => {
  token = 'test';
  jest.useFakeTimers();
  let polls = 0;
  handle = async request => {
    if (request.path === 'transcribe') return { jobId: 'job' };
    expect(request.path).toBe('transcribe-status');
    expect(request.body).toEqual({ jobId: 'job' });
    return ++polls === 1 ? { status: 'running', stage: 'aligning' } : { status: 'ready', segments };
  };
  const result = transcribe({ uploadId: 'upload' });
  for (let i = 0; i < 20 && polls < 2; i++) { await Promise.resolve(); jest.advanceTimersByTime(5000); }
  expect(await result).toEqual(segments);
  expect(polls).toBe(2);
});

test('legacy results work and failed jobs reject without polling forever', async () => {
  token = 'test';
  handle = async () => ({ segments });
  expect(await transcribe({ uploadId: 'old' })).toEqual(segments);
  handle = async r => r.path === 'transcribe' ? { jobId: 'job' } : { status: 'failed', error: 'Alignment failed' };
  await expect(transcribe({ uploadId: 'new' })).rejects.toThrow('Alignment failed');
});

test('upload reuse survives repeated calls but respects scene seed and account boundaries', async () => {
  const jwt = (user: string) => 'header.' + btoa(JSON.stringify({ iss: 'https://test.convex.site', sub: user })) + '.signature';
  token = jwt('alice');
  let uploads = 0;
  handle = async () => ({ uploadId: `upload-${++uploads}` });
  const wav = new Blob(['pcm'], { type: 'audio/wav' });
  const first = await uploadBlob(wav, 'scene:0');
  expect(await uploadBlob(wav, 'scene:0')).toEqual(first);
  expect(uploads).toBe(1);
  expect(await uploadBlob(wav, 'scene:1')).not.toEqual(first);
  token = jwt('bob');
  expect(await uploadBlob(wav, 'scene:0')).not.toEqual(first);
  expect(uploads).toBe(3);
});
