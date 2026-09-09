import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';
const crons = cronJobs();
crons.interval('expire temporary upload records', { hours: 1 }, internal.uploads.expire);
export default crons;
