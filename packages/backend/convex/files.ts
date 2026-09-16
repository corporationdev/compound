import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, query, type MutationCtx } from './_generated/server';
import { requireProjectMember } from './lib/membership';

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

/** A row without its text: what `list` delivers, so a subscription costs bytes per change, not per project. */
export type RemoteFileMeta = Omit<RemoteFile, 'text'>;

/** How long a burst of writes shares one `projects.updatedAt` stamp, so unrelated files do not contend on the project row. */
const UPDATED_AT_GRANULARITY_MS = 30_000;

export function toRemoteFileMeta(row: Doc<'projectFiles'>): RemoteFileMeta {
  return {
    path: row.path,
    hash: row.hash,
    version: row.version,
    deleted: row.deleted,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

export function toRemoteFile(row: Doc<'projectFiles'>): RemoteFile {
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
  if (path.startsWith('/')) throw new ConvexError('Path must be project-relative');
  if (path.includes('\\')) throw new ConvexError('Path must use forward slashes');
  if (path.includes('\0')) throw new ConvexError('Path must not contain NUL bytes');
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    throw new ConvexError('Path must not contain empty, "." or ".." segments');
  return path;
}

function validateText(text: string) {
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
async function validateHash(text: string, hash: string) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new ConvexError('Hash must be 64 lowercase hex characters');
  const subtle = globalThis.crypto?.subtle;
  if (!subtle?.digest) return;
  const digest = new Uint8Array(await subtle.digest('SHA-256', encoder.encode(text)));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  if (hex !== hash) throw new ConvexError('Hash does not match text');
}

async function currentRow(ctx: MutationCtx, projectId: Id<'projects'>, path: string) {
  return await ctx.db
    .query('projectFiles')
    .withIndex('by_project_path', (q) => q.eq('projectId', projectId).eq('path', path))
    .unique();
}

/**
 * Version check shared by write and remove. `expectedVersion` null means
 * "create": allowed when the row is absent or a tombstone. Otherwise the row
 * must exist at exactly that version.
 */
function checkVersion(
  row: Doc<'projectFiles'> | null,
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

async function upsert(
  ctx: MutationCtx,
  projectId: Id<'projects'>,
  row: Doc<'projectFiles'> | null,
  fields: { path: string; text: string; hash: string; deleted: boolean },
  userId: string,
) {
  const now = Date.now();
  const version = (row?.version ?? 0) + 1;
  if (row) await ctx.db.patch(row._id, { ...fields, version, updatedAt: now, updatedBy: userId });
  else await ctx.db.insert('projectFiles', { projectId, ...fields, version, updatedAt: now, updatedBy: userId });
  const project = await ctx.db.get(projectId);
  if (project && now - project.updatedAt >= UPDATED_AT_GRANULARITY_MS) await ctx.db.patch(projectId, { updatedAt: now });
  return version;
}

/**
 * A path that would collide with an existing one on a case-insensitive disk
 * (macOS, Windows): two rows, one file, and two checkouts pushing each
 * other's text forever. Only creates are checked; an existing row is itself.
 */
async function checkCaseCollision(ctx: MutationCtx, projectId: Id<'projects'>, path: string) {
  const lower = path.toLowerCase();
  const rows = await ctx.db
    .query('projectFiles')
    .withIndex('by_project_path', (q) => q.eq('projectId', projectId))
    .collect();
  const clash = rows.find((row) => row.path !== path && !row.deleted && row.path.toLowerCase() === lower);
  if (clash) throw new ConvexError(`A file named ${clash.path} already exists, differing only in case`);
}

/**
 * Every row for the project without its text, tombstones included, ordered
 * by path. The subscription target: a change costs every subscriber one
 * small list, and only the rows whose version moved are fetched with `get`.
 */
export const list = query({
  args: { projectId: v.id('projects') },
  handler: async (ctx, { projectId }): Promise<RemoteFileMeta[]> => {
    await requireProjectMember(ctx, projectId);
    const rows = await ctx.db
      .query('projectFiles')
      .withIndex('by_project_path', (q) => q.eq('projectId', projectId))
      .collect();
    return rows.map(toRemoteFileMeta);
  },
});

/** One row with its text, or null when the path has never existed. */
export const get = query({
  args: { projectId: v.id('projects'), path: v.string() },
  handler: async (ctx, { projectId, path }): Promise<RemoteFile | null> => {
    await requireProjectMember(ctx, projectId);
    const row = await ctx.db
      .query('projectFiles')
      .withIndex('by_project_path', (q) => q.eq('projectId', projectId).eq('path', path))
      .unique();
    return row ? toRemoteFile(row) : null;
  },
});

export const write = mutation({
  args: {
    projectId: v.id('projects'),
    path: v.string(),
    text: v.string(),
    hash: v.string(),
    expectedVersion: v.union(v.number(), v.null()),
  },
  handler: async (ctx, { projectId, path, text, hash, expectedVersion }): Promise<WriteResult> => {
    const { user } = await requireProjectMember(ctx, projectId);
    validatePath(path);
    validateText(text);
    await validateHash(text, hash);
    const row = await currentRow(ctx, projectId, path);
    const conflict = checkVersion(row, expectedVersion);
    if (conflict) return conflict;
    if (!row || row.deleted) await checkCaseCollision(ctx, projectId, path);
    const version = await upsert(ctx, projectId, row, { path, text, hash, deleted: false }, user._id);
    return { status: 'ok', version };
  },
});

/** Tombstones the file: deleted true, empty text, version bumped. */
export const remove = mutation({
  args: {
    projectId: v.id('projects'),
    path: v.string(),
    expectedVersion: v.union(v.number(), v.null()),
  },
  handler: async (ctx, { projectId, path, expectedVersion }): Promise<WriteResult> => {
    const { user } = await requireProjectMember(ctx, projectId);
    validatePath(path);
    const row = await currentRow(ctx, projectId, path);
    const conflict = checkVersion(row, expectedVersion);
    if (conflict) return conflict;
    if (!row) return { status: 'conflict', current: null };
    if (row.deleted) return { status: 'ok', version: row.version };
    const version = await upsert(
      ctx,
      projectId,
      row,
      { path, text: '', hash: EMPTY_SHA256, deleted: true },
      user._id,
    );
    return { status: 'ok', version };
  },
});

/** Publish: force-upserts every file (no version check), bumping versions. Chunked by the caller. */
export const writeMany = mutation({
  args: {
    projectId: v.id('projects'),
    files: v.array(v.object({ path: v.string(), text: v.string(), hash: v.string() })),
  },
  handler: async (ctx, { projectId, files }): Promise<void> => {
    const { user } = await requireProjectMember(ctx, projectId);
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
      const row = await currentRow(ctx, projectId, file.path);
      if (!row || row.deleted) await checkCaseCollision(ctx, projectId, file.path);
      await upsert(ctx, projectId, row, { ...file, deleted: false }, user._id);
    }
  },
});
