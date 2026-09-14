import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { vWorkflowId } from '@convex-dev/workflow';
import { catalogKind, catalogProvider, catalogSourceRange } from './catalog_types';
import { socialCover, socialMediaKind, socialOperation, socialPlatform, socialSnapshot, socialStatus } from './social_model';
export default defineSchema({
  // One Zernio profile per Compound user; social accounts attach to it.
  socialProfiles: defineTable({
    ownerId: v.string(),
    providerId: v.string(),
  }).index('by_owner', ['ownerId']),
  // A social account the user connected through Zernio. Disconnecting keeps
  // the row with `active: false` so history can still name the account.
  socialAccounts: defineTable({
    ownerId: v.string(),
    providerId: v.string(),
    profileId: v.string(),
    platform: socialPlatform,
    username: v.string(),
    avatarUrl: v.optional(v.string()),
    active: v.boolean(),
    updatedAt: v.number(),
  })
    .index('by_owner', ['ownerId'])
    .index('by_provider', ['providerId']),
  // A single-use OAuth attempt. Only the hash of the state is stored; the
  // callback proves possession of the state itself.
  socialConnections: defineTable({
    ownerId: v.string(),
    stateHash: v.string(),
    profileId: v.string(),
    platform: socialPlatform,
    returnUrl: v.optional(v.string()),
    expiresAt: v.number(),
    completed: v.boolean(),
  })
    .index('by_state_hash', ['stateHash'])
    .index('by_owner', ['ownerId']),
  // A rendered video or cover image in R2 under `social/`, owned by the user
  // and referenced by posts. `ready` flips once the Worker has verified the
  // object; targets wait on it before submitting.
  socialMedia: defineTable({
    ownerId: v.string(),
    kind: socialMediaKind,
    key: v.string(),
    contentType: v.string(),
    size: v.number(),
    sha256: v.optional(v.string()),
    durationMs: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    projectId: v.optional(v.string()),
    projectName: v.optional(v.string()),
    sceneId: v.optional(v.string()),
    /** Hash of the render inputs (project sources, assets, export settings, app version); same hash, same bytes. */
    contentHash: v.optional(v.string()),
    ready: v.boolean(),
    createdAt: v.number(),
  })
    .index('by_owner', ['ownerId'])
    .index('by_owner_hash', ['ownerId', 'contentHash']),
  // The editable post: what the composer shows. Submitting freezes a copy
  // into one target per account, so the draft can keep changing safely.
  socialPosts: defineTable({
    ownerId: v.string(),
    caption: v.string(),
    title: v.optional(v.string()),
    cover: socialCover,
    mediaId: v.optional(v.id('socialMedia')),
    accountIds: v.array(v.id('socialAccounts')),
    scheduledFor: v.union(v.null(), v.number()),
    timezone: v.string(),
    projectId: v.optional(v.string()),
    projectName: v.optional(v.string()),
    sceneId: v.optional(v.string()),
    status: socialStatus,
    version: v.number(),
    submittedVersion: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_owner', ['ownerId'])
    .index('by_owner_project_scene', ['ownerId', 'projectId', 'sceneId']),
  // One delivery per account. Carries everything dispatch needs to submit,
  // poll, update, cancel, or retry against Zernio with exactly-once intent.
  socialPostTargets: defineTable({
    ownerId: v.string(),
    postId: v.id('socialPosts'),
    accountId: v.id('socialAccounts'),
    platform: socialPlatform,
    username: v.string(),
    providerAccountId: v.string(),
    providerPostId: v.optional(v.string()),
    postUrl: v.optional(v.string()),
    snapshot: socialSnapshot,
    snapshotVersion: v.number(),
    requestedSnapshot: v.optional(socialSnapshot),
    requestedVersion: v.optional(v.number()),
    requestedMediaToken: v.optional(v.string()),
    mediaToken: v.string(),
    requestId: v.string(),
    requestBody: v.optional(v.string()),
    firstAttemptAt: v.optional(v.number()),
    status: socialStatus,
    operation: socialOperation,
    attempts: v.number(),
    dueAt: v.number(),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    error: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index('by_post', ['postId'])
    .index('by_provider_post', ['providerPostId'])
    .index('by_due', ['dueAt'])
    .index('by_account_and_status', ['accountId', 'status'])
    .index('by_owner_and_status', ['ownerId', 'status'])
    .index('by_owner', ['ownerId']),
  socialWebhookEvents: defineTable({
    eventId: v.string(),
    providerPostId: v.string(),
    receivedAt: v.number(),
  })
    .index('by_event', ['eventId'])
    .index('by_provider_post', ['providerPostId']),
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
});
