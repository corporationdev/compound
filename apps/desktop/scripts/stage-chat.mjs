import { chmod, cp, mkdir, readFile, readdir, rename, rm, writeFile, open } from 'node:fs/promises';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createPackage } from '@electron/asar';
import { rebuild } from '@electron/rebuild';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

// Install the locked T3 server at build time. Electron supplies Node at runtime.
const desktop = fileURLToPath(new URL('..', import.meta.url));
const source = join(desktop, 'scripts/chat-runtime');
const staging = join(desktop, '.generated/chat-runtime');
const destination = join(desktop, 'chat-runtime');
const lock = await readFile(join(source, 'package-lock.json'), 'utf8');
// Native artifacts are kept for the host platform only (every CPU of it, so
// Forge's universal macOS build finds both darwin variants). Other platforms'
// variants arrive via npm's optional dependencies and the explicit darwin
// pins; they are pruned below.
const platform = process.platform;
const foreign = new RegExp(`-(${['darwin', 'linux', 'win32', 'android', 'freebsd'].filter((p) => p !== platform).join('|')})-`);
const stamp = createHash('sha256').update(lock).update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
if (await readFile(join(destination, '.staged'), 'utf8').catch(() => '') !== stamp) {
  console.time('Stage chat runtime');
  await rm(staging, { recursive: true, force: true });
  await rm(destination, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await mkdir(destination, { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) await cp(join(source, file), join(staging, file));
  // Both CPU variants must be present in the same resource tree for Forge's
  // universal build. They are explicit locked dependencies; no host ABI rebuild.
  const result = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--force', '--no-audit', '--no-fund'], { cwd: staging, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Could not stage the T3 chat runtime');
  const modules = join(staging, 'node_modules');
  // Compound supplies its own UI. Keep the server and its source maps/licenses.
  await rm(join(modules, 't3/dist/client'), { recursive: true, force: true });
  // T3 passes the user's installed Claude path to its SDK, just as its desktop
  // build does. The SDK's optional bundled executables are unused (~200 MB each).
  for (const name of await readdir(join(modules, '@anthropic-ai'))) {
    if (name.startsWith('claude-agent-sdk-')) await rm(join(modules, '@anthropic-ai', name), { recursive: true, force: true });
  }
  await rm(join(modules, '.bin'), { recursive: true, force: true });
  // node-pty ships prebuilds for macOS and Windows only. Elsewhere, compile it
  // against Electron (needs Python and a C++ toolchain) and file the result
  // where node-pty's loader looks, keeping one layout across platforms.
  const prebuild = join(modules, 'node-pty/prebuilds', `${platform}-${process.arch}`);
  if (!(await readdir(prebuild).catch(() => [])).length) {
    console.log(`Building node-pty for ${platform}-${process.arch}`);
    const { version: electronVersion } = JSON.parse(await readFile(createRequire(import.meta.url).resolve('electron/package.json'), 'utf8'));
    await rebuild({ buildPath: staging, electronVersion, onlyModules: ['node-pty'], force: true });
    await mkdir(prebuild, { recursive: true });
    await cp(join(modules, 'node-pty/build/Release/pty.node'), join(prebuild, 'pty.node'));
    await rm(join(modules, 'node-pty/build'), { recursive: true, force: true });
  }
  for (const target of await readdir(join(modules, 'node-pty/prebuilds'))) {
    if (!target.startsWith(`${platform}-`)) await rm(join(modules, 'node-pty/prebuilds', target), { recursive: true, force: true });
    // npm ships this without execute permission; set it before signing the app.
    else await chmod(join(modules, 'node-pty/prebuilds', target, 'spawn-helper'), 0o755).catch(() => {});
  }
  for (const scope of ['@ff-labs', '@yuuang', '@msgpackr-extract']) {
    for (const name of await readdir(join(modules, scope))) {
      if (foreign.test(name)) await rm(join(modules, scope, name), { recursive: true, force: true });
    }
  }
  // Native loaders need real filesystem paths. Keep them and their dependencies
  // beside the archive; module resolution from app.asar finds this node_modules.
  await mkdir(join(destination, 'node_modules'));
  for (const name of ['node-pty', 'node-addon-api', '@ff-labs', 'ffi-rs', '@yuuang',
    'msgpackr-extract', '@msgpackr-extract', 'node-gyp-build-optional-packages', 'detect-libc']) {
    await rename(join(modules, name), join(destination, 'node_modules', name));
  }
  await rename(join(modules, 't3/dist/resource-monitor'), join(destination, 'resource-monitor'));
  for (const target of await readdir(join(destination, 'resource-monitor'))) {
    if (!target.startsWith(`${platform}-`)) await rm(join(destination, 'resource-monitor', target), { recursive: true, force: true });
    else await chmod(join(destination, 'resource-monitor', target, 't3-resource-monitor'), 0o755).catch(() => {});
  }
  await createPackage(staging, join(destination, 'app.asar'));
  await rm(staging, { recursive: true, force: true });
  await writeFile(join(destination, '.staged'), stamp);
  console.timeEnd('Stage chat runtime');
}

// Native binaries under Resources are outside Electron's normal signing pass.
// Sign every Mach-O in the server's native dependencies.
if (platform === 'darwin' && !process.env.SKIP_SIGN) {
  const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const identity = process.env.APPLE_SIGNING_IDENTITY ?? identities.match(/"(Developer ID Application: [^"]+)"/)?.[1];
  if (!identity && process.env.COMPOUND_RELEASE === '1') throw new Error('No Developer ID signing identity found');
  if (identity) {
    const entitlements = join(source, 'entitlements.plist');
    const magic = new Set(['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca']);
    for (const entry of await readdir(destination, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name === 'app.asar') continue;
      const path = join(entry.parentPath, entry.name);
      const handle = await open(path, 'r');
      const buffer = Buffer.alloc(4);
      try { await handle.read(buffer, 0, 4, 0); } finally { await handle.close(); }
      if (!magic.has(buffer.toString('hex'))) continue;
      execFileSync('codesign', ['--force', '--options', 'runtime', '--timestamp', '--entitlements', entitlements, '--sign', identity, path], { stdio: 'inherit' });
    }
  }
}
