import type { Ctx } from './context.js';
import { processEmailQueue, queueDigests } from './mailer.js';
import { processWebhookQueue } from './webhooks.js';

/** Run every background job once. Used by the scheduler and by tests. */
export async function runJobsOnce(ctx: Ctx) {
  await processEmailQueue(ctx);
  await processWebhookQueue(ctx);
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
  const digests = setInterval(() => {
    try {
      queueDigests(ctx);
    } catch (error) {
      console.error('Digest job failed', error);
    }
  }, 10 * 60_000);
  queues.unref();
  digests.unref();
  return () => {
    clearInterval(queues);
    clearInterval(digests);
  };
}
