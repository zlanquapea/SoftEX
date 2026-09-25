import type { Ctx } from './context.js';
import { backupIfDue } from './backup.js';
import { processEmailQueue, queueDigests } from './mailer.js';
import { processWebhookQueue } from './webhooks.js';
import { processBillingNotices } from './routes/billing.js';
import { applyRetention, processDeadlines, processReminders, processScheduledMessages } from './routes/productivity.js';

/** Run every background job once. Used by the scheduler and by tests. */
export async function runJobsOnce(ctx: Ctx) {
  await processScheduledMessages(ctx);
  await processReminders(ctx);
  await processEmailQueue(ctx);
  await processWebhookQueue(ctx);
}

/** Slower jobs: deadline reminders, retention and digests. */
export async function runPeriodicJobs(ctx: Ctx) {
  await processDeadlines(ctx);
  await applyRetention(ctx);
  await queueDigests(ctx);
  await processBillingNotices(ctx);
  await ctx.db.run('DELETE FROM rate_limits WHERE reset_at < ?', new Date().toISOString());
  await ctx.db.run('DELETE FROM realtime_events WHERE created_at < ?', new Date(Date.now() - 60 * 60_000).toISOString());
  // Push subscriptions whose browser session has ended (signed out, revoked or expired).
  await ctx.db.run('DELETE FROM push_subscriptions WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = push_subscriptions.session_id AND s.expires_at > ?)', new Date().toISOString());
  await ctx.db.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
  await backupIfDue(ctx);
}

/**
 * In-process scheduler: delivery queues every few seconds, digests every 10
 * minutes. Queues live in the database, so jobs pick up where they left off
 * after a restart, and a database lock makes sure only one server works on
 * them at a time.
 */
export function startBackgroundJobs(ctx: Ctx) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      // With several servers on one PostgreSQL database, only one runs the queues at a time.
      await ctx.db.exclusive('softex:jobs:queues', () => runJobsOnce(ctx));
    } catch (error) {
      console.error('Background job failed', error);
    } finally {
      busy = false;
    }
  };
  const queues = setInterval(tick, 5_000);
  const periodic = async () => {
    try {
      await ctx.db.exclusive('softex:jobs:periodic', () => runPeriodicJobs(ctx));
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
