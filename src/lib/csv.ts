// CSV text for the data export (kept free of browser code so the server tests can check it).
export type Cell = string | number | boolean | null

export function csv(rows: Record<string, Cell>[]) {
  if (!rows.length) return ''
  const head = Object.keys(rows[0])
  // A cell that starts like a formula (=, +, -, @, tab, CR) is made plain text with a leading ' — otherwise a name
  // like =HYPERLINK(…) typed into the app would run when the CSV is opened in Excel. Plain numbers (-50.00) stay numbers.
  const safe = (t: string) => (/^[=+\-@\t\r]/.test(t) && !/^[+-]?\d+(\.\d+)?$/.test(t) ? `'${t}` : t)
  const esc = (v: Cell) => { const t = typeof v === 'number' ? String(v) : safe(v == null ? '' : String(v)); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
  return [head.map(esc).join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\r\n')
}
