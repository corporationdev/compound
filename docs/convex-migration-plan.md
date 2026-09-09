# Compound backend plan: Convex, Better Auth, Worker, and 1Password

Status: Convex and the media API are implemented and have passed live dev smoke tests. Configuration follows PostBob through `packages/config` (stage → tier → runtime), credential-only `.env.op`, and `packages/infra/alchemy.run.ts` for Worker/R2/tunnel/state management. See [cloud setup](cloud-setup.md) for current setup status, commands, exact secret fields, limits, and remaining live checks. The remainder records the original design.

## Settled scope

- Bun workspaces and TypeScript setup scripts, following PostBob. Keep Electron's runtime requirements and validate dependency lifecycle scripts with Bun.
- Fresh backend/accounts/cloud data. No Supabase import, historical backfill, dual writes, or legacy API compatibility work.
- Better Auth email-code login, delivered by Resend.
- Preserve only cloud uploads, Deepgram transcription, and Gemini audio/video analysis. Preserve automatic captions, which depend on transcription.
- Remove billing, credits, marketing preferences, social login, image/video generation, TTS/music/SFX generation, and transforms.
- Keep local projects/media, editing, rendering, and CLI functionality. Browser-only project editing is separate work.
- Use PostBob's 1Password/environment setup pattern with Compound-owned resources and credentials.

## Recommended responsibility split

Bring back a minimal Cloudflare Worker now. This is an architectural recommendation, not a deployed change.

| Responsibility | Home | Reason |
| --- | --- | --- |
| Better Auth, sessions, email verification | Convex + Better Auth | One identity system and authoritative user records |
| Profile and upload ownership metadata | Convex | Shared authenticated data and transactional checks |
| Upload authorization/signing | Worker | Keep storage integration with the media API |
| Media bytes | R2 | Direct uploads and provider-readable signed downloads |
| Deepgram request and response normalization | Worker | Simple external HTTP operation; no database transaction during inference |
| Gemini Files API and analysis request | Worker | Media streaming, provider lifecycle, and HTTP response handling |
| Local encoding and captions/assets | Existing Electron renderer | Already implemented; keeps full-resolution originals local |

Both Convex actions and Workers can call these providers. Convex-only would also work, particularly for small requests, and avoids a second service. The reason to choose the Worker here is a coherent media/service boundary: the same service owns storage access, provider calls, and eventually agent execution; Convex owns durable app data. This costs an additional deployment and authenticated Convex lookup, which we accept explicitly. A future worker alone would not force every existing operation out of Convex.

Do not have the frontend call a Convex action that merely forwards to the Worker. It calls Convex for app data/auth and the Worker directly for media operations.

```text
Browser / Electron
  |-- Better Auth session -> Convex JWT
  |-- Convex: identity, profile, authenticated app data
  |-- Worker /media/upload-url -> signed R2 upload URL + uploadId
  |-- direct PUT to R2
  |-- Worker /media/transcribe or /media/analyze, using uploadId
         |-- Convex: authenticate and check upload ownership
         |-- R2: validate/read uploaded media
         |-- Deepgram or Gemini
         `-- transcript or analysis returned to caller
```

## PostBob code to reuse selectively

Reference repo: `/Users/isaacdyor/code/postbob`.

- `packages/backend/convex/auth.ts`, `auth.config.ts`, `convex.config.ts`, `http.ts`: Better Auth component/adapter, auth routes, email OTP through Resend. Omit Expo and legacy password support.
- `apps/server/src/convex.ts`: Worker uses a request-scoped ConvexHttpClient with the user's JWT to authenticate via a Convex query. Keep tokens in Authorization headers; do not copy query-string token fallbacks.
- `apps/server/src/deepgram.ts` and `index.ts`: a simple Worker endpoint already calls Deepgram directly. Its response currently keeps only transcript text; adapt the response parser to retain Deepgram word timestamps for our CLI/captions. Do not copy its whole-body buffering for large media.
- `apps/server/src/tools/assets.ts`: Gemini Files upload/readiness and generateContent call. Extract a small single-media adapter; omit multi-asset agent context, readiness/indexing orchestration, and transcript correction.
- `packages/backend/convex/asset_transcription.ts`: the larger PostBob pipeline begins with a Deepgram call, then has other processing stages. We only need direct Deepgram output. No wav2vec2, forced alignment, Gemini transcript rewrite, Modal, or seam correction.
- `.env.op`, `scripts/secrets-inject.ts`, `scripts/write-runtime-env.ts`, stage/runtime config, and injection/deploy actions: use the same workflow, with Compound-specific allowlists and resources.

## The three media operations

### 1. Upload URL

`POST /media/upload-url { contentType, size, contentHash? }`

1. Validate the Better Auth-issued Convex JWT via an authenticated Convex query.
2. Register an upload record owned by that user. The server chooses the R2 object key.
3. Return `{ uploadId, uploadUrl }` for a direct signed PUT.
4. The app uploads the prepared audio/video directly to R2.
5. Before using it, transcribe/analyze verifies ownership and checks the actual object exists and satisfies size/type constraints. A separate completion endpoint is unnecessary initially.

The agent never needs to manage this endpoint. Existing local media handlers call it automatically. Normal drag/drop stays local.

Use one signed PUT for the first bounded implementation. Preserve streamed encoding where practical, and validate the uploader can supply the required request metadata; otherwise encode into a local temporary file before upload. Do not buffer a large video in Worker memory. Add R2 multipart upload only if supported input sizes require it; the current GCS resumable implementation cannot be reused unchanged.

The upload record can be small: owner ID, server-generated object key, MIME type, declared size, creation/expiry time, and optional content hash. No global asset catalog or project synchronization.

### 2. Transcribe

`POST /media/transcribe { uploadId, language? }`

1. Authenticate and authorize the uploaded object.
2. Create a short-lived R2 download URL and pass it to Deepgram's prerecorded transcription API.
3. Read Deepgram's transcript and word start/end times directly.
4. Normalize to the existing shape: `{ segments: [{ text, words: [{ text, start, end }] }] }` for CLI usage, with a small client adapter for caption consumers.

Use provider word timings as returned, in seconds, with punctuated words where available. Configure utterance grouping if useful; simple grouping is sufficient. Return an explicit no-speech result and preserve existing caption handling. Do not introduce a second model or alignment service.

Keep the current local preparation: CLI transcription extracts mono 16 kHz Opus audio; automatic captions render the edited scene's mixed audio. Captions save transcript JSON in the local project. Long transcripts remain in the response/local asset rather than forcing a single oversized Convex document.

### 3. Analyze

`POST /media/analyze { uploadId, prompt? }`

1. Authenticate and authorize the uploaded object.
2. Stream the R2 object into the Gemini Files API.
3. Wait for the file to become usable, with bounded polling and cancellation.
4. Call a configured Gemini model with the file and user prompt; return `{ result: text }`.
5. Delete temporary Gemini files after the operation where appropriate; R2 objects have a bounded retention policy. File reuse can be added later if repeated questions justify it.

Preserve existing CLI behavior: `dapi media listen` defaults to audio only, `--keep-video` includes compressed video, and start/end windows are prepared locally. Document offsets so the model's timestamps can be related back to the original clip. Select and validate a supported Gemini model at implementation time rather than assume PostBob's pinned model is appropriate.

## Keep execution simple

Start with three authenticated request/response handlers, direct provider calls, explicit request deadlines, and clear errors. Do not introduce queues, workflows, Durable Objects, job tables, progress subscriptions, internal RPC frameworks, or a full PostBob agent runtime for these endpoints.

Choose and test a maximum media size/duration and request deadline before release. Workers are not durable jobs: client disconnects or request failures can interrupt execution. Do not claim retrying an uncertain provider request is free or use waitUntil as a reliable long-job runner. If inputs must run independently of a client connection, add a queue/workflow as a separate requirement. Convex actions also have a ten-minute execution limit and do not automatically retry provider side effects.

The future agent runtime can call the same provider adapter functions inside the Worker. Keep adapters separate from HTTP handlers so adding agent tools does not duplicate provider logic or require an HTTP loopback.

## Auth transport

Browser: Better Auth Solid client, the Convex cross-domain integration, and a small ConvexClient.setAuth adapter. Do not copy the React provider into Solid.

Electron: validate dev localhost and packaged file:// separately. Prefer a small main-process auth service with controlled IPC methods, durable OS-protected Better Auth session storage scoped by deployment, and short-lived JWT retrieval/refresh. PostBob's native AuthService is a behavioral reference: session cookies and Convex JWTs are different credentials. Do not assume its stored raw session token alone authenticates, or disable browser security to work around file origins.

The same JWT goes to Convex and Worker requests. Worker creates a fresh user-authenticated Convex client per request. Ownership mutations derive identity from that token. Initially the Worker need not write trusted provider results into Convex, so it needs no admin deploy key or generic INTERNAL_SECRET. Add narrowly scoped service authorization only when future background/server-owned writes require it.

## 1Password and environments

Use Bun TypeScript scripts and proposed `compound-dev`, `compound-preview`, `compound-prod` vaults. Do not copy actual PostBob/Diffusion Studio credentials or resource IDs.

Committed:

- `.env.op`: tier-based references, such as `DEEPGRAM_API_KEY=op://compound-${ENV_TIER}/deepgram/api-key`.
- `.env.example`: bootstrap/deployment variable names.
- `apps/web/.env.example`: public client config only.
- `apps/server/.env.example`: Worker runtime allowlist.
- `packages/backend/.env.example`: Convex runtime allowlist.
- Stage/runtime config and Bun scripts for injection, setup, URL derivation, and explicit backend env sync.

Generated env files stay ignored. Bootstrap OP_SERVICE_ACCOUNT_TOKEN comes from the caller or ignored root env. Injection resolves only needed keys, checks missing values without logging them, writes correctly escaped values atomically with restrictive permissions, and masks secrets in CI. Do not preserve stale secrets across stage switches or let .env.local silently select another backend.

| Destination | Required values |
| --- | --- |
| Injection only | OP_SERVICE_ACCOUNT_TOKEN |
| Convex runtime | BETTER_AUTH_SECRET, RESEND_API_KEY, RESEND_FROM_EMAIL, exact trusted web/native origin config |
| Worker runtime | DEEPGRAM_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, CONVEX_URL, R2 bucket binding/config, R2 signing credentials, allowed frontend origins, Gemini model config |
| Public web/Electron build | VITE_CONVEX_URL, VITE_CONVEX_SITE_URL, VITE_SERVER_URL, stage |
| Deployment only | CONVEX_DEPLOY_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, ALCHEMY_PASSWORD, ALCHEMY_STATE_TOKEN |
| Optional preview cleanup | CONVEX_MANAGEMENT_TOKEN and exact team/project identifiers |
| macOS release only | MACOS_CERT_P12, MACOS_CERT_PASSWORD, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID |

R2 binding access and signing credentials are different: a Worker binding can read objects; S3 presigning uses scoped R2 access-key credentials. No provider keys belong in Convex if only the Worker calls providers. No deployment or 1Password token belongs in either runtime or the shipped app. Retain GitHub's built-in GITHUB_TOKEN rather than storing it in 1Password.

Local commands: `bun run setup`, `bun run secrets:check --dev`, `bun run env:dev`, `bun run backend:env:sync --dev`, `bun run dev`, `bun run dev:web`. Setup selects a Compound dev deployment before deriving URLs, syncs only backend runtime variables, and starts Convex + Worker + Vite/Electron with coherent shutdown.

Dev stage names do not create isolation by themselves: validate the actual Convex deployment and R2 namespace/bucket. Preview CI uses preview-scoped secrets and an isolated deployment; production is explicit and never a local fallback. Inject Worker secrets through Alchemy separately from Convex env sync. Use PostBob's Alchemy Worker/R2/tunnel/state pattern without its agent/Modal/social infrastructure.

## Implementation order and acceptance

1. Align remaining workspace scripts/CI with Bun and the existing bun.lock. Add 1Password templates/setup and deploy-target validation.
2. Prove email login, persistence, refresh, sign-out, and account isolation in browser, Electron dev, and packaged Electron before removing Supabase.
3. Add Convex profiles/uploads and a tiny Worker with health + the three media endpoints; provision R2 CORS/retention and the two provider keys.
4. Wire existing local media/caption handlers to the Worker. Validate one direct Deepgram transcription, one Gemini audio analysis, one video analysis, and automatic scene captions.
5. Remove Supabase, billing/social-login code, unsupported hosted generation features, upstream API dependencies, and model/voice listings. Extract caption code from gen-ai.ts before deleting unrelated generation logic. Keep local CLI tRPC transport.
6. Add preview/prod/desktop-release injection and deployment. Pin Bun, use frozen-lockfile installs, keep secret-free checks available to untrusted PRs, and clean up only the exact preview resources. Replace upstream updater/release destinations before distribution.

Acceptance includes ownership rejection, wrong/expired OTP, session restart and token refresh, bad uploads, provider timeouts/no speech, transcript timing compatibility, preserved local edits/export, temporary-media cleanup, and browser/Electron network checks showing no Supabase or api.diffusion.studio traffic. Audit bundles for secret/env inclusion. Do not delete original upstream infrastructure or local files.

## Current hosted contract for reference

We have generated tRPC types, input schemas, and client calls; not the remote endpoint handlers or full server database schema. The local desktop/CLI server is implemented separately in this repo.

Retain functionality: getUploadUrl, transcribe, analyze.

Remove: generateImage, generateVideo, generateSound, textToSpeech, removeBackground, upscaleImage, upscaleVideo, addAudioToVideo, getBillingInfo, listInvoices, createBillingPortal, createSubscription, createTopup, getSubscriptionSummary, updateEmailPreference.

Replace deleteAccount with Better Auth + owned cloud-data cleanup. Leave local project folders alone.

## Original decisions (resolved or documented in cloud-setup.md)

- Accept the recommended Worker/Convex/R2 responsibility split.
- Compound project/vault/domain/sender/distribution identities and public signup/AI access policy.
- Supported media size/duration, request deadline, and initial Deepgram/Gemini model configuration.

## Documentation checked

- [Convex actions and limits](https://docs.convex.dev/functions/actions).
- [Worker execution limits and disconnect behavior](https://developers.cloudflare.com/workers/platform/limits/).
- [Deepgram prerecorded transcription and word timestamps](https://developers.deepgram.com/docs/pre-recorded-audio).
- [Gemini video](https://ai.google.dev/gemini-api/docs/video-understanding) and [audio understanding](https://ai.google.dev/gemini-api/docs/audio).
- [Better Auth Convex integration](https://labs.convex.dev/better-auth/framework-guides/react), [Solid-capable clients](https://better-auth.com/docs/concepts/client), and [email OTP](https://better-auth.com/docs/plugins/email-otp).
- [1Password template syntax](https://www.1password.dev/cli/secrets-template-syntax).
