import { cp, mkdir, readFile, readdir, rm, writeFile, open } from 'node:fs/promises';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// An isolated, locked Node runtime avoids Electron's native-module ABI and
// never installs or updates code during application startup.
const desktop = fileURLToPath(new URL('..', import.meta.url));
const source = join(desktop, 'scripts/chat-runtime');
const destination = join(desktop, 'chat-runtime');
const lock = await readFile(join(source, 'package-lock.json'), 'utf8');
if (process.platform !== 'darwin') throw new Error('The packaged chat runtime currently targets macOS.');
const stamp = `darwin-universal-v3\n${lock}`;
if (await readFile(join(destination, '.staged'), 'utf8').catch(() => '') !== stamp) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) await cp(join(source, file), join(destination, file));
  // Both CPU variants must be present in the same resource tree for Forge's
  // universal build. They are explicit locked dependencies; no host ABI rebuild.
  const result = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--force', '--no-audit', '--no-fund'], { cwd: destination, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Could not stage the T3 chat runtime');
  // Compound supplies its own UI. Keep the server and its source maps/licenses.
  await rm(join(destination, 'node_modules/t3/dist/client'), { recursive: true, force: true });
  // No module compilation occurs in the app: Node's C/C++ headers aren't used.
  for (const node of ['node-bin-darwin-arm64', 'node-darwin-x64']) {
    await rm(join(destination, 'node_modules', node, 'include'), { recursive: true, force: true });
  }
  for (const platform of await readdir(join(destination, 'node_modules/node-pty/prebuilds'))) {
    if (!platform.startsWith('darwin-')) await rm(join(destination, 'node_modules/node-pty/prebuilds', platform), { recursive: true, force: true });
  }
  await writeFile(join(destination, '.staged'), stamp);
}

// Native binaries under Resources are outside Electron's normal signing pass.
// Sign every Mach-O, including the two Node runtimes and provider dependencies.
if (!process.env.SKIP_SIGN) {
  const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const identity = process.env.APPLE_SIGNING_IDENTITY ?? identities.match(/"(Developer ID Application: [^"]+)"/)?.[1];
  if (!identity && process.env.COMPOUND_RELEASE === '1') throw new Error('No Developer ID signing identity found');
  if (identity) {
    const entitlements = join(source, 'entitlements.plist');
    const magic = new Set(['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca']);
    for (const entry of await readdir(destination, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      const handle = await open(path, 'r');
      const buffer = Buffer.alloc(4);
      try { await handle.read(buffer, 0, 4, 0); } finally { await handle.close(); }
      if (!magic.has(buffer.toString('hex'))) continue;
      execFileSync('codesign', ['--force', '--options', 'runtime', '--timestamp', '--entitlements', entitlements, '--sign', identity, path], { stdio: 'inherit' });
    }
  }
}
