import { deployment } from '@compound/config/deployment';
import { getStageKind } from '@compound/config/stage-kind';
import { validateStage } from '@compound/config/runtime';
import { scopedEnv, stageFrom } from './environment';

type Deployment = { name: string; deploymentType: string; previewIdentifier: string | null };
export function requirePreviewStage(stage: string): void {
  if (getStageKind(validateStage(stage)) !== 'preview') throw new Error('Preview lifecycle commands require a preview stage');
}
/** PostBob's Management API cleanup, limited to this project and exact preview. */
export class ConvexPreviews {
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  constructor(token: string, fetcher: typeof fetch = fetch) {
    if (!token) throw new Error('Missing CONVEX_MANAGEMENT_TOKEN: set compound-preview / Convex / team-access-token');
    this.token = token;
    this.fetcher = fetcher;
  }
  private async request<T>(path: string, method = 'GET'): Promise<T> {
    const response = await this.fetcher(`https://api.convex.dev/v1${path}`, {
      method,
      signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    if (!response.ok) throw new Error(`Convex Management API ${method} failed (${response.status})`);
    const text = await response.text();
    return text ? JSON.parse(text) as T : undefined as T;
  }
  async find(stage: string): Promise<Deployment | null> {
    requirePreviewStage(stage);
    const project = await this.request<{ id: number }>(`/teams/${encodeURIComponent(deployment.convexTeamSlug)}/projects/${encodeURIComponent(deployment.convexProjectSlug)}`);
    if (!Number.isSafeInteger(project.id)) throw new Error('Convex returned an invalid project ID');
    const rows = await this.request<Deployment[]>(`/projects/${project.id}/list_deployments?deploymentType=preview`);
    const matches = rows.filter((row) => row.deploymentType === 'preview' && row.previewIdentifier === stage);
    if (matches.length > 1) throw new Error('Multiple deployments match this preview; refusing ambiguous cleanup');
    const match = matches[0] ?? null;
    if (match && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(match.name)) throw new Error('Convex returned an invalid deployment name');
    return match;
  }
  async remove(stage: string): Promise<void> {
    const target = await this.find(stage);
    if (!target) { console.log(`No Convex preview remains for ${stage}.`); return; }
    await this.request(`/deployments/${encodeURIComponent(target.name)}/delete`, 'POST');
    console.log(`Deleted Convex preview ${target.name}.`);
  }
}
if (import.meta.main) {
  const stage = stageFrom(process.argv.slice(2));
  requirePreviewStage(stage);
  const previews = new ConvexPreviews(scopedEnv('packages/backend', stage).CONVEX_MANAGEMENT_TOKEN ?? '');
  if (process.argv.includes('--dry-run')) {
    const target = await previews.find(stage);
    console.log(target ? `Would delete Convex preview ${target.name}.` : 'No matching preview.');
  } else await previews.remove(stage);
}
