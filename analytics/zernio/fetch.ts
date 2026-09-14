/**
 * Pulls everything Zernio exposes about this account's posts and stores it
 * under analytics/zernio/data. Run with:
 *
 *   ZERNIO_API_KEY=sk_... bun analytics/zernio/fetch.ts
 *
 * Every raw response is kept verbatim in data/raw/. The normalised dataset the
 * dashboard reads is data/dataset.json, mirrored as data/dataset.js so
 * index.html works from file:// without a server.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const API = 'https://zernio.com/api/v1';
const KEY = process.env.ZERNIO_API_KEY?.trim();
if (!KEY) {
  console.error('Set ZERNIO_API_KEY');
  process.exit(1);
}
const ROOT = new URL('.', import.meta.url).pathname;
const RAW = join(ROOT, 'data', 'raw');
await mkdir(RAW, { recursive: true });

type Json = Record<string, any>;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = new Date();
const daysAgo = (n: number) => iso(new Date(today.getTime() - n * 86_400_000));

let calls = 0;
async function get(path: string, params: Record<string, string | number | boolean | undefined> = {}, attempt = 0): Promise<Json> {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  calls++;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
  const body = (await res.json().catch(() => ({}))) as Json;
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 5) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait));
      return get(path, params, attempt + 1);
    }
  }
  if (!res.ok) return { __error: true, status: res.status, ...body, __url: url.toString() };
  return body;
}

async function paginate(path: string, params: Record<string, any>, key: string): Promise<{ rows: Json[]; first: Json }> {
  const rows: Json[] = [];
  let page = 1;
  let first: Json = {};
  for (;;) {
    const body = await get(path, { ...params, page, limit: 100 });
    if (body.__error) throw new Error(`${path} failed: ${JSON.stringify(body)}`);
    if (page === 1) first = body;
    rows.push(...(body[key] ?? []));
    const pages = body.pagination?.pages ?? 1;
    process.stdout.write(`  ${path} ${JSON.stringify(params)} page ${page}/${pages}\r`);
    if (page >= pages) break;
    page++;
  }
  process.stdout.write('\n');
  return { rows, first };
}

async function save(name: string, data: unknown) {
  await writeFile(join(RAW, `${name}.json`), JSON.stringify(data, null, 2));
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

console.log('accounts + profiles');
const accounts = await get('/accounts');
const profiles = await get('/profiles');
const health = await get('/accounts/health');
await save('accounts', accounts);
await save('profiles', profiles);
await save('accounts_health', health);

const accountList: Json[] = accounts.accounts ?? [];
const byPlatform = (p: string) => accountList.filter((a) => a.platform === p && a.isActive !== false);

console.log('live platform post lists');
const livePosts: Json = {};
for (const a of accountList) {
  livePosts[a._id] = await get(`/accounts/${a._id}/posts`);
  if (a.platform === 'tiktok') await save(`tiktok_creator_info_${a._id}`, await get(`/accounts/${a._id}/tiktok/creator-info`));
}
await save('accounts_live_posts', livePosts);

console.log('posts');
const zernioPosts = await paginate('/posts', { source: 'zernio', includeHidden: true, sortBy: 'created-asc' }, 'posts');
const externalPosts = await paginate('/posts', { source: 'external', includeHidden: true, sortBy: 'created-asc' }, 'posts');
await save('posts_zernio', zernioPosts.rows);
await save('posts_external', externalPosts.rows);

console.log('analytics');
const fromDate = daysAgo(365);
const analytics = await paginate('/analytics', { source: 'all', fromDate, toDate: iso(today), sortBy: 'date', order: 'asc' }, 'posts');
await save('analytics_posts', analytics.rows);
await save('analytics_overview', { ...analytics.first, posts: undefined });

console.log('aggregate analytics');
const agg: Json = {};
for (const platform of ['', 'instagram', 'tiktok']) {
  const suffix = platform || 'all';
  agg[`daily_publish_${suffix}`] = await get('/analytics/daily-metrics', { fromDate, toDate: iso(today), attribution: 'publish', platform });
  agg[`daily_received_${suffix}`] = await get('/analytics/daily-metrics', { fromDate, toDate: iso(today), attribution: 'received', platform });
  agg[`best_time_${suffix}`] = await get('/analytics/best-time', { platform });
  agg[`content_decay_${suffix}`] = await get('/analytics/content-decay', { platform });
  agg[`posting_frequency_${suffix}`] = await get('/analytics/posting-frequency', { platform });
}
for (const [k, v] of Object.entries(agg)) await save(k, v);

console.log('follower stats');
const followerStats: Json = {};
for (const g of ['daily', 'weekly', 'monthly']) {
  followerStats[g] = await get('/accounts/follower-stats', { fromDate: daysAgo(365), toDate: iso(today), granularity: g });
}
await save('follower_stats', followerStats);

console.log('instagram account insights');
const ig: Json = {};
for (const a of byPlatform('instagram')) {
  const id = a._id;
  const since = daysAgo(88);
  const until = iso(today);
  ig[id] = {
    totals: await get('/analytics/instagram/account-insights', {
      accountId: id,
      since,
      until,
      metricType: 'total_value',
      metrics: 'reach,views,accounts_engaged,total_interactions,comments,likes,saves,shares,replies,reposts,profile_links_taps,follows_and_unfollows',
    }),
    reachSeries: await get('/analytics/instagram/account-insights', { accountId: id, since, until, metricType: 'time_series', metrics: 'reach' }),
    byMediaType: await get('/analytics/instagram/account-insights', { accountId: id, since, until, metricType: 'total_value', metrics: 'reach', breakdown: 'media_product_type' }),
    byFollowType: await get('/analytics/instagram/account-insights', { accountId: id, since, until, metricType: 'total_value', metrics: 'reach', breakdown: 'follow_type' }),
    followerHistory: await get('/analytics/instagram/follower-history', { accountId: id, since, until, metricType: 'time_series' }),
    followerHistoryTotals: await get('/analytics/instagram/follower-history', { accountId: id, since, until, metricType: 'total_value' }),
    followerDemographics: await get('/analytics/instagram/demographics', { accountId: id, metric: 'follower_demographics', timeframe: 'this_month' }),
    engagedDemographics: await get('/analytics/instagram/demographics', { accountId: id, metric: 'engaged_audience_demographics', timeframe: 'this_month' }),
  };
}
await save('instagram_insights', ig);

console.log('tiktok account insights');
const tt: Json = {};
for (const a of byPlatform('tiktok')) {
  const id = a._id;
  tt[id] = {
    totals: await get('/analytics/tiktok/account-insights', { accountId: id, since: daysAgo(88), until: iso(today), metricType: 'total_value' }),
    series: await get('/analytics/tiktok/account-insights', { accountId: id, since: daysAgo(88), until: iso(today), metricType: 'time_series' }),
  };
}
await save('tiktok_insights', tt);

console.log(`post timelines (${analytics.rows.length})`);
let done = 0;
const timelines = await pool(analytics.rows, 4, async (row) => {
  const from = row.publishedAt ? iso(new Date(new Date(row.publishedAt).getTime() - 86_400_000)) : fromDate;
  const body = await get('/analytics/post-timeline', { postId: row._id, fromDate: from, toDate: iso(today) });
  done++;
  process.stdout.write(`  timeline ${done}/${analytics.rows.length}\r`);
  return { id: row._id, ...body };
});
process.stdout.write('\n');
await save('post_timelines', timelines);

console.log('zernio post details');
done = 0;
const details = await pool(zernioPosts.rows, 4, async (p) => {
  const body = await get(`/posts/${p._id}`);
  done++;
  process.stdout.write(`  detail ${done}/${zernioPosts.rows.length}\r`);
  return body.post ?? body;
});
process.stdout.write('\n');
await save('posts_zernio_details', details);

// ---------------------------------------------------------------- dataset

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const metricKeys = [
  'impressions', 'reach', 'likes', 'comments', 'shares', 'saves', 'clicks', 'views', 'follows',
  'igReelsAvgWatchTime', 'igReelsVideoViewTotalTime', 'reelsSkipRate', 'completionRate', 'profileViews',
  'reposts', 'videoDurationSeconds', 'engagementRate',
] as const;

const zernioById = new Map<string, Json>();
for (const p of details) zernioById.set(p._id, p);
const timelineById = new Map<string, Json[]>();
for (const t of timelines) timelineById.set(t.id, t.timeline ?? []);

const posts = analytics.rows.map((row) => {
  const platformRows: Json[] = row.platforms ?? [];
  const pr = platformRows.find((p) => p.platform === row.platform) ?? platformRows[0] ?? {};
  const z = row.latePostId ? zernioById.get(row.latePostId) : undefined;
  const zPlatform = z?.platforms?.find((p: Json) => p.platformPostId === pr.platformPostId || p.platform === row.platform);
  const metrics: Json = {};
  for (const k of metricKeys) metrics[k] = num(row.analytics?.[k]);
  const publishedAt = row.publishedAt ?? zPlatform?.publishedAt ?? z?.scheduledFor ?? null;
  const date = publishedAt ? new Date(publishedAt) : null;
  return {
    id: row._id,
    zernioPostId: row.latePostId ?? null,
    platform: row.platform,
    accountId: pr.accountId ?? zPlatform?.accountId?._id ?? null,
    username: pr.accountUsername ?? zPlatform?.accountId?.username ?? null,
    platformPostId: pr.platformPostId ?? zPlatform?.platformPostId ?? null,
    url: row.platformPostUrl ?? pr.platformPostUrl ?? zPlatform?.platformPostUrl ?? null,
    thumbnailUrl: row.thumbnailUrl ?? row.mediaItems?.[0]?.thumbnail ?? null,
    mediaUrl: row.mediaItems?.[0]?.url ?? null,
    content: row.content ?? z?.content ?? '',
    title: z?.title ?? '',
    hashtags: z?.hashtags ?? [],
    publishedAt,
    scheduledFor: row.scheduledFor ?? z?.scheduledFor ?? null,
    createdAt: z?.createdAt ?? null,
    timezone: z?.timezone ?? null,
    status: row.status,
    platformStatus: zPlatform?.status ?? null,
    syncStatus: pr.syncStatus ?? null,
    errorMessage: pr.errorMessage ?? null,
    source: row.latePostId ? 'zernio' : 'external',
    isExternal: row.isExternal ?? null,
    isAd: row.isAd ?? false,
    isAiGenerated: row.isAiGenerated ?? null,
    isSharedToFeed: row.isSharedToFeed ?? null,
    mediaType: row.mediaType ?? null,
    mediaProductType: row.mediaProductType ?? null,
    publishAttempts: zPlatform?.publishAttempts ?? z?.publishAttempts ?? null,
    platformSettings: zPlatform?.platformSpecificData ?? null,
    lastUpdated: row.analytics?.lastUpdated ?? null,
    metrics,
    engagement: (metrics.likes ?? 0) + (metrics.comments ?? 0) + (metrics.shares ?? 0) + (metrics.saves ?? 0),
    contentLength: (row.content ?? z?.content ?? '').length,
    hour: date ? date.getUTCHours() : null,
    weekday: date ? date.getUTCDay() : null,
    timeline: timelineById.get(row._id) ?? [],
  };
});

const groups = new Map<string, Json>();
for (const p of posts) {
  const key = p.zernioPostId ?? `external:${p.id}`;
  const g = groups.get(key) ?? {
    key,
    zernioPostId: p.zernioPostId,
    content: p.content,
    firstPublishedAt: p.publishedAt,
    platforms: [] as string[],
    postIds: [] as string[],
    totals: Object.fromEntries(['impressions', 'reach', 'likes', 'comments', 'shares', 'saves', 'views', 'engagement'].map((k) => [k, 0])),
  };
  g.platforms.push(p.platform);
  g.postIds.push(p.id);
  if (p.publishedAt && (!g.firstPublishedAt || p.publishedAt < g.firstPublishedAt)) g.firstPublishedAt = p.publishedAt;
  for (const k of Object.keys(g.totals)) g.totals[k] += (k === 'engagement' ? p.engagement : p.metrics[k]) ?? 0;
  groups.set(key, g);
}

const dataset = {
  fetchedAt: new Date().toISOString(),
  apiCalls: calls,
  range: { fromDate, toDate: iso(today) },
  accounts: accountList.map((a) => ({
    id: a._id,
    platform: a.platform,
    username: a.metadata?.profileData?.username ?? a.username ?? null,
    displayName: a.displayName,
    profilePicture: a.metadata?.profileData?.profilePicture ?? a.profilePicture ?? null,
    profileUrl: a.metadata?.profileData?.profileUrl ?? null,
    followersCount: a.followersCount ?? null,
    followersLastUpdated: a.followersLastUpdated ?? null,
    externalPostCount: a.externalPostCount ?? null,
    createdAt: a.createdAt,
    isActive: a.isActive,
    analyticsLastSyncedAt: a.analyticsLastSyncedAt ?? null,
  })),
  profiles: profiles.profiles ?? [],
  overview: analytics.first.overview ?? null,
  posts,
  groups: [...groups.values()],
  zernioPosts: details,
  externalPosts: externalPosts.rows,
  livePosts,
  aggregates: agg,
  followerStats,
  instagram: ig,
  tiktok: tt,
  health,
};

await writeFile(join(ROOT, 'data', 'dataset.json'), JSON.stringify(dataset, null, 2));
await writeFile(join(ROOT, 'data', 'dataset.js'), `window.ZERNIO_DATA = ${JSON.stringify(dataset)};\n`);
console.log(`done: ${posts.length} platform posts, ${groups.size} unique posts, ${calls} API calls`);
