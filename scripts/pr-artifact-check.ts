import { execFileSync } from 'node:child_process';
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
if (platform === 'mac') {
  const app = join(out, 'Compound-darwin-universal/Compound.app');
  appDir = join(app, 'Contents/Resources/app');
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
  execFileSync('xcrun', ['stapler', 'validate', app], { stdio: 'inherit' });
  execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', app], { stdio: 'inherit' });
  installers = [...new Bun.Glob('**/*.{dmg,zip}').scanSync(join(out, 'make'))];
} else if (platform === 'linux') {
  const app = join(out, 'Compound-linux-x64');
  if (!existsSync(join(app, 'Compound'))) throw new Error('Linux package has no Compound binary');
  appDir = join(app, 'resources/app');
  installers = [...new Bun.Glob('**/*.zip').scanSync(join(out, 'make'))];
} else throw new Error('Expected mac or linux');
const config = JSON.parse(readFileSync(join(appDir, 'runtime-config.json'), 'utf8'));
if (config.stage !== expectedStage) throw new Error(`Installer is configured for ${config.stage}, expected ${expectedStage}`);
if (config.stage === 'prod') throw new Error('Pull request builds must never carry production configuration');
if (installers.length === 0) throw new Error('No installers were made');
const files = installers.map((relative) => {
  const name = relative.split('/').pop()!;
  cpSync(join(out, 'make', relative), join(output, name));
  return { name, sha256: createHash('sha256').update(readFileSync(join(output, name))).digest('hex') };
});
writeFileSync(join(output, 'checksums.txt'), files.map((file) => `${file.sha256}  ${file.name}`).join('\n') + '\n');
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ platform, stage: config.stage, convexUrl: config.convexUrl, serverUrl: config.serverUrl, files }, null, 2) + '\n');
console.log(`Verified ${platform} build for ${config.stage}: ${files.map((f) => f.name).join(', ')}`);
