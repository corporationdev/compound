import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { vWorkflowId } from '@convex-dev/workflow';
import { catalogKind, catalogProvider, catalogSourceRange } from './catalog_types';
export default defineSchema({
  catalogSources: defineTable({
    provider: v.union(catalogProvider, v.literal('upload')),
    externalId: v.string(),
    ownerId: v.optional(v.string()),
    kind: catalogKind,
    title: v.string(),
    durationUs: v.optional(v.number()),
    status: v.union(v.literal('uploading'), v.literal('queued'), v.literal('running'), v.literal('ready'), v.literal('failed')),
    attempt: v.number(),
    updatedAt: v.number(),
    key: v.optional(v.string()),
    uploadKey: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    size: v.optional(v.number()),
    extension: v.optional(v.string()),
    checksum: v.optional(v.string()),
    artworkKey: v.optional(v.string()),
    error: v.optional(v.string()),
    errorDetail: v.optional(v.string()),
    externalRunId: v.optional(v.string()),
    externalRunTerminal: v.optional(v.boolean()),
  }).index('by_external', ['provider', 'externalId'])
    .index('by_owner', ['ownerId'])
    .index('by_provider_status_updated', ['provider', 'status', 'updatedAt']),
  catalogEntries: defineTable({
    ownerId: v.string(),
    sourceId: v.id('catalogSources'),
    kind: catalogKind,
    title: v.string(),
    description: v.string(),
    sourceRange: v.optional(catalogSourceRange),
    sortOrder: v.number(),
    searchText: v.string(),
    revision: v.optional(v.string()),
  }).index('by_owner_source', ['ownerId', 'sourceId'])
    .index('by_owner_kind_order', ['ownerId', 'kind', 'sortOrder'])
    .searchIndex('search', { searchField: 'searchText', filterFields: ['ownerId', 'kind'] }),
  catalogSearches: defineTable({
    key: v.string(),
    kind: catalogKind,
    query: v.string(),
    status: v.union(v.literal('running'), v.literal('ready'), v.literal('failed')),
    sourceIds: v.array(v.id('catalogSources')),
    expiresAt: v.number(),
    error: v.optional(v.string()),
  }).index('by_key', ['key']).index('by_expiry', ['expiresAt']),
  catalogRateLimits: defineTable({ ownerId: v.string(), window: v.number(), count: v.number() }).index('by_owner', ['ownerId']),
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
  // One text file of an organization's workspace. The truth for the text;
  // every desktop folder is a checkout of these rows (see docs/workspace-plan.md).
  files: defineTable({
    organizationId: v.string(),
    path: v.string(),
    text: v.string(),
    hash: v.string(),
    version: v.number(),
    deleted: v.boolean(),
    updatedAt: v.number(),
    updatedBy: v.string(),
  })
    .index('by_org_path', ['organizationId', 'path'])
    .index('by_org', ['organizationId']),
  // Legacy: per-project rows from before the workspace. Kept until
  // `migrations.projectsToWorkspace` has run on every deployment.
  projects: defineTable({
    organizationId: v.string(),
    name: v.string(),
    entry: v.string(),
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    archivedAt: v.optional(v.number()),
  }).index('by_org', ['organizationId']),
  projectFiles: defineTable({
    projectId: v.id('projects'),
    path: v.string(),
    text: v.string(),
    hash: v.string(),
    version: v.number(),
    deleted: v.boolean(),
    updatedAt: v.number(),
    updatedBy: v.string(),
  })
    .index('by_project_path', ['projectId', 'path'])
    .index('by_project', ['projectId']),
  assets: defineTable({
    organizationId: v.string(),
    sampleId: v.string(),
    size: v.number(),
    mimeType: v.string(),
    name: v.string(),
    originalKey: v.optional(v.string()),
    originalState: v.union(v.literal('uploading'), v.literal('ready')),
    // A 720p MP4 made beside the original so another machine can start
    // playing before the original has come down. Absent for assets that
    // have none (audio, images) and for originals registered before proxies.
    proxyKey: v.optional(v.string()),
    proxySize: v.optional(v.number()),
    proxyState: v.optional(v.union(v.literal('uploading'), v.literal('ready'))),
    // The S3 multipart upload a large original is arriving through, so a
    // client that stops can carry on from the parts already in the bucket.
    multipartUploadId: v.optional(v.string()),
    uploadedBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_org_sample', ['organizationId', 'sampleId']),
});
