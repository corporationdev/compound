import { spawnSync } from 'node:child_process';
import { root, stageFrom, scopedEnv } from './environment';
import { ConvexPreviews, requirePreviewStage } from './convex-preview-deployments';
import { writeRuntime } from './write-runtime-env';

const stage = stageFrom(process.argv.slice(2));
requirePreviewStage(stage);
let failed = false;
let previews: ConvexPreviews | undefined;
let deploymentName: string | undefined;
try {
  previews = new ConvexPreviews(scopedEnv('packages/backend', stage).CONVEX_MANAGEMENT_TOKEN ?? '');
  deploymentName = (await previews.find(stage))?.name;
} catch (error) {
  failed = true;
  console.error((error as Error).message);
}
try {
  // Alchemy destroy evaluates configuration but does not deploy these bindings.
  // A deleted/expired Convex preview must not prevent deletion of its CF stack.
  process.env.CONVEX_URL = `https://${deploymentName ?? 'removed-preview'}.convex.cloud`;
  writeRuntime(stage);
  const result = spawnSync(process.execPath, [`${root}/scripts/infra.ts`, 'destroy', '--stage', stage], {
    cwd: root, stdio: 'inherit', env: process.env,
  });
  if (result.status !== 0) failed = true;
} catch (error) {
  failed = true;
  console.error((error as Error).message);
}
// Attempt Convex cleanup even if Alchemy failed, matching PostBob's lifecycle.
try {
  if (previews) await previews.remove(stage);
} catch (error) {
  failed = true;
  console.error((error as Error).message);
}
process.exitCode = failed ? 1 : 0;
