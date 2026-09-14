# Media library

The editor's left panel has Project and Library tabs with matching header, tab, and control positions. Library searches curated and personal entries together, with Music and Sound effects views. Typing searches stored titles and descriptions. External keyword search requires the explicit **Search catalog** button after the results. Music accepts supported media links and shows **Open this link**. Enter only resolves Music links. Sound effects uses search only. Both views use provider-neutral labels. Results remain visible across focus changes until the query changes or Library is closed.

Library listings use TanStack Query through the shared `PersistentQueryCache`. Each account/backend, media kind, and search has a separate infinite-query entry, including all loaded pages. First opening an uncached tab fetches its results; fresh entries are reused for five minutes with no request when switching or reopening tabs. Stale entries remain visible during background revalidation on opening. Leaving a tab disables its query and never starts a request; a download already under way may finish caching its result. Uploads invalidate listings, and Retry explicitly refetches. Only a query without loaded results shows the initial loading state. Refreshes reconcile rows by source ID so existing thumbnails stay mounted with their local blob URLs; pagination is disabled while a refresh is in flight.

Successful queries marked `meta.persist` are dehydrated to account/backend-scoped IndexedDB snapshots and hydrated before the authenticated UI is enabled. Snapshots and individual persisted query results expire after 24 hours. A reload restores cached Music, Sound effects, searches, and pagination before deciding whether revalidation is needed. Media blobs use the separate content-addressed cache described below.

Library **+** uploads MP3, AAC/M4A, or WAV audio (up to 100 MiB and two hours), or focuses link entry. Uploading saves to the signed-in account. **Add** imports a local copy and inserts the selected section at the playhead. Canvas/timeline drops import and place it at the drop location. Preview stops editor playback; editor playback pauses preview. The compact dock follows PostBob's mobile player: artwork with play/pause, a selection-relative scrubber, and inline Trim and Add icon buttons beside the playback time. Both actions have tooltips; Trim expands the waveform below the player. Successful insertion briefly animates the Add icon into a checkmark for one second before returning to the plus, without a separate status row. Source-time waveform handles and zoom change the selected section; adjustments audition from the new start and loop while trimming. Hiding trim controls preserves the section. Resume and seek reuse the loaded bytes.

Preparation rings appear on the row and dock only after a confirmed local cache miss, including when joining a download already in flight. Memory and IndexedDB hits show no preparation text, ring, or completion flash while the audio element starts. For uncached audio, rings use PostBob's asymptotic loading estimate (40-second music / 4-second SFX baseline), labeled as estimated progress, and reach completion only on the audio element's playing event. A short completion hold also covers clips that finish quickly. Canceled or superseded previews cannot autoplay. Waveform decoding is keyed to the audio blob, independent of playback position updates.

Preview and project import share `catalogFile`, which checks a renderer-owned media cache before any preparation, polling, or file request. Recently used audio stays in memory (64 MiB soft limit, retaining at least the latest file); checksum-verified blobs persist in IndexedDB with a 512 MiB least-recently-used budget. The same implementation runs on web and desktop. Disk writes happen in the background, and unavailable persistent storage falls back to memory with a console warning. Files are deduplicated by checksum, scoped by authentication backend and user, and stored without signed URLs. Account changes clear memory and fence pending consumers. Switching tracks, reopening Library, and restarting the renderer reuse cached bytes. Concurrent preview/Add requests share one download; closing a preview prevents autoplay but allows the shared download to finish caching. Cache eviction never removes project files. Catalog query-result persistence is separate from this media cache.

## Service boundary

`packages/backend/catalog.ts` defines the shared types. Authenticated `/media/catalog-*` Worker routes dispatch to Convex queries, mutations, and actions. Desktop requests use native IPC for cloud transport and file transfer; web requests use the same routes. `apps/web/src/lib/catalog.ts` is the typed client. `apps/web/src/engine/catalog-assets.ts` owns local project import. The `library_search`, `library_get`, `library_resolve` and `library_import` catalog tools use these same operations, over MCP and as `compound library …` on the CLI. `library search --kind music|sfx` with an omitted or empty query collects every page from the shared query cache; `--expand` adds external discovery. `library get` and `resolve` return compact selection metadata in seconds. `library import` writes a durable project copy without personal membership or timeline placement. `media` accepts `library:<source-id>` for cached inspection without import. See [`docs/reference/library.md`](reference/library.md). Generation UI remains deferred.

`catalogSources` identifies provider media or an owner-scoped upload and its immutable prepared bytes. `catalogEntries` provides curated or personal membership, title, description, order, and preferred source range. Public external identities are shared; uploaded sources remain private. `catalogSearches` caches discovery for 24 hours. Preparation persists attempts and Apify run IDs, fences stale completions, and resumes existing nonterminal runs on retry. Account requests are limited to 120 new operations per hour.

Thumbnails load only for visible results, independently of audio preparation. Artwork uses the same renderer-owned cache abstraction as audio, with an 8 MiB memory / 64 MiB IndexedDB budget. Scrolling, remounting the dock, and reopening the app reuse cached image bytes without requesting another signed URL. Concurrent row/dock requests share one download; confirmed missing images are cached, but failures can retry. On a cache miss, the artwork endpoint authenticates access, caches the provider image under `library/artwork/`, and returns a signed URL used once to fetch bounded JPEG bytes. Packaged desktop transports those bytes through native IPC; both platforms store them in IndexedDB. Components own and revoke their local blob URLs. Missing artwork keeps a play icon in the same fixed-size slot.

Audio is probed before publication, bounded while downloading, and checksummed. Durable R2 keys use `library/`; staging uses `library-staging/` with a one-day lifecycle. Existing temporary transcription objects under `media/` retain their one-day lifecycle. Signed media URLs last 15 minutes. Account deletion removes private records and schedules object deletion. Removing an uploaded library item deletes its private cloud copy; project copies remain usable.

Project import stores bytes through AssetLibrary and flushes `assets.yml`. Provenance contains source ID, checksum, kind, title, and source-range snapshot. Project JSX uses the local library path; it never depends on signed URLs. Ranges use integer microseconds in the catalog and seconds in JSX's `sourceIn` / `sourceOut`. Imports are serialized per open library, deduplicated, and check that the project remains open before committing placement.

## Curated catalog and deployment

Edit `packages/backend/catalog_manifest.ts` to add or change songs and SFX. It initially contains PostBob's 18 music tracks and 10 sounds, including descriptions and preferred sections. YouTube and MyInstants links are normalized and validated; duplicate identities and invalid sections fail publication.

The existing production and preview workflows invoke the catalog publisher after backend and infrastructure deployment. The publisher prepares sources in batches of three, skips an unchanged revision, then atomically publishes the complete manifest. A failed source leaves the previous selection published and fails the deployment step. Archived sources do not alter personal saves or local project files.

For development, after setup and backend deployment:

```sh
bun run catalog:publish --dev
```

`APIFY_TOKEN` is injected from the stage's Compound 1Password vault and synced to Convex. Vault item IDs are explicit because duplicate Apify item titles already exist. Provider credentials never go to the renderer. The MyInstants adapter requires `impit` as a Convex Node external package; the root postinstall creates the workspace link Convex's bundler needs.

## Downloader and operating cost

Music preparation uses `streamers/youtube-video-downloader` with M4A output, Apify key-value storage, no transcription, a 240-second actor timeout, and a $0.50 maximum charge per run. Compound copies the validated bytes to durable R2 storage. Both the output identity and the saved file must be valid; a successful actor status alone does not count as prepared audio. Terminal failures start a new run on retry; transient transfer failures can resume the existing file.

On 2026-09-10, the prior `thenetaji/youtube-music-downloader` failed before producing media on builds 2.0.16 and 2.0.15, with US and DE regions and even with file saving disabled. The same actor's documented example also failed. LurkAPI's alternative returned a blocked-video error after 62 seconds. The selected Streamers actor downloaded the failing Espresso track as a valid 2.84 MB M4A in 31.15 seconds for $0.018, versus approximately $0.01395 under the old actor's published Free-tier rate. Across all 20 verification/seed runs, every run succeeded: median 31.15 seconds, maximum 61.476 seconds, total $0.438, maximum $0.036 per run. Pricing varies by Apify plan; no subscription was added. No PostBob cached audio was migrated.

## Validation and remaining work

The cloud test suite has 84 passing tests, including private access, preparation races, cache isolation, atomic publication, URL restrictions, bounded downloads, and audio validation with generated fixtures. Preview tests cover loading through actual playback, cancellation, resume without redownload, trimming/looping/scrubbing, errors, and retry. Project tests cover provenance across file-watcher reloads and manifest-write failure recovery. Token tests cover request coalescing, expiry, and logout invalidation.

All 28 items were independently prepared and atomically published to `dev-isaacdyor-107806b0`. The manifest is identical to PostBob's 28-item manifest, including descriptions and ranges. A second publication correctly reported “Catalog unchanged (28 items).” Production and preview receive this seed through their existing deployment workflows when the change is shipped.

Live uploads, preview, selected-section insertion, and local persistence after library removal have been verified in a separate desktop project. A live thumbnail loaded at 480×360; a 20-result search survived a focus/session refresh and cleared on Library exit. Live music and SFX search succeed. Remote Espresso now downloads and plays in the desktop UI. Its saved 10–15 second selection reopened, looped in the trimmer, and inserted with `sourceIn={10}` / `sourceOut={15}` and matching microsecond provenance. Removing its personal membership preserved the local audio. The waveform worker count stayed unchanged through playback updates. All 18 curated songs and 10 SFX appeared in the UI; the 0.37-second Whoosh selection played to its exact end without an error.

Video/image categories, generation, collections, advanced filters, aggregate account storage quotas, and provider-wide concurrency controls remain future work. This implementation keeps metadata and import operations separate so those additions can reuse the library contract.

## CLI validation

Library CLI checks cover complete multi-page browsing beyond 50 items, empty and
whitespace queries, shared UI-cache pagination, account isolation, failures without
partial success, and source-range conversion. Live checks returned all 18 songs
and 10 SFX, resolved an exact music link, rendered a cached source waveform, and
returned 20 unique expanded SFX results. Three concurrent imports into an isolated
project produced two unique assets; another import reused the existing asset and
left composition source unchanged. Native fractional file modification times
exposed a provenance reload bug: unchanged content now retains its catalog source
metadata after re-probing, while replacement content drops it.
