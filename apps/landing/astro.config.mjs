import { defineConfig } from 'astro/config';
import { deployment } from '@compound/config/deployment';

export default defineConfig({
  site: `https://${deployment.rootDomain}`,
  server: { host: '127.0.0.1', port: 3002 },
  vite: { server: { strictPort: true } },
});
