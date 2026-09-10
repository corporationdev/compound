import { WorkflowManager, vWorkflowId } from '@convex-dev/workflow';
import { vResultValidator } from '@convex-dev/workpool';
import { v } from 'convex/values';
import { components, internal } from './_generated/api';
import { internalMutation } from './_generated/server';

// Like PostBob, each provider piece/batch is a durable step. Provider adapters
// own bounded transport retries; invalid audio/alignment must not be retried.
export const transcriptionWorkflowManager = new WorkflowManager(
  components.workflow,
  {
    workpoolOptions: { maxParallelism: 10, retryActionsByDefault: false },
  },
);

export const prepareTranscript = transcriptionWorkflowManager
  .define({
    args: { jobId: v.id('transcriptionJobs'), attempt: v.number() },
    returns: v.null(),
  })
  .handler(async (step, args): Promise<null> => {
    const prepared = await step.runAction(
      internal.asset_transcription.prepare,
      args,
      { name: 'deepgram-transcript' },
    );
    if (prepared.enhance) {
      for (let index = 0; index < prepared.pieces; index++) {
        await step.runAction(
          internal.asset_transcription.correctPiece,
          { ...args, index },
          { name: `gemini-piece-${index}` },
        );
      }
      const batches = await step.runAction(
        internal.asset_transcription.mergeWords,
        args,
        { name: 'store-verbatim-transcript' },
      );
      for (let index = 0; index < batches; index++) {
        await step.runAction(
          internal.asset_transcription.alignBatch,
          { ...args, index },
          { name: `alignment-batch-${index}` },
        );
        await step.runAction(
          internal.asset_transcription.joinBatch,
          { ...args, index },
          { name: `alignment-seam-${index}` },
        );
      }
    }
    await step.runAction(internal.asset_transcription.finish, args, {
      name: 'store-aligned-transcript',
    });
    return null;
  });

export const completeTranscriptWorkflow = internalMutation({
  args: {
    context: v.object({
      jobId: v.id('transcriptionJobs'),
      attempt: v.number(),
    }),
    result: vResultValidator,
    workflowId: vWorkflowId,
  },
  handler: async (ctx, { context, result, workflowId }) => {
    const job = await ctx.db.get(context.jobId);
    if (
      job &&
      job.attempt === context.attempt &&
      job.workflowId === workflowId &&
      job.status === 'running'
    ) {
      await ctx.db.patch(job._id, {
        status: result.kind === 'canceled' ? 'canceled' : 'failed',
        error:
          result.kind === 'failed'
            ? `${job.stage}: ${result.error}`
            : 'Transcription did not finish.',
        updatedAt: Date.now(),
      });
    }
    if (result.kind === 'canceled') {
      // Let any queued initial runner observe cancellation before removing its journal.
      await ctx.scheduler.runAfter(
        60000,
        internal.transcription_workflow.cleanupWorkflow,
        { workflowId },
      );
    } else {
      await transcriptionWorkflowManager.cleanup(ctx, workflowId);
    }
  },
});

export const cleanupWorkflow = internalMutation({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, { workflowId }) => {
    await transcriptionWorkflowManager.cleanup(ctx, workflowId);
  },
});
