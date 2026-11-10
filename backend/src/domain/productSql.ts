// Small SQL pieces for product lists read a page at a time (one database per shop): Inventory and the paged
// QR menu. Values always go in as arguments, never into the SQL text.
export type Arg = string | number | null

/** Name contains the search (as the app's own filter); '' = everything. */
export function nameLike(q: unknown): { sql: string; args: Arg[] } {
  const s = String(q ?? '').trim().toLowerCase().slice(0, 100)
  return s ? { sql: ` AND LOWER(p."name") LIKE ? ESCAPE '\\'`, args: [`%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`] } : { sql: '', args: [] }
}
/** Keyset paging in the list's order (sort order, then id): `after` = "<sort>:<id>" of the last row shown. */
export function afterKey(after: unknown): { sql: string; args: Arg[] } {
  const m = /^(-?\d{1,9}):(\d{1,16})$/.exec(String(after ?? ''))
  if (!m) return { sql: '', args: [] }
  const sort = Number(m[1]), id = Number(m[2])
  return { sql: ' AND (p."sort_order" > ? OR (p."sort_order" = ? AND p."id" > ?))', args: [sort, sort, id] }
}
