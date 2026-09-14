import { httpRouter } from 'convex/server';
import { authComponent, createAuth } from './auth';
import { callback, webhook } from './social_http';
const http = httpRouter();
authComponent.registerRoutes(http, createAuth, { cors: true });
// Zernio redirects the browser here once the user approves a social account.
http.route({ path: '/social/callback', method: 'GET', handler: callback });
// Zernio post status events; a cron sweep also polls, so a missed event only delays an update.
http.route({ path: '/webhooks/zernio', method: 'POST', handler: webhook });
export default http;
