# macOS releases

The landing page is an Astro app in `apps/landing`, deployed by Alchemy at
`compound.mov`. Preview landing pages use `<stage>.compound.mov`; all download
buttons point to the production installer. Run `bun run dev:landing` locally.

## Where releases live

Installers are published to the repository
[corporationdev/compound-releases](https://github.com/corporationdev/compound-releases),
separate from the source so releases have a page of their own, the feed and
download URLs never depend on this repository's visibility, and the token that
publishes them can write nothing else. Every release carries:

- `Compound-mac-universal.dmg`, the installer people download.
- `Compound-mac-universal.zip`, what the app's updater installs.
- `checksums.txt`, SHA-256 of both.
- `latest-mac.json`, the update feed: the version, the zip's URL, and checksums.

`https://compound.mov/download` redirects to the newest stable release's DMG
through GitHub's `releases/latest/download/` URL; the README links there too.

GitHub needs `OP_SERVICE_ACCOUNT_TOKEN` with read access to `compound-prod`.
The **Release** workflow loads these fields only in the release job:

| 1Password item | Fields |
| --- | --- |
| `Apple` | `certificate`, `certificate-password`, `api-key`, `api-key-id`, `api-issuer`, `team-id` |
| `GitHub` | `releases-token` |

`certificate` is a base64 encrypted PKCS#12 containing the Developer ID Application
certificate and private key. `api-key` is the base64 App Store Connect team key.
The signing keychain and decoded files are temporary and cleaned up after the job.
Apple credentials do not belong in the application `.env.op` or client bundle.

`releases-token` is a fine-grained personal access token owned by the
organization with **Contents: read and write** on `compound-releases` and
nothing else; the workflow's own token cannot write to another repository. It
is referenced from `.env.op` as `GITHUB_RELEASES_TOKEN` (resolved for the
production tier only) and loaded by the workflow directly.

## Cut a release

Open **GitHub → Actions → Release → Run workflow**:

1. Leave the branch set to **main**.
2. Choose **patch** (the default), **minor**, or **major**.
3. Click **Run workflow**.

The workflow bumps the shared version on a detached checkout and pushes only the
version tag. It never advances `main`, so cutting a release does not make local
development branches diverge. The next version comes from the highest stable
release tag or the checkout's package version, whichever is newer; package
versions on `main` may therefore lag behind published installers. The tagged
checkout contains matching versions in all four package manifests.

No local commands or manual tags are needed. Re-running the same workflow run
reuses its tag instead of bumping the version again. The GitHub Actions token
needs permission to create release tags and GitHub releases, and tag protection
rules still apply. Tags created with the workflow token do not start a second
workflow; the same run builds and publishes the tagged checkout.

The job then builds one universal
Mac app, signs and notarizes it, checks both architectures and the bundled CLI,
and produces `Compound-mac-universal.dmg` and `Compound-mac-universal.zip`.

`scripts/release-publish.ts` then creates the release on `compound-releases`
as a draft, attaches the four files, checks that every upload is whole, and
publishes it. Only then does `latest` move. A published release is never
changed: rerunning the workflow for a version that is out is a no-op when the
files match and an error when they do not, so a changed build needs a new
version.

A release cut from `main` (the workflow's own version bump, or a tag on a
`main` commit) is stable. A tag pushed from any other branch is published as a
**prerelease**: it appears on the releases page for people to try, but neither
`latest` nor the app's updater ever points at it.

## Updating the app

The packaged macOS app checks `latest-mac.json` on the newest stable release
fifteen seconds after launch and every four hours, and on demand from
**Compound → Check for Updates…**. The main process compares the feed's version
with its own first; only when the feed names something newer is Electron's
`autoUpdater` (Squirrel.Mac) pointed at it, because Squirrel installs whatever a
feed names. Squirrel downloads the zip, checks that its code signature matches
the running app's, and stages it. A toast in the window offers **Restart**; the
menu check also answers "up to date" and errors as dialogs.

Development builds, pull request builds and other platforms have no updater.
`COMPOUND_UPDATE_FEED=<url>` in the environment points a packaged build at
another feed, such as a prerelease's `latest-mac.json`, to try an update before
it is the latest.

Local unsigned packaging for testing: `SKIP_SIGN=1 bun run make --arch=universal`.
Use `bun scripts/release-env.ts` first when specifically testing production URLs;
run `bun run setup` afterward to restore development configuration.
