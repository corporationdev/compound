import { S3Client } from 'bun';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { release, releaseVersion } from '@compound/config/release';
import { root, requireKeys } from './environment';

const required = ['CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
requireKeys(Object.fromEntries(required.map(key => [key, process.env[key] ?? ''])), required);
const directory = join(root, '.generated/release');
const manifest = await Bun.file(join(directory, 'manifest.json')).json();
const version = releaseVersion(manifest.version);
if (version !== releaseVersion((await Bun.file(join(root, 'package.json')).json()).version))
  throw new Error('Release artifacts do not match the checkout version');
const client = new S3Client({
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  bucket: release.bucket,
});
const latest = client.file('latest.json');
if (await latest.exists()) {
  const current = releaseVersion((await latest.json()).version);
  if (Bun.semver.order(version, current) < 0) throw new Error(`Cannot replace latest ${current} with older release ${version}`);
}
for (const name of [release.dmg, release.zip]) {
  const file = Bun.file(join(directory, name));
  const expected = manifest.files.find((entry: { name: string }) => entry.name === name)?.sha256;
  const sha256 = createHash('sha256').update(await file.bytes()).digest('hex');
  if (!expected || expected !== sha256) throw new Error(`Checksum mismatch for ${name}`);
  const destination = client.file(`releases/v${version}/${name}`);
  if (await destination.exists()) {
    const existing = createHash('sha256');
    for await (const chunk of destination.stream()) existing.update(chunk);
    if (existing.digest('hex') !== sha256) throw new Error(`Release ${version} already has different ${name}; use a new version`);
  } else {
    await destination.write(file, { type: name.endsWith('.dmg') ? 'application/x-apple-diskimage' : 'application/zip' });
  }
  if ((await destination.stat()).size !== file.size) throw new Error(`Upload size mismatch for ${name}`);
  console.log(`Uploaded ${name} for ${version}`);
}
// The public button advances only after both complete, verified uploads exist.
await latest.write(JSON.stringify({ version }), { type: 'application/json' });
console.log(`Published ${version}: ${release.downloadUrl}`);
