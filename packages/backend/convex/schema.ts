import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { vWorkflowId } from '@convex-dev/workflow';
export default defineSchema({
  transcriptionJobs: defineTable({
    ownerId: v.string(),
    uploadId: v.id('uploads'),
    options: v.string(),
    language: v.optional(v.string()),
    workflowId: v.optional(vWorkflowId),
    attempt: v.number(),
    status: v.union(
      v.literal('running'),
      v.literal('ready'),
      v.literal('failed'),
      v.literal('canceled'),
    ),
    stage: v.string(),
    updatedAt: v.number(),
    expiresAt: v.number(),
    resultKey: v.optional(v.string()),
    quality: v.optional(v.string()),
    error: v.optional(v.string()),
  })
    .index('by_upload', ['uploadId', 'options'])
    .index('by_owner', ['ownerId'])
    .index('by_expiry', ['expiresAt']),
  uploads: defineTable({
    ownerId: v.string(),
    key: v.string(),
    contentType: v.string(),
    size: v.number(),
    calls: v.number(),
    expiresAt: v.number(),
  })
    .index('by_owner', ['ownerId', 'expiresAt'])
    .index('by_expiry', ['expiresAt']),
});
