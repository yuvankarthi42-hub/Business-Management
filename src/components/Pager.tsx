// Page-by-page tables: the screen keeps the full list (totals, search and filters stay exact) and shows 50 rows
// at a time, so long lists stay fast and nothing is cut off. Changing a filter goes back to page 1.
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useData } from '@/app/AppContext'
import { PAGE_SIZE, pageWindow, type Cursor } from '@/core/paging'

export function usePage<T>(rows: readonly T[], resetKey: unknown = null, size = PAGE_SIZE) {
  const [page, setPage] = useState(0)
  const key = JSON.stringify(resetKey ?? null)
  useEffect(() => { setPage(0) }, [key])
  const w = pageWindow(rows.length, page, size)
  return { rows: rows.slice(w.from, w.to), page: w.page, pages: w.pages, from: w.from, to: w.to, total: rows.length, setPage }
}

export type Paged = Pick<ReturnType<typeof usePage>, 'page' | 'pages' | 'from' | 'to' | 'total'> & { setPage: (n: number) => void }

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

/**
 * Pages that come from the server (each answer = one page + the cursor for the next + the total count). The screen
 * keeps the cursor of every page it has seen, so Previous / Next move one page at a time; a new filter starts again.
 */
export function useServerPages<D extends { rows: unknown[]; next: Cursor | null; count: number }>(load: (before: Cursor | null) => Promise<D>, resetKey: unknown, size = PAGE_SIZE) {
  const key = JSON.stringify(resetKey ?? null)
  const [state, setState] = useState<{ key: string; page: number; cursors: (Cursor | null)[] }>({ key, page: 0, cursors: [null] })
  // A changed filter starts at page 1 straight away (no request with the old filter's cursor).
  const s = state.key === key ? state : { key, page: 0, cursors: [null] as (Cursor | null)[] }
  useEffect(() => { if (state.key !== key) setState({ key, page: 0, cursors: [null] }) }, [key, state.key])
  const cursor = s.cursors[s.page] ?? null
  const { data } = useData(() => load(cursor), [key, s.page, JSON.stringify(cursor)])
  useEffect(() => {
    if (!data || state.key !== key) return
    setState((x) => {
      if (x.key !== key || JSON.stringify(x.cursors[x.page + 1] ?? null) === JSON.stringify(data.next ?? null)) return x
      const cursors = x.cursors.slice(0, x.page + 1)
      if (data.next) cursors[x.page + 1] = data.next
      return { ...x, cursors }
    })
  }, [data, key, state.key])
  const total = data?.count ?? 0
  const rows = (data?.rows ?? []) as D['rows']
  const p: Paged = {
    page: s.page, pages: Math.max(1, Math.ceil(total / size)), from: s.page * size, to: s.page * size + rows.length, total,
    // Only to a page whose cursor is known (the next one appears once this page has loaded).
    setPage: (n: number) => setState((x) => (n >= 0 && n < x.cursors.length && (n === 0 || x.cursors[n]) ? { ...x, page: n } : x)),
  }
  return { data, rows, p }
}
