// Live events carry the orders / kitchen tickets an action changed. The cached lists on screen take them in
// place (add, replace or drop that one record) instead of reading the whole list again. Anything not listed
// here — or any case we can't be sure about — is simply re-read, exactly as before.
import type { KitchenTicket, Order } from '@/core/types'

export interface LiveRecords { orders?: Order[]; kots?: KitchenTicket[] }

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString() }
const byCreated = (dir: 1 | -1) => (a: { createdAt: string }, b: { createdAt: string }) => dir * a.createdAt.localeCompare(b.createdAt)

/** Upsert / remove by id, then sort. A record older than the one on screen (events out of order) is ignored. */
function merge<T extends { id: string; createdAt: string; updatedAt?: string }>(list: T[], changed: T[], keep: (x: T) => boolean, dir: 1 | -1): T[] {
  const fresh = changed.filter((c) => { const cur = list.find((x) => x.id === c.id); return !cur || !cur.updatedAt || !c.updatedAt || c.updatedAt >= cur.updatedAt })
  const out = list.filter((x) => !fresh.some((c) => c.id === x.id))
  for (const c of fresh) if (keep(c)) out.push(c)
  return out.sort(byCreated(dir))
}

/**
 * The patched value of one cached read, or undefined when it must be re-read.
 * `branch` = the branch the list was read for ('all' = every allowed branch; '' = unknown → re-read).
 */
export function patchCached(name: string, branch: string, args: string, value: unknown, rec: LiveRecords): unknown {
  if (!Array.isArray(value) || args !== '[]' || !branch) return undefined
  const inBranch = (x: { branchId: string }) => branch === 'all' || x.branchId === branch
  const orders = rec.orders ?? [], kots = rec.kots ?? []
  switch (name) {
    case 'kitchen.list': {
      if (!rec.kots) return undefined
      const today = startOfToday()
      // The server lists open tickets and today's tickets.
      return merge(value as KitchenTicket[], kots, (k) => inBranch(k) && (['new', 'preparing', 'ready'].includes(k.status) || k.createdAt >= today), 1)
    }
    case 'orders.running':
      if (!rec.orders) return undefined
      return merge(value as Order[], orders, (o) => inBranch(o) && o.status === 'open', 1)
    case 'qr.pending':
      if (!rec.orders) return undefined
      return merge(value as Order[], orders, (o) => inBranch(o) && o.source === 'qr' && o.status === 'open' && o.qrStatus === 'pending', 1)
    case 'qr.recent': {
      if (!rec.orders) return undefined
      const today = startOfToday()
      return merge(value as Order[], orders, (o) => inBranch(o) && o.source === 'qr' && o.createdAt >= today, -1)
    }
    default: return undefined
  }
}
