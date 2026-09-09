import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
export default defineSchema({
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
