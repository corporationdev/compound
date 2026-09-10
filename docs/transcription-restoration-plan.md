# Restore corrected and aligned transcription

Proposed September 9, 2026, from inspection of the current Compound and sibling PostBob checkouts. Implementation is now present in this checkout; the detailed sections below retain the original proposal. See cloud-setup.md for the implemented behavior and deployment steps.

## Recommendation

Use **Convex Workflow for durable orchestration, Convex Node actions for transcription provider calls, Modal for wav2vec2 inference, and the existing Worker/R2 for uploads and media delivery**. Audio preparation and final caption files remain local.

The requirement is durable execution, not Convex specifically. Cloudflare Workflows could also own the job, but Convex is the shorter adaptation of PostBob's working design, already owns Compound authentication/upload records, and supports reactive job progress. Introducing Cloudflare Workflows would require another workflow integration and coordination with Convex. Keeping provider adapters in the Worker is technically possible, but would add an internal authenticated RPC hop to every Convex step. Prefer direct Node actions for this pipeline.

Compound currently imposes a 240-second Worker request deadline, 255-second browser/Electron media deadlines, and a 600-second CLI generation deadline. Increasing these is insufficient for recovery after disconnects and multi-stage retries. HTTP Workers themselves have no fixed wall-clock limit while connected, but `waitUntil` only extends execution up to 30 seconds after response/disconnect. [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/)

Convex Workflow checkpoints completed steps and supports retries/cancellation. Node actions still have a ten-minute execution limit and 512 MiB memory; make each provider chunk a separate action. Store large transcript artifacts outside workflow return values: Convex documents have a 1 MiB limit, and workflow journals also have size constraints. [Convex Workflow](https://www.convex.dev/components/workflow), [Convex limits](https://docs.convex.dev/production/state/limits), [workflow implementation guidance](https://github.com/get-convex/workflow)

| Responsibility | Location |
| --- | --- |
| Extract source audio; render edited scene mix | Local Compound runtime/encoder |
| Upload authorization, signed R2 upload URLs, result delivery | Existing Worker |
| Ownership, job identity, status, retries, cancellation | Convex mutations + Workflow |
| Deepgram, Gemini audio chunks, merge logic, Modal client calls | Convex Node actions |
| Torch/wav2vec2 inference | Dedicated Compound Modal app |
| Temporary WAV and stage/result JSON | R2; Convex stores references and small metadata |
| Final transcript/caption JSON | Local project library |

## What the code does today

Compound:

- `apps/server/src/providers.ts` calls Deepgram `nova-3` with punctuation, smart formatting, and language detection. It keeps word timestamps unchanged and groups words at sentence punctuation or 30 words. There is no correction or alignment stage.
- `apps/server/src/index.ts` executes transcription inside the HTTP request. Convex only stores upload ownership, expiry and a provider-call counter; there is no job table or workflow component.
- `packages/runtime/src/media/transcode.ts` prepares asset transcription as 16 kHz mono Opus/Ogg.
- `apps/web/src/utils/gen-ai.ts` separately renders scene captions as 24 kHz Opus/Ogg, using the encoder's default two channels. Captions describe the edited scene mix.
- `apps/web/src/context/dapi/media.ts` caches source transcripts by asset ID. Scene captions use a generation key and store the returned segment array locally.

PostBob's production entry point is `packages/backend/convex/transcription_workflow_batched.ts`, started from `assets.ts`. The older `transcription_workflow.ts` also holds the shared manager/completion handler, but its monolithic provider action is not the entry point to copy.

1. Read metadata from the uploaded 16 kHz mono PCM16 WAV using bounded R2 range reads. Deepgram fetches the WAV by signed URL. PostBob uses `nova-2`, utterances, filler words and creator vocabulary hints.
2. Independently ask Gemini for a verbatim transcript, **without showing it Deepgram's text**. Split at provider-word gaps into pieces of at most three minutes. These are rough provider gaps, not a separate VAD pass. Each Gemini piece is checkpointed.
3. Diff Gemini's words against Deepgram using `packages/timeline/src/seam-merge.ts`. Accept omitted-word insertions and the same word marked as a cut-off fragment. Reject general substitutions, deletions and paraphrases. The code comments document why: its historical evaluation found arbitrary replacements substantially less reliable than omission recovery. This is not a general spelling-replacement pass.
4. Persist the corrected word sequence before alignment so alignment can be retried independently.
5. Call the Modal aligner in batches of up to two 150-second segments. Repair overlaps at segment/batch seams, validate exact word identity/order and non-overlapping in-bounds timestamps, then rebuild segments.

PostBob's `apps/wav2vec-aligner` runs Torch on **4 CPUs and 4 GiB RAM**, with a five-minute method timeout; it does not currently use a GPU. Preserve its number/time normalization, partial-word handling, seam repair and fallback placement for unalignable tokens. The deployed model is `WAV2VEC2_ASR_BASE_960H`, trained on LibriSpeech: treat this port as English alignment and retain Deepgram timing for other/uncertain languages until a multilingual aligner is evaluated. [Model documentation](https://docs.pytorch.org/audio/2.0.0/generated/torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H.html)

## Implementation sequence

### 1. Extract the tested transcription core

Keep the helpers in `packages/backend/lib/transcription` with the required pure types and helpers from PostBob's `transcript-pipeline.ts`, `seam-merge.ts`, and `forced-alignment.ts`. Separate provider adapters from algorithms and keep integer microseconds internally. Port the relevant tests and recorded fixtures alongside the code; omit the legacy VAD timing-correction pipeline except any necessary shared types.

Keep Compound's current `nova-3` initially, explicitly enable the verbatim options supported by that model, and evaluate the port against fresh Nova-3 output as well as recorded PostBob cases. Parameterize model selection through `packages/config/src/models.ts`. Preserve the conservative Gemini merge policy. General name/spelling correction would be a separate evaluated feature; PostBob's creator-vocabulary storage is not a prerequisite for this restoration.

### 2. Normalize both local audio paths

Produce one canonical **16 kHz, mono, signed 16-bit PCM WAV** for enhanced transcription. Update asset extraction and add WAV/PCM support to the scene encoder path (`packages/encoder/src/types.ts`, `format.ts`, and codec handling as needed). Encode the rendered scene mix directly; avoid an intermediate lossy Opus round trip.

Allow `audio/wav` in both Worker and Convex upload validation. Validate RIFF chunks, sample rate, channel count and PCM format on the backend; do not trust the declared MIME type. Keep Ogg accepted for existing clients during rollout.

WAV changes the size tradeoff: 32,000 bytes/second is about 110 MiB/hour, so the current 100 MiB cap allows only about **54.6 minutes**. Initially retain that cap with duration-aware validation before encoding. Longer recordings need a separate decision to raise all client/server limits and address memory copies. Desktop uploads currently materialize an ArrayBuffer for IPC, and scene rendering also allocates audio buffers; test these paths near the cap.

### 3. Add a durable job API

Add a `transcriptionJobs` table and register `@convex-dev/workflow`. Suggested metadata: owner/upload ID, pipeline version, options hash, workflow ID, status, current stage/chunk, attempt generation, timestamps, artifact keys, language, error, expiry and quality summary.

Use an authenticated start operation that atomically deduplicates by owner, upload, pipeline version and options. Repeated polling/reconnection must not consume additional `uploads.claim` calls. Claim once per accepted job; provider retries belong to the workflow. Never persist the user's bearer token in job state.

The Worker validates the uploaded object and starts the job, returning `{ jobId }` promptly. Add authenticated status/result/retry/cancel operations through the existing media bridge; optionally use Convex subscriptions for editor progress. Resolve storage keys server-side from owned records. Result download URLs are issued only after an ownership check.

Checkpoint Deepgram output, each Gemini response, merged words, each alignment batch/seam repair, and the final result under deterministic R2 keys. Workflow steps return artifact references and bounded summaries rather than whole recordings or whole transcript histories. Put sizeable merge/validation work in actions, with a small workflow handler coordinating the steps.

### 4. Port bounded provider steps and the Modal service

Adapt PostBob's Convex actions to Compound upload/job records. Give these actions stage-specific Deepgram/Gemini/Modal credentials and scoped R2 access. Keep the existing Gemini analysis endpoint in the Worker. Create a Compound-named Modal app with isolated dev/preview/production configuration instead of coupling Compound to PostBob's deployment.

Deepgram reads a signed source URL. Gemini reads only its bounded PCM range and receives a small WAV chunk. Mint fresh signed URLs when each step starts, including on retry.

Start from PostBob's batching and seam-repair logic. Its Modal method currently downloads and decodes the **entire source WAV on every batch**; adapt it to fetch the requested PCM ranges with explicit source offsets, preserving absolute result timestamps. Verify offset handling and seam context before enabling long inputs. The initial copy can establish short-clip parity first.

Assign retry ownership deliberately: bounded backoff for network/429/5xx failures; no repeated retries for invalid audio, invalid model output or deterministic alignment failures. Keep the combined request/retry budget safely below each action's deadline. PostBob currently has nested SDK/provider/workflow retries; do not copy those budgets blindly. If a provider finishes before checkpoint persistence fails, a retry may repeat paid work—durability does not imply exactly-once provider execution. Reuse persisted artifacts and remote call IDs where available.

### 5. Finish client integration and quality behavior

Keep `transcribe(file)` resolving to the existing `{ text, words: [{ text, start, end }] }[]` shape, converting microseconds to seconds once at the boundary. Internally it starts a job, waits on status and fetches the result. Show transcribing/correcting/aligning progress. Persist pending job associations locally so application restarts can reconnect without another upload/provider run. Extend the CLI with a job-status/resume path when its waiting deadline expires.

Version source-transcript caches and future scene-generation keys so new requests use the restored pipeline. Preserve existing authored caption files; make regeneration explicit. Associate a completed job with the source/scene snapshot that started it so late results cannot replace newer captions.

For supported English, successful enhanced output requires validated alignment. Keep the raw transcript as an explicit basic fallback; never label unaligned Gemini insertions as precise timings. Record skipped Gemini correction, provider-timed/placed tokens and fallback reasons in job metadata. Distinguish no speech from provider failure. Non-English input can use the existing Deepgram path with accurate provenance.

Cancel/delete/expiry must fence late completions, stop further steps and clean up workflow/artifacts. Best-effort cancel in-flight provider calls where supported. Bound the job lifetime within the current 24-hour temporary-upload retention; expired jobs require re-upload. Terminal job/artifact cleanup must not delete the local caption file already saved by the user.

### 6. Verify and roll out

First run the ported deterministic merge, alignment and WAV-parser tests. Then exercise recorded fixtures and a small live corpus covering repeated takes, cut-off words, names, numbers/clock times, silence/music, continuous speech across three-minute boundaries, long leading/trailing silence, and non-English input.

Verify both asset transcription and edited-scene captions, including trims, playback changes and mixed tracks. Check exact word preservation after alignment, positive/non-overlapping ranges, end-of-audio bounds, chunk offsets and caption compatibility. Include disconnect/restart, retry without rerunning completed stages, duplicate start, cancellation, ownership/account deletion, expired media and near-cap memory tests.

Compare against current Deepgram on omitted-word recovery, erroneous insertions/substitutions, timing error on manually checked boundaries, latency, provider calls and cost. Record warm/cold Modal timings. Ship behind a pipeline switch, enable enhanced English transcription after fixture/live parity, and retain basic Deepgram as a rollback. Update `reference/media/transcribe.md` and cloud setup docs when implementation lands; this proposal supersedes the earlier migration plan's deliberate exclusion of correction/alignment.
