# Compound cloud setup

The code now uses **Convex + Better Auth for email-code login** and a **Cloudflare Worker + R2 for media**. The Worker handles uploads and Gemini analysis; Convex Workflow runs Deepgram → Gemini omission recovery → Modal wav2vec2 alignment for WAV transcription. There is no Supabase migration, billing, credit system, social login, or media generation service.

The dev environment is connected and deployed. The current root `.env` service account can access `compound-dev`, `compound-preview`, and `compound-prod`; setup does not create those vaults. Preview and production deployment remain separate setup steps.

On September 9, 2026, setup and Alchemy deployment succeeded for `dev-isaacdyor-107806b0`, using Compound's `insightful-iguana-755` Convex deployment. The full `bun run dev` command starts Convex, Alchemy's local Worker and tunnel, and Vite/Electron. Live tests passed through `server-dev-isaacdyor-107806b0.compound.mov`: OTP rejection/sign-in with a seeded dev-only test code, signed sessions, JWT access, signed R2 uploads, Deepgram transcription, Gemini audio analysis, and account deletion/revocation. Temporary accounts and media were removed. `compound.mov` is verified in Resend; no email was sent by these tests, so actual inbox delivery remains unverified.

## Where things live

| Component | Responsibility |
| --- | --- |
| `packages/backend/convex` | Better Auth component, Resend email OTP, upload ownership, expiry and request limits; durable transcription workflows |
| `packages/infra/alchemy.run.ts` | Alchemy Worker, R2 bucket/CORS/lifecycle, dev tunnel, encrypted infrastructure state |
| `apps/server` | Authenticated media endpoints, R2 signing/result delivery, legacy Ogg transcription, streamed Gemini Files API |
| `apps/wav2vec-aligner` | Stage-scoped Modal CPU inference; bounded source PCM reads |
| `packages/backend/lib/transcription` | PostBob correction/alignment algorithms and provider/storage adapters |
| `apps/web` | Solid auth client, email-code UI, local editor/captions and CLI handlers |
| `apps/desktop/src/cloud.ts` | Native auth/media transport, OS-encrypted session storage, short-lived Convex tokens |
| `scripts` | Bun setup, scoped 1Password injection, runtime config, Convex CLI and Alchemy orchestration |

Dropping/importing a file remains local. Upload happens when the user or agent requests transcription, analysis, or automatic captions. `compound media transcribe` and `compound media listen` handle the upload internally. Normal projects, edits, exports and caption JSON stay on the computer. This does not implement browser-only project editing or cloud project sync.

The desktop initializes a default projects folder on startup: `~/Movies/compound` in production and `~/Movies/compound-<stage>` in development/preview (the OS Videos folder on other platforms). Each stage remembers its own selected folder. The first stage opened after this update keeps an existing saved selection; other stages initialize their own default. Changing the selection does not move existing projects.

The authenticated Worker API is:

- `POST /media/upload-url { contentType, size }` → `{ uploadId, uploadUrl }`. The client PUTs the prepared file to that R2 URL.
- `POST /media/transcribe { uploadId, language? }` → `{ jobId }` for WAV, or the legacy `{ segments }` result for Ogg.
- `POST /media/transcribe-status { jobId }` → status, or `{ status: "ready", segments, quality }`. The existing client waits internally and still returns the segment array.
- `POST /media/transcribe-cancel { jobId }` cancels an owned job.
- `POST /media/analyze { uploadId, prompt? }` → `{ result: string }`.

Each request uses `Authorization: Bearer <Convex JWT>`. The Worker verifies the current Better Auth session through Convex and checks ownership before accessing R2. It receives no Convex admin key. The signed PUT binds both MIME type and byte length. The client cannot submit an arbitrary provider URL or object key.

English WAV transcription uses independent Gemini verbatim text with PostBob’s conservative omission/cut-off merge and Modal forced alignment. It preserves the existing sentence/30-word caption segmentation and seconds-based word JSON. Non-English/undetected languages retain Deepgram timings. Provider failures fail the job instead of silently presenting guessed Gemini timings as aligned. `listen` uses Gemini, defaults to audio only, and supports `--keep-video`. Analysis timestamps are relative to the requested start offset.

## Configuration follows PostBob

`packages/config` owns stage classification and public runtime configuration:

- `src/stage.ts`: `resolveStage('dev')` produces a stable `dev-<user>-<machine hash>` stage for the main checkout. Inside a linked git worktree it produces `sandbox-<worktree>-<hash>` instead, so each worktree is a stage of its own. Explicit `--stage` remains available.
- `src/ports.ts`: `stagePorts(stage)` names the local listeners a running stage owns: Vite, the local Worker, the local Convex backend and its site, and the desktop's remote debugging port. A machine dev stage keeps 5173, 3000, 3210, 3211 and 9333; a sandbox stage gets a block derived from its name, so several worktrees run side by side.
- `src/stage-kind.ts`: development stages select `compound-dev`; `pr-*`/`preview-*` select `compound-preview`; production stages select `compound-prod`. Resource names still use the full stage, not the vault tier.
- `src/deployment.ts`: the public `rootDomain` is `compound.mov`, matching the Cloudflare zone and Resend domain. Production Convex is `strong-panda-857` (`https://strong-panda-857.convex.cloud`), as supplied by the user. These are version-controlled identifiers, not secrets. Recording this identity does not deploy the production backend or infrastructure.
- `src/runtime.ts`: derives web, Worker, Convex auth, desktop and Resend configuration together. Dev's web UI uses localhost on the stage's web port; its stable `server-dev-….<rootDomain>` hostname tunnels to the local Worker on the stage's server port, following PostBob. A sandbox stage's Convex URLs are `http://127.0.0.1:<port>` from its port block; no deployment output or deploy key is involved. Automatic PR stages use `preview-<clean-branch>-<hash>`, with `app-<stage>.<rootDomain>` and `server-<stage>.<rootDomain>`; production uses `app.<rootDomain>` and `server.<rootDomain>`.
- `src/models.ts`: `nova-3` for Deepgram and `gemini-3.5-flash-lite` for Gemini, matching PostBob's current Gemini analysis choice. Change these constants in code, not in 1Password or an env file.

Convex assigns deployment names, so those URLs cannot be inferred from a PR number. Non-production resolution accepts Convex's `CONVEX_URL` deployment output, reads the local CLI's `packages/backend/.env.local` in dev, or derives the hostname from a deployment-specific deploy key. A deployment-specific key must match the selected URL. Project preview keys must belong to the committed Compound team/project; Convex supplies their isolated deployment URL through its deploy command. Production uses the committed production deployment name. Previously generated app env URLs are never used to resolve a new stage.

No URLs, model identifiers, or sender email addresses belong in `.env.op`. The Resend sender is derived as `Compound <no-reply@<rootDomain>>`; verify that domain in Resend. Alchemy attaches Worker custom domains for preview/production and a Cloudflare Tunnel hostname for dev, so the root domain must be a zone managed in your Cloudflare account. Alchemy also hosts the Vite frontend at `app-<stage>...` outside local development. This makes the web frontend accessible; project-folder editing still requires desktop.

## Create the secrets

Create `compound-dev`, `compound-preview`, and `compound-prod`. The grouped `.env.op` uses the same item naming pattern as PostBob:

| Section / item | Fields | Destination |
| --- | --- | --- |
| Deployment / `Cloudflare` | `account-id`, `api-token` | Deployment tools; only the public account ID is a Worker variable |
| R2 / `R2` | `access-key-id`, `secret-access-key` | Worker and Convex signing credentials, scoped to the relevant stage buckets |
| Alchemy / `Alchemy` | `password`, `state-token` | Infrastructure workspace only; encrypt state and authenticate the CI state service |
| Convex / `Convex` | `deploy-key` | Convex CLI only; a project preview key in the preview vault |
| Convex / `Convex` | `team-access-token` | Preview teardown through the Management API; never synced to app runtime |
| Auth / `Better Auth` | `secret` | Convex only; at least 32 random characters, independent per tier |
| Auth / `Resend` | `api-key` | Convex only |
| AI / `Deepgram` | `api-key` | Worker and Convex transcription actions |
| AI / `Gemini` | `api-key` | Worker and Convex transcription actions; Google AI Studio/Gemini API key, not Vertex service-account JSON |

| AI / `Modal` | `token-id`, `token-secret` | Convex actions and Modal deployment CLI |

Use deployment-specific keys for dev and production. In `compound-preview / Convex / deploy-key`, use a project preview deploy key for `corporation/compound` (format `preview:corporation:compound|…`). Each branch stage creates or reuses its own isolated Convex deployment with `--preview-name`. The shared preview vault supplies credentials, not a shared database. Store the Convex team access token in `compound-preview / Convex / team-access-token`; it is injected only for preview by default and is used for exact-stage cleanup. Dev/prod setup does not require this additional token. The preview R2 signing credentials must cover the dynamically created preview buckets.

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

For deployment-specific keys, `setup` injects credentials, writes runtime config, and syncs the four Convex runtime variables. With a project preview key, setup stops after injection; `deploy` creates/reuses the preview first, receives its public URL, writes runtime configuration, deploys code, syncs auth settings, and deploys Alchemy. It does not deploy code, create vaults, or provision accounts. `deploy` syncs/deploys Convex through its CLI, then runs Alchemy to reconcile the bucket, Worker, secrets, and routing. `bun run deploy:infra --dev` runs just Alchemy. `bun run destroy --stage <stage>` destroys the selected Alchemy stack and does not delete Convex accounts/data. No Supabase data is migrated.

`bun run runtime:write --dev` regenerates configuration after a public identity/deployment-output change. For UI-only development use `bun run dev:desktop` or `bun run dev:web_v1`. Missing configuration produces a login setup message.

### Worktrees: one sandbox stage each

The machine's main checkout shares the team's cloud Convex dev deployment, which is why only one full `bun dev` per user can run against it. A linked git worktree (`git worktree add ../compound-feature -b feature`) resolves a `sandbox-<worktree>-<hash>` stage instead, and `bun dev` there brings up a stack that is independent of the main checkout and of other worktrees:

- **Convex** runs locally. Setup configures a local deployment in the committed `corporation/compound` project (`npx convex dev --dev-deployment local`) on the stage's ports; its data lives in the ignored `packages/backend/.convex/` beside the functions, so each worktree keeps its own database. The Convex CLI must be logged in on the machine (`npx convex login`). The dev vault's deploy key is injected but never used by a sandbox.
- **Worker, R2 bucket and tunnel** are the stage's own `compound-media-<stage>` and `compound-server-<stage>`, provisioned by Alchemy like any dev stage, with the tunnel forwarding `server-<stage>.<rootDomain>` to the local Worker on the stage's server port.
- **Vite and Electron** listen on the stage's web port. The desktop runs with its own profile, `Compound-<stage>` under the platform's application-data directory, so its single-instance lock, saved projects (`~/Movies/compound-<stage>`) and chat data are separate, and it exposes the stage's inspector port for remote debugging.

Each worktree needs its own `bun install`, and the root `.env` with `OP_SERVICE_ACCOUNT_TOKEN` is not versioned, so copy it in before `bun dev`; the checked-in `t3.json` does both when T3 Code creates a worktree. Ports are derived from the stage name (`stagePorts` in `packages/config`) and are recorded in `apps/web/.env` for the launcher.

- `bun run sandbox:info` prints the stage, ports, URLs, Electron profile, CDP endpoint and sign-in code as JSON.
- `bun run sandbox:seed` (with `bun dev` running) signs in as `agent@compound.mov` and writes a sample project into the personal organization's workspace through Convex.
- `bun run sandbox:clean` destroys the stage's Alchemy resources, its local Convex database, its Electron profile and its projects folder. Follow it with `git worktree remove`.

**Sign-in on developer stages.** Dev, sandbox and test stages issue the fixed code `000000` for any address and log it instead of emailing (`acceptsSandboxOtp` in `packages/backend/convex/auth.ts`). Preview and production stages email the code as before. A deployment without `STAGE` behaves as production.

Agents get the same instructions from `.agents/skills/sandbox/SKILL.md`.

Injection resolves only credentials listed in `.env.op` and distributes them according to each app's grouped `.env.example`. Literal credentials and bootstrap tokens are rejected in `.env.op`. Like PostBob, the injector passes a temporary reference-only file to `op inject` because stdin detection fails under Bun; it captures resolved values and removes the temporary file. `--include KEY` refreshes selected credentials only after full injection for the same stage. `--check` writes nothing. Full stage changes clear prior runtime values; runtime generation writes only allowlisted values with restrictive permissions. Generated files stay ignored, and secrets are never printed or placed in subprocess arguments.

The web app receives public URLs; desktop runtime configuration also includes its stage and default project-folder name. Neither receives provider secrets. Production release configuration is derived directly from committed config and needs **no 1Password access**.

### Issues to T3 Code threads

The short version of this loop, for anyone filing issues, is in `docs/issue-worker.md`.

Planned work reaches the ThinkPad through GitHub. An agent planning with Isaac opens an issue on `corporationdev/compound` whose body is the plan and labels it `ready`. `bun run issue-worker` (`scripts/issue-worker.ts`, installed as the user unit in `scripts/issue-worker.service`) checks every minute and, for each `ready` issue while fewer than three are `in-progress`, moves the label to `in-progress`, starts a T3 Code thread whose first message is the issue, and comments the branch and thread id. The thread runs in a new worktree on `issue/<number>-<slug>`, created from `main` (or `--base`), where T3 Code runs the `t3.json` setup script. The agent there follows `.agents/skills/issue-worker/SKILL.md`: implement, verify in a sandbox, open a PR that says `Closes #<number>`, label the issue `in-review`, or comment and stop if blocked. A thread that fails to start puts the issue back to `ready` with a comment. Isaac follows the thread in the T3 Code app on his Mac, where the ThinkPad is an environment.

T3 Code has no public API. `scripts/lib/t3code.ts` uses the one its own client uses (checked against 0.0.40): `GET /api/orchestration/*` for reads and `thread.turn.start` with a bootstrap over the `/ws` RPC socket. It mints its bearer session with T3 Code's CLI through the desktop binary and caches it in `~/.config/compound-issue-worker/`. That version runs the project's stored scripts rather than reading `t3.json`, so the worker copies the `t3.json` scripts into the Compound project when it has none. Each issue maps to a fixed thread id, so an issue is never started twice. `--once` runs a single pass.

The issue worker exists and runs on the ThinkPad.

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

The 18 automated tests use Convex's test runtime and mocked email/provider responses to cover OTP/native auth, JWT claims, revoked sessions, account cleanup, ownership, quotas, signed upload constraints, provider normalization/cleanup, local 1Password token precedence, and concurrent private-file writes. Workspace typechecks include the Alchemy stack and deployed Convex-generated bindings. A patch lets Electron Forge locate hoisted Electron from `bun.lock`. The optional Redraw example requires an external vendor tarball as described in `docs/examples/11-redraw.tsx` and is excluded from the standard example typecheck.

Verify actual email delivery and sign-in in browser, Electron dev, and a packaged build, including restart and sign-out. The sender domain is verified, and audio transcription/analysis and auth transport have passed live smoke tests; video analysis, scene captions, and cancelled/long requests still need live checks.

## CI and distribution

`Check` runs without secrets on pushes and pull requests. `Deploy cloud` is manual, selects a GitHub environment named `dev`, `preview`, or `prod`, and reads its `OP_SERVICE_ACCOUNT_TOKEN`. Setup writes the infra workspace's Alchemy credentials; deploy syncs Convex and runs Alchemy with its Cloudflare state store in CI. Give each environment a suitably scoped service account. The manual workflow remains available for shared dev/preview/prod stages.

`Prepare PR` deploys a pull request's preview on request (a `prepare-linux`, `prepare-mac`, `prepare-both` or `prepare-preview` label on the PR, added by an agent with `bun run pr prepare <n>` and removed by the run; or `workflow_dispatch` from the Actions tab once the workflow is on `main`), using GitHub environment `Preview` and its `OP_SERVICE_ACCOUNT_TOKEN`, then builds desktop installers against that preview for the platforms asked for: a Linux zip, and a signed, notarized macOS universal DMG and zip using the prod vault's Apple credentials. A pull request build is named `Compound PR <n>` with bundle id `dev.corporation.compound.pr<n>` and, when packaged for a non-production stage, its own profile `Compound-<stage>`, so it installs and runs beside the real app (`scripts/pr-brand.ts`, read by the packager and by main). Installers are published to the public R2 bucket `compound-evidence` under `pr-<number>/`, served at `https://evidence.compound.mov/`, listed in a PR comment, and deleted with the preview when the PR closes. The bucket is account-level (declared with the production Alchemy stage, custom domain attached once through the API); every tier's R2 key can write to it. GitHub's Actions artifact storage is not used: the organization's quota fills up. Only same-repository PRs are prepared; forks never receive credentials. The branch-derived stage adds an eight-character hash to PostBob's cleaned/truncated name to prevent collisions. Re-running is idempotent: the Convex preview and Alchemy resources are reused by name, and runs for one branch serialize with each other and with teardown through the branch's concurrency group. Nothing deploys on push.

The deploy workflow injects `compound-preview`, runs `convex deploy --preview-name`, writes configuration from the returned Convex URL, syncs auth environment variables, and deploys the media Worker, R2 bucket and Vite web frontend through Alchemy. It maintains one PR comment with web/API links and deployment status. Unlike PostBob's `--preview-create`, `--preview-name` preserves test accounts and data between pushes. Incompatible schema changes may require a migration or deliberate reset. Convex previews still have provider-managed expiry; these are not permanent databases.

`Teardown Preview` runs when a PR closes or merges. It skips cleanup if the PR was reopened while queued, destroys only that stage's Alchemy resources (including emptying its temporary R2 bucket), and deletes the exact matching Convex preview through the Management API. Convex deletion is attempted even if Alchemy cleanup fails. Cleanup can be retried with the same stage; it never offers an all-previews deletion option.

To exercise a preview manually, use `bun run setup --stage preview-example` then `bun run deploy --stage preview-example`. To remove it, inject that stage and run `bun scripts/teardown-preview.ts --stage preview-example`. These commands modify the selected environment; use a separate checkout to keep local dev configuration intact. CI uses encrypted remote Alchemy state automatically.

Lifecycle tests: `bun test scripts/preview.test.ts`. Workflow YAML, local checks and the web build are verified separately from an actual GitHub Actions deployment.

The tagged macOS release workflow derives public production URLs from `@compound/config/runtime`, with no 1Password step. Existing macOS signing/notarization secrets remain GitHub secrets: `MACOS_CERT_P12`, `MACOS_CERT_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`. GitHub supplies `GITHUB_TOKEN`. No provider key is needed on a release runner.

Release publishing/download links now target this repository (`corporationdev/compound`). Upstream auto-update, install telemetry, hard-coded Sentry reporting, and the upstream Homebrew tap workflow were removed. Desktop builds are named Compound, with bundle ID `dev.corporation.compound`, Compound artwork, and `Compound-arm64.dmg` releases. The CLI command is now `compound`; update older scripts that invoke `dapi`. See [branding-audit.md](branding-audit.md).

References: [Better Auth bearer sessions](https://www.better-auth.com/docs/plugins/bearer), [Convex Better Auth](https://labs.convex.dev/better-auth), [Cloudflare fixed-length request streams](https://developers.cloudflare.com/workers/runtime-apis/request/), [R2 lifecycle API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/update/).

Convex lifecycle reference: [named previews preserve existing data; preview-create resets it](https://docs.convex.dev/production/multiple-deployments), [Management API team tokens](https://docs.convex.dev/management-api/overview).


## Improved transcription deployment

`bun run deploy --stage <stage>` deploys `compound-wav2vec-aligner` to the matching Modal environment before syncing/deploying Convex and the Worker. The Modal deployment script follows PostBob’s pinned Python CLI pattern and creates an ignored `.cache/modal-cli` environment when needed; Python 3 with venv support is required. For development, deploy the aligner once with `bun scripts/modal-aligner.ts --stage <stage>` and redeploy after Python changes. `bun scripts/modal-aligner.ts stop --stage <stage>` stops only Compound’s app, preserving any other apps in that Modal environment.

Add a `Modal` item with `token-id` and `token-secret` to each Compound environment vault before running fresh setup/CI injection. The existing development Modal account was used for the initial isolated Compound app test; preview and production credentials/deployments must be provisioned separately. No production deployment was performed as part of this restoration.

Transcription uses 16 kHz mono PCM16 WAV for both source extraction and rendered scene audio. The 100 MiB upload limit permits about 54.6 minutes. Job metadata lives in Convex; provider responses, corrected words, alignment batches and final JSON live under the temporary R2 `media/` prefix. Jobs expire with their upload. Account deletion cancels jobs and removes ownership records; R2 lifecycle removes temporary bytes. Successful caption files stay in the local library. The client’s upload cache stores references, never credentials, scoped to account/environment/pipeline/scene seed.
