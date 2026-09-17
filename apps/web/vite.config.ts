/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defineConfig, loadEnv } from 'vite'
import solid from 'vite-plugin-solid'
import solidSvg from 'vite-plugin-solid-svg'
import tailwindcss from '@tailwindcss/vite'
import typegpu from 'unplugin-typegpu/vite'
import { resolve } from 'path'
import pkg from '../../package.json'

export default defineConfig(({ mode }) => {
  // The desktop app bundles this build; missing client env would silently ship with auth disabled.
  if (mode === 'desktop') {
    const env = loadEnv(mode, __dirname, '')
    for (const key of ['VITE_CONVEX_URL', 'VITE_CONVEX_SITE_URL', 'VITE_SERVER_URL']) {
      if (!env[key]) {
        throw new Error(`${key} is not set. Run bun run setup before building the desktop app.`)
      }
    }
  }

  // Written by runtime:write; absent for a bare checkout, which keeps the historical ports.
  const ports = loadEnv(mode, __dirname, 'COMPOUND_')
  const webPort = Number(ports.COMPOUND_WEB_PORT) || 5173
  const serverPort = Number(ports.COMPOUND_SERVER_PORT) || 3000

  return {
    plugins: [
      solid(),
      tailwindcss(),
      solidSvg({ defaultAsComponent: true }),
      typegpu(),
    ],
    define: {
      APP_VERSION: JSON.stringify(pkg.version),
    },
    server: {
      port: webPort,
      strictPort: true,
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      },
      proxy: {
        '/api': {
          target: `http://localhost:${serverPort}`,
          changeOrigin: true,
        },
      },
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "./src"),
        "@desktop": resolve(__dirname, "../desktop/src"),
      }
    }
  }
})
