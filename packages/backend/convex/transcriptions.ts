import { ConvexError, v } from 'convex/values';
import { TRANSCRIPTION_VERSION } from '@compound/config/transcription';
import { internal } from './_generated/api';
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
} from './_generated/server';
import type { Id } from './_generated/dataModel';
import { authComponent } from './auth';
import { transcriptionWorkflowManager } from './transcription_workflow';

export const start = mutation({
  args: { uploadId: v.id('uploads'), language: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ jobId: Id<'transcriptionJobs'> }> => {
    const user = await authComponent.getAuthUser(ctx);
    const upload = await ctx.db.get(args.uploadId);
    if (
      !upload ||
      upload.ownerId !== user._id ||
      upload.expiresAt <= Date.now()
    )
      throw new ConvexError('Upload not found or expired');
    if (upload.contentType !== 'audio/wav')
      throw new ConvexError('Enhanced transcription requires WAV audio');
    if (args.language && !/^[a-zA-Z-]{2,20}$/.test(args.language))
      throw new ConvexError('Invalid language');
    const language = args.language?.toLowerCase();
    const options = `${TRANSCRIPTION_VERSION}:${language ?? 'auto'}`;
    const existing = await ctx.db
      .query('transcriptionJobs')
      .withIndex('by_upload', (q) =>
        q.eq('uploadId', upload._id).eq('options', options),
      )
      .unique();
    if (
      existing &&
      (existing.status === 'running' || existing.status === 'ready')
    )
      return { jobId: existing._id };
    if (upload.calls >= 10)
      throw new ConvexError('Media request limit reached');
    await ctx.db.patch(upload._id, { calls: upload.calls + 1 });
    const attempt = (existing?.attempt ?? 0) + 1;
    const fields = {
      ownerId: user._id,
      uploadId: upload._id,
      options,
      language,
      attempt,
      status: 'running' as const,
      stage: 'transcribing',
      updatedAt: Date.now(),
      expiresAt: upload.expiresAt,
    };
    const jobId =
      existing?._id ?? (await ctx.db.insert('transcriptionJobs', fields));
    if (existing)
      await ctx.db.patch(jobId, {
        ...fields,
        error: undefined,
        resultKey: undefined,
      });
    const workflowId = await transcriptionWorkflowManager.start(
      ctx,
      internal.transcription_workflow.prepareTranscript,
      { jobId, attempt },
      {
        onComplete: internal.transcription_workflow.completeTranscriptWorkflow,
        context: { jobId, attempt },
        startAsync: true,
      },
    );
    await ctx.db.patch(jobId, { workflowId });
    return { jobId };
  },
});

export const get = query({
  args: { jobId: v.id('transcriptionJobs') },
  handler: async (ctx, { jobId }) => {
    const user = await authComponent.getAuthUser(ctx);
    const job = await ctx.db.get(jobId);
    const upload = job && (await ctx.db.get(job.uploadId));
    if (
      !job ||
      job.ownerId !== user._id ||
      !upload ||
      job.expiresAt <= Date.now()
    )
      throw new ConvexError('Transcription not found or expired');
    return {
      status: job.status,
      stage: job.stage,
      resultKey: job.resultKey,
      quality: job.quality,
      error: job.error,
    };
  },
});

export const cancel = mutation({
  args: { jobId: v.id('transcriptionJobs') },
  handler: async (ctx, { jobId }) => {
    const user = await authComponent.getAuthUser(ctx);
    const job = await ctx.db.get(jobId);
    if (!job || job.ownerId !== user._id)
      throw new ConvexError('Transcription not found');
    if (job.status !== 'running') return;
    await ctx.db.patch(jobId, { status: 'canceled', updatedAt: Date.now() });
    if (job.workflowId)
      await transcriptionWorkflowManager.cancel(ctx, job.workflowId);
  },
});

// Every action checks this both before provider work and before publishing an
// artifact/result. Deleted uploads and superseded attempts cannot finish jobs.
export const context = internalQuery({
  args: { jobId: v.id('transcriptionJobs'), attempt: v.number() },
  handler: async (ctx, { jobId, attempt }) => {
    const job = await ctx.db.get(jobId);
    const upload = job && (await ctx.db.get(job.uploadId));
    if (
      !job ||
      !upload ||
      job.status !== 'running' ||
      job.attempt !== attempt ||
      job.expiresAt <= Date.now() ||
      upload.ownerId !== job.ownerId
    )
      throw new Error('Transcription canceled or expired');
    return { job, upload };
  },
});

export const progress = internalMutation({
  args: {
    jobId: v.id('transcriptionJobs'),
    attempt: v.number(),
    stage: v.string(),
    resultKey: v.optional(v.string()),
    quality: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (
      !job ||
      job.attempt !== args.attempt ||
      job.status !== 'running' ||
      job.expiresAt <= Date.now() ||
      !(await ctx.db.get(job.uploadId))
    )
      throw new Error('Transcription canceled or expired');
    await ctx.db.patch(job._id, {
      stage: args.stage,
      updatedAt: Date.now(),
      ...(args.resultKey
        ? {
            resultKey: args.resultKey,
            quality: args.quality,
            status: 'ready' as const,
          }
        : {}),
    });
  },
});

export const expire = internalMutation({
  args: {},
  handler: async (ctx) => {
    const jobs = await ctx.db
      .query('transcriptionJobs')
      .withIndex('by_expiry', (q) => q.lt('expiresAt', Date.now()))
      .take(100);
    for (const job of jobs) {
      if (job.status === 'running' && job.workflowId)
        await transcriptionWorkflowManager.cancel(ctx, job.workflowId);
      await ctx.db.delete(job._id);
    }
  },
});
