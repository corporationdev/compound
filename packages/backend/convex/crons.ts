import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';
const crons = cronJobs();
crons.interval('expire temporary upload records', { hours: 1 }, internal.uploads.expire);
crons.interval('expire transcription jobs', { hours: 1 }, internal.transcriptions.expire);
crons.interval('expire library staging and search records', { hours: 1 }, internal.catalog.expire);
crons.interval('dispatch social posts', { minutes: 1 }, internal.social_dispatch.sweep);
export default crons;
