# macOS releases

The landing page is an Astro app in `apps/landing`, deployed by Alchemy at
`compound.mov`. Preview landing pages use `<stage>.compound.mov`; all download
buttons point to the production installer. Run `bun run dev:landing` locally.

## First deployment

Push the changes to `main` and let **Deploy Production** complete. This creates
the landing Worker and the persistent `compound-releases-prod` R2 bucket, along
with the existing production backend resources. The production R2 credentials
must have Object Read & Write access to this bucket. It is separate from the
temporary media buckets and has no automatic expiration.

GitHub needs `OP_SERVICE_ACCOUNT_TOKEN` with read access to `compound-prod`.
The **Release** workflow loads these fields only in the release job:

| 1Password item | Fields |
| --- | --- |
| `Apple` | `certificate`, `certificate-password`, `api-key`, `api-key-id`, `api-issuer`, `team-id` |
| `R2` | `access-key-id`, `secret-access-key` |
| `Cloudflare` | `account-id` |

`certificate` is a base64 encrypted PKCS#12 containing the Developer ID Application
certificate and private key. `api-key` is the base64 App Store Connect team key.
The signing keychain and decoded files are temporary and cleaned up after the job.
Apple credentials do not belong in the application `.env.op` or client bundle.

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

Verified artifacts are retained in GitHub Actions and attached to the private
repository's GitHub release. Public downloads are served from R2:

- `https://compound.mov/download` redirects to the latest release's DMG.
- `/releases/v<VERSION>/Compound-mac-universal.dmg` is the immutable installer.
- `/releases/v<VERSION>/Compound-mac-universal.zip` is the immutable ZIP.

The latest pointer changes only after both uploads complete. Older versions cannot
replace the latest pointer, and a published version cannot be overwritten with
different files. If a build changes, cut a new version. Before the first release,
the download endpoint returns a short unavailable response.

Local unsigned packaging for testing: `SKIP_SIGN=1 bun run make --arch=universal`.
Use `bun scripts/release-env.ts` first when specifically testing production URLs;
run `bun run setup` afterward to restore development configuration.
