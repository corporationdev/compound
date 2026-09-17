import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@compound/backend/convex/_generated/api';
import { root, stageFrom } from './environment';
import { sandboxInfo } from './sandbox-info';

// Seeds a developer stage so an agent has something to open: signs in with
// the fixed code (creating the user and their personal organization), then
// writes one project into that organization's workspace through Convex, the
// source of truth. The desktop checks it out into the projects folder on its
// next sync. Idempotent: rerunning rewrites the same files.
//
//   bun run sandbox:seed                # while `bun dev` is running
//   bun run sandbox:seed --email me@example.com
const args = process.argv.slice(2);
const stage = stageFrom(args);
const info = sandboxInfo(stage);
if (!info.signInCode) throw new Error(`Stage ${stage} does not accept the fixed sign-in code; seed only developer stages`);
const emailIndex = args.indexOf('--email');
const email = emailIndex >= 0 ? args[emailIndex + 1] : 'agent@compound.mov';
if (!email || !email.includes('@')) throw new Error('Pass --email <address>');

// The same native transport the desktop uses (apps/desktop/src/cloud.ts).
async function auth(route: string, body?: Record<string, unknown>, session?: string) {
  const response = await fetch(`${info.authUrl}/api/auth/${route}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'compound://',
      ...(session ? { Authorization: `Bearer ${session}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  }).catch((error) => {
    throw new Error(`Cannot reach ${info.authUrl}: is \`bun dev\` running for ${stage}? (${error.message})`);
  });
  const result = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) throw new Error(`${route}: ${(result?.message as string) ?? response.status}`);
  return { result, session: response.headers.get('set-auth-token') };
}
await auth('email-otp/send-verification-otp', { email, type: 'sign-in' });
const { session } = await auth('sign-in/email-otp', { email, otp: info.signInCode });
if (!session) throw new Error('Sign-in did not issue a session');
const { result: token } = await auth('convex/token', undefined, session);
if (typeof token?.token !== 'string') throw new Error('No Convex token for the session');
const convex = new ConvexHttpClient(info.convexUrl);
convex.setAuth(token.token);

const organizations = await convex.query(api.organizations.listMine, {});
const organization = organizations[0];
if (!organization) throw new Error('The user has no organization; sign-in should have created one');

// One project, laid out the way the desktop scaffolds one: a package.json
// record, an entry composition, and an empty asset manifest. The composition
// is the basics example, whose sources are public URLs, so it plays without
// any asset in the stage's bucket.
const folder = 'projects/sample';
const projectName = 'Sample';
const composition = readFileSync(resolve(root, 'docs/examples/01-basics.tsx'), 'utf8');
const files: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'sample',
    projectId: 'seed-sample-project-0001',
    displayName: projectName,
    private: true,
    type: 'module',
    main: 'index.tsx',
    scripts: { open: 'compound open .', context: 'compound context', capture: 'compound capture' },
  }, null, 2) + '\n',
  'index.tsx': composition,
  'assets.yml': 'version: 1\nfolders: []\nassets: []\n',
  'README.md': `# ${projectName}\n\nSeeded by \`bun run sandbox:seed\` for stage ${stage}. The composition is the repository's basics example; its media are public URLs.\n`,
};
await convex.mutation(api.files.writeMany, {
  organizationId: organization.id,
  files: Object.entries(files).map(([name, text]) => ({
    path: `${folder}/${name}`,
    text,
    hash: createHash('sha256').update(text).digest('hex'),
  })),
});
console.log(JSON.stringify({
  stage,
  email,
  organization: { id: organization.id, name: organization.name, slug: organization.slug },
  project: { path: folder, displayName: projectName, files: Object.keys(files) },
  signInCode: info.signInCode,
}, null, 2));
