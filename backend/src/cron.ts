// Zoho Catalyst Cron function ("daily"). Schedule it in the console: Cloud Scale → Triggers → Cron,
// every day at 09:00 IST, target function "daily". It runs the daily jobs in batches until all shops are done, and
// sends the renewal reminders (once per day — a second run the same day does nothing).
import catalyst from 'zcatalyst-sdk-node'
import { catalystEnv } from './catalystEnv'
import { Ctx } from './core/context'
import { runDailyJobs } from './modules/admin/renewals'

process.env.NODE_ENV ||= 'production' // unset or empty → production (never the development secrets)

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
