// Customer data export: one Excel workbook (a sheet per table) or a ZIP of CSV files + product photos.
// JSZip is loaded only when someone exports.
import type { ExportBundle } from '@/data'

type Cell = string | number | boolean | null
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'business'
const stamp = () => new Date().toISOString().slice(0, 10)

function csv(rows: Record<string, Cell>[]) {
  if (!rows.length) return ''
  const head = Object.keys(rows[0])
  const esc = (v: Cell) => { const t = v == null ? '' : String(v); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
  return [head.map(esc).join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\r\n')
}

const xmlEsc = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const col = (i: number) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26) } return s }

function sheetXml(rows: Record<string, Cell>[]) {
  const head = rows.length ? Object.keys(rows[0]) : ['(no rows)']
  const cell = (v: Cell, ref: string, bold = false) => {
    const st = bold ? ' s="1"' : ''
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`
    if (typeof v === 'boolean') return `<c r="${ref}" t="b"${st}><v>${v ? 1 : 0}</v></c>`
    return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${xmlEsc(v == null ? '' : String(v))}</t></is></c>`
  }
  const lines = [`<row r="1">${head.map((h, i) => cell(h, `${col(i)}1`, true)).join('')}</row>`,
    ...rows.map((r, ri) => `<row r="${ri + 2}">${head.map((h, i) => cell(r[h], `${col(i)}${ri + 2}`)).join('')}</row>`)]
  const widths = head.map((h) => Math.min(60, Math.max(h.length, ...rows.slice(0, 200).map((r) => String(r[h] ?? '').length)) + 2)).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths}</cols><sheetData>${lines.join('')}</sheetData></worksheet>`
}

export async function buildXlsx(b: ExportBundle): Promise<Blob> {
  const { default: JSZip } = await import('jszip')
  const z = new JSZip()
  const names = b.tables.map((t) => t.name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31))
  z.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`)
  z.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  z.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`)
  z.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`)
  z.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`)
  b.tables.forEach((t, i) => z.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(t.rows)))
  return z.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', compression: 'DEFLATE' })
}

export async function buildZip(b: ExportBundle): Promise<Blob> {
  const { default: JSZip } = await import('jszip')
  const z = new JSZip()
  z.file('README.txt', [
    `Data export — ${b.businessName}`, `Exported: ${new Date(b.exportedAt).toLocaleString('en-IN')}`, '',
    'Each .csv file opens in Excel or Google Sheets (UTF-8, so Tamil text shows correctly).',
    'Product photos are in the images folder; the Products sheet names the file for each item.',
    'Passwords are never exported.', '',
    ...b.tables.map((t) => `${t.name}.csv — ${t.rows.length} row${t.rows.length === 1 ? '' : 's'}`),
  ].join('\r\n'))
  for (const t of b.tables) z.file(`${slug(t.name)}.csv`, '﻿' + csv(t.rows))
  for (const img of b.images) z.file(img.path, img.dataUrl.slice(img.dataUrl.indexOf(',') + 1), { base64: true })
  return z.generateAsync({ type: 'blob', compression: 'DEFLATE' })
}

export async function downloadExport(b: ExportBundle, format: 'xlsx' | 'zip') {
  const blob = format === 'xlsx' ? await buildXlsx(b) : await buildZip(b)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `${slug(b.businessName)}-data-${stamp()}.${format}`; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  return blob.size
}
