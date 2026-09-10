// Convex discovers external Node packages beside the backend package.json.
// Bun's hoisted install otherwise only places these at the workspace root.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const backend = fileURLToPath(new URL('../packages/backend/', import.meta.url));
const require = createRequire(join(backend, 'package.json'));
const config = JSON.parse(readFileSync(join(backend, 'convex.json'), 'utf8'));
for (const name of config.node?.externalPackages ?? []) {
  const target = join(backend, 'node_modules', name);
  if (existsSync(target)) continue;
  const source = dirname(require.resolve(`${name}/package.json`));
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(relative(dirname(target), source), target, 'dir');
}
