# `compound media transcribe <path>`

Uses Deepgram, conservative Gemini recovery of omitted/cut-off words, and wav2vec2 forced alignment for English. The command, caption controls, and JSON output are unchanged. Other or undetected languages retain Deepgram timing. Prepared mono 16 kHz PCM WAV audio is limited to 100 MiB (about 55 minutes).


Transcribes the speech in a video or audio asset and returns the timed transcript. Word-level start/end times are in **seconds** (source/content time).

## Input

- `<path>`: a local video or audio file to transcribe in place without adding it to the library, or a project library path (required; library paths need an open project).

The whole asset is cached in memory. A temporary, account-scoped upload reference lets the same prepared audio rejoin its cloud job after an app restart for up to 23 hours. Provider stages are checkpointed so retrying a failed job reuses completed work. Existing generated captions remain local; changing their seed regenerates them.

## Output

One JSON object, the transcript:

```ts
{
  segments: Array<{
    text:  string;      // spoken words only (no silence markers)
    words: Array<{ text: string; start: number; end: number }>;  // seconds
  }>;
}
```

## Errors

Exits non-zero if the path can't be resolved or the asset is not a video/audio asset, or if no speech is detected in the audio at all (`No speech detected`).
