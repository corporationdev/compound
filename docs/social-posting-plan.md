# Social posting implementation plan

Status: connections (section 5) implemented September 9, 2026; posting, media, and the Posts tab are still proposed. Based on the PostBob direct-posting integration at `/Users/isaacdyor/code/postbob` (`docs/social-posting-plan.md`, `packages/backend/convex/social_*.ts`, `packages/backend/tests/social-posting.test.ts`).

Compound gains the ability to publish a rendered scene to Instagram, TikTok, YouTube, X, LinkedIn, or Facebook through Zernio, schedule it, and see every past and upcoming post in one place. PostBob proved the provider contract and the recovery model; this plan ports that backend and designs a desktop-first UI on top of Compound's local projects and local rendering.

**1. Product structure**

Three surfaces, each in the place users already look for that kind of thing:

| Surface | Where | Why |
| --- | --- | --- |
| Connected accounts | Settings → new "Connected accounts" section (`apps/web/src/components/dashboard/settings-view.tsx`) | Connection is configuration, done rarely. It sits with the projects folder and permissions rows and reuses `DashboardInfoActionRow`. |
| Posts | New top-level sidebar tab "Posts" next to Projects (`DashboardView` gains `"posts"`; new `apps/web/src/components/dashboard/posts-view.tsx`) | A daily surface. A list of upcoming and published posts with status, edit, cancel, retry, and "New post". |
| Composer | A modal (`DashboardFormModal` pattern) opened from two entry points: the editor's export panel (`apps/web/src/components/sidebar-right/inspector/export.tsx`) gets a **Post** button beside Export, and the Posts tab gets **New post** | The composer is the same component in both places: media, accounts, caption, cover, Now/Schedule, submit. |

Connections are not a sidebar tab. The Posts tab's empty state and the composer's account picker both link to Settings → Connected accounts so the user never has to hunt for it. If connections later grow analytics or per-account settings, promote them to a tab then.

The web build shows the Posts tab and Settings section (they are Convex-backed, so they work in the browser) but cannot create a post from a project, because rendering is desktop-only. "New post" in the browser explains that and offers the desktop download banner already used by `DashboardGetDesktopApp`.

**2. Rendering and the "do I need a render first" question**

Compound renders only inside the Electron renderer, in the open project's editor, one render at a time (`apps/web/src/context/render.ts`, `renderOverlay` guard). There is no headless or cloud render, and the app may be closed at a scheduled time. So:

- A post always references a **finished rendered file uploaded to R2**, never "render this project later". Scheduling means Zernio holds the media URL and publishes at the instant; nothing in Compound has to be running.
- Creating a post from the editor **triggers the render automatically**. The user does not have to export first. Flow: Post button → the scene's export entry (`compound.export.<sceneId>`, defaulting to a social preset from `export-templates.ts`) renders to `<project>/exports/<scene>.mp4` via `renderScene` with an `ElectronWritableFileHandle`, the same path the CLI export already uses → the file streams to R2 → the composer opens as soon as the render starts, so caption, accounts, and schedule can be written while the upload finishes. Submit is enabled once the upload is confirmed.
- Creating a post from the Posts tab asks for a project, then a scene, then navigates to the editor with `?post=<sceneId>` and runs the same flow. Rendering always happens in the editor; the Posts tab never renders. An alternative "attach an existing export file" chooser is a later addition.
- A post freezes its media. Editing the project later does not change a scheduled post. The composer offers **Replace video** which re-renders and swaps the upload, mirroring PostBob's explicit replacement rule.
- Each post records `projectId` (the nanoid in the project's `package.json`), `sceneId`, the export config, and a SHA-256 of the file. The Posts tab resolves project names from the local project list when the folder still exists and falls back to the name saved at post time.

Render config for posting: default to the platform preset matching the first selected account (`instagram-1080p`, `tiktok-1080p`, `youtube-1080p`) when the scene has no export entry; otherwise honor the scene's entry. Warn, do not block, when the aspect ratio does not match the platform.

**3. Responsibility split**

PostBob does everything in Convex. Compound's rule (`docs/convex-migration-plan.md`) is: Convex owns durable data and scheduling; the Worker owns storage credentials and provider HTTP. Posting is dominated by scheduler-driven work (dispatch leases, cron sweeps, webhooks), which is what Convex is good at and what Workers are explicitly not (not durable jobs). So the split is:

| Concern | Home | Notes |
| --- | --- | --- |
| Zernio profile/account/post calls | Convex actions and internal actions | Port `social_provider.ts`, `social_connections.ts`, `social_dispatch.ts`, `social_jobs.ts`, `social_model.ts` nearly verbatim. `ZERNIO_API_KEY` lives in Convex. This is the one deliberate exception to "no provider keys in Convex", because the dispatch loop cannot live anywhere else. |
| OAuth callback, Zernio webhook | Convex `http.ts` routes `/social/callback`, `/webhooks/zernio` | Same as PostBob. `ZERNIO_WEBHOOK_SECRET` in Convex. |
| Durable state, cron, scheduler | Convex tables + `crons.ts` (`sweep` every minute) + `ctx.scheduler` | Reuses the transcription job pattern. |
| R2 signing (multipart upload, GET for Zernio and previews) | Worker (`apps/server/src/index.ts`, `apps/server/src/upload.ts`) | Uploads use the shared `/upload/begin`, `/upload/complete`, `/upload/abort` routes with `purpose: 'social'`; previews and Zernio use `/social/media-url` and `GET /social/media/:targetId/:kind?token=`. R2 credentials stay in the Worker. |
| Rendering, file streaming | Electron renderer + main | Existing `renderScene`; new main-process streamed upload. |

Media capability URL handed to Zernio: `${SERVER_URL}/social/media/<targetId>/<video|cover>?token=<mediaToken>`. The Worker validates the token with a public Convex query (`social_targets.resolveMedia` returns the R2 key only on an exact token match) and 307-redirects to a 10-minute signed R2 GET. This keeps the PostBob design (stable capability URL, short-lived signed object URL) while keeping signing in the Worker. The Worker must also answer HEAD and pass Range through, since platforms fetch with both.

Storage: social media goes under the `social/` prefix, outside the existing `temporary-media` lifecycle rule on `media/` (`packages/infra/alchemy.run.ts`). Add a separate lifecycle rule deleting `social/` objects 30 days after creation; the sweep also deletes objects for posts that reached a terminal state more than 7 days ago. Raise the per-object cap for this prefix to 300 MiB (PostBob's limit) in a new `social` upload schema; the existing 100 MiB media cap is unchanged.

Upload transport: every upload (post video, transcription media, library audio) goes through one multipart flow (`packages/config/src/upload.ts`). The Worker registers the row for the purpose, opens an S3 multipart upload and signs one URL per 8 MiB part; the client uploads parts three at a time with per-part retry, then the Worker lists the parts R2 holds, completes the object and verifies size and type before marking the row ready. Small files are one part. On desktop the main process reads parts from disk by offset (`apps/desktop/src/cloud-upload.ts`, `CLOUD_UPLOAD` with progress on `CLOUD_UPLOAD_PROGRESS` and `CLOUD_UPLOAD_CANCEL`); in the browser the parts go out with XHR (`apps/web/src/lib/upload.ts`).

**4. Data model (Convex `packages/backend/convex/schema.ts`)**

All tables owner-scoped by `ownerId` (the Better Auth user id) with `by_owner` indexes, matching `uploads`.

- `socialProfiles`: `{ ownerId, providerId }`. One Zernio profile per Compound user, created lazily on first connect, named `Compound <ownerId>`.
- `socialAccounts`: `{ ownerId, providerId, profileId, platform, username, avatarUrl, active, updatedAt }`. Indexes `by_owner`, `by_provider`. Soft-deleted on disconnect.
- `socialConnections`: `{ ownerId, stateHash, profileId, platform, expiresAt, completed }`. 30-minute single-use OAuth state.
- `socialMedia`: `{ ownerId, kind: video|cover, key, contentType, size, sha256, durationMs?, width?, height?, projectId, sceneId, projectName, exportConfig, ready, createdAt }`. Registered by the Worker upload route; `ready` flips when the Worker confirms the object via HEAD.
- `socialPosts`: `{ ownerId, caption, videoId, coverId?, coverOffsetMs?, accountIds[], scheduledFor: number|null, timezone, projectId, sceneId, projectName, status, version, submittedVersion, updatedAt }`. The editable draft plus aggregate status.
- `socialPostTargets`: PostBob's shape (`postId, accountId, platform, providerPostId, postUrl, snapshot, requestedSnapshot, mediaToken, requestId, requestBody, status, operation, attempts, dueAt, leaseToken, leaseExpiresAt, error`). Indexes `by_post`, `by_provider_post`, `by_due`, `by_owner_and_status`.
- `socialWebhookEvents`: `{ eventId, providerPostId, receivedAt }`.

Statuses and `aggregateSocialStatus` come straight from PostBob's `social_model.ts`: `draft, uploading, queued, submitting, scheduled, publishing, published, failed, partial, checking, cancelling, cancelled`.

Differences from PostBob: no `projects.socialPublicationId` pointer (projects are local folders, not rows), so a project can have many posts and the Posts tab is the index; no multipart upload tables; `projectName` is denormalized because the folder may be gone later.

**5. Connections (Settings → Connected accounts)** — implemented

Platforms: Instagram, TikTok, YouTube, X, LinkedIn, Facebook. The values are Zernio's slugs, so X is `twitter` on the wire (`packages/backend/convex/social_model.ts`).

Rows per active account: avatar, `@username`, platform, Disconnect (confirmed in a dialog). **Connect account** is a menu of the six platforms; **Refresh** re-syncs from Zernio's account list. Lives in `apps/web/src/components/dashboard/connected-accounts.tsx`, mounted in `settings-view.tsx`.

The rule: **the backend completes the connection, the app observes it.** The return trip into the app is a courtesy, never load-bearing.

1. `social_connections.connect({ platform, returnUrl })` (Convex action) creates the user's Zernio profile on first use, stores a hashed single-use state (30 min), and returns Zernio's `authUrl`. `returnUrl` is validated: only `compound://social-connected` or a page on `SITE_URL` is accepted.
2. Desktop opens the URL in the system browser (`APP_OPEN_EXTERNAL`); the web build navigates the tab.
3. Zernio redirects to `<CONVEX_SITE_URL>/social/callback?state=…&accountId=…`. The route (`social_http.ts`) runs `complete`, which re-lists accounts, upserts `socialAccounts`, and consumes the state. It then renders an HTML page: "Connected. Return to Compound." with a one-second meta refresh to the return URL when one was given, carrying `platform` and `username`.
4. Every client subscribes to `social_connections.list` through `createQuery` (`apps/web/src/lib/convex.ts`, the first reactive Convex consumer in the UI), so the new row appears the moment step 3 saves it, on web, desktop, and any future mobile client alike.
5. Desktop deep link, focus only: the app registers the `compound` scheme (`app.setAsDefaultProtocolClient`, plus `protocols` in `forge.config.ts` for the packaged bundle). `apps/desktop/src/deep-link.ts` parses links from `open-url` (macOS), second-instance argv (Windows/Linux), and cold-start argv, and holds one in an inbox until the renderer asks (`APP_DEEP_LINK_TAKE`) or is ready for a push (`APP_DEEP_LINK`). The renderer (`apps/web/src/lib/deep-link.tsx`, mounted at the app root) routes `social-connected` to Settings and toasts the username. A mobile client would pass its own scheme as `returnUrl` and add it to `validateReturnUrl`.

Tables (`schema.ts`): `socialProfiles`, `socialAccounts` (soft-deleted on disconnect), `socialConnections` (OAuth state). Account deletion runs `social_connections.removeForUser`, which drops rows and detaches Zernio accounts with exponential retry. Env: `ZERNIO_API_KEY` in the Convex runtime (`.env.op`, `packages/backend/.env.example`, `scripts/backend.ts`). Tests: `packages/backend/test/social-connections.test.ts` (mocked Zernio, full round trip, replay, ownership, escaping) and `apps/desktop/test/deep-link.test.ts`.

**6. Composer**

One component, `apps/web/src/components/social/composer.tsx`, used from the editor and the Posts tab. Sections:

- Media: video preview from the local file when available, otherwise a signed R2 URL. Upload progress inline. **Replace video** (editor only).
- Cover: frame scrub over the local file producing a JPEG, or leave unset to let the platform pick. Stored as a second `socialMedia` object.
- Accounts: multi-select of active accounts, grouped by platform. Empty state links to Settings.
- Caption: textarea with a 2200 code-point counter. Autosave, 600 ms debounced, through `socialPosts.save` with optimistic `expectedVersion`.
- Timing: Now / Schedule with a date-time picker and IANA timezone (default to the system zone). Stored as a UTC instant plus zone.
- Actions: **Post now** / **Schedule** / **Save changes** (already scheduled) / **Cancel schedule** / **Retry** (per failed target). Submit is disabled until every media object is `ready`.

TikTok: check creator info before submit; posts are public by default and unpostable accounts get an actionable error, as in PostBob. YouTube: needs a title; the composer shows a title field only when a YouTube account is selected. Verify YouTube's `platformSpecificData` against the Zernio docs during implementation, since PostBob never shipped YouTube.

**7. Posts tab**

`posts-view.tsx` with `DashboardScrollView` and sections in this order: **Needs attention** (failed, partial, checking), **Upcoming** (scheduled, ascending), **In progress** (uploading, submitting, publishing), **Published** (descending, paginated), **Drafts**. Each card: cover thumbnail, project and scene name, caption excerpt, platform badges each colored by target status, time (scheduled or published, in local zone), and a menu with Edit, Open on platform, Cancel schedule, Retry, Delete draft. Clicking opens the composer in edit mode.

A month calendar is a second iteration. The list with an Upcoming section covers the "what is going out and when" question and is cheaper to get right. When the calendar is built it reads the same `socialPosts` query filtered by a date range.

**8. Dispatch, scheduling, and recovery**

Port PostBob's dispatch as-is; it is tested and handles the failure modes that matter:

- One Zernio post per target (one platform each), `POST /posts` with a stable `x-request-id` and frozen `requestBody`; 409 adopts `existingPostId`; after the 4-minute window, reconcile by scanning `/posts?accountId=` for the same caption and media URL; refuse re-submission after 23 hours and stay `checking`.
- `settleProvider` maps `post.platforms[0].status` to our status, records `platformPostUrl`, and re-arms `dueAt` (near the scheduled instant for `scheduled`, +20 s for `publishing`).
- Cron `social sweep` every minute picks up to 30 due targets by `by_due`, leases them for 180 s, and runs the operation (`create | update | cancel | retry | poll`).
- Webhook `POST /webhooks/zernio`: HMAC-SHA256 over the raw body in `x-zernio-signature`, deduped by event id, never trusted for content; it only sets `dueAt = now` and schedules a sweep that re-fetches live state.
- Missed schedules (app offline is irrelevant, Zernio publishes; but a target still `queued` past its instant because upload never finished) go to `failed` with "Missed scheduled time", never an implicit immediate post.
- Retries: exponential to 60 s, 8 attempts, honor `Retry-After` up to an hour.

Tests: port `social-posting.test.ts` (mocked `fetch`, real response shapes) into `packages/backend/tests/`, adapting table names. Add tests for the Worker media route (token mismatch, HEAD, Range passthrough) and the streamed upload.

**9. Access, configuration, and secrets**

- Gate the feature behind `SOCIAL_POSTING_ALLOWED_EMAILS` in the Convex runtime for the first release, enforced in `connect`, `save`, and `submit`, and reflected in the UI as a disabled Connect button with a contact line. Remove the gate once Zernio plan limits and cost are understood.
- Convex runtime: `ZERNIO_API_KEY`, `ZERNIO_WEBHOOK_SECRET`, `SOCIAL_POSTING_ALLOWED_EMAILS`, `SERVER_URL` (to build media URLs). Add to `.env.op` as `op://compound-${ENV_TIER}/Zernio/api-key` and `…/webhook-secret`, to `packages/backend/.env.example`, and to the backend env sync allowlist.
- Worker: no new secrets. New `social/` prefix, new routes, bucket lifecycle rule in `alchemy.run.ts`, and CORS unchanged (the desktop upload runs from main, not the browser origin; the web build cannot upload video anyway).
- Zernio dashboard: register the webhook URL `<CONVEX_SITE_URL>/webhooks/zernio` per stage. Dev, preview, and prod each need their own Zernio API key or at least distinct profile naming, since accounts are attached to a Zernio profile.
- Release notes and `docs/cloud-setup.md` gain the Zernio fields and the smoke-test checklist (connect one account, post now, schedule five minutes out, cancel, retry a failure).

**10. Implementation order**

1. **Backend foundation.** Done (no allowlist gate yet; see section 11).
2. **Connections UI.** Done, including the desktop deep link.
3. **Media path.** `socialMedia` table, Worker `/upload/*` (purpose `social`) and `/social/media/:id/:kind`, `social/` lifecycle rule, main-process multipart upload from disk with progress and cancel. Acceptance: upload a 200 MiB mp4 from disk, fetch it through the capability URL with HEAD, GET, and a Range request.
4. **Post from the editor.** Post button in the export panel, render-then-upload orchestration in a new `apps/web/src/context/social.tsx`, composer, `socialPosts.save/submit`, dispatch port, cron, webhook. Acceptance: post now to one account, schedule to two accounts, cancel one, retry a forced failure, and observe statuses update reactively.
5. **Posts tab.** List view, edit mode, per-target actions, New post → project → scene → editor handoff via `?post=`. Acceptance: every post created in step 4 appears with the correct section and actions.
6. **Later.** Calendar view, attach-existing-export chooser, multipart resumable uploads, a `compound post` CLI/dapi command so the chat agent can draft posts (PostBob's `update_post` tool is the reference: caption and cover only, never accounts or timing), and analytics.

**11. Decisions to confirm before step 1**

- Allowlist gating for the first release versus open to every signed-in user. Connections currently have no gate; `connect` is the one place to add it.
- Retention of published media in R2: 30 days after upload (recommended) versus indefinite, which would require a storage budget.
- Whether the web build should show the Posts tab at all before browser rendering exists (recommended: yes, read-only plus status actions).
