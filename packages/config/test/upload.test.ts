import { expect, test } from 'bun:test';
import { UploadError, describeError, planParts, runMultipartUpload, type MultipartIo } from '../src/upload';

function harness(size: number, partSize: number, putBehaviour?: (index: number, attempt: number) => void) {
  const calls: { operation: string; body: Record<string, unknown> }[] = [];
  const puts = new Map<number, number>();
  const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
  const count = Math.ceil(size / partSize);
  const io: MultipartIo = {
    async request(operation, body) {
      calls.push({ operation, body });
      if (operation === 'begin')
        return { id: 'row', uploadId: 'mp', partSize, urls: Array.from({ length: count }, (_, i) => `https://r2.example/part?partNumber=${i + 1}`) };
      return { ok: true };
    },
    read: async (start, end) => bytes.subarray(start, end),
    async put(url, body, onBytes) {
      const index = Number(new URL(url).searchParams.get('partNumber')) - 1;
      const attempt = (puts.get(index) ?? 0) + 1;
      puts.set(index, attempt);
      putBehaviour?.(index, attempt);
      onBytes((body as Uint8Array).byteLength);
    },
    sleep: async () => {},
  };
  return { io, calls, puts, bytes };
}

test('a small file is one part and completes through the Worker', async () => {
  const { io, calls, puts } = harness(1000, 8 * 1024 * 1024);
  const progress: number[] = [];
  const id = await runMultipartUpload(io, {
    size: 1000,
    request: { purpose: 'media', contentType: 'audio/wav' },
    onProgress: (p) => progress.push(p.sent),
  });
  expect(id).toBe('row');
  expect(puts.size).toBe(1);
  expect(calls.map((c) => c.operation)).toEqual(['begin', 'complete']);
  expect(calls[0]!.body).toEqual({ purpose: 'media', contentType: 'audio/wav', size: 1000 });
  expect(calls[1]!.body).toEqual({ purpose: 'media', id: 'row', uploadId: 'mp' });
  expect(progress.at(-1)).toBe(1000);
});

test('parts retry on retryable failures and every byte is covered exactly once', async () => {
  const size = 5 * 10 + 7;
  const { io, puts, bytes } = harness(size, 10, (index, attempt) => {
    if (index === 2 && attempt < 3) throw new UploadError('Upload failed (503)', true);
  });
  const seen: number[] = [];
  const read = io.read;
  io.read = async (start, end) => {
    seen.push(start, end);
    return read(start, end);
  };
  await runMultipartUpload(io, { size, request: { purpose: 'social', kind: 'video', contentType: 'video/mp4' }, concurrency: 2 });
  expect(puts.get(2)).toBe(3);
  expect(puts.size).toBe(6);
  expect(bytes.byteLength).toBe(size);
  expect(planParts(size, 10).at(-1)).toEqual({ start: 50, end: 57 });
  expect(Math.max(...seen)).toBe(size);
});

test('a non-retryable failure aborts the multipart upload on the Worker', async () => {
  const { io, calls } = harness(30, 10, (index) => {
    if (index === 1) throw new UploadError('Upload failed (403)', false);
  });
  await expect(
    runMultipartUpload(io, { size: 30, request: { purpose: 'library', kind: 'music', title: 't', mimeType: 'audio/mpeg' } }),
  ).rejects.toThrow('403');
  expect(calls.map((c) => c.operation)).toEqual(['begin', 'abort']);
});

test('cancelling stops the remaining parts and discards the object', async () => {
  const controller = new AbortController();
  const { io, calls, puts } = harness(40, 10, (index) => {
    if (index === 0) controller.abort();
  });
  await expect(
    runMultipartUpload(io, { size: 40, request: { purpose: 'media', contentType: 'video/mp4' }, signal: controller.signal, concurrency: 1 }),
  ).rejects.toThrow();
  expect(puts.size).toBe(1);
  expect(calls.at(-1)!.operation).toBe('abort');
});

test('size limits and error descriptions', async () => {
  const { io } = harness(1, 10);
  await expect(
    runMultipartUpload(io, { size: 101 * 1024 * 1024, request: { purpose: 'media', contentType: 'video/mp4' } }),
  ).rejects.toThrow('100 MiB');
  expect(describeError(new TypeError('fetch failed', { cause: new Error('ECONNRESET') }))).toBe('fetch failed: ECONNRESET');
  expect(describeError(new Error('plain'))).toBe('plain');
});
