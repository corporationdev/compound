import { getProject, getProjectsRoot, listKnownProjects } from '@/projects';
import { mainBridge } from "@/lib/ipc";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { editorSession } from './session';
import type { EditorSession } from './session';
import type { CliProjectTarget } from '@compound/cli/channels';
import type { ProjectInfo } from '@desktop/main-channels';

export async function resolveTarget(target?: CliProjectTarget): Promise<ProjectInfo> {
  if (target?.dir) {
    const project = await getProject(target.dir);
    if (!project?.id) throw new Error(`No Compound project at ${target.dir}. Run compound open explicitly to create or open one.`);
    return project;
  }
  if (target?.ref) {
    const matches = (await listKnownProjects()).filter(p => p.id === target.ref);
    if (matches.length > 1) throw new Error(`Project ID ${target.ref} is ambiguous. Pass --project with an absolute directory.`);
    if (matches[0]) return matches[0];
    throw new Error(`Unknown project ID: ${target.ref}. Run compound projects list or pass an absolute directory.`);
  }
  throw new Error('No project resolved. Run this command inside a Compound project, or pass --project <id-or-path>.');
}

export async function attachedSession(project: ProjectInfo): Promise<EditorSession | null> {
  const session = editorSession();
  if (!session) return null;
  const [open, target] = await Promise.all([session.project.dir(), project.dir].map(dir => mainBridge.call(MAIN_CHANNELS.PROJECTS_FS_REAL_PATH, { dir, source: '.' })));
  return open && open === target && session === editorSession() ? session : null;
}

export async function targetContext(target?: CliProjectTarget) {
  const project = await resolveTarget(target);
  const session = await attachedSession(project);
  return { project, session, base: { rootDir: await getProjectsRoot(), projectId: project.id, projectName: project.displayName, projectDir: project.dir, editorAttached: !!session } };
}

// Navigation waits while a renderer command uses the current world. Multiple
// callers hold independent leases; no request changes another request's target.
const jobs = new Set<Promise<unknown>>();
export const hasRendererJobs = () => jobs.size > 0;
export const waitForRendererJobs = async () => { while (jobs.size) await Promise.allSettled([...jobs]); };
export async function withProjectJob<T>(run: () => Promise<T>): Promise<T> {
  const work = Promise.resolve().then(run);
  jobs.add(work);
  try { return await work; } finally { jobs.delete(work); }
}
export async function withTargetRenderer<T>(target: CliProjectTarget | undefined, run: (session: EditorSession) => Promise<T>): Promise<T> {
  const project = await resolveTarget(target);
  const session = await attachedSession(project);
  if (!session) throw new Error(`Project "${project.displayName}" is not open in the editor. Open it to capture, check, or export. Background rendering is not available.`);
  // Register the lease synchronously before any handler can yield.
  const work = Promise.resolve().then(() => run(session));
  jobs.add(work);
  try { return await work; } finally { jobs.delete(work); }
}
