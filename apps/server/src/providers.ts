import { z } from 'zod';
export type TranscriptSegment = {
  text: string;
  words: { text: string; start: number; end: number }[];
};
const wordSchema = z.object({
  word: z.string(),
  punctuated_word: z.string().optional(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});
const deepgramSchema = z.object({
  results: z.object({
    channels: z.array(
      z.object({
        alternatives: z.array(z.object({ transcript: z.string(), words: z.array(wordSchema) })),
      }),
    ),
  }),
});
export function parseTranscript(value: unknown): TranscriptSegment[] {
  const result = deepgramSchema.parse(value).results.channels[0]?.alternatives[0];
  if (!result || !result.words.length) return [];
  const segments: TranscriptSegment[] = [];
  let current: TranscriptSegment = { text: '', words: [] };
  for (const word of result.words) {
    if (word.end < word.start) throw new Error('Invalid transcript timing');
    const text = word.punctuated_word ?? word.word;
    current.words.push({ text, start: word.start, end: word.end });
    current.text = current.words.map((w) => w.text).join(' ');
    if (/[.!?]$/.test(text) || current.words.length >= 30) {
      segments.push(current);
      current = { text: '', words: [] };
    }
  }
  if (current.words.length) segments.push(current);
  return segments;
}
async function checkedJson(response: Response, provider: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${provider} request failed (${response.status})`);
  return response.json();
}
export async function transcribe(
  input: { key: string; model: string; url: string; language?: string; signal: AbortSignal },
  fetcher: typeof fetch = fetch,
) {
  const url = new URL('https://api.deepgram.com/v1/listen');
  url.search = new URLSearchParams({
    model: input.model,
    smart_format: 'true',
    punctuate: 'true',
    ...(input.language ? { language: input.language } : { detect_language: 'true' }),
  }).toString();
  return parseTranscript(
    await checkedJson(
      await fetcher(url, {
        method: 'POST',
        signal: input.signal,
        headers: { Authorization: `Token ${input.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: input.url }),
      }),
      'Deepgram',
    ),
  );
}
const fileSchema = z.object({
  name: z.string().regex(/^files\/[a-zA-Z0-9_-]+$/),
  uri: z.string().url(),
  mimeType: z.string().optional(),
  state: z.enum(['ACTIVE', 'PROCESSING', 'FAILED']),
});
const analysisSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z.array(
              z.object({ text: z.string().optional(), thought: z.boolean().optional() }),
            ),
          })
          .optional(),
      }),
    )
    .optional(),
});
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export async function analyze(
  input: {
    key: string;
    model: string;
    body: ReadableStream;
    size: number;
    contentType: string;
    prompt?: string;
    signal: AbortSignal;
  },
  fetcher: typeof fetch = fetch,
) {
  const base = 'https://generativelanguage.googleapis.com';
  const headers = { 'x-goog-api-key': input.key, 'Content-Type': 'application/json' };
  let fileName: string | undefined;
  try {
    const start = await fetcher(`${base}/upload/v1beta/files`, {
      method: 'POST',
      signal: input.signal,
      headers: {
        ...headers,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(input.size),
        'X-Goog-Upload-Header-Content-Type': input.contentType,
      },
      body: JSON.stringify({ file: { display_name: 'compound-media' } }),
    });
    if (!start.ok) throw new Error(`Gemini upload could not start (${start.status})`);
    const uploadUrl = start.headers.get('x-goog-upload-url');
    if (!uploadUrl || new URL(uploadUrl).origin !== base)
      throw new Error('Gemini returned an invalid upload endpoint');
    const uploaded = await fetcher(uploadUrl, {
      method: 'POST',
      signal: input.signal,
      headers: {
        'Content-Length': String(input.size),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: input.body,
    });
    let file = fileSchema.parse(
      z.object({ file: z.unknown() }).parse(await checkedJson(uploaded, 'Gemini upload')).file,
    );
    fileName = file.name;
    while (file.state === 'PROCESSING') {
      await pause(1500, input.signal);
      file = fileSchema.parse(
        await checkedJson(
          await fetcher(`${base}/v1beta/${file.name}`, { headers, signal: input.signal }),
          'Gemini status',
        ),
      );
    }
    if (file.state !== 'ACTIVE') throw new Error('Gemini could not process this media');
    const response = await fetcher(
      `${base}/v1beta/models/${encodeURIComponent(input.model)}:generateContent`,
      {
        method: 'POST',
        headers,
        signal: input.signal,
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { fileData: { fileUri: file.uri, mimeType: input.contentType } },
                {
                  text:
                    input.prompt ||
                    'Describe this media accurately. Include useful timestamps where possible.',
                },
              ],
            },
          ],
        }),
      },
    );
    const result = analysisSchema.parse(await checkedJson(response, 'Gemini'));
    const text = result.candidates?.[0]?.content?.parts
      .filter((p) => !p.thought)
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!text) throw new Error('Gemini returned no analysis for this media');
    return text;
  } finally {
    if (fileName)
      await fetcher(`${base}/v1beta/${fileName}`, {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
  }
}
