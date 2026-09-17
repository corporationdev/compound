import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { root } from './environment';

// Verifies a pull-request desktop build and collects its installers into
// .generated/pr-build for upload. The installer must carry the preview stage
// it was built for (EXPECTED_STAGE), never production's. macOS builds are
// signed and notarized like releases, so the same checks run on them.
const platform = process.argv[2];
const expectedStage = process.env.EXPECTED_STAGE;
if (!expectedStage) throw new Error('Set EXPECTED_STAGE to the preview stage the build targets');
const out = join(root, 'apps/desktop/out');
const output = join(root, '.generated/pr-build');
mkdirSync(output, { recursive: true });
let appDir: string;
let installers: string[];
const only = (pattern: string, where: string) => {
  const matches = [...new Bun.Glob(pattern).scanSync({ cwd: where, onlyFiles: false })];
  if (matches.length !== 1) throw new Error(`Expected one ${pattern} under ${where}, found ${matches.length}`);
  return join(where, matches[0]!);
};
if (platform === 'mac') {
  // Apple Silicon only, signed with the Developer ID but not notarized (see the workflow).
  const app = only('*-darwin-arm64/*.app', out);
  appDir = join(app, 'Contents/Resources/app');
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
  // codesign reports on stderr.
  const details = spawnSync('codesign', ['-dvv', app], { encoding: 'utf8' });
  if (!/Authority=Developer ID Application/.test(`${details.stdout}${details.stderr}`))
    throw new Error('Pull request build is not signed with the Developer ID');
  installers = [...new Bun.Glob('**/*.{dmg,zip}').scanSync(join(out, 'make'))];
} else if (platform === 'linux') {
  const app = only('*-linux-x64', out);
  if (!existsSync(join(app, 'Compound'))) throw new Error('Linux package has no Compound binary');
  appDir = join(app, 'resources/app');
  installers = [...new Bun.Glob('**/*.zip').scanSync(join(out, 'make'))];
} else throw new Error('Expected mac or linux');
const config = JSON.parse(readFileSync(join(appDir, 'runtime-config.json'), 'utf8'));
if (config.stage !== expectedStage) throw new Error(`Installer is configured for ${config.stage}, expected ${expectedStage}`);
if (config.stage === 'prod') throw new Error('Pull request builds must never carry production configuration');
if (installers.length === 0) throw new Error('No installers were made');
if (typeof config.appName !== 'string' || !config.appName.startsWith('Compound PR ')) throw new Error('Pull request builds must be branded with pr-brand.ts before packaging');
const files = installers.map((relative) => {
  // The app's display name has spaces; file names do not.
  const name = relative.split('/').pop()!.replace(/\s+/g, '-');
  cpSync(join(out, 'make', relative), join(output, name));
  return { name, sha256: createHash('sha256').update(readFileSync(join(output, name))).digest('hex') };
});
// Both platforms land on one release, so the sidecar files carry the platform in their names.
writeFileSync(join(output, `checksums-${platform}.txt`), files.map((file) => `${file.sha256}  ${file.name}`).join('\n') + '\n');
writeFileSync(join(output, `manifest-${platform}.json`), JSON.stringify({ platform, headSha: process.env.HEAD_SHA ?? null, stage: config.stage, appName: config.appName, appId: config.appId, convexUrl: config.convexUrl, serverUrl: config.serverUrl, files }, null, 2) + '\n');
console.log(`Verified ${platform} build for ${config.stage}: ${files.map((f) => f.name).join(', ')}`);
