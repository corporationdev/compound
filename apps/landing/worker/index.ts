import { release } from '@compound/config/release';

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // The stable download link: the newest stable release's DMG, resolved by GitHub.
    if (url.pathname === '/download') {
      if (!['GET', 'HEAD'].includes(request.method))
        return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
      return new Response(null, { status: 302, headers: { Location: release.downloadUrl, 'Cache-Control': 'no-store' } });
    }
    return env.ASSETS.fetch(request);
  },
};
