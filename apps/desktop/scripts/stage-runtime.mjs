/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Stages the main process's external dependencies into apps/desktop/runtime
// so electron-forge can ship them as an app resource (Contents/Resources/
// runtime). A packaged app has no node_modules of its own: everything else
// is bundled into dist/main.js, but esbuild (native binary) and the babel
// toolchain stay external and are loaded from here at run time (see `load`
// in src/projects.ts). The staged layout:
//   runtime/package.json   the externals, pinned to the workspace's versions
//   runtime/node_modules   a fresh `npm install --omit=dev` of them
//
// The list of externals is read from the build:main script so that it cannot
// drift from what the bundle actually leaves unresolved.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const stageDir = join(desktopDir, "runtime");
const require = createRequire(join(desktopDir, "package.json"));

const pkg = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
const externals = [...pkg.scripts["build:main"].matchAll(/--external:(\S+)/g)]
  .map((match) => match[1])
  // Electron is provided by the host binary, not installed.
  .filter((name) => name !== "electron");

// Pin what the workspace has installed (and was tested against), not the
// ranges in package.json.
const dependencies = Object.fromEntries(
  externals.map((name) => [name, require(`${name}/package.json`).version]),
);

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

writeFileSync(
  join(stageDir, "package.json"),
  JSON.stringify({ name: "desktop-runtime", private: true, dependencies }, null, 2),
);

execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock"], {
  cwd: stageDir,
  stdio: "inherit",
});

// Ship one esbuild executable that runs on both Mac architectures: npm only
// installs the host's, and the app is packaged universal from one machine.
// Keeping every copy universal also lets Electron merge the two app bundles
// without exceptions beyond the resource folders listed in forge.config.ts.
if (process.platform === "darwin") {
  const esbuildVersion = JSON.parse(readFileSync(join(stageDir, "node_modules/esbuild/package.json"), "utf8")).version;
  execFileSync("npm", ["install", "--force", "--ignore-scripts", "--no-save", "--no-audit", "--no-fund", "--no-package-lock",
    `@esbuild/darwin-arm64@${esbuildVersion}`, `@esbuild/darwin-x64@${esbuildVersion}`], {
    cwd: stageDir, stdio: "inherit",
  });
  const arches = ["darwin-arm64", "darwin-x64"].map((arch) => join(stageDir, "node_modules/@esbuild", arch, "bin/esbuild"));
  const universal = join(stageDir, "esbuild-universal");
  execFileSync("lipo", ["-create", ...arches, "-output", universal]);
  for (const binary of [...arches, join(stageDir, "node_modules/esbuild/bin/esbuild")]) cpSync(universal, binary);
  rmSync(universal);
}

// Mach-O files inside Resources are not reached by the app-bundle signing
// pass, and notarization rejects unsigned executables; sign them here.
// esbuild's postinstall hard-links the native binary over its bin/esbuild
// shim, so the same executable can sit in two places.
const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe]);
function isMachO(path) {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(4);
    return readSync(fd, header, 0, 4, 0) === 4 && MACHO_MAGIC.has(header.readUInt32BE(0));
  } finally {
    closeSync(fd);
  }
}

const esbuildDir = join(stageDir, "node_modules", "@esbuild");
const binaries = [
  join(stageDir, "node_modules", "esbuild", "bin", "esbuild"),
  ...(existsSync(esbuildDir) ? readdirSync(esbuildDir).map((name) => join(esbuildDir, name, "bin", "esbuild")) : []),
].filter((path) => existsSync(path) && isMachO(path));

if (process.platform === "darwin" && !process.env.SKIP_SIGN) {
  const identities = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  const identity = process.env.APPLE_SIGNING_IDENTITY ?? identities.match(/"(Developer ID Application: [^"]+)"/)?.[1];
  if (identity) {
    for (const bin of binaries) {
      execFileSync("codesign", ["--force", "--options", "runtime", "--timestamp", "--sign", identity, bin], {
        stdio: "inherit",
      });
    }
  } else {
    if (process.env.COMPOUND_RELEASE === "1") throw new Error("No Developer ID signing identity found");
    console.warn("stage-runtime: no Developer ID identity found, leaving esbuild binaries unsigned");
  }
}

console.log(`stage-runtime: staged ${externals.join(", ")} at ${stageDir}`);
