import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { MODAL_ALIGNER_APP } from '@compound/config/transcription';
import { root, scopedEnv, stageFrom, requireKeys } from './environment';

const stage = stageFrom(process.argv.slice(2));
const backend = scopedEnv('packages/backend', stage);
requireKeys(backend, ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET']);
// Same per-stage Modal environment pattern as PostBob, with a Compound app name.
function resolvePython(): string {
  if (process.env.MODAL_PYTHON) return process.env.MODAL_PYTHON;
  const directory = resolve(root, '.cache/modal-cli');
  const python = resolve(directory, 'bin/python');
  if (
    spawnSync(
      python,
      [
        '-c',
        'from importlib.metadata import version; assert version("modal") == "1.2.6"',
      ],
      { stdio: 'ignore' },
    ).status === 0
  )
    return python;
  mkdirSync(resolve(root, '.cache'), { recursive: true });
  if (
    spawnSync('python3', ['-m', 'venv', directory], { stdio: 'inherit' })
      .status !== 0
  )
    throw new Error('Could not create Modal CLI environment');
  if (
    spawnSync(
      python,
      ['-m', 'pip', 'install', '--disable-pip-version-check', 'modal==1.2.6'],
      { stdio: 'inherit' },
    ).status !== 0
  )
    throw new Error('Could not install Modal CLI');
  return python;
}
const python = resolvePython();
const run = (args: string[], capture = false) => {
  const result = spawnSync(python, ['-m', 'modal', ...args], {
    cwd: resolve(root, 'apps/wav2vec-aligner'),
    env: {
      ...process.env,
      MODAL_TOKEN_ID: backend.MODAL_TOKEN_ID,
      MODAL_TOKEN_SECRET: backend.MODAL_TOKEN_SECRET,
    },
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Modal ${args[0]} failed`);
  return result.stdout;
};
const environments = JSON.parse(
  run(['environment', 'list', '--json'], true),
) as { name: string }[];
if (process.argv.includes('stop')) {
  if (environments.some((e) => e.name === stage))
    run(['app', 'stop', '--env', stage, MODAL_ALIGNER_APP]);
} else {
  if (!environments.some((e) => e.name === stage))
    run(['environment', 'create', stage]);
  run(['deploy', '--env', stage, '-m', 'wav2vec_aligner.app']);
}
