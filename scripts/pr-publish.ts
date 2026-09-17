import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './environment';
import { evidenceStore } from './lib/evidence-store';

// CI: put a pull request's verified installers (from pr-artifact-check) on the
// evidence bucket under pr-<number>/, or remove everything for a closed PR.
//
//   bun scripts/pr-publish.ts upload <number>
//   bun scripts/pr-publish.ts delete <number>
const [action, numberArg] = process.argv.slice(2);
const number = Number(numberArg);
if (!['upload', 'delete'].includes(action ?? '') || !Number.isInteger(number) || number <= 0) throw new Error('Usage: pr-publish.ts upload|delete <pull request number>');
const store = evidenceStore();
if (action === 'delete') {
  console.log(`Removed ${await store.deletePrefix(number)} object(s) for #${number}.`);
} else {
  const directory = join(root, '.generated/pr-build');
  for (const name of readdirSync(directory)) {
    const { url, size } = await store.put(number, join(directory, name));
    console.log(`${url} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }
}
