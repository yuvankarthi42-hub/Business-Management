// Page-by-page lists (50 rows a page). Pure helpers, shared by the screens (components/Pager.tsx) and the tests.

export const PAGE_SIZE = 50

/** Which rows page `page` (0-based) shows; a page past the end moves back to the last one. */
export function pageWindow(total: number, page: number, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(total / size))
  const p = Math.min(Math.max(0, Math.floor(page) || 0), pages - 1)
  return { page: p, pages, from: p * size, to: Math.min(total, (p + 1) * size) }
}

/** Cursor for "load older" lists: the last row's time and id (rows with the same time are told apart by id). */
export interface Cursor { at: string; id: string }

/** a < b for numeric ids of any length (Catalyst ids don't fit in a JavaScript number). */
export function idBefore(a: string, b: string) {
  return a.length !== b.length ? a.length < b.length : a < b
}

/** Keeps the rows strictly after the cursor in a newest-first list (same time → smaller id comes later). */
export function afterCursor<T extends { id: string }>(rows: T[], at: (r: T) => string, cursor: Cursor | null | undefined): T[] {
  if (!cursor) return rows
  return rows.filter((r) => { const t = at(r); return t < cursor.at || (t === cursor.at && idBefore(r.id, cursor.id)) })
}
