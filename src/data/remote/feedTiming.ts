// How often a screen asks the change feed (no event hub): screens where another counter's change must show quickly
// (new KOT, QR order, a table's bill) every 30 s; every other screen (dashboard, reports, products, settings…) every
// 60 s — about half the server calls. Hidden tabs and idle screens don't ask at all (sync.ts).
const URGENT = /^\/(kitchen|qr-orders|tables|billing|m\/order|customer-orders)(\/|$|\?)/

export const feedInterval = (path: string) => (URGENT.test(path) ? 30_000 : 60_000)

/** What the server says with every answer: the shop's newest change number, the sign-in version, this request's own change. */
export interface FeedNote { latest: number; epoch?: string | null; own?: number | null }

/**
 * After a server answer: 'same' = no new change; 'own' = only this tab's own changes since `since` (nothing to
 * refresh — skip the timed check); 'ask' = another device or the account changed something → ask the feed once.
 */
export function feedDecision(since: number, note: FeedNote, own: ReadonlySet<number>, epoch: string | null): 'same' | 'own' | 'ask' {
  if (note.epoch && epoch !== null && note.epoch !== epoch) return 'ask'
  if (note.latest <= since) return 'same'
  if (note.latest - since > 200) return 'ask'
  for (let n = since + 1; n <= note.latest; n++) if (!own.has(n)) return 'ask'
  return 'own'
}
