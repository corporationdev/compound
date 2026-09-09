import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { release, releaseVersion } from '@compound/config/release';
import { root } from './environment';

const version = releaseVersion(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
const app = join(root, 'apps/desktop/out/Compound-darwin-universal/Compound.app');
const binary = join(app, 'Contents/MacOS/Compound');
for (const path of [binary, join(app, 'Contents/Resources/app/dist/corner_radius.node'),
  join(app, 'Contents/Resources/cli/node_modules/@esbuild/darwin-arm64/bin/esbuild'),
  join(app, 'Contents/Resources/cli/node_modules/@esbuild/darwin-x64/bin/esbuild')])
  execFileSync('lipo', [path, '-verify_arch', 'arm64', 'x86_64']);
execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
execFileSync('xcrun', ['stapler', 'validate', app], { stdio: 'inherit' });
execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', app], { stdio: 'inherit' });
const config = JSON.parse(readFileSync(join(app, 'Contents/Resources/app/runtime-config.json'), 'utf8'));
if (config.stage !== 'prod' || config.projectsFolderName !== 'compound') throw new Error('Installer does not contain production configuration');
execFileSync(binary, [join(app, 'Contents/Resources/cli/compound.js'), '--help'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit',
});
const output = join(root, '.generated/release');
mkdirSync(output, { recursive: true });
for (const [pattern, name] of [['**/*.dmg', release.dmg], ['**/*.zip', release.zip]]) {
  const matches = [...new Bun.Glob(pattern).scanSync(join(root, 'apps/desktop/out/make'))];
  if (matches.length !== 1) throw new Error(`Expected exactly one ${pattern} installer, found ${matches.length}`);
  cpSync(join(root, 'apps/desktop/out/make', matches[0]!), join(output, name!));
}
const files = [release.dmg, release.zip].map(name => ({
  name, sha256: createHash('sha256').update(readFileSync(join(output, name))).digest('hex'),
}));
writeFileSync(join(output, 'checksums.txt'), files.map(file => `${file.sha256}  ${file.name}`).join('\n') + '\n');
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ version, files }, null, 2) + '\n');
console.log(`Verified signed, notarized universal release ${version}.`);
