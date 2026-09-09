import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
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

export function resolveStage(mode: StageMode): string {
  if (mode === 'sandbox') {
    return 'sandbox';
  }

  const userSlug = getUserSlug();
  const suffix = shortHash(`${userSlug}:${hostname()}`);

  return trimStage(`dev-${userSlug}-${suffix}`);
}

export function getStageKind(stage: string): StageKind {
  return getStageKindFromStageKind(stage);
}

export function deriveEnvTier(stage: string): EnvTier {
  return deriveEnvTierFromStageKind(stage);
}
