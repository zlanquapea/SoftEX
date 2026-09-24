import type { Ctx } from './context.js';
import { processEmailQueue, queueDigests } from './mailer.js';
import { processWebhookQueue } from './webhooks.js';
import { applyRetention, processDeadlines, processReminders, processScheduledMessages } from './routes/productivity.js';

/** Run every background job once. Used by the scheduler and by tests. */
export async function runJobsOnce(ctx: Ctx) {
  processScheduledMessages(ctx);
  processReminders(ctx);
  await processEmailQueue(ctx);
  await processWebhookQueue(ctx);
}

/** Slower jobs: deadline reminders, retention and digests. */
export function runPeriodicJobs(ctx: Ctx) {
  processDeadlines(ctx);
  applyRetention(ctx);
  queueDigests(ctx);
}

/**
 * In-process scheduler: delivery queues every few seconds, digests every 10
 * minutes. Queues live in the database, so jobs pick up where they left off
 * after a restart.
 */
export function startBackgroundJobs(ctx: Ctx) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runJobsOnce(ctx);
    } catch (error) {
      console.error('Background job failed', error);
    } finally {
      busy = false;
    }
  };
  const queues = setInterval(tick, 5_000);
  const periodic = () => {
    try {
      runPeriodicJobs(ctx);
    } catch (error) {
      console.error('Periodic job failed', error);
    }
  };
  const digests = setInterval(periodic, 10 * 60_000);
  setTimeout(periodic, 15_000).unref();
  queues.unref();
  digests.unref();
  return () => {
    clearInterval(queues);
    clearInterval(digests);
  };
}
