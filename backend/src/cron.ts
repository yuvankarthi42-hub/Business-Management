// Zoho Catalyst Cron function ("daily"). Schedule it in the console: Cloud Scale → Triggers → Cron,
// every day at 09:00 IST, target function "daily". It sends the renewal reminders (once per day —
// platform_settings.reminders.lastRunOn stops a second run).
import catalyst from 'zcatalyst-sdk-node'
import { catalystEnv } from './catalystEnv'
import { Ctx } from './core/context'
import { runDailyJobs } from './modules/admin/renewals'

process.env.NODE_ENV ??= 'production'

interface CronContext { closeWithSuccess(): void; closeWithFailure(): void }

module.exports = async (_cronDetails: unknown, context: CronContext) => {
  try {
    const env = catalystEnv(catalyst.initialize(context as never))
    const c = new Ctx(env, await env.dbs.platform(), null)
    const sent = await runDailyJobs(c)
    console.log(`Daily jobs done: ${JSON.stringify(sent)}`)
    context.closeWithSuccess()
  } catch (e) {
    console.error('Daily jobs failed', e)
    context.closeWithFailure()
  }
}
