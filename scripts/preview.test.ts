import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { previewStage } from './preview-stage';
import { convexTarget } from './convex-target';
import { ConvexPreviews, requirePreviewStage } from './convex-preview-deployments';

test('branch previews have stable DNS-safe stages without truncation collisions', () => {
  expect(previewStage('feature/editor')).toBe(previewStage('feature/editor'));
  expect(previewStage('feature/editor')).not.toBe(previewStage('feature-editor'));
  expect(previewStage('a'.repeat(100))).not.toBe(previewStage('a'.repeat(99) + 'b'));
  expect(previewStage('$(echo unsafe)/UPPER_你好')).toMatch(/^preview-[a-z0-9-]+$/);
  expect(previewStage('🦊')).toMatch(/^preview-branch-/);
  expect(() => previewStage('')).toThrow('branch');
});
test('Convex preview targeting never falls through to a dev/prod deployment', () => {
  const key = 'preview:corporation:compound|test';
  expect(convexTarget('preview-example', key, 'https://isolated-preview.convex.cloud'))
    .toEqual({ url: 'https://isolated-preview.convex.cloud', preview: true });
  expect(() => convexTarget('preview-example', key)).toThrow('CONVEX_URL');
  expect(() => convexTarget('prod', key, 'https://isolated-preview.convex.cloud')).toThrow('preview stage');
  expect(() => convexTarget('preview-example', 'preview:corporation:postbob|test', 'https://wrong.convex.cloud')).toThrow('Compound');
  expect(() => convexTarget('preview-example', 'prod:production-one|test')).toThrow('key type');
  expect(() => convexTarget('dev-local', 'prod:production-one|test')).toThrow('key type');
  expect(() => convexTarget('dev-local', 'dev:dev-one|test', 'https://other.convex.cloud')).toThrow('does not match');
});
test('teardown deletes only the exact preview; repeated cleanup and empty responses work', async () => {
  const deleted: string[] = [];
  let rows = [
    { name: 'production-one', deploymentType: 'prod', previewIdentifier: 'preview-one' },
    { name: 'other-preview', deploymentType: 'preview', previewIdentifier: 'preview-two' },
    { name: 'target-preview', deploymentType: 'preview', previewIdentifier: 'preview-one' },
  ];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    expect(new URL(String(url)).origin).toBe('https://api.convex.dev');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
    if (path === '/v1/teams/corporation/projects/compound') return Response.json({ id: 42 });
    if (path === '/v1/projects/42/list_deployments') return Response.json(rows);
    expect(init?.method).toBe('POST');
    deleted.push(path);
    rows = rows.filter(r => r.name !== 'target-preview');
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const previews = new ConvexPreviews('test-token', fetcher);
  await previews.remove('preview-one');
  await previews.remove('preview-one');
  expect(deleted).toEqual(['/v1/deployments/target-preview/delete']);
  expect(rows.map(r => r.name)).toEqual(['production-one', 'other-preview']);
  expect(() => requirePreviewStage('prod')).toThrow('preview stage');
  expect(() => requirePreviewStage('dev-local')).toThrow('preview stage');
});
test('ambiguous or unauthorized cleanup fails without deleting anything', async () => {
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(init?.method).toBe('GET');
    if (String(url).includes('/teams/')) return Response.json({ id: 42 });
    return Response.json(['one', 'two'].map(name => ({ name, deploymentType: 'preview', previewIdentifier: 'preview-one' })));
  }) as typeof fetch;
  await expect(new ConvexPreviews('test', fetcher).remove('preview-one')).rejects.toThrow('ambiguous');
  await expect(new ConvexPreviews('test', (async (_url: string | URL | Request, _init?: RequestInit) => new Response('private details', { status: 403 })) as typeof fetch).find('preview-one'))
    .rejects.toThrow('Convex Management API GET failed (403)');
});
test('preview lifecycle uses retained data and matching serialized PR workflows', () => {
  const backend = readFileSync(new URL('./backend.ts', import.meta.url), 'utf8');
  expect(backend).not.toContain('--preview-create');
  // Previews are deployed on request by Prepare PR and removed by Teardown
  // Preview; both serialize on the branch's group and refuse forks.
  const prepare = readFileSync(new URL('../.github/workflows/prepare-pr.yml', import.meta.url), 'utf8');
  const teardown = readFileSync(new URL('../.github/workflows/teardown-preview.yml', import.meta.url), 'utf8');
  expect(prepare).toContain('workflow_dispatch');
  expect(prepare).not.toContain('pull_request:');
  expect(prepare).toContain('group: preview-${{ needs.resolve.outputs.head_ref }}');
  expect(prepare).toContain('pr.head.repo.full_name !== `${context.repo.owner}/${context.repo.repo}`');
  expect(teardown).toContain('group: preview-${{ github.event.pull_request.head.ref }}');
  expect(teardown).toContain('head.repo.full_name == github.repository');
  for (const workflow of [prepare, teardown]) {
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).not.toContain('pull_request_target');
  }
});
