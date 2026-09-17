/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import { PublisherGithub } from '@electron-forge/publisher-github';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { version } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
// A pull request build carries its own name and bundle id (scripts/pr-brand.ts)
// so it installs beside the real app; a production build is plain "Compound".
const runtimeConfig = (() => { try { return JSON.parse(readFileSync(join(__dirname, 'runtime-config.json'), 'utf8')); } catch { return {}; } })();
const appName: string = runtimeConfig.appName ?? 'Compound';
const appBundleId: string = runtimeConfig.appId ?? 'dev.corporation.compound';
const fileSlug = appName.replace(/\s+/g, '-');
const productionRelease = process.env.COMPOUND_RELEASE === '1';
if (productionRelease) {
  if (process.env.SKIP_SIGN) throw new Error('Production releases must be signed');
  for (const key of ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_SIGNING_IDENTITY'])
    if (!process.env[key]) throw new Error(`Missing release credential: ${key}`);
}

const config: ForgeConfig = {
  packagerConfig: {
    name: appName,
    // The binary keeps its name whatever the app is called, so tooling finds it.
    executableName: 'Compound',
    appBundleId,
    appCategoryType: 'public.app-category.video',
    appVersion: version,
    icon: './assets/icon',
    prune: false,
    ignore: (path) =>
      path !== '' &&
      path !== '/package.json' &&
      path !== '/runtime-config.json' &&
      path !== '/dist' &&
      !path.startsWith('/dist/') &&
      path !== '/web' &&
      !path.startsWith('/web/'),
    // Staged by scripts/stage-{cli,runtime,docs,chat}.mjs; end up at
    // Contents/Resources/{cli,runtime,docs,chat-runtime}.
    extraResource: ['./cli', './runtime', './docs', './chat-runtime'],
    // Native dependencies in these folders select their CPU variant at run
    // time (or are already universal), so the same files sit in both builds.
    osxUniversal: { x64ArchFiles: 'Contents/Resources/{chat-runtime,runtime}/**' },
    osxSign: process.env.SKIP_SIGN ? undefined : {
      ...(process.env.APPLE_SIGNING_IDENTITY ? { identity: process.env.APPLE_SIGNING_IDENTITY } : {}),
    },
    osxNotarize:
      !process.env.SKIP_SIGN && process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER
        ? {
            appleApiKey: process.env.APPLE_API_KEY,
            appleApiKeyId: process.env.APPLE_API_KEY_ID,
            appleApiIssuer: process.env.APPLE_API_ISSUER,
          }
        : undefined,
  },
  makers: [
    // Linux zips are pull-request builds for the ThinkPad; macOS zips ship beside the DMG.
    new MakerZIP({}, ['darwin', 'linux']),
    new MakerDMG((arch) => ({
      // hdiutil caps a volume name at 27 characters, so a PR build drops the "mac".
      name: appName === 'Compound' ? `Compound-mac-${arch}` : `${fileSlug}-${arch}`,
      icon: './assets/icon.icns',
      // Dark, on-brand window; @2x sibling is picked up automatically for retina.
      background: './assets/dmg-background.png',
      iconSize: 120,
      additionalDMGOptions: {
        'background-color': '#f7f7f5',
        window: { size: { width: 658, height: 498 } },
      },
      contents: (opts) => [
        { x: 188, y: 217, type: 'file', path: opts.appPath },
        { x: 470, y: 217, type: 'link', path: '/Applications' },
      ],
    })),
  ],
  publishers: [
    new PublisherGithub({
      repository: { owner: 'corporationdev', name: 'compound' },
      draft: true,
    }),
  ],
};

export default config;
