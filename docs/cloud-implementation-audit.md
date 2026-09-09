# Convex / media migration audit

Audited September 9, 2026. This describes the current code and the setup actions recorded in this task. It is an audit, not another implementation pass: no application code or cloud resources were changed for this review.

Subsequent update: the user supplied production Convex `strong-panda-857`, now recorded in deployment configuration, and requested the CLI rename from `dapi` to `compound`. The audit below describes the earlier snapshot; the blank production identity and old command name are superseded. Production deployment is still separate work.

## Scope and attribution

You authorized a fresh Convex backend, PostBob-style Better Auth email codes, Bun, 1Password secret injection, Alchemy infrastructure, Deepgram transcription, Gemini analysis, and removal of billing and the other hosted AI features. You did not ask for cloud project storage or a browser filesystem implementation.

The working tree also contains a large concurrent branding change: package renames, icons, fonts, application identity, local-data compatibility helpers, and related edits. The entire uncommitted Git diff cannot honestly be attributed to this migration. The inventory below identifies the migration work by responsibility. The later `@compound/jsx` CLI dependency fix and supplying the missing logo import were startup fixes in this task; the broad rebrand was separate work. No migration commit provides a clean authorship boundary.

## What the uploads table actually does

It is a temporary authorization record for a file in R2. Convex stores the record; R2 stores the bytes. It is not a project table, a cloud asset library, a transcript table, or a billing ledger.

Implementation: [schema](../packages/backend/convex/schema.ts), [upload functions](../packages/backend/convex/uploads.ts), [Worker](../apps/server/src/index.ts).

| Field | Actual use | Assessment |
| --- | --- | --- |
| `_id` | Convex-generated ID, returned to the caller as `uploadId` | Used by subsequent requests |
| `ownerId` | Better Auth user ID; every read/claim checks it against the authenticated user | Necessary for this ownership design; a string because the user lives in a separate component |
| `key` | R2 object path, always `media/<uploadId>` | Redundant stored field; it can be derived from `_id` |
| `contentType` | Declared `audio/ogg` or `video/mp4`; checked against R2 metadata | Validates the upload contract, not the actual media bytes |
| `size` | Declared byte length; bound into the signed PUT and compared to R2 object size | Supports bounded uploads |
| `calls` | Incremented before each provider attempt; a shared maximum of ten transcription/analysis attempts | An extra policy I introduced; failures count too, and it is not a usage/billing system |
| `expiresAt` | Creation time plus 24 hours; prevents further API use after expiry | Temporary authorization policy I chose |

`by_owner(ownerId, expiresAt)` finds active uploads for the per-user limit and finds records for account deletion. `by_expiry(expiresAt)` supports cleanup. An hourly cron deletes at most 500 expired rows per run. R2 has its own age-based lifecycle rule; deleting a Convex row does not delete an R2 object.

The lifecycle is:

1. The editor or CLI handler prepares Ogg audio or MP4 video locally.
2. It requests `POST /media/upload-url` with the MIME type and exact size.
3. The Worker verifies the user's Convex JWT/current session, creates the ownership row, and returns a signed R2 PUT URL plus `uploadId`.
4. The client uploads directly to R2. On desktop, Electron's main process performs that request.
5. The client calls transcription or analysis with `uploadId`.
6. The Worker checks ownership, expiry, R2 size/type, and the attempt limit, then calls the provider.
7. The response returns directly to the client. There is no durable job/result record. Caption JSON is saved locally by the editor.

Dropping a file into the editor does not trigger this upload. `dapi media transcribe`, `dapi media listen`, and automatic captions call the upload helper internally. An agent does not need to request an upload URL as a separate tool step.

## Current architecture and endpoint surface

| Location | Responsibility |
| --- | --- |
| Convex | Better Auth, email delivery integration, current-user query, upload ownership and cleanup |
| Cloudflare Worker | Authenticated media API, signed URLs, Deepgram calls, Gemini file upload/analysis |
| R2 | Temporary private media bytes |
| Electron main process | Native session storage, auth and media transport |
| Solid renderer | Login UI, local encoding, editor/CLI integrations |
| Local filesystem | Project source, assets, caption files, exports |

Worker endpoints in [index.ts](../apps/server/src/index.ts):

| Method/path | Input/output | Authentication |
| --- | --- | --- |
| `GET /health` | `{ ok: true }`; does not test dependencies | None |
| `POST /media/upload-url` | `{ contentType, size }` → `{ uploadId, uploadUrl }` | Convex JWT/current session |
| `POST /media/transcribe` | `{ uploadId, language? }` → `{ segments }` | Same, plus upload ownership |
| `POST /media/analyze` | `{ uploadId, prompt? }` → `{ result }` | Same, plus upload ownership |
| `OPTIONS` | Browser preflight | Exact configured origin |

The Worker also rejects an explicitly supplied foreign Origin. Native requests omit Origin. This is not a replacement for authentication: every media POST still authenticates.

Public Convex functions are `auth.getCurrentUser`, `uploads.create`, `uploads.get`, and `uploads.claim`. Authenticated clients can call the upload functions directly; their permission checks are inside the functions. `uploads.expire` and `uploads.removeForUser` are internal functions.

Better Auth registers its own HTTP routes below `/api/auth/*` on the Convex `.site` domain. The native allowlist uses `email-otp/send-verification-otp`, `sign-in/email-otp`, `get-session`, `convex/token`, `sign-out`, `update-user`, `delete-user`, `email-otp/request-email-change`, and `email-otp/change-email`. The installed library also supplies its plugin/internal routes; the three Worker endpoints are not the entire auth API surface.

There is no application `INTERNAL_SECRET` needed or used by this flow. The Worker uses the user's JWT and has no Convex deploy/admin key.

## Migration change inventory

### Backend and auth

- Added `packages/backend` with Convex configuration, generated bindings, schema, uploads functions, hourly cron, HTTP routes, and auth tests.
- Added the Better Auth component. Its users, sessions, verification codes, accounts, signing keys, and rate-limit records live inside that component's schema, which explains why they are absent from the application's `schema.ts`.
- Added Resend email codes: ten-minute expiry, five attempts, reuse an unexpired code on resend. Verification can create a new account.
- Added explicit database-backed auth throttling with a base 30 requests per 60 seconds; endpoint/plugin rules can override that base.
- Enabled profile-name updates and account deletion. Deletion removes upload records; local projects remain.
- Enabled verified email changes in the backend/native transport, although there is no email-change UI. This is extra exposed functionality relative to the minimal initial screen.
- Added signed bearer sessions for Electron and cross-domain browser auth, using the Convex Better Auth plugins.

### Provider implementations

[providers.ts](../apps/server/src/providers.ts) implements both providers directly.

- Deepgram: prerecorded URL-based transcription, `nova-3`, punctuation/smart formatting, automatic language detection unless supplied. Word timestamps are used directly. Segments end at sentence punctuation or 30 words. No wav2vec2, forced alignment, transcript rewrite, or second model.
- Gemini: `gemini-3.5-flash-lite`, resumable Files API upload, poll until active, then `generateContent` with the media and prompt. Returns text; filters thought-marked parts. Attempts file deletion in `finally`.
- Worker-to-Gemini bytes stream through a fixed-length stream. The client still buffers the prepared upload; this is not an end-to-end streaming implementation.
- Provider requests are synchronous with a four-minute deadline. No durable jobs, queue, automatic paid retries, transcript database, or output cache was added to the server.
- The existing `listen` handler defaults to stripping video, so Gemini normally receives audio. Keeping video is an explicit option. Transcription prepares the full asset; analysis supports the existing start/end selection.

### Desktop and web integration

- Added [desktop cloud transport](../apps/desktop/src/cloud.ts): deployment-scoped signed session storage encrypted through Electron `safeStorage`; authentication requests are serialized to avoid refresh/logout races. Secure storage failure blocks persistence. Short-lived Convex JWTs can reach the renderer; the long-lived native session is withheld.
- Added typed cloud IPC channels and sender/main-frame/origin checks in desktop main.
- Added [browser auth client](../apps/web/src/lib/auth-client.ts), replaced auth context/login/account UI, and added [media client](../apps/web/src/lib/media-api.ts).
- Replaced [uploads helper](../apps/web/src/lib/uploads.ts). Desktop uses main-process IPC; browser transport uses JWT-authenticated fetch and signed PUT.
- Rewired `context/dapi/media.ts` transcription/listen handlers and `utils/gen-ai.ts` scene transcription. Automatic captions still render scene audio locally and save transcript JSON locally.
- The web frontend has browser auth/media transport, but project access still depends on Electron. [ProjectFS](../apps/web/src/projects/fs.ts) calls desktop IPC; [project host](../apps/web/src/projects/host.ts) explicitly rejects opening project folders outside desktop. This migration does not make the standalone web editor functional or move projects into Convex/browser storage.

### Removed behavior

- Supabase client, old remote tRPC client, OAuth callback/development-code plumbing, and checkout integration.
- Billing, subscriptions/plans, invoices, AI credits, purchase-success and upgrade UI, and their navigation entries.
- Social login UI, avatar upload, and the older account settings tied to those services.
- Hosted image/video/audio/voice generation UI and hooks, generation records, model configuration, and cloud source transformations such as background removal/upscaling/adding audio.
- CLI models/voices handlers now return empty lists. Runtime generation requests produce an unavailable error; cloud source modifiers also error. Existing source files that request those features need adjustment, even though normal local editing/rendering remains.
- Removed upstream automatic updates, install telemetry, hard-coded Sentry reporting, and the upstream Homebrew publishing workflow. Release links were redirected to this repository. Those distribution changes were adjacent cleanup, not necessary for the three media endpoints. The optional env-configured Umami wrapper still exists.

The local CLI transport and editor APIs remain; removing the remote tRPC client does not mean all local tRPC usage was removed.

### Configuration and secret injection

- Added `packages/config`: stage classification, personal dev-stage resolution, vault-tier mapping, committed deployment identity, derived URLs, and provider model constants.
- `compound-dev`, `compound-preview`, and `compound-prod` select credentials by environment tier; resource names use the full stage.
- Public root domain is `compound.mov`. The production Convex deployment identifier is currently blank and intentionally blocks production config/release generation.
- `.env.op` contains credential references only, grouped to follow PostBob. Model names, URLs and sender identity live in code.
- `scripts/environment.ts`: stage validation, dotenv handling, allowlisted output templates, root `.env` OP-token precedence, atomic private writes, and stage-scoped configuration reads.
- `scripts/secrets-inject.ts`: invokes `op inject` with a temporary reference file, captures output, distributes only template-listed values, supports check/partial injection, and rejects literal secrets in `.env.op`.
- `scripts/write-runtime-env.ts`: derives public configuration and verifies Convex URL/deploy-key identity before writing backend/server/web env and desktop runtime JSON.
- Generated files are ignored and written with mode `0600`. They contain plaintext credentials on disk; injection is not runtime encryption. Alchemy state and native sessions have separate encryption.
- Root `.env` takes priority over an inherited OP service token, as requested. CI uses its injected process token when there is no root override.

| Credential/reference | Destination/use |
| --- | --- |
| Root `OP_SERVICE_ACCOUNT_TOKEN` | 1Password CLI bootstrap; not copied into app config |
| Cloudflare `account-id` | Public deployment ID; also Worker binding |
| Cloudflare `api-token` | Alchemy provisioning/tunnels |
| R2 `access-key-id`, `secret-access-key` | Worker URL signing |
| Alchemy `password`, `state-token` | State encryption and CI state service |
| Convex `deploy-key` | Convex CLI only |
| Better Auth `secret` | Convex auth runtime |
| Resend `api-key` | Convex email delivery |
| Deepgram `api-key` | Worker |
| Gemini `api-key` | Worker as `GOOGLE_GENERATIVE_AI_API_KEY` |

The injector resolves eleven values, including the public account ID. Browser/Electron public runtime configuration contains three URLs and no provider/deployment credentials. Existing macOS signing/notarization GitHub secrets remain separate.

### Alchemy, development and CI

- [packages/infra/alchemy.run.ts](../packages/infra/alchemy.run.ts) now declares the R2 bucket, PUT CORS, temporary-object lifecycle, Worker/bindings/secrets, and dev tunnel. It adopts the resources initially created during setup.
- Dev uses a stable `server-<stage>.compound.mov` tunnel to localhost:3000. Preview/production use Worker custom domains. Workers.dev URLs also remain enabled.
- Local Alchemy state is local; CI uses a tier-named Cloudflare state-store Worker/Durable Object. This is infrastructure state, not an application agent or media job system.
- `setup.ts`: inject → derive config → sync four Convex auth runtime values.
- `backend.ts`: sync/dev/deploy through the Convex CLI. `infra.ts`: thin Alchemy wrapper. `deploy.ts`: runtime write → Convex sync/deploy → Alchemy deploy.
- `dev.ts`: setup once, then Convex watcher + Alchemy dev + desktop/Vite. This command needs working cloud credentials and services; it is not an offline local-only startup.
- Added secret-free check workflow and manual stage-selected cloud deployment workflow. The latter does not host the browser app or automatically provision isolated per-PR Convex deployments.
- Switched workspace installation/scripts to Bun and removed npm lockfile. Added an Electron Forge patch to recognize Bun lockfiles with hoisted Electron. Added script/example typechecking support and cloud tests. The optional Redraw vendor-dependent example is excluded from the regular example check.

## Remote actions performed earlier in this task

These are recorded setup results, not a new live infrastructure inspection during this audit:

- Connected the fresh dev Convex deployment `insightful-iguana-755`; deployed auth/component/application functions, schema/indexes, cron and auth runtime configuration.
- Created, then adopted into Alchemy, Worker and private R2 bucket `compound-media-dev-isaacdyor-107806b0`; set Worker provider/signing secrets, bucket CORS and lifecycle.
- Replaced the initially direct dev Worker custom-domain binding with the PostBob-style tunnel routing. Created `compound-server-dev-isaacdyor-107806b0` and its hostname routing after the Cloudflare permission update.
- Created/verified `compound-alchemy-state-dev` for CI infrastructure state.
- Triggered Resend verification for the existing `compound.mov` domain; it verified. The required email DNS records already existed.
- Ran small real Deepgram/Gemini audio smoke tests and synthetic auth tests. Seeded temporary dev-only verification data to avoid sending email; cleaned up test identities/media.
- Did not provision/deploy production or preview application infrastructure, create 1Password vaults/tokens, migrate Supabase users/data, or verify actual inbox delivery.

## Findings and unfinished work

### Confirmed defects / operational gaps

1. **Auth cleanup scans an unindexed table.** `auth.ts` explicitly selects database rate-limit storage. The installed Better Auth component's `rateLimit` table only indexes `key`; Better Auth deletes expired rows by `lastRequest`. This is the warning you saw and can become a performance/read-limit problem. Adding an index to the application's uploads schema will not fix the component schema. This remains unfixed. PostBob's inspected auth configuration does not contain this explicit database limiter; it was my addition.

2. **Dev deployment does not mean an always-on dev hostname.** Alchemy routes dev hostnames to a tunnel that runs only during local development. A manual CI deployment of stage `dev` can deploy a Worker but does not run the local tunnel connector. The configured dev hostname therefore needs a running dev machine, even though a Workers.dev endpoint exists. The workflow naming does not make this distinction obvious.

3. **Production and preview are incomplete.** Production's Convex identity is blank. Browser hosting is absent. Stage labels do not automatically create separate Convex deployments: multiple PR stages resolve the same preview-vault deploy key unless separately configured. The scripts validate the key/URL match, not a full one-stage-to-one-Convex provisioning contract. Do not treat arbitrary PR names as database isolation.

4. **Worker failures are hard to diagnose.** Most provider failures collapse to a generic 502; Worker observability is explicitly disabled and the catch path does not emit a sanitized diagnostic. An invalid provider setting, a provider outage, and some internal errors look the same to the caller.

5. **Gemini file deletion is best effort and silent.** The cleanup fetch ignores non-2xx responses and catches network failures. It cannot delete an uploaded file if cancellation/response failure prevents learning its name. The tests cover a deletion attempt after normal success/failure, not guaranteed remote erasure.

6. **Cloudflared discovery is platform-limited.** The Alchemy file looks in three fixed macOS/Linux locations rather than searching PATH or supporting Windows. Local macOS development was verified; the startup scripts are not fully portable as written.

### Additional behavior I chose, rather than requirements you gave

| Choice | Consequence |
| --- | --- |
| 100 MiB prepared-upload maximum | Long media may be rejected; client buffering still costs memory |
| 100 active reservations per user | Failed/abandoned PUTs consume slots until their rows expire |
| Ten provider attempts per upload | Failed requests consume attempts; no user-facing attempt counter |
| 24-hour upload authorization | Old uploads cannot be reused through the API |
| Hourly cleanup capped at 500 rows | More than 500 expirations/hour can create a cleanup backlog |
| Four-minute provider timeout | Long jobs cannot resume; retries can incur another provider charge |
| Explicit database auth limiter | Added persistent counters and the index warning |
| Backend email-change routes | Functionality beyond the initial email-code login UI |

These are bounded defaults, not billing, but I should have called them out rather than presenting everything as a literal PostBob copy. They do not provide a complete abuse or spending budget: users can create fresh uploads/accounts, and there is no global provider concurrency or cost cap.

### Retention and correctness limits

- Account deletion removes rows and access to future API calls, but not R2 bytes immediately. Already-issued PUT URLs remain usable for up to 15 minutes; GET URLs for up to ten minutes. In-flight provider work is not cancelled by account deletion.
- R2 lifecycle age is measured from object storage, while row expiry starts when the upload URL is requested. Physical deletion is asynchronous, so “deleted after exactly 24 hours” would be inaccurate.
- A signed PUT can be reused during its validity window, allowing replacement of the same key. There is no finalized/immutable upload state. Type checks compare metadata, not sniffed content; the HEAD-then-read sequence is not an atomic object snapshot.
- Account cleanup collects all matching rows in one mutation. With a large historical backlog it should be paginated. Expired rows are already refused by API checks even if cleanup falls behind.
- No server-side job/result history, cancellation UI, idempotency keys, durable resume, or comprehensive long-video tests were added. Some local transcript caching existed/is retained, but server retries are independent paid calls.
- Removing cloud generation means source projects requiring generation/transforms can now error. This is intentional feature removal, not backwards-compatible feature parity.

## Mistakes and corrections during implementation

- I initially used custom Wrangler/R2 deployment logic instead of Alchemy despite the PostBob requirement. That was the wrong implementation choice. It was replaced by the Alchemy stack; the existing resources were adopted.
- Initial runtime writes shared a `.tmp` filename and raced during parallel dev startup. Fixed with unique temporary filenames and setup before watcher fan-out; a concurrent-write regression test now covers it.
- Initial compatibility date exceeded the bundled local workerd version. Changed to the PostBob-compatible date and verified startup.
- The Bun/Forge hoisting problem required the lockfile-detection patch. The later package rename exposed an undeclared CLI JSX dependency; that declaration was added and the build checked. A missing imported logo asset was also supplied during the startup investigation.
- During earlier secret troubleshooting, reading a user-edited `.env.op` exposed a literal service token in tool output. I removed that misplaced copy; the intended root `.env` remains the bootstrap source and the injector now rejects literal credentials there. This was a handling mistake, not evidence that the token was committed. This audit does not repeat its value.
- Earlier successful smoke tests were narrower than a complete product validation. They did not establish packaged-app login, actual email delivery, or full video/caption behavior.

## Validation evidence

Re-run during this audit:

- `bun run test:cloud`: **18 passed, 0 failed, 144 assertions**.
- `bun run check`: **passed**, including workspaces, examples in scope, and scripts.

The tests cover OTP rejection/sign-in, signed native session handling, JWT/session revocation, account upload cleanup, ownership and limits, URL-signing constraints, provider response conversion/file-cleanup attempts, root-token precedence, configuration derivation, and concurrent private writes. Providers/email and Electron secure storage are mocked where appropriate; this is not an end-to-end proof of those external systems.

Earlier live/manual checks in this task passed: dev startup, CLI/web builds, signed R2 uploads, Deepgram transcription, Gemini audio analysis, and auth transport/account deletion. Still unverified end to end: actual inbox delivery, browser and packaged Electron login/restart, live video analysis, scene captions, long/cancelled requests, preview deployment and production deployment.

## Simplification assessment

The basic division of responsibility is small: Convex auth plus ownership, Worker provider calls, R2 temporary bytes. A small upload ownership record is reasonable with that design. The stored `key` is unnecessary, and `calls` plus the active-upload quota are extra product policies rather than prerequisites for transcription/analysis.

The immediate decisions are whether to keep those explicit quotas and database auth throttling, and how dev deployment should be presented. Removing counters can simplify the schema, but removing ownership checks would change the security model. No such changes were made during this audit.
