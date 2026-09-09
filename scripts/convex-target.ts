import { deployment } from '@compound/config/deployment';
import { getStageKind } from '@compound/config/stage-kind';
import { validateStage } from '@compound/config/runtime';

export function isProjectPreviewKey(key: string): boolean {
  return /^preview:[^:|]+:[^:|]+\|.+$/.test(key);
}
export function validateProjectPreviewKey(stage: string, key: string): void {
  if (getStageKind(validateStage(stage)) !== 'preview') throw new Error('Project preview keys require a preview stage');
  if (!isProjectPreviewKey(key)) throw new Error('Automatic previews require a project preview deploy key');
  const prefix = key.split('|')[0]!.split(':');
  if (prefix[1] !== deployment.convexTeamSlug || prefix[2] !== deployment.convexProjectSlug)
    throw new Error('Preview key must belong to the configured Compound Convex project');
}
export function convexTarget(stage: string, key: string, url?: string): { url: string; preview: boolean } {
  validateStage(stage);
  const kind = getStageKind(stage);
  const prefix = key.split('|')[0]!.split(':');
  if (isProjectPreviewKey(key)) {
    validateProjectPreviewKey(stage, key);
    if (!url || !/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.convex\.cloud$/.test(url))
      throw new Error('Preview requires CONVEX_URL from convex deploy --preview-name');
    return { url, preview: true };
  }
  if (!/^(dev|prod|preview):[a-z0-9]+(?:-[a-z0-9]+)*\|.+$/.test(key))
    throw new Error('Use a deployment-specific Convex key or a project preview key');
  const expected = kind === 'production' ? 'prod' : kind === 'preview' ? 'preview' : 'dev';
  if (prefix[0] !== expected) throw new Error('Convex deploy key type does not match the selected stage');
  const keyUrl = `https://${prefix[1]}.convex.cloud`;
  if (url && url !== keyUrl) throw new Error('Convex deployment output does not match the selected deploy key');
  return { url: keyUrl, preview: false };
}
