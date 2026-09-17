import { createHash } from 'node:crypto';
import { getStageKind } from './stage-kind';

/** Local listeners a running stage owns on this machine. */
export type StagePorts = {
  /** Vite dev server; Electron loads it in development. */
  web: number;
  /** Local Worker started by Alchemy; the stage's tunnel forwards here. */
  server: number;
  /** Local Convex backend (sandbox stages only). */
  convexCloud: number;
  /** Local Convex HTTP actions and auth routes (sandbox stages only). */
  convexSite: number;
  /** Chromium remote debugging port for driving the desktop app. */
  inspector: number;
};

const machinePorts: StagePorts = { web: 5173, server: 3000, convexCloud: 3210, convexSite: 3211, inspector: 9333 };

/**
 * A machine's own dev stage keeps the ports every script and doc already
 * names. A sandbox stage (a linked worktree) gets a block above the
 * ephemeral-free range, derived from its name so every process that knows
 * the stage agrees without a registry. Blocks are ten apart, so a stage's
 * ports never overlap another's.
 */
export function stagePorts(stage: string): StagePorts {
  if (getStageKind(stage) !== 'sandbox') return { ...machinePorts };
  const digest = createHash('sha256').update(`ports:${stage}`).digest();
  const base = 20000 + (digest.readUInt32BE(0) % 2000) * 10;
  return { web: base, server: base + 1, convexCloud: base + 2, convexSite: base + 3, inspector: base + 4 };
}
