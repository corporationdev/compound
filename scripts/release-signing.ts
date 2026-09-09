import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('Release signing requires macOS');
const temporary = process.env.RUNNER_TEMP;
const githubEnv = process.env.GITHUB_ENV;
if (!temporary || !githubEnv) throw new Error('Run release-signing in the macOS release job');
for (const key of ['MACOS_CERT_P12', 'MACOS_CERT_PASSWORD', 'APPLE_API_KEY_BASE64', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_TEAM_ID'])
  if (!process.env[key]) throw new Error(`Missing ${key} from compound-prod / Apple`);

process.umask(0o077);
const directory = join(temporary, 'compound-signing');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const certificate = join(directory, 'certificate.p12');
const apiKey = join(directory, 'AuthKey.p8');
const keychain = join(directory, 'build.keychain-db');
writeFileSync(certificate, Buffer.from(process.env.MACOS_CERT_P12!, 'base64'), { mode: 0o600 });
writeFileSync(apiKey, Buffer.from(process.env.APPLE_API_KEY_BASE64!, 'base64'), { mode: 0o600 });
chmodSync(apiKey, 0o600);
const password = randomBytes(32).toString('base64url');
// Pass secrets to security directly, never through shell expansion or logged commands.
function security(args: string[]) {
  try { return execFileSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new Error(`macOS keychain operation failed: ${args[0]}`); }
}
const original = security(['list-keychains', '-d', 'user']).split('\n').map(line => line.trim().replace(/^"|"$/g, '')).filter(Boolean);
writeFileSync(join(directory, 'original-keychains.json'), JSON.stringify(original), { mode: 0o600 });
security(['create-keychain', '-p', password, keychain]);
security(['set-keychain-settings', '-lut', '21600', keychain]);
security(['unlock-keychain', '-p', password, keychain]);
security(['import', certificate, '-k', keychain, '-P', process.env.MACOS_CERT_PASSWORD!, '-T', '/usr/bin/codesign']);
security(['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', password, keychain]);
security(['list-keychains', '-d', 'user', '-s', keychain, ...original]);
const identities = security(['find-identity', '-v', '-p', 'codesigning', keychain]);
const identity = identities.match(/"(Developer ID Application: [^"]+)"/)?.[1];
if (!identity?.endsWith(`(${process.env.APPLE_TEAM_ID})`)) throw new Error('Signing certificate does not match the Apple team');
execFileSync('xcrun', ['notarytool', 'history', '--key', apiKey, '--key-id', process.env.APPLE_API_KEY_ID!,
  '--issuer', process.env.APPLE_API_ISSUER!, '--output-format', 'json'], { stdio: ['ignore', 'ignore', 'pipe'] });
appendFileSync(githubEnv, `APPLE_API_KEY=${apiKey}\nAPPLE_SIGNING_IDENTITY=${identity}\nCOMPOUND_RELEASE=1\n`);
console.log('Prepared and validated Apple signing and notarization credentials.');
