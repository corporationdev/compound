import { resolveStage } from '@compound/config/stage';
import { validateStage } from '@compound/config/runtime';
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, chmodSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { parse } from 'dotenv';

export const root = resolve(import.meta.dirname, '..');
export const targets = ['packages/infra', 'packages/backend', 'apps/server', 'apps/web'] as const;
export function stageFrom(args: string[]): string {
  const index = args.indexOf('--stage');
  if (index >= 0 && args.includes('--dev')) throw new Error('Use --stage or --dev, not both');
  if (index >= 0 && !args[index + 1]) throw new Error('Missing --stage value');
  return validateStage(index >= 0 ? args[index + 1]! : resolveStage('dev'));
}
export function readEnv(path: string): Record<string, string> {
  const file = resolve(root, path);
  return existsSync(file) ? parse(readFileSync(file)) : {};
}
export function serviceAccountToken(local: Record<string, string>, inherited: NodeJS.ProcessEnv): string {
  // Local setup must not silently use another project's exported service account.
  const token = local.OP_SERVICE_ACCOUNT_TOKEN?.trim() || inherited.OP_SERVICE_ACCOUNT_TOKEN?.trim();
  if (!token?.startsWith('ops_'))
    throw new Error('Set OP_SERVICE_ACCOUNT_TOKEN in the root .env or process environment');
  return token;
}
export function renderEnv(values: Record<string, string>): string {
  return (
    Object.entries(values)
      .map(([key, value]) => {
        // Quoted dotenv escapes are deliberately restricted to values that round-trip.
        const line = `${key}=${JSON.stringify(value)}`;
        if (parse(line)[key] !== value) throw new Error(`Unsupported characters in ${key}`);
        return line;
      })
      .join('\n') + '\n'
  );
}
/** Preserve the same grouped layout as the committed example; omit unlisted values. */
export function renderEnvTemplate(target: string, values: Record<string, string>): string {
  const example = readFileSync(resolve(root, target, '.env.example'), 'utf8');
  return example
    .split('\n')
    .map((line) => {
      const key = line.match(/^([A-Z_][A-Z0-9_]*)=/)?.[1];
      return key ? renderEnv({ [key]: values[key] ?? '' }).trimEnd() : line;
    })
    .join('\n');
}
export function writePrivate(path: string, content: string) {
  const full = resolve(root, path);
  mkdirSync(dirname(full), { recursive: true });
  // Dev starts several writers together. Each atomic write needs its own file.
  const temporary = `${full}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, full);
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function requireKeys(env: Record<string, string>, keys: readonly string[]) {
  for (const key of keys)
    if (!env[key] || env[key].includes('op://'))
      throw new Error(`Missing ${key}; configure the selected stage first`);
}
export function scopedEnv(target: string, stage: string) {
  const env = readEnv(`${target}/.env`);
  if (env.STAGE !== stage)
    throw new Error(
      `${target}/.env does not match stage ${stage}. Inject the correct stage first.`,
    );
  return env;
}
