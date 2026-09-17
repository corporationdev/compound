import { homedir } from 'node:os';
import { join } from 'node:path';
import { stagePorts } from '@compound/config/ports';
import { getStageKind } from '@compound/config/stage';
import { resolveRuntimeContext } from '@compound/config/runtime';
import { stageFrom } from './environment';

/** Electron's appData directory on this platform, where profiles live (mirrors dev-desktop.mjs). */
export function appDataDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
}

/** Everything a script or agent needs to find this checkout's running stage. */
export function sandboxInfo(stage: string) {
  const kind = getStageKind(stage);
  const ports = stagePorts(stage);
  const runtime = resolveRuntimeContext(stage, kind === 'sandbox' ? {} : { convexUrl: process.env.CONVEX_URL });
  const sandbox = kind === 'sandbox';
  return {
    stage,
    kind,
    ports,
    webUrl: runtime.webUrl,
    convexUrl: runtime.convexUrl,
    authUrl: runtime.convexSiteUrl,
    serverUrl: runtime.serverUrl,
    // The desktop's Chromium remote debugging endpoint; agent-browser attaches with --cdp <inspector port>.
    cdpUrl: `http://127.0.0.1:${ports.inspector}`,
    // Only a sandbox runs with its own profile; the machine dev stage uses the default one.
    electronProfile: sandbox ? join(appDataDir(), `Compound-${stage}`) : null,
    projectsFolderName: runtime.desktopConfig.projectsFolderName,
    signInCode: ['dev', 'sandbox', 'test'].includes(kind) ? '000000' : null,
  };
}
if (import.meta.main) {
  const stage = stageFrom(process.argv.slice(2));
  let info: ReturnType<typeof sandboxInfo>;
  try {
    info = sandboxInfo(stage);
  } catch {
    // A dev stage's Convex URL comes from setup; without it, report what is stage-derived.
    const ports = stagePorts(stage);
    info = { stage, kind: getStageKind(stage), ports, cdpUrl: `http://127.0.0.1:${ports.inspector}` } as ReturnType<typeof sandboxInfo>;
  }
  console.log(JSON.stringify(info, null, 2));
}
