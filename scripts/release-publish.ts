import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { release, releaseVersion, type ReleaseFeed } from '@compound/config/release';
import { root, requireKeys } from './environment';

// Publishes a verified release to the public releases repository: a draft
// release with the DMG, the zip, the checksums and the update feed attached,
// every upload checked, then published. A release cut from main becomes
// `latest`, which is what the landing page and the app's updater follow; a
// tag pushed from a branch is a prerelease that neither ever sees.
//
// Needs GITHUB_RELEASES_TOKEN (writes the releases repository) and GH_TOKEN
// (reads this one, to tell the two kinds of tag apart).

const SOURCE = process.env.GITHUB_REPOSITORY ?? 'corporationdev/compound';
const TARGET = `${release.repository.owner}/${release.repository.name}`;
requireKeys({ GITHUB_RELEASES_TOKEN: process.env.GITHUB_RELEASES_TOKEN ?? '', GH_TOKEN: process.env.GH_TOKEN ?? '' }, ['GITHUB_RELEASES_TOKEN', 'GH_TOKEN']);

function gh(args: string[], token: string): string {
  const result = spawnSync('gh', args, { encoding: 'utf8', env: { ...process.env, GH_TOKEN: token }, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}
const source = (args: string[]) => gh(args, process.env.GH_TOKEN!);
const target = (args: string[]) => gh([...args, '--repo', TARGET], process.env.GITHUB_RELEASES_TOKEN!);

const directory = join(root, '.generated/release');
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as { version: string; files: { name: string; sha256: string }[] };
const version = releaseVersion(manifest.version);
if (version !== releaseVersion(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version))
  throw new Error('Release artifacts do not match the checkout version');
const tag = `v${version}`;
const commit = process.env.GITHUB_SHA ?? source(['api', `repos/${SOURCE}/commits/${tag}`, '--jq', '.sha']).trim();

const files = [release.dmg, release.zip].map((name) => {
  const path = join(directory, name);
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  const expected = manifest.files.find((entry) => entry.name === name)?.sha256;
  if (!expected || expected !== sha256) throw new Error(`Checksum mismatch for ${name}`);
  return { name, path, sha256, size: statSync(path).size };
});
const checksums = files.map((file) => `${file.sha256}  ${file.name}`).join('\n') + '\n';
if (readFileSync(join(directory, release.checksums), 'utf8') !== checksums) throw new Error('checksums.txt does not match the installers');

// A release is stable when its commit sits on main: the version bump the
// workflow makes on top of main, or main itself. A branch's tag is not.
const parent = source(['api', `repos/${SOURCE}/commits/${commit}`, '--jq', '.parents[0].sha']).trim();
const onMain = (sha: string) => ['identical', 'behind'].includes(JSON.parse(source(['api', `repos/${SOURCE}/compare/main...${sha}`, '--jq', '{status}'])).status);
const stable = onMain(commit) || onMain(parent);

const feed: ReleaseFeed = {
  version,
  name: tag,
  notes: `Compound ${version}`,
  pub_date: new Date().toISOString(),
  url: release.asset(version, release.zip),
  dmg: release.asset(version, release.dmg),
  sha256: Object.fromEntries(files.map((file) => [file.name, file.sha256])),
};
writeFileSync(join(directory, release.feed), JSON.stringify(feed, null, 2) + '\n');
const notes = [
  `Compound ${version} for macOS: a universal build, signed and notarized.`,
  '',
  ...(stable ? [] : ['**Prerelease** built from a branch of the source repository; the app does not update to it.', '']),
  `Source: ${SOURCE}@${commit.slice(0, 7)}`,
  '',
  '```', checksums.trimEnd(), '```',
].join('\n');
const notesPath = join(directory, 'notes.md');
writeFileSync(notesPath, notes + '\n');

type Existing = { isDraft: boolean; assets: { name: string; size: number }[] };
const existing = ((): Existing | null => {
  try { return JSON.parse(target(['release', 'view', tag, '--json', 'isDraft,assets'])); } catch { return null; }
})();
if (existing && !existing.isDraft) {
  // Published releases are immutable: a rerun with the same files is done, anything else needs a new version.
  const published = target(['release', 'download', tag, '--pattern', release.checksums, '--output', '-']);
  if (published !== checksums) throw new Error(`${tag} is already published with different files; cut a new version`);
  console.log(`${tag} is already published: ${release.url}/releases/tag/${tag}`);
  process.exit(0);
}
if (existing) {
  // A draft is an earlier attempt that never finished; start over.
  target(['release', 'delete', tag, '--yes', '--cleanup-tag']);
}
target(['release', 'create', tag, '--draft', '--title', `Compound ${version}`, '--notes-file', notesPath, ...(stable ? [] : ['--prerelease'])]);
const uploads = [...files.map((file) => file.path), join(directory, release.checksums), join(directory, release.feed)];
target(['release', 'upload', tag, ...uploads, '--clobber']);
const attached = (JSON.parse(target(['release', 'view', tag, '--json', 'assets'])) as Existing).assets;
for (const path of uploads) {
  const name = path.split('/').pop()!;
  const asset = attached.find((entry) => entry.name === name);
  if (!asset || asset.size !== statSync(path).size) throw new Error(`Upload of ${name} is incomplete`);
}
// `latest` moves only now, once every asset is attached and checked.
target(['release', 'edit', tag, '--draft=false', stable ? '--latest' : '--latest=false']);
console.log(`Published ${tag}${stable ? '' : ' (prerelease)'}: ${release.url}/releases/tag/${tag}`);
