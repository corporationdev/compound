import { deriveEnvTier } from '@compound/config/stage';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import {
  root,
  targets,
  stageFrom,
  readEnv,
  renderEnv,
  renderEnvTemplate,
  writePrivate,
  requireKeys,
  serviceAccountToken,
} from './environment';

const args = process.argv.slice(2);
const stage = stageFrom(args);
const included = args.flatMap((arg, i) => (arg === '--include' ? [args[i + 1] ?? ''] : []));
const examples = targets.map((target) => ({ target, values: readEnv(`${target}/.env.example`) }));
const template = parse(
  readFileSync(resolve(root, '.env.op'), 'utf8')
    .replaceAll('${STAGE}', stage)
    .replaceAll('${ENV_TIER}', deriveEnvTier(stage)),
);
const allKeys = new Set(Object.keys(template).filter((key) => key !== 'STAGE'));
for (const key of allKeys) {
  if (key === 'OP_SERVICE_ACCOUNT_TOKEN' || !template[key]?.startsWith('op://'))
    throw new Error(`Invalid .env.op entry ${key}: only vault references belong here; keep the service account token in root .env`);
}
for (const key of included) if (!allKeys.has(key)) throw new Error(`Unknown --include key: ${key}`);
const keys = included.length ? included : [...allKeys];
requireKeys(
  Object.fromEntries(keys.map((key) => [key, template[key]?.replace('op://', '') ?? ''])),
  keys,
);
const token = serviceAccountToken(readEnv('.env'), process.env);
// Like PostBob, give op a reference-only file: its stdin detection fails under Bun.
// Resolved secrets stay in captured stdout until written to the scoped env files.
const temporary = mkdtempSync(resolve(tmpdir(), 'compound-inject-'));
const result = (() => {
  try {
    const inputPath = resolve(temporary, 'references.env');
    writeFileSync(inputPath, renderEnv(Object.fromEntries(keys.map((key) => [key, template[key]!]))), { mode: 0o600 });
    return spawnSync('op', ['inject', '--in-file', inputPath], {
      encoding: 'utf8',
      env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token },
      maxBuffer: 1024 * 1024,
      timeout: 60000,
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
})();
if (result.status !== 0)
  throw new Error(
    '1Password injection failed. Check the service account, vault names, items, and field permissions.',
  );
const values = parse(result.stdout);
requireKeys(values, keys);
if (!args.includes('--check')) {
  if (included.length)
    for (const { target } of examples) {
      if (readEnv(`${target}/.env`).STAGE !== stage)
        throw new Error('Partial injection requires an existing environment for the same stage');
    }
  for (const { target, values: example } of examples) {
    const old = readEnv(`${target}/.env`);
    if (included.length && old.STAGE !== stage)
      throw new Error('Partial injection requires an existing environment for the same stage');
    const next = Object.fromEntries(
      Object.keys(example).map((key) => [
        key,
        key === 'STAGE'
          ? stage
          : (values[key] ?? (included.length ? old[key] : undefined) ?? example[key]!),
      ]),
    );
    writePrivate(`${target}/.env`, renderEnvTemplate(target, next));
  }
}
console.log(
  `${args.includes('--check') ? 'Verified' : 'Injected'} ${keys.length} values for ${stage}; secret values are not printed.`,
);
