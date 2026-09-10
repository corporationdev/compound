import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';
const crons = cronJobs();
crons.interval('expire temporary upload records', { hours: 1 }, internal.uploads.expire);
crons.interval('expire transcription jobs', { hours: 1 }, internal.transcriptions.expire);
export default crons;
