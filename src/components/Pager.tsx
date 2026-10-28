// Page-by-page tables: the screen keeps the full list (totals, search and filters stay exact) and shows 50 rows
// at a time, so long lists stay fast and nothing is cut off. Changing a filter goes back to page 1.
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { PAGE_SIZE, pageWindow, type Cursor } from '@/core/paging'

export function usePage<T>(rows: readonly T[], resetKey: unknown = null, size = PAGE_SIZE) {
  const [page, setPage] = useState(0)
  const key = JSON.stringify(resetKey ?? null)
  useEffect(() => { setPage(0) }, [key])
  const w = pageWindow(rows.length, page, size)
  return { rows: rows.slice(w.from, w.to), page: w.page, pages: w.pages, from: w.from, to: w.to, total: rows.length, setPage }
}

export type Paged = Pick<ReturnType<typeof usePage>, 'page' | 'pages' | 'from' | 'to' | 'total' | 'setPage'>

/** "1–50 of 1,240  ‹ ›" under a table; nothing when everything fits on one page. */
export function Pager({ p, more }: { p: Paged; more?: React.ReactNode }) {
  if (p.pages <= 1 && !more) return null
  const n = (x: number) => x.toLocaleString('en-IN')
  return (
    <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">
      <span className="tabular">{p.total ? `${n(p.from + 1)}–${n(p.to)} of ${n(p.total)}` : ''}</span>
      <div className="flex items-center gap-1">
        {more}
        {p.pages > 1 && <>
          <button type="button" aria-label="Previous page" disabled={p.page === 0} onClick={() => p.setPage(p.page - 1)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent"><ChevronLeft className="h-4 w-4" /></button>
          <span className="tabular px-1">Page {p.page + 1} of {n(p.pages)}</span>
          <button type="button" aria-label="Next page" disabled={p.page >= p.pages - 1} onClick={() => p.setPage(p.page + 1)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent"><ChevronRight className="h-4 w-4" /></button>
        </>}
      </div>
    </div>
  )
}

/**
 * A newest-first list the server sends in parts: `base` is the newest part (refreshed as usual), "Load older"
 * adds the next part after the last row. `size` = rows per answer; a shorter answer means nothing older is left.
 */
export function useOlder<T extends { id: string }>(base: readonly T[] | undefined, size: number, at: (r: T) => string, load: (before: Cursor) => Promise<T[]>) {
  const [older, setOlder] = useState<T[]>([])
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const rows = useMemo(() => {
    const seen = new Set<string>()
    return [...(base ?? []), ...older].filter((r) => !seen.has(r.id) && !!seen.add(r.id))
  }, [base, older])
  const canMore = !done && (base?.length ?? 0) >= size
  const more = async () => {
    const last = rows[rows.length - 1]
    if (!last || busy) return
    setBusy(true)
    try { const next = await load({ at: at(last), id: last.id }); setOlder((o) => [...o, ...next]); if (next.length < size) setDone(true) }
    finally { setBusy(false) }
  }
  return { rows, canMore, more, busy }
}

/** The "Load older" button for a Pager's `more`. */
export function LoadOlder({ o }: { o: { canMore: boolean; more: () => void; busy: boolean } }) {
  if (!o.canMore) return null
  return <button type="button" onClick={() => o.more()} disabled={o.busy} className="mr-2 rounded-lg px-2.5 py-1.5 font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-50">{o.busy ? 'Loading…' : 'Load older'}</button>
}
