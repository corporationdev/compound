import { test, expect, jest, afterEach } from 'bun:test';
import { convexTest } from 'convex-test';
import { resolve, dirname } from 'node:path';
import { v } from 'convex/values';
import schema from '../convex/schema';
import { api, internal, components } from '../convex/_generated/api';
import { internalAction } from '../convex/_generated/server';

function modules(dir: string) {
  return Object.fromEntries(
    [...new Bun.Glob('**/*.ts').scanSync(dir)].map((path) => [
      `${dir}/${path}`,
      () => import(`${dir}/${path}`),
    ]),
  );
}
const registry = await Promise.all(
  [
    ['betterAuth', '@convex-dev/better-auth'],
    ['workflow', '@convex-dev/workflow'],
    ['workflow/workpool', '@convex-dev/workpool'],
    ['workflow/workpool/batchWorker', '@convex-dev/batch-worker'],
  ].map(async ([name, pkg]) => {
    const dir = resolve(
      dirname(
        import.meta.resolve(`${pkg}/package.json`).replace('file://', ''),
      ),
      'src/component',
    );
    return {
      name,
      schema: (await import(`${dir}/schema.ts`)).default,
      modules: modules(dir),
    };
  }),
);
function setup() {
  jest.useFakeTimers();
  const dir = resolve(import.meta.dirname, '../convex');
  const steps: string[] = [];
  const ids = { jobId: v.id('transcriptionJobs'), attempt: v.number() };
  const record = (name: string) =>
    internalAction({
      args: { ...ids, index: v.number() },
      handler: async () => {
        steps.push(name);
        return null;
      },
    });
  const fake = {
    prepare: internalAction({
      args: ids,
      handler: async () => {
        steps.push('deepgram');
        return { enhance: true, pieces: 2 };
      },
    }),
    correctPiece: record('gemini'),
    mergeWords: internalAction({
      args: ids,
      handler: async () => {
        steps.push('merge');
        return 2;
      },
    }),
    alignBatch: record('align'),
    joinBatch: record('seam'),
    finish: internalAction({
      args: ids,
      handler: async (ctx, args) => {
        steps.push('finish');
        await ctx.runMutation(internal.transcriptions.progress, {
          ...args,
          stage: 'ready',
          resultKey: `media/transcripts/${args.jobId}/result.json`,
          quality: 'aligned',
        });
        return null;
      },
    }),
  };
  const t = convexTest(schema, {
    ...modules(dir),
    [`${dir}/asset_transcription.ts`]: async () => fake,
  });
  for (const c of registry) t.registerComponent(c.name, c.schema, c.modules);
  return { t, steps };
}
async function user(t: ReturnType<typeof setup>['t'], email: string) {
  const now = Date.now();
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'user',
      data: {
        name: 'Test',
        email,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const session = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'session',
      data: {
        userId: user!._id,
        token: crypto.randomUUID(),
        expiresAt: now + 86400000,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return {
    id: user!._id,
    client: t.withIdentity({ subject: user!._id, sessionId: session!._id }),
  };
}
afterEach(() => jest.useRealTimers());

test('duplicate starts share one durable job and return the same result without claiming again', async () => {
  const { t, steps } = setup();
  const alice = await user(t, 'alice-jobs@example.com');
  const bob = await user(t, 'bob-jobs@example.com');
  const upload = (await alice.client.mutation(api.uploads.create, {
    contentType: 'audio/wav',
    size: 32044,
  }))!;
  const first = await alice.client.mutation(api.transcriptions.start, {
    uploadId: upload._id,
  });
  expect(
    await alice.client.mutation(api.transcriptions.start, {
      uploadId: upload._id,
    }),
  ).toEqual(first);
  await expect(
    bob.client.mutation(api.transcriptions.start, { uploadId: upload._id }),
  ).rejects.toThrow('Upload not found');
  await expect(bob.client.query(api.transcriptions.get, first)).rejects.toThrow(
    'not found',
  );
  await t.finishAllScheduledFunctions(() => jest.advanceTimersByTime(100));
  expect(steps).toEqual([
    'deepgram',
    'gemini',
    'gemini',
    'merge',
    'align',
    'seam',
    'align',
    'seam',
    'finish',
  ]);
  expect(await alice.client.query(api.transcriptions.get, first)).toMatchObject(
    { status: 'ready', quality: 'aligned' },
  );
  expect(
    await alice.client.mutation(api.transcriptions.start, {
      uploadId: upload._id,
    }),
  ).toEqual(first);
  expect(
    (await alice.client.query(api.uploads.get, { id: upload._id })).calls,
  ).toBe(1);
});

test('cancellation and deleted accounts fence late provider completions', async () => {
  const { t } = setup();
  const alice = await user(t, 'cancel-jobs@example.com');
  const upload = (await alice.client.mutation(api.uploads.create, {
    contentType: 'audio/wav',
    size: 32044,
  }))!;
  const { jobId } = await alice.client.mutation(api.transcriptions.start, {
    uploadId: upload._id,
  });
  await alice.client.mutation(api.transcriptions.cancel, { jobId });
  await expect(
    t.query(internal.transcriptions.context, { jobId, attempt: 1 }),
  ).rejects.toThrow('canceled');
  await expect(
    t.mutation(internal.transcriptions.progress, {
      jobId,
      attempt: 1,
      stage: 'ready',
      resultKey: 'late',
    }),
  ).rejects.toThrow('canceled');
  await t.finishAllScheduledFunctions(() => jest.advanceTimersByTime(100));
  await t.mutation(internal.uploads.removeForUser, { ownerId: alice.id });
  expect(await t.run((ctx) => ctx.db.get(jobId))).toBeNull();
});
