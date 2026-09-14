import { release, releaseVersion, updateFeed } from '@compound/config/release';

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  RELEASES?: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/download' && !url.pathname.startsWith('/releases/'))
      return env.ASSETS.fetch(request);
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    const feedPath = `/releases/${release.feed}`;
    // Preview sites download the production installer without owning its bucket.
    if (!env.RELEASES) return Response.redirect(url.pathname === feedPath ? release.feedUrl : release.downloadUrl, 302);
    if (url.pathname === '/download' || url.pathname === feedPath) {
      const latest = await env.RELEASES.get('latest.json');
      if (!latest) return new Response(request.method === 'HEAD' ? null : 'The first Compound release is not available yet.', {
        status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '300' },
      });
      const manifest = await latest.json<{ version: string }>();
      const version = releaseVersion(manifest.version);
      if (url.pathname === feedPath) {
        // The desktop app polls this; latest.json only advances after the zip is verified.
        const body = JSON.stringify(updateFeed(version, latest.uploaded));
        return new Response(request.method === 'HEAD' ? null : body, { headers: {
          'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        } });
      }
      return new Response(null, { status: 302, headers: {
        Location: `/releases/v${version}/${release.dmg}`, 'Cache-Control': 'no-store',
      } });
    }
    if (!/^\/releases\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\/Compound-mac-universal\.(dmg|zip)$/.test(url.pathname))
      return new Response('Not found', { status: 404 });
    const key = url.pathname.slice(1);
    const metadata = await env.RELEASES.head(key);
    if (!metadata) return new Response('Not found', { status: 404 });
    const headers = new Headers({
      'Content-Type': key.endsWith('.dmg') ? 'application/x-apple-diskimage' : 'application/zip',
      'Content-Disposition': `attachment; filename="${key.split('/').at(-1)}"`,
      'Content-Length': String(metadata.size),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Accept-Ranges': 'bytes',
      ETag: metadata.httpEtag,
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') return new Response(null, { headers });
    const range = request.headers.get('Range');
    // A single byte range supports resuming large installer downloads.
    let offset = 0, end = metadata.size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2]))
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${metadata.size}` } });
      if (match[1]) {
        offset = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      } else offset = Math.max(0, metadata.size - Number(match[2]));
      if (offset > end || !Number.isSafeInteger(offset) || !Number.isSafeInteger(end))
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${metadata.size}` } });
    }
    const object = await env.RELEASES.get(key, range ? { range: { offset, length: end - offset + 1 } } : {});
    if (!object) return new Response('Not found', { status: 404 });
    if (range) {
      headers.set('Content-Range', `bytes ${offset}-${end}/${metadata.size}`);
      headers.set('Content-Length', String(end - offset + 1));
    }
    return new Response(object.body, { status: range ? 206 : 200, headers });
  },
};
