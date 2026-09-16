import { ConvexError, v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { mutation, query, type MutationCtx } from './_generated/server';
import { requireMember } from './lib/membership';

export const MAX_PATH_BYTES = 512;
export const MAX_TEXT_BYTES = 512 * 1024;
export const MAX_WRITE_MANY_FILES = 64;
export const MAX_WRITE_MANY_BYTES = 8 * 1024 * 1024;

const encoder = new TextEncoder();
/** sha256 of the empty string; tombstones carry it so every row has a valid hash. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export type RemoteFile = {
  path: string;
  text: string;
  hash: string;
  version: number;
  deleted: boolean;
  updatedAt: number;
  updatedBy: string;
};
export type WriteResult =
  | { status: 'ok'; version: number }
  | { status: 'conflict'; current: RemoteFile | null };

/** A row without its text: what `list` delivers, so a subscription costs bytes per change, not per workspace. */
export type RemoteFileMeta = Omit<RemoteFile, 'text'>;

export function toRemoteFileMeta(row: Doc<'files'>): RemoteFileMeta {
  return {
    path: row.path,
    hash: row.hash,
    version: row.version,
    deleted: row.deleted,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

export function toRemoteFile(row: Doc<'files'>): RemoteFile {
  return {
    path: row.path,
    text: row.text,
    hash: row.hash,
    version: row.version,
    deleted: row.deleted,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

export function validatePath(path: string) {
  if (!path) throw new ConvexError('Path must not be empty');
  if (encoder.encode(path).length > MAX_PATH_BYTES)
    throw new ConvexError('Path must be at most 512 bytes');
  if (path.startsWith('/')) throw new ConvexError('Path must be workspace-relative');
  if (path.includes('\\')) throw new ConvexError('Path must use forward slashes');
  if (path.includes('\0')) throw new ConvexError('Path must not contain NUL bytes');
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    throw new ConvexError('Path must not contain empty, "." or ".." segments');
  return path;
}

export function validateText(text: string) {
  if (text.includes('\0')) throw new ConvexError('Text must not contain NUL bytes');
  const bytes = encoder.encode(text).length;
  if (bytes > MAX_TEXT_BYTES) throw new ConvexError('Text must be at most 512 KiB');
  return bytes;
}

/**
 * The hash must be the sha256 hex of the text. It is recomputed here when the
 * runtime exposes `crypto.subtle`; otherwise (older Convex isolates) only the
 * format is checked and the client's value is trusted.
 */
export async function validateHash(text: string, hash: string) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new ConvexError('Hash must be 64 lowercase hex characters');
  const subtle = globalThis.crypto?.subtle;
  if (!subtle?.digest) return;
  const digest = new Uint8Array(await subtle.digest('SHA-256', encoder.encode(text)));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  if (hex !== hash) throw new ConvexError('Hash does not match text');
}

export async function currentRow(ctx: MutationCtx, organizationId: string, path: string) {
  return await ctx.db
    .query('files')
    .withIndex('by_org_path', (q) => q.eq('organizationId', organizationId).eq('path', path))
    .unique();
}

/**
 * Version check shared by write and remove. `expectedVersion` null means
 * "create": allowed when the row is absent or a tombstone. Otherwise the row
 * must exist at exactly that version.
 */
function checkVersion(
  row: Doc<'files'> | null,
  expectedVersion: number | null,
): WriteResult | null {
  if (expectedVersion === null) {
    if (row && !row.deleted) return { status: 'conflict', current: toRemoteFile(row) };
    return null;
  }
  if (!row || row.version !== expectedVersion)
    return { status: 'conflict', current: row ? toRemoteFile(row) : null };
  return null;
}

export async function upsert(
  ctx: MutationCtx,
  organizationId: string,
  row: Doc<'files'> | null,
  fields: { path: string; text: string; hash: string; deleted: boolean },
  userId: string,
) {
  const now = Date.now();
  const version = (row?.version ?? 0) + 1;
  if (row) await ctx.db.patch(row._id, { ...fields, version, updatedAt: now, updatedBy: userId });
  else await ctx.db.insert('files', { organizationId, ...fields, version, updatedAt: now, updatedBy: userId });
  return version;
}

/**
 * A path that would collide with an existing one on a case-insensitive disk
 * (macOS, Windows): two rows, one file, and two checkouts pushing each
 * other's text forever. Only creates are checked; an existing row is itself.
 */
export async function checkCaseCollision(ctx: MutationCtx, organizationId: string, path: string) {
  const lower = path.toLowerCase();
  const rows = await ctx.db
    .query('files')
    .withIndex('by_org_path', (q) => q.eq('organizationId', organizationId))
    .collect();
  const clash = rows.find((row) => row.path !== path && !row.deleted && row.path.toLowerCase() === lower);
  if (clash) throw new ConvexError(`A file named ${clash.path} already exists, differing only in case`);
}

/**
 * Every row of the organization's workspace without its text, tombstones
 * included, ordered by path. The subscription target: a change costs every
 * subscriber one small list, and only the rows whose version moved are
 * fetched with `get`.
 */
export const list = query({
  args: { organizationId: v.string() },
  handler: async (ctx, { organizationId }): Promise<RemoteFileMeta[]> => {
    await requireMember(ctx, organizationId);
    const rows = await ctx.db
      .query('files')
      .withIndex('by_org_path', (q) => q.eq('organizationId', organizationId))
      .collect();
    return rows.map(toRemoteFileMeta);
  },
});

/** One row with its text, or null when the path has never existed. */
export const get = query({
  args: { organizationId: v.string(), path: v.string() },
  handler: async (ctx, { organizationId, path }): Promise<RemoteFile | null> => {
    await requireMember(ctx, organizationId);
    const row = await ctx.db
      .query('files')
      .withIndex('by_org_path', (q) => q.eq('organizationId', organizationId).eq('path', path))
      .unique();
    return row ? toRemoteFile(row) : null;
  },
});

export const MAX_GET_MANY_FILES = 64;
export const MAX_GET_MANY_BYTES = 8 * 1024 * 1024;

/**
 * Rows with their text, by path, for a checkout that needs many at once.
 * Rows come back in the order asked, missing paths left out. Stops after
 * `MAX_GET_MANY_BYTES` of text, so a caller with more asks again from the
 * first path it did not get.
 */
export const getMany = query({
  args: { organizationId: v.string(), paths: v.array(v.string()) },
  handler: async (ctx, { organizationId, paths }): Promise<RemoteFile[]> => {
    await requireMember(ctx, organizationId);
    if (paths.length > MAX_GET_MANY_FILES) throw new ConvexError(`At most ${MAX_GET_MANY_FILES} paths per call`);
    const files: RemoteFile[] = [];
    let bytes = 0;
    for (const path of paths) {
      const row = await ctx.db
        .query('files')
        .withIndex('by_org_path', (q) => q.eq('organizationId', organizationId).eq('path', path))
        .unique();
      if (!row) continue;
      bytes += encoder.encode(row.text).length;
      if (files.length > 0 && bytes > MAX_GET_MANY_BYTES) break;
      files.push(toRemoteFile(row));
    }
    return files;
  },
});

export const write = mutation({
  args: {
    organizationId: v.string(),
    path: v.string(),
    text: v.string(),
    hash: v.string(),
    expectedVersion: v.union(v.number(), v.null()),
  },
  handler: async (ctx, { organizationId, path, text, hash, expectedVersion }): Promise<WriteResult> => {
    const { user } = await requireMember(ctx, organizationId);
    validatePath(path);
    validateText(text);
    await validateHash(text, hash);
    const row = await currentRow(ctx, organizationId, path);
    const conflict = checkVersion(row, expectedVersion);
    if (conflict) return conflict;
    if (!row || row.deleted) await checkCaseCollision(ctx, organizationId, path);
    const version = await upsert(ctx, organizationId, row, { path, text, hash, deleted: false }, user._id);
    return { status: 'ok', version };
  },
});

/** Tombstones the file: deleted true, empty text, version bumped. */
export const remove = mutation({
  args: {
    organizationId: v.string(),
    path: v.string(),
    expectedVersion: v.union(v.number(), v.null()),
  },
  handler: async (ctx, { organizationId, path, expectedVersion }): Promise<WriteResult> => {
    const { user } = await requireMember(ctx, organizationId);
    validatePath(path);
    const row = await currentRow(ctx, organizationId, path);
    const conflict = checkVersion(row, expectedVersion);
    if (conflict) return conflict;
    if (!row) return { status: 'conflict', current: null };
    if (row.deleted) return { status: 'ok', version: row.version };
    const version = await upsert(
      ctx,
      organizationId,
      row,
      { path, text: '', hash: EMPTY_SHA256, deleted: true },
      user._id,
    );
    return { status: 'ok', version };
  },
});

/** Force-upserts every file (no version check), bumping versions. Chunked by the caller. */
export const writeMany = mutation({
  args: {
    organizationId: v.string(),
    files: v.array(v.object({ path: v.string(), text: v.string(), hash: v.string() })),
  },
  handler: async (ctx, { organizationId, files }): Promise<void> => {
    const { user } = await requireMember(ctx, organizationId);
    if (files.length === 0) return;
    if (files.length > MAX_WRITE_MANY_FILES)
      throw new ConvexError('At most 64 files per writeMany call');
    let total = 0;
    const seen = new Set<string>();
    for (const file of files) {
      validatePath(file.path);
      if (seen.has(file.path)) throw new ConvexError('Duplicate path in writeMany');
      seen.add(file.path);
      total += validateText(file.text);
      await validateHash(file.text, file.hash);
    }
    if (total > MAX_WRITE_MANY_BYTES) throw new ConvexError('At most 8 MiB per writeMany call');
    for (const file of files) {
      const row = await currentRow(ctx, organizationId, file.path);
      if (!row || row.deleted) await checkCaseCollision(ctx, organizationId, file.path);
      await upsert(ctx, organizationId, row, { ...file, deleted: false }, user._id);
    }
  },
});
