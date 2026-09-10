# Media library implementation plan

Status: proposed; implementation has not started. Based on the working trees inspected on September 9, 2026.

The library is one searchable pool of Compound's curated media, the signed-in user's uploads and saved media, and external search results. Project remains the collection of files available to one edit. The user confirmed that Compound should initially reuse PostBob's curated selection.

**1. Product structure and scope**

Replace the Assets heading with Project / Library tabs. Keep + and the filter/settings control beside them. Project is the default tab; remember library search and selection when switching. Library initially has Music / Sound effects. No required Catalog / My library dropdown. Source and ownership are optional filters and small result badges.

In Project, + offers Import files and Browse library. In Library, + offers Upload audio and Add from link. Uploads go to the account's personal library; they are not automatically attached to the project. Add from link uses the same exact-source resolver as pasting a URL into search. The filter control holds source filters, saved-only, duration, and sorting; avoid offering mood/BPM filters until the metadata supports them.

V1 includes curated music and SFX, private audio uploads, saving discovered tracks, YouTube search and exact links, MyInstants SFX search and exact links, auditioning, source-range selection, project import, timeline drag/drop, and CLI parity. Video/image library views, collections, semantic search, and generation are subsequent work. The underlying media records can support images/video without showing unfinished controls.

**2. One search with progressive results**

An empty search browses curated items and personal items together. Use the curated manifest's order for the initial curated selection and surface recently added/used personal items without hiding the starter tracks. Provide pagination from the start.

Typing debounces a fast query over curated and personal titles, descriptions, and supported tags. Enter or the search button submits that same query to external providers as well: YouTube for Music, MyInstants for Sound effects. There is no source-mode switch. The placeholder says "Search music or paste a YouTube link" in Music. Explain the submission behavior with a short hint only while typing.

Show library matches immediately; merge external results into the same list as they arrive. Preserve selection and scroll position when results update. Keep the selected preview item stable even if a new query no longer matches it. If external search fails, retain local matches and show "YouTube search unavailable — Retry"; a partial result is not an empty successful search.

Use canonical source identity to merge duplicates: the same YouTube video can be curated, saved, and returned by search, but appears once. Display all applicable membership states on that result. Order exact title matches ahead of weak matches; use personal membership, curation, availability, and recency as boosts. Initially use deterministic lexical ranking and provider rank, not embeddings. Reserve capacity for external matches so a full first page of library matches cannot silently suppress them, which PostBob's current concatenate-and-slice implementation can do.

Cache external source IDs and provider metadata by provider, query, locale, filters, and adapter version. Apply personal metadata only at response time. Use PostBob's 24-hour TTL as a starting configuration. Share concurrent identical public searches, but never globally cache a merged response containing private uploads or overrides. For v1, explicitly cap provider results at a configured limit (initially 20); paginate that result snapshot and do not imply unbounded YouTube pagination. Scope private search indexes by authenticated owner; do not copy PostBob's capped 500-row scan as the permanent search implementation.

**3. Exact YouTube links are first-class input**

Yes: support watch, youtu.be, shorts, embed, and music.youtube.com links naming one public video. Normalize them to provider + video ID. Strip tracking parameters from identity. A video URL containing playlist parameters resolves only that video; playlist-only/channel/search URLs return an actionable unsupported-input error. Do not import an entire playlist implicitly.

Pasting a recognized link and submitting it resolves that exact source, even if keyword search would never return it. Existing sources return immediately. New ones require an exact-ID metadata lookup; add that provider capability explicitly instead of using a text search and trusting the first match. PostBob already has a useful URL parser for its deployment manifest, but its general provider interface currently exposes search/resolve/artwork, not a client-facing exact-link lookup.

If the link includes a valid timestamp, use it as a draft preview in-point. It does not change source identity or silently overwrite a saved range. Reject a point past measured duration. Saving the range is explicit. In Music, importing a YouTube video produces an audio asset; downloadable video is a separate future capability.

The lookup displays metadata and actions. It does not create personal membership, import into the project, or place a clip. If a provider cannot supply metadata without preparation, surface that state as "Resolving link" and reuse the resulting cache, while preserving those membership boundaries.

**4. Preview, saving, and placement have explicit effects**

| Action | Media cache | Personal library | Project | Timeline |
| --- | --- | --- | --- | --- |
| Browse/search/resolve | Metadata and artwork only where supported | Unchanged | Unchanged | Unchanged |
| Play/prepare | Prepare cached audio if needed | Unchanged | Unchanged | Unchanged |
| Save to library | Ensure durable media is available | Add membership | Unchanged | Unchanged |
| Upload audio | Store private durable audio | Add membership after validation | Unchanged | Unchanged |
| Add to project | Prepare/download if necessary | Unchanged | Add local asset | Unchanged |
| Drag to timeline | Prepare/download if necessary | Unchanged | Add local asset | Insert at captured drop target |
| Project item: Save to library | Upload/copy if necessary | Add membership | Unchanged | Unchanged |

Use compact audio rows: play/pause, title, duration, secondary description, source/saved/in-project state. The selected item has one preview dock with scrubber, volume, optional waveform/trim, Save, and Add to project. Only one library preview plays at once. Starting preview pauses editor playback; starting editor playback stops preview. Closing the panel stops auditioning. Space controls preview only when focus is in its controls; otherwise preserve editor shortcuts. Support keyboard navigation and an explicit insertion command alongside drag/drop.

Preparing remote audio can take time. Show real states (queued, preparing, downloading, ready, failed), not a fabricated percentage. Clicking another result stops obsolete playback from starting when its request finishes. A shared backend preparation may finish after the preview closes, without changing any library/project membership.

Retain immutable originals. A selected source range is metadata, not a newly trimmed file. Resolve the default as personal range, then curated range, then full source; an explicit full-file personal selection opts out of inherited trimming. Preview drafts take precedence only for the current action. Resetting a saved default restores inheritance. V1 has one saved range per source per membership; multiple named excerpts are future work.

Insertion captures project, parent/scene, timeline start, and source range before any asynchronous work. Do not use a later playhead or whichever project becomes visible. If the captured parent disappears, keep the imported project asset and report that placement could not complete. Drop location determines timing for both Music and SFX; explicit Insert at playhead uses the captured playhead. Do not copy PostBob's automatic music-at-zero or continuous/ripple-track policy into Compound's different timeline model.

Snapshot sourceIn/sourceOut into the authored JSX. Existing clips never change when catalog metadata/ranges change. Preserve the full original so users can extend trims. Make timeline insertion one ordinary undoable editor operation; undoing placement can leave the imported asset available in Project. No automatic looping, ducking, normalization, or music-bed generation in v1.

**5. Backend and data boundaries**

Keep Compound's existing architecture: authenticated Worker API, Convex state/workflows, R2 bytes, local project manifests. Add a library service behind the Worker and reuse it from desktop/web and CLI. The CLI uses the running app's authenticated session; no Apify token or separate provider authentication on the user's machine.

| Record | Responsibility |
| --- | --- |
| Media source | Stable identity and origin: external provider ID, private upload, or future generation. Includes media type and canonical metadata. |
| Media object/version | Immutable bytes, checksum, content type, measured duration/dimensions, storage key and preparation state. |
| Curated entry | Public membership, ordering, editorial description, category and preferred source range. |
| User library entry | Private membership, personal name/description/category, saved source range and timestamps. |
| Search cache/job | Public discovery results, provider run/status, expiry and resumable search snapshot. |
| Preparation/import job | Durable progress, attempts, provider run ID, retry/error state and completion intent where needed. |
| Project asset/provenance | Compound's existing local asset record plus source/object references and imported metadata snapshots. |

Keep media type (audio/image/video), use category (music/SFX/B-roll), and origin (YouTube/upload/generation) separate. A YouTube source can eventually serve multiple use categories. Generation is a job that produces a media object, not a new kind of timeline asset.

Suggested service operations: list, search/start-search, resolve-link, get-source, prepare, get-job, create/finalize-upload, save, update-personal, remove-personal, and authorize-download. Account operations do not require a project ID. Project import is coordinated locally; do not transplant PostBob's projectAssets table or editing-session authorization into a repository where project membership lives in assets.yml.

**6. Permanent storage and local project integration**

Compound's current uploads expire after 24 hours and the R2 media/ prefix has a matching one-day lifecycle rule. Library audio must use separate durable records and prefixes, such as library/private/ and library/catalog/. Temporary upload staging can have an expiry. Do not change the transcription upload contract to make all uploads permanent.

For private upload: reserve an owner-scoped record, issue a bounded signed upload URL, upload bytes, verify size/checksum and probe real media, then commit a library entry. Failed or abandoned staging uploads expire without creating playable entries. Start with verified MP3, AAC/M4A and WAV support; add other codecs only after checking preview/export support or providing an explicit playback derivative. Preserve originals. Make byte, duration, storage and provider limits configuration; use PostBob's existing audio limits as initial external-provider bounds and validate private-upload limits during implementation.

Authorize every private lookup, download, update and deletion. Private bytes and metadata never become public through a cache hit or content-hash match. Shared external caches contain only publicly discoverable provider sources. Clear account-scoped UI/cache state when switching users. Catalog administration uses server-enforced permissions or deployment credentials.

Adding to a project downloads bytes into its assets/ directory and registers them through AssetLibrary, producing a project-relative src. Store stable source/object IDs as provenance, never an expiring signed URL as the source of a saved project. Reopening, moving the project folder, and offline exporting must work after a successful import. Library preview cache can be evicted; project-owned files cannot be evicted by that policy.

Compound deduplicates assets by content hash; PostBob identifies remote sources by provider ID. Preserve both identities. If two sources resolve to the same local bytes, reuse the project asset and append source bindings rather than replacing its provenance or renaming existing references. Each insertion uses the selected source's range, even when its bytes are shared with another source. Persist provenance through manifest load/save and keep older manifests valid.

Use a serialized import operation per project and atomic file/manifest commits. Reuse the live AssetLibrary when that project is attached; use the same project filesystem service with locking when it is not. Add the needed flush/commit boundary so CLI success means the asset is durably recorded, not merely waiting in a debounce timer. Handle duplicate clicks, CLI/UI concurrency, filename collisions, disk-full failures, expired download URLs and crash cleanup. PostBob's cloud asset ID is never used as Compound's local content hash.

Permanent storage also needs deletion semantics. Removing a saved external item removes personal membership and overrides; a curated item may still appear in unified search. Removing a private upload revokes library access and schedules private objects for deletion after a defined grace period. Already imported local project copies remain intact. Account deletion removes private membership/media. Catalog archival removes discovery visibility without rewriting existing projects. Retention and orphan cleanup must distinguish staging objects, cache objects, private originals and project-owned local files.

**7. Port PostBob's provider machinery, adapted to Compound**

Reuse the current YouTube search/download adapter, URL normalization, media validation, independent artwork caching, immutable object strategy, job deduplication and stale-attempt protection. PostBob uses api-ninja/youtube-search-scraper for discovery and thenetaji/youtube-music-downloader for audio. Their published input pages currently document keyword search and direct-video audio input respectively; this inspection did not run a paid actor or validate live outputs.

Use server-side APIFY_TOKEN configuration. Pin/configure actor identifiers and tested builds where supported. Validate actual output contracts in a dev smoke test; published schemas and comments are not enough. Preserve the AAC validation that accepts valid DASH-branded M4A and verify duration from the audio stream/sample data, including PostBob's regression fixtures.

Run provider work as durable jobs, returning a job ID promptly. Use Convex's existing workflow component with scheduled status checks/backoff or authenticated completion webhooks. Persist the external run ID so a retry resumes observation instead of starting another paid run. Treat an ambiguous actor-start response as reconciliation work rather than blindly resubmitting. Bound concurrency across interactive requests and seeding; use current account limits rather than PostBob's hardcoded free-plan assumption.

Fetch provider bytes on the server, validate host/redirects, source identity, content/container, duration and byte count, then store in our R2 bucket. Issue authorized playback/download URLs from our service. Never return token-bearing Apify URLs or use transient provider streams in the saved project. Read artwork independently without downloading every search result's audio.

SFX must use the current PostBob implementation: it directly reads MyInstants HTML using impit and node-html-parser. An older PostBob planning document still describes an unofficial API and is stale. Verify the native impit package in Compound's Convex Node deployment early; it cannot simply run in the Cloudflare Worker. Keep the adapter behind a capability interface so its runtime can be changed without altering UI/CLI contracts.

External availability is variable. Preserve cached usable audio through provider outages; fail missing/private/deleted/unsupported sources clearly. Retry transient errors with bounds, not invalid media. Instrument search latency, preparation latency, cache hits, provider failures, concurrency and spend; apply server-side rate limits and configurable quotas. Preparation failures must not create half-attached local assets.

**8. Seed and maintain the curated catalog**

The inspected PostBob manifest contains 18 music entries and 10 SFX entries. Copy that selection into a Compound-owned manifest, preserving canonical URLs, titles, descriptions, order and preferred ranges. Record the source revision/content fingerprint so the initial import is reproducible. Do not import private user libraries or reuse PostBob database IDs.

Build an idempotent seed/reconcile command keyed by canonical source identity. Validate the complete manifest before changes; prepare/probe the 28 sources with bounded concurrency, validate ranges against measured audio, then publish the ready catalog revision. If an item fails, retain the previously published catalog and report the failing entries. Re-running does not duplicate sources or re-download ready immutable objects. Keep this out of the critical path of every unrelated app deployment; reconcile when the catalog changes.

Reusing the selection does not require a live dependency on PostBob's production database. Default to independently preparing Compound's copies. If existing bytes are later migrated to avoid downloads, use an explicit server-to-server export with source mapping, checksums and a report, not signed URLs embedded in seed data.

Preserve original source attribution and any known license/usage metadata; label the collection Curated rather than implying it is royalty-free. Curated inclusion and provider availability do not establish music rights. Unsupported or unavailable entries should be reported rather than silently substituted with a similarly titled video.

**9. CLI contract**

Add account-scoped library commands and project-scoped assets commands to the existing app router. All commands below are proposed, not currently implemented. Library operations work while no project is open, as long as the app is running and signed in. Keep current --project/cwd targeting for project operations; never select a different visible project implicitly.

```sh
# Curated and personal items, without external provider discovery
compound library list --kind music

# One submitted search across personal, curated, and YouTube
compound library search "quiet piano" --kind music
compound library search "whoosh" --kind sfx
compound library search "quiet piano" --kind music --local-only

# Exact metadata resolution; no membership or project mutation
compound library resolve "https://www.youtube.com/watch?v=JuSsvM8B4Jc" --kind music
compound library get <source-id>

# Add private content; URL input uses the exact-source resolver
compound library add "/absolute/path/song.mp3" --kind music
compound library add "https://www.youtube.com/watch?v=JuSsvM8B4Jc" --kind music
compound library save <source-id> --source-in 00:15 --source-out 01:00
compound library update <source-id> --description "Quiet background for narration"
compound library remove <source-id>

# Cache/inspect without saving membership or editing a project
compound library prepare <source-id> --no-wait
compound library jobs get <job-id>
compound library download <source-id> --output /absolute/path/audition.m4a
compound media listen /absolute/path/audition.m4a

# Materialize a reusable source in one local project
compound --project /absolute/path/project assets add --library <source-id>
compound --project /absolute/path/project assets list
compound --project /absolute/path/project assets save-to-library <asset-id> --kind music
```

Search defaults to all supported sources on submission, mirroring the UI. --local-only is an optional speed/offline control. Optional source filters can be added without making them the default experience. list/search return paginated snapshots with stable IDs and explicit nextCursor, externalStatus and warnings; do not report a provider failure as a complete search. Use one JSON envelope per command for these new paginated operations, and document this deliberate exception to the older reference's JSON Lines convention. Progress goes to stderr; stdout stays machine-readable. Continue exit 1 for failures, with stable error codes available through an optional JSON error format.

prepare/add/save/search operations that can outlive a request return or internally follow durable jobs. Default CLI behavior waits with stderr progress; --no-wait returns a job or search-session ID. A wait timeout reports that ID and does not claim the backend operation was canceled. jobs get/list/wait expose recovery. Define cancellation per job: cancel a user's import/save intent where supported, but do not abort another user's shared preparation. Repeated mutation requests use idempotency keys; source IDs identify content, job IDs identify work, and neither is a project asset ID.

assets add returns at least sourceId, objectId, assetId, path, absolute localPath, mediaType, duration and the resolved default source range in seconds. The agent can inspect the local file using existing media commands, then edit JSX using the returned path and sourceIn/sourceOut. This follows Compound's source-is-the-document workflow; no new generic timeline mutation CLI is necessary for v1. A successful asset import never silently places music.

```json
{
  "sourceId": "<stable-cloud-source-id>",
  "objectId": "<immutable-object-id>",
  "assetId": "<local-content-hash>",
  "path": "music/cornfield-chase.m4a",
  "localPath": "/absolute/path/project/assets/music/cornfield-chase.m4a",
  "mediaType": "audio",
  "duration": 126.4,
  "sourceRange": { "start": 0, "end": 126.4 }
}
```

The values above are illustrative. Use PostBob's integer microseconds internally if retained, but explicitly convert to Compound's seconds in UI/CLI responses and to sourceIn/sourceOut during insertion; test round trips at the editor's frame boundaries. Update CLI help, reference/library.md, reference/assets.md, the reference index and editor guidance together. Descriptions and provider metadata are content for choosing media, never instructions to execute. UI and agents must receive the same effective titles, descriptions and selected ranges.

Retain compound fetch as its existing local yt-dlp utility. It downloads files and does not imply personal-library membership. The supported library flow uses the shared server provider/cache path; users can upload a file obtained by fetch if desired. Avoid two independent implementations of catalog discovery or saving.

**10. Extension to B-roll and generation**

Personal B-roll later adds Video to Library and reuses upload, membership, search, preview, local materialization and provenance. It also needs larger/resumable uploads, thumbnails, video preview, storage quotas and eventually descriptive indexing. Do not claim that adding a new filter alone completes B-roll support.

Generate later launches a creation flow from + and creates immutable outputs with model, prompt, references and job provenance. Outputs can be saved privately and/or added to a project through the same operations. Prompt editing, cost disclosure, progress, cancel/retry and variations remain generation-specific UI. Compound currently retains generation metadata in its asset model but its models endpoint returns an empty list; generation providers and execution are a separate project, not part of this library rollout.

**11. Implementation order and acceptance**

1. Prove integration assumptions in development: exact-link metadata, YouTube search/audio, MyInstants native dependency, AAC duration/decoding, signed playback with seeking/CORS, and representative private uploads. Verify active actor builds and config. This is the early runtime checkpoint.
2. Add durable media records/storage, owner checks, source identity, jobs, generic library service and a minimal vertical path: resolve exact URL, prepare, save, retrieve, import into a local project. Include permanent retention and cleanup boundaries now.
3. Add the Compound manifest and idempotent seed; prepare and verify all 28 entries. Add fast unified personal/curated search and external search sessions with merging/deduplication.
4. Expose the service through CLI library/assets commands, including app-wide routing and correct explicit project targeting. Use those commands to verify the backend before wiring the full panel.
5. Build Project/Library UI, Music/SFX browsing, + upload/link, preview/trim, saved/in-project state, project import and asynchronous drag/drop. Reuse the existing Project assets component beneath the new tabs.
6. Complete focused end-to-end tests, feature-flag rollout, provider telemetry/limits, account cleanup and CLI documentation. Ship audio first; separately scope generation/video library work.

Required acceptance cases:

- All seed entries preserve exact source identity, descriptions and saved ranges; repeat seeding changes nothing and failed reconciliation preserves the prior published set.
- Own upload and curated track appear in one search. Matching YouTube search results merge without duplicates, even when an item is both curated and saved. Local matches survive external failure.
- Equivalent URL forms resolve one source; exact link lookup never substitutes a search result. Invalid links, playlist-only input, unsupported media and timestamps outside duration fail clearly.
- Search and auditioning create no membership or project files. Save, import and placement have the documented effects. Multiple previews/clients share preparation without stale playback or duplicate paid runs.
- Private upload remains after the temporary upload lifecycle window and after moving/deleting the original local file. It cannot be queried, downloaded, deduplicated into visibility, edited or removed by another account.
- Import commits project files and provenance, uses the correct range and deduplicates repeat additions. Reopening and exporting offline works; catalog renames/removal and personal deletion do not rewrite existing clips.
- CLI works without an open project for account operations. Concurrent UI/CLI imports preserve the manifest; targeted project imports never write into another visible project. A timeout/disconnect yields recoverable status.
- Drag/drop captures scene/time before download, fails placement gracefully if its target disappears, and uses ordinary undo. Library keyboard and playback controls do not conflict with timeline shortcuts.
- Check browser GET/HEAD/range playback support and origin policy, desktop signed-download behavior, disk-full/partial-file recovery, account switching, expired auth/URLs, provider outage, job retry fencing and AAC duration regression fixtures.

Suggested code ownership: packages/backend for records, providers and workflows; apps/server for authenticated library/media delivery; packages/infra and deployment scripts for secrets, durable prefixes and CORS; apps/desktop/src/cloud.ts and apps/web/src/lib for the shared transport; packages/assets for stable project storage/provenance; apps/web/src/engine for importing/inserting; sidebar-left for presentation; apps/web/src/context/dapi and apps/cli for command exposure. Keep generated backend API files generated, and coordinate with the substantial existing working-tree changes.

**12. Evidence and remaining validation**

Local evidence inspected:

- [Current Assets panel](/Users/isaacdyor/code/compound/apps/web/src/components/sidebar-left/assets.tsx), [project AssetLibrary](/Users/isaacdyor/code/compound/packages/assets/src/library.ts), [manifest](/Users/isaacdyor/code/compound/packages/assets/src/manifest.ts), and [insertion](/Users/isaacdyor/code/compound/apps/web/src/engine/insert-asset.tsx).
- [App-wide CLI router](/Users/isaacdyor/code/compound/apps/web/src/context/dapi/api.tsx), [project targeting](/Users/isaacdyor/code/compound/apps/cli/src/project-target.ts), and [local fetch implementation](/Users/isaacdyor/code/compound/apps/cli/src/ytdlp.ts).
- [Current cloud schema](/Users/isaacdyor/code/compound/packages/backend/convex/schema.ts), [temporary uploads](/Users/isaacdyor/code/compound/packages/backend/convex/uploads.ts), [R2 lifecycle/CORS](/Users/isaacdyor/code/compound/packages/infra/alchemy.run.ts), and [existing workflow setup](/Users/isaacdyor/code/compound/packages/backend/convex/transcription_workflow.ts).
- PostBob's [curated manifest](/Users/isaacdyor/code/postbob/packages/backend/catalog_manifest.ts), [catalog queries/membership](/Users/isaacdyor/code/postbob/packages/backend/convex/catalog.ts), [actions](/Users/isaacdyor/code/postbob/packages/backend/convex/catalog_actions.ts), [YouTube adapter](/Users/isaacdyor/code/postbob/packages/backend/convex/catalog_providers/youtube.ts), [current MyInstants adapter](/Users/isaacdyor/code/postbob/packages/backend/convex/catalog_providers/myinstants.ts), and [seed reconciliation](/Users/isaacdyor/code/postbob/packages/backend/convex/catalog_deploy_actions.ts).

External documentation checked: the [YouTube search actor input](https://apify.com/api-ninja/youtube-search-scraper/input-schema) documents query/video/result-limit controls; the [audio downloader input](https://apify.com/thenetaji/youtube-music-downloader/input-schema) documents direct YouTube URLs, M4A output and optional transcript controls. Apify documents asynchronous run/wait/result retrieval via [its integration guide](https://help.apify.com/en/articles/3224035-run-actor-task-and-retrieve-data-via-api).

Still to validate during implementation: live actor output/build behavior, native adapter compatibility, the availability of every seed source, codec/browser coverage, private storage/operation quota values, and operational retention windows. These do not change the agreed UI model or the initial seed selection. No scraping, uploads, catalog mutations or deployment were performed while preparing this plan.
