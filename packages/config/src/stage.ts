import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, resolve } from 'node:path';
import type { EnvTier as DerivedEnvTier, StageKind as DerivedStageKind } from './stage-kind';
import {
  deriveEnvTier as deriveEnvTierFromStageKind,
  getStageKind as getStageKindFromStageKind,
} from './stage-kind';

export type StageMode = 'dev' | 'sandbox';
export type EnvTier = DerivedEnvTier;
export type StageKind = DerivedStageKind;

const leadingDashesRegex = /^-+/;
const maxStageLength = 48;
const maxWorktreeSlugLength = 24;
const multipleDashesRegex = /-+/g;
const slugNonAlphanumericRegex = /[^a-z0-9-]+/g;
const trailingDashesRegex = /-+$/;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(slugNonAlphanumericRegex, '-')
    .replace(multipleDashesRegex, '-')
    .replace(leadingDashesRegex, '')
    .replace(trailingDashesRegex, '');
}

function shortHash(input: string, length = 8): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

function trimStage(stage: string): string {
  return stage.slice(0, maxStageLength).replace(trailingDashesRegex, '');
}

function getUserSlug(): string {
  const user = process.env.USER ?? process.env.USERNAME ?? 'user';
  return slugify(user) || 'user';
}

/**
 * The top-level directory of a linked git worktree containing `cwd`, or null
 * for the main checkout and for directories outside any repository. A linked
 * worktree keeps its own `.git` file while sharing the main checkout's object
 * store, so its git dir and common dir differ.
 */
export function linkedWorktreeRoot(cwd: string = process.cwd()): string | null {
  let output: string;
  try {
    output = execFileSync('git', ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const [toplevel, gitDir, commonDir] = output.trim().split('\n');
  if (!toplevel || !gitDir || !commonDir) return null;
  return resolve(toplevel, gitDir) === resolve(toplevel, commonDir) ? null : toplevel;
}

/**
 * The stage this machine develops on. The main checkout owns the machine's
 * `dev-<user>-<hash>` stage, which shares the team's cloud Convex dev
 * deployment. A linked worktree owns a `sandbox-<worktree>-<hash>` stage of
 * its own, so several worktrees can run side by side with their own local
 * Convex backend, Worker, bucket, tunnel, ports and desktop profile.
 */
export function resolveStage(mode: StageMode, options: { cwd?: string } = {}): string {
  if (mode === 'sandbox') {
    return 'sandbox';
  }

  const userSlug = getUserSlug();
  const worktree = linkedWorktreeRoot(options.cwd);
  if (worktree) {
    const slug = slugify(basename(worktree)).slice(0, maxWorktreeSlugLength).replace(trailingDashesRegex, '') || 'worktree';
    const suffix = shortHash(`${userSlug}:${hostname()}:${worktree}`);
    return trimStage(`sandbox-${slug}-${suffix}`);
  }
  const suffix = shortHash(`${userSlug}:${hostname()}`);

  return trimStage(`dev-${userSlug}-${suffix}`);
}

export function getStageKind(stage: string): StageKind {
  return getStageKindFromStageKind(stage);
}

export function deriveEnvTier(stage: string): EnvTier {
  return deriveEnvTierFromStageKind(stage);
}
