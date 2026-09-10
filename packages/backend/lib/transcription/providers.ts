import { DEEPGRAM_MODEL, GEMINI_MODEL } from '@compound/config/models';
import { z } from 'zod';
import {
  parseDeepgramResponse,
  parseVerbatim,
  type DeepgramTranscript,
} from './audio';

const deepgramSchema = z.object({
  results: z.object({
    channels: z
      .array(
        z.object({
          detected_language: z.string().optional(),
          alternatives: z.array(
            z.object({
              transcript: z.string(),
              words: z.array(
                z.object({
                  start: z.number().nonnegative(),
                  end: z.number().nonnegative(),
                  word: z.string(),
                  punctuated_word: z.string().optional(),
                }),
              ),
            }),
          ),
        }),
      )
      .min(1),
    utterances: z
      .array(
        z.object({
          start: z.number(),
          end: z.number(),
          transcript: z.string(),
        }),
      )
      .optional(),
  }),
});
const verbatimPrompt =
  'Transcribe this talking-head recording exactly as spoken, verbatim, start to finish. Include every repeated word, filler, stutter, and false start; the speaker often restarts a sentence several times, and every attempt must appear. Write a word that is cut off mid-way as its audible fragment followed by a dash (e.g. "actua—"). If the audio begins or ends in the middle of a word, write that partial word with a dash on the cut side. Do not add words you do not hear. Do not fix grammar. Do not summarize or skip anything. Return JSON only: {"verbatim": "..."}';

// Retry transport failures only. Three 180s Gemini attempts fit inside a Node
// action; deterministic schema/merge/acoustic errors are not retried here.
export async function requestProvider(
  url: string,
  init: RequestInit,
  timeoutMs = 180000,
  attempts = 3,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      if (attempt >= attempts)
        throw new Error('Provider request timed out or could not connect');
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      continue;
    }
    if (response.ok || response.status === 404) return response;
    await response.body?.cancel();
    if (
      (response.status !== 429 && response.status < 500) ||
      attempt >= attempts
    )
      throw new Error(`Provider request failed (HTTP ${response.status})`);
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
}

export async function deepgram(
  audioUrl: string,
  apiKey: string,
  language?: string,
): Promise<DeepgramTranscript> {
  const query = new URLSearchParams({
    model: DEEPGRAM_MODEL,
    smart_format: 'true',
    punctuate: 'true',
    utterances: 'true',
    filler_words: 'true',
    ...(language ? { language } : { detect_language: 'true' }),
  });
  const response = await requestProvider(
    `https://api.deepgram.com/v1/listen?${query}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: audioUrl }),
    },
    240000,
    2,
  );
  if (!response.ok) throw new Error('Deepgram transcription is unavailable');
  const parsed = parseDeepgramResponse(
    deepgramSchema.parse(await response.json()),
  );
  for (const word of parsed.words) {
    if (word.endUs < word.startUs || !word.text.trim())
      throw new Error('Deepgram returned invalid words');
  }
  return parsed;
}

export async function geminiVerbatim(
  wavBase64: string,
  apiKey: string,
): Promise<string> {
  const response = await requestProvider(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: verbatimPrompt },
              { inlineData: { mimeType: 'audio/wav', data: wavBase64 } },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0,
        },
      }),
    },
  );
  if (!response.ok) throw new Error('Gemini transcription is unavailable');
  const result = z
    .object({
      candidates: z
        .array(
          z.object({
            finishReason: z.string().optional(),
            content: z.object({
              parts: z.array(
                z.object({
                  text: z.string().optional(),
                  thought: z.boolean().optional(),
                }),
              ),
            }),
          }),
        )
        .min(1),
    })
    .parse(await response.json());
  const candidate = result.candidates[0];
  if (candidate.finishReason && candidate.finishReason !== 'STOP')
    throw new Error('Gemini transcription was incomplete');
  const text = candidate.content.parts
    .filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('');
  // A valid empty transcript is useful for silence-only chunks.
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.verbatim === 'string') return parsed.verbatim;
  } catch {
    /* PostBob tolerates an omitted closing quote/brace. */
  }
  const verbatim = parseVerbatim(text);
  if (!verbatim.trim()) throw new Error('Gemini returned no usable transcript');
  return verbatim;
}
