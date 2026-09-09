import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { validateStage } from '@compound/config/runtime';

/** PostBob's branch-derived stage, with a hash to avoid truncated-name collisions. */
export function previewStage(branch: string): string {
  if (!branch.trim()) throw new Error('Missing preview branch');
  const clean = branch.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 16).replace(/-$/, '') || 'branch';
  const hash = createHash('sha256').update(branch).digest('hex').slice(0, 8);
  return validateStage(`preview-${clean}-${hash}`);
}
if (import.meta.main) {
  const stage = previewStage(process.env.PREVIEW_BRANCH ?? '');
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `STAGE=${stage}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `stage=${stage}\n`);
  console.log(`Preview stage: ${stage}`);
}
