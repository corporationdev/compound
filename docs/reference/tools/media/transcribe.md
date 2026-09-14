# media_transcribe

Transcribe the speech in a video or audio file and write the timed transcript to a JSON file, with word-level start/end times in seconds; returns the file's path and its segment and word counts. Commonly useful for footage with speakers (talking head, interview), where the word times let you cut on a line. A transcript marks only speech; the gaps are not necessarily silent (music, score, applause).

Compound transcribes with Deepgram, recovers omitted or cut-off words with a conservative Gemini pass, and refines English word timings with wav2vec2 forced alignment. The tool, its caption controls, and its JSON output are unchanged. Other or undetected languages keep Deepgram timing. Prepared mono 16 kHz PCM WAV audio is limited to 100 MiB (about 55 minutes).

| | |
| --- | --- |
| MCP tool | `media_transcribe` |
| CLI | `compound media transcribe <path>` |

## Input

| Field | Type | CLI | Description |
| --- | --- | --- | --- |
| `path` | `string`, required | `<path>` | absolute file path or URL (works with or without an open project), or a library path like `b-roll/clip.mp4` (needs an open project) |
| `output` | `string` | `-o, --output <path>` | absolute path to write the transcript JSON to (default: a fresh file under the system temp dir) |

Times are in **seconds** of source/content time. An `output` naming an existing directory gets a fresh `compound-transcript-*.json` inside it. The whole asset is cached in memory. A temporary, account-scoped upload reference lets the same prepared audio rejoin its cloud job after an app restart for up to 23 hours. Provider stages are checkpointed, so retrying a failed job reuses completed work. Existing generated captions stay local; changing their seed regenerates them. Every call writes the file again, so a cached transcript returns at once.

## Output

One JSON object, where the transcript went and how large it is:

```ts
{
  path:     string;   // absolute path of the transcript JSON
  segments: number;   // segments in the transcript
  words:    number;   // words across all segments
}
```

The file holds the transcript as indented JSON, so it searches line by line: a grep for a phrase lands on its segment's `text`, with the word times in the lines after it. Search it (grep, jq) or read the part you need rather than loading it whole — a long recording's word timings run to tens of thousands of tokens.

```ts
{
  segments: Array<{
    text:  string;      // spoken words only (no silence markers)
    words: Array<{ text: string; start: number; end: number }>;  // seconds
  }>;
}
```

## Errors

Fails when the path can't be resolved, the asset is not a video/audio asset, or no speech is detected in the audio at all (`No speech detected`).
