import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

if (!process.env.RUNNER_TEMP) throw new Error('Missing RUNNER_TEMP');
const directory = join(process.env.RUNNER_TEMP, 'compound-signing');
const original = join(directory, 'original-keychains.json');
if (existsSync(original)) {
  const keychains: string[] = JSON.parse(readFileSync(original, 'utf8'));
  spawnSync('security', ['list-keychains', '-d', 'user', '-s', ...keychains], { stdio: 'ignore' });
}
spawnSync('security', ['delete-keychain', join(directory, 'build.keychain-db')], { stdio: 'ignore' });
rmSync(directory, { recursive: true, force: true });
