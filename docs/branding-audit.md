# Compound branding audit

Updated September 9, 2026.

## Artwork

- `assets/compound-logo.png` preserves the original supplied artwork as the source.
- `assets/compound-logo-centered.png` is the shaded mark centered by the silhouette's visual mass. This accounts for the two lobes on its right side.
- `assets/compound-mark.svg` is the flat, transparent, single-color mark. Interface icons use `currentColor` to follow their surrounding text in dark and light themes.
- `bun run brand:assets` regenerates the desktop PNGs, web artwork, favicon, startup mark, README banner, social preview, and installer backgrounds. On macOS, follow it with `bun run --cwd apps/desktop make:icns`.
- Native app artwork uses a white rounded tile; interface branding uses the flat mark. Production and development app icons use the same centered artwork.
- Old logos, the upstream promotional screenshots/GIFs, unused callback pages, and the permission screenshot showing an upstream domain were removed.

The 1024px native icon's silhouette center is within one pixel of the canvas center; the 256px web artwork and 128px app badge are within a quarter pixel. The flat SVG uses the same center and preserves the traced outline.

## Names, paths, and links

- App name and executable: `Compound`.
- macOS bundle identifier: `dev.corporation.compound`.
- Installer: `Compound-arm64.dmg` on Apple Silicon.
- Workspace packages, imports, build configuration, and examples: `@compound/*`.
- New project folder: `~/Movies/Compound` on macOS; the platform's videos directory elsewhere.
- New project metadata and authoring references: `package.json` → `compound` and `.compound/`.
- Local CLI connection: `compound.sock` or the `compound` Windows named pipe.
- Help, issues, releases, authoring documentation, and installation instructions point to `corporationdev/compound`.
- Agent skills are maintained in this repository and bundled locally; packaging no longer clones an upstream skills repository.
- The two font files previously fetched from upstream storage are bundled locally. Their provenance is recorded in `NOTICE.md`.

The CLI executable is `compound` (renamed from `dapi`). Its installer, help text, bundled wrapper, project templates, and agent documentation use the new command. Existing external project scripts that invoke `dapi` need to be updated to `compound`.

## Compatibility and retained references

Remaining references to the old brand are intentional:

- `brand-migration.ts` recognizes old desktop profile directories and copies project storage/preferences into a new Compound profile on first launch. Existing Compound profiles and the original directories are left intact. Encrypted native sessions are not copied between app identities; signing in again may be necessary.
- `db-migration.ts` copies the previous IndexedDB roots and compiled bundles once. Compound records take precedence, and forgotten roots do not reappear on later launches.
- The compiler and runtime accept `@diffusionstudio/jsx` in existing project source and cached bundles.
- Export configuration reads the old `diffusion` field when needed, then writes `compound` and removes the old field on save.
- The skill-link repair recognizes paths to the previous app bundle.
- Tests cover the previous names. `NOTICE.md` preserves upstream attribution; the earlier cloud migration plan records historical service names.

Existing user project folders and source files are not renamed automatically. New projects and generated documentation use Compound names.

## Verification

- Workspace TypeScript checks, web production build, desktop build, and macOS app packaging passed.
- Five branding migration tests passed; the existing eighteen cloud tests passed.
- An isolated Electron instance opened and scaffolded a project, installed its local authoring package, compiled an old-namespace composition, and preserved export settings while migrating their field name.
- Dark and light interface checks verified the flat mark follows the theme. The packaged app's display name, executable, bundle ID, icon, authoring types, and skill resources were inspected.
- No release was published.
