# Compound cloud setup

The code now uses **Convex + Better Auth for email-code login** and a **Cloudflare Worker + R2 for media**. The Worker calls Deepgram directly for transcription and Gemini for analysis. There is no Supabase migration, billing, credit system, social login, or media generation service.

The dev environment is connected and deployed. The current root `.env` service account can access `compound-dev`, `compound-preview`, and `compound-prod`; setup does not create those vaults. Preview and production deployment remain separate setup steps.

On September 9, 2026, setup and Alchemy deployment succeeded for `dev-isaacdyor-107806b0`, using Compound's `insightful-iguana-755` Convex deployment. The full `bun run dev` command starts Convex, Alchemy's local Worker and tunnel, and Vite/Electron. Live tests passed through `server-dev-isaacdyor-107806b0.compound.mov`: OTP rejection/sign-in with a seeded dev-only test code, signed sessions, JWT access, signed R2 uploads, Deepgram transcription, Gemini audio analysis, and account deletion/revocation. Temporary accounts and media were removed. `compound.mov` is verified in Resend; no email was sent by these tests, so actual inbox delivery remains unverified.

## Where things live

| Component | Responsibility |
| --- | --- |
| `packages/backend/convex` | Better Auth component, Resend email OTP, upload ownership, expiry and request limits |
| `packages/infra/alchemy.run.ts` | Alchemy Worker, R2 bucket/CORS/lifecycle, dev tunnel, encrypted infrastructure state |
| `apps/server` | Three authenticated media endpoints, R2 URL signing, Deepgram, streamed Gemini Files API |
| `apps/web` | Solid auth client, email-code UI, local editor/captions and CLI handlers |
| `apps/desktop/src/cloud.ts` | Native auth/media transport, OS-encrypted session storage, short-lived Convex tokens |
| `scripts` | Bun setup, scoped 1Password injection, runtime config, Convex CLI and Alchemy orchestration |

Dropping/importing a file remains local. Upload happens when the user or agent requests transcription, analysis, or automatic captions. `compound media transcribe` and `compound media listen` handle the upload internally. Normal projects, edits, exports and caption JSON stay on the computer. This does not implement browser-only project editing or cloud project sync.

The authenticated Worker API is:

- `POST /media/upload-url { contentType, size }` → `{ uploadId, uploadUrl }`. The client PUTs the prepared file to that R2 URL.
- `POST /media/transcribe { uploadId, language? }` → `{ segments: [{ text, words: [{ text, start, end }] }] }`.
- `POST /media/analyze { uploadId, prompt? }` → `{ result: string }`.

Each request uses `Authorization: Bearer <Convex JWT>`. The Worker verifies the current Better Auth session through Convex and checks ownership before accessing R2. It receives no Convex admin key. The signed PUT binds both MIME type and byte length. The client cannot submit an arbitrary provider URL or object key.

Deepgram word timing is used as returned, with simple punctuation-based segmentation. There is no wav2vec2, forced alignment, transcript rewrite, or second model. `listen` uses Gemini, defaults to audio only, and supports `--keep-video`. Analysis timestamps are relative to the requested start offset.

## Configuration follows PostBob

`packages/config` owns stage classification and public runtime configuration:

- `src/stage.ts`: `resolveStage('dev')` produces a stable `dev-<user>-<machine hash>` stage. Explicit `--stage` remains available.
- `src/stage-kind.ts`: development stages select `compound-dev`; `pr-*`/`preview-*` select `compound-preview`; production stages select `compound-prod`. Resource names still use the full stage, not the vault tier.
- `src/deployment.ts`: the public `rootDomain` is `compound.mov`, matching the Cloudflare zone and Resend domain. Production Convex is `strong-panda-857` (`https://strong-panda-857.convex.cloud`), as supplied by the user. These are version-controlled identifiers, not secrets. Recording this identity does not deploy the production backend or infrastructure.
- `src/runtime.ts`: derives web, Worker, Convex auth, desktop and Resend configuration together. Dev's web UI uses localhost:5173; its stable `server-dev-….<rootDomain>` hostname tunnels to the local Worker on port 3000, following PostBob. A PR uses `app-pr-42.<rootDomain>` and `server-pr-42.<rootDomain>`; production uses `app.<rootDomain>` and `server.<rootDomain>`.
- `src/models.ts`: `nova-3` for Deepgram and `gemini-3.5-flash-lite` for Gemini, matching PostBob's current Gemini analysis choice. Change these constants in code, not in 1Password or an env file.

Convex assigns deployment names, so those URLs cannot be inferred from a PR number. Non-production resolution accepts Convex's `CONVEX_URL` deployment output, reads the local CLI's `packages/backend/.env.local` in dev, or derives the hostname from a deployment-specific deploy key. The selected URL must match that key. Production uses the committed production deployment name. Previously generated app env URLs are never used to resolve a new stage.

No URLs, model identifiers, or sender email addresses belong in `.env.op`. The Resend sender is derived as `Compound <no-reply@<rootDomain>>`; verify that domain in Resend. Alchemy attaches Worker custom domains for preview/production and a Cloudflare Tunnel hostname for dev, so the root domain must be a zone managed in your Cloudflare account. Browser hosting for `app...` remains a separate deployment.

## Create the secrets

Create `compound-dev`, `compound-preview`, and `compound-prod`. The grouped `.env.op` uses the same item naming pattern as PostBob:

| Section / item | Fields | Destination |
| --- | --- | --- |
| Deployment / `Cloudflare` | `account-id`, `api-token` | Deployment tools; only the public account ID is a Worker variable |
| R2 / `R2` | `access-key-id`, `secret-access-key` | Worker signing credentials, scoped to the relevant stage buckets |
| Alchemy / `Alchemy` | `password`, `state-token` | Infrastructure workspace only; encrypt state and authenticate the CI state service |
| Convex / `Convex` | `deploy-key` | Convex CLI only |
| Auth / `Better Auth` | `secret` | Convex only; at least 32 random characters, independent per tier |
| Auth / `Resend` | `api-key` | Convex only |
| AI / `Deepgram` | `api-key` | Worker only |
| AI / `Gemini` | `api-key` | Worker only; Google AI Studio/Gemini API key, not Vertex service-account JSON |

Use a fresh hosted Convex deployment and a **deployment-specific deploy key**. This minimal setup does not create Convex previews with a project-level preview key. Multiple PR stage names select the same preview vault; separate Convex deployment outputs/keys must be supplied if you want separate Convex backends. Naming a stage alone does not create database isolation.

R2 buckets are `compound-media-<stage>`. Keep public access disabled. Create the bucket before issuing bucket-scoped signing credentials, or let Alchemy create it. The deployment token needs Worker/R2 administration, Worker custom domains, Zone Read/DNS Edit for the selected zone, and **Cloudflare One / Zero Trust → Cloudflare One Connector: cloudflared → Edit** for PostBob's dev tunnel (also documented as Cloudflare Tunnel Write). The R2 signing key is separate from this deployment token. Alchemy configures the dev bucket with `dev: { remote: true }`, so direct signed uploads and local Worker reads see the same bytes.

## Alchemy infrastructure

`packages/infra/alchemy.run.ts` follows PostBob's `alchemy('compound', { adopt: true, stage, … })` pattern. It declares `R2Bucket('media')`, `Worker('server')`, and dev-only `Tunnel('server-tunnel')`. Worker credentials are `alchemy.secret.env(...)` bindings. CORS and the 24-hour media lifecycle are properties of the bucket resource. The compatibility date matches PostBob (`2026-05-01`) and Alchemy's bundled local runtime. There is no generated Wrangler config or separate imperative Cloudflare deployment path.

Local runs keep encrypted state in ignored `.alchemy/` files. CI uses `CloudflareStateStore`, as in PostBob, with a Compound-specific `compound-alchemy-state-<tier>` service so its vault token does not conflict with PostBob or another tier. Preserve the `Alchemy/password` and `Alchemy/state-token` values across runs. Alchemy adopted the existing `compound-media-<stage>` Worker and bucket names from the initial deployment; the old dev Worker domain was removed so Alchemy's tunnel owns that hostname. Dev deployment was also verified with `CI=true`, exercising the remote state service and resource adoption.

In dev, Alchemy starts the local Worker and `cloudflared` together. The tunnel is active only while dev is running; deploying a dev stage alone does not keep a local server online. Preview and production attach their hostname directly to the deployed Worker.

## Local setup and deployment

Install Bun 1.3.11, Node 22+, the 1Password CLI, and `cloudflared` (for local dev). Fill in the public deployment identity in `packages/config/src/deployment.ts`. Copy the root `.env.example` to `.env` and supply only `OP_SERVICE_ACCOUNT_TOKEN`, or export it in your terminal/CI. The root `.env` token takes priority over an inherited shell token; CI falls back to its environment when no local token is set. Never put the token in `.env.op` or an app's env file.

After creating the services and vault fields:

```sh
bun install --frozen-lockfile
bun run secrets:inject --dev --check # Resolve only credentials; write nothing
bun run setup --dev                  # Inject, derive runtime configuration, sync Convex env
bun run deploy --dev                 # Convex code, then Alchemy infrastructure
bun run dev                         # Refresh setup; Convex watch + Alchemy dev/tunnel + Vite/Electron
```

Use `--stage pr-42`, `--stage preview`, or `--stage prod` for explicit stages. `--dev` and no stage flag both resolve your personal dev stage. To use the shared literal `dev` stage, consistently pass `--stage dev` to setup, deploy, and dev.

Like PostBob, `setup` injects credentials, writes runtime config, and syncs the four Convex runtime variables. It does not deploy code, create vaults, or provision accounts. `deploy` syncs/deploys Convex through its CLI, then runs Alchemy to reconcile the bucket, Worker, secrets, and routing. `bun run deploy:infra --dev` runs just Alchemy. `bun run destroy --stage <stage>` destroys the selected Alchemy stack and does not delete Convex accounts/data. No Supabase data is migrated.

`bun run runtime:write --dev` regenerates configuration after a public identity/deployment-output change. For UI-only development use `bun run dev:desktop` or `bun run dev:web_v1`. Missing configuration produces a login setup message.

Injection resolves only credentials listed in `.env.op` and distributes them according to each app's grouped `.env.example`. Literal credentials and bootstrap tokens are rejected in `.env.op`. Like PostBob, the injector passes a temporary reference-only file to `op inject` because stdin detection fails under Bun; it captures resolved values and removes the temporary file. `--include KEY` refreshes selected credentials only after full injection for the same stage. `--check` writes nothing. Full stage changes clear prior runtime values; runtime generation writes only allowlisted values with restrictive permissions. Generated files stay ignored, and secrets are never printed or placed in subprocess arguments.

The web app and packaged Electron app receive only three public URLs. Production release configuration is derived directly from committed config and needs **no 1Password access**.

## Auth behavior

New users sign up by verifying their email code. Codes last ten minutes, have five allowed attempts, and resending reuses an unexpired code. Better Auth rate limits the auth endpoints. Profile name editing, sign-out, and account deletion are available. Social identities, marketing preferences, billing settings, profile photo upload and email-change UI are intentionally absent from this initial account screen.

Browser sessions use the Better Auth cross-domain client, with storage names scoped to the deployment. Native sessions use Better Auth's signed `set-auth-token` header, encrypted via Electron safeStorage and scoped to the auth deployment. Long-lived native session credentials never reach the renderer; it can request a short-lived Convex JWT. Unavailable secure storage fails closed. No `file://` origin is added to browser CORS: native calls go through constrained main-process IPC and a `compound://` auth origin.

Deleting an account removes the Better Auth identity/sessions and upload records. Local project files are retained. API access is revoked immediately, but already-issued signed download URLs last up to ten minutes. R2 lifecycle deletion begins when objects reach 24 hours and is asynchronous, so physical deletion is not an exact 24-hour guarantee. Gemini files are deleted in a finally block; if the provider/connection prevents deletion, Gemini's own temporary-file retention is the fallback.

## Limits and verification

Prepared uploads support Ogg audio and MP4 video, up to 100 MiB. The renderer buffers the **prepared** file to obtain an exact byte count for a single signed PUT; the Worker streams media using a fixed-length stream and does not buffer the video. There are at most 100 active uploads per user and ten provider attempts per upload. These are simple bounds, not a subscription or usage ledger. Failed provider attempts count, and a retry may incur another provider charge.

Provider operations have a four-minute deadline. This is a request/response service, not a durable job queue. Shorten long clips with `--start` and `--end` if processing times out. There are no automatic retries of paid provider calls.

```sh
bun run check
bun run test:cloud
bun run build
bun run --cwd apps/desktop build:main
bun run --cwd apps/desktop build:preload
```

The 18 automated tests use Convex's test runtime and mocked email/provider responses to cover OTP/native auth, JWT claims, revoked sessions, account cleanup, ownership, quotas, signed upload constraints, provider normalization/cleanup, local 1Password token precedence, and concurrent private-file writes. Workspace typechecks include the Alchemy stack and deployed Convex-generated bindings. A patch lets Electron Forge locate hoisted Electron from `bun.lock`. The optional Redraw example requires an external vendor tarball as described in `examples/11-redraw.tsx` and is excluded from the standard example typecheck.

Verify actual email delivery and sign-in in browser, Electron dev, and a packaged build, including restart and sign-out. The sender domain is verified, and audio transcription/analysis and auth transport have passed live smoke tests; video analysis, scene captions, and cancelled/long requests still need live checks.

## CI and distribution

`Check` runs without secrets on pushes and pull requests. `Deploy cloud` is manual, selects a GitHub environment named `dev`, `preview`, or `prod`, and reads its `OP_SERVICE_ACCOUNT_TOKEN`. Setup writes the infra workspace's Alchemy credentials; deploy syncs Convex and runs Alchemy with its Cloudflare state store in CI. Give each environment a suitably scoped service account. The manual workflow offers shared dev/preview/prod stages; local scripts also accept PR stages. Automatic per-PR Convex provisioning/cleanup is separate work.

The tagged macOS release workflow derives public production URLs from `@compound/config/runtime`, with no 1Password step. Existing macOS signing/notarization secrets remain GitHub secrets: `MACOS_CERT_P12`, `MACOS_CERT_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`. GitHub supplies `GITHUB_TOKEN`. No provider key is needed on a release runner.

Release publishing/download links now target this repository (`corporationdev/compound`). Upstream auto-update, install telemetry, hard-coded Sentry reporting, and the upstream Homebrew tap workflow were removed. Desktop builds are named Compound, with bundle ID `dev.corporation.compound`, Compound artwork, and `Compound-arm64.dmg` releases. The CLI command is now `compound`; update older scripts that invoke `dapi`. See [branding-audit.md](branding-audit.md).

References: [Better Auth bearer sessions](https://www.better-auth.com/docs/plugins/bearer), [Convex Better Auth](https://labs.convex.dev/better-auth), [Cloudflare fixed-length request streams](https://developers.cloudflare.com/workers/runtime-apis/request/), [R2 lifecycle API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/update/).
