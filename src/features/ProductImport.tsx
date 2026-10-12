import clsx from 'clsx'
import Papa from 'papaparse'
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Download, FileSpreadsheet, FileUp, Info, Upload, XCircle } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { Badge, Button, Modal, Segmented, Select, useAction, useToast } from '@/components/ui'
import { autoMap, checkRows, importFieldsFor, sampleCsv, type CheckedRow, type ImportFieldKey } from '@/core/productImport'
import { api } from '@/data'
import { money } from '@/lib/format'

type Step = 1 | 2 | 3 | 4
type Filter = 'all' | 'ready' | 'warnings' | 'errors' | 'existing'
const STEPS = ['Upload', 'Match columns', 'Check rows', 'Import']
const MAX_ROWS = 5000
const PAGE = 100

const downloadCsv = (name: string, text: string) => {
  // BOM so Excel opens Tamil text correctly.
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Import products / menu items from a CSV file: upload → match columns → check rows → import. */
export function ProductImportModal({ onClose }: { onClose: () => void }) {
  const { me, t } = useApp()
  const run = useAction()
  const toast = useToast()
  const b = me!.business
  const fields = useMemo(() => importFieldsFor(b), [b])
  const { data: products = [] } = useData(() => api.products.list())
  const { data: categories = [] } = useData(() => api.categories.list())

  const [step, setStep] = useState<Step>(1)
  const [fileName, setFileName] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [raw, setRaw] = useState<Record<string, string>[]>([])
  const [mapping, setMapping] = useState<Partial<Record<ImportFieldKey, string>>>({})
  const [edits, setEdits] = useState<Record<number, Partial<Record<ImportFieldKey, string>>>>({})
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [filter, setFilter] = useState<Filter>('all')
  const [limit, setLimit] = useState(PAGE)
  const [onExisting, setOnExisting] = useState<'skip' | 'update'>('skip')
  const [result, setResult] = useState<{ created: number; updated: number; skippedRows: number[]; newCategories: string[] } | null>(null)
  const [drag, setDrag] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const plural = t('product', true).toLowerCase()

  // ---------- 1. Upload ----------
  const readFile = (file: File) => {
    if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') { toast('Choose a .csv file (in Excel: File → Save as → CSV UTF-8)', 'error'); return }
    if (file.size > 10 * 1024 * 1024) { toast('The file is bigger than 10 MB', 'error'); return }
    Papa.parse<Record<string, string>>(file, {
      header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.replace(/^﻿/, '').trim(),
      complete: (res) => {
        const hs = (res.meta.fields ?? []).filter(Boolean)
        const rows = res.data.filter((r) => Object.values(r).some((v) => String(v ?? '').trim()))
        if (!hs.length || !rows.length) { toast('No rows found. The first line must have column names.', 'error'); return }
        if (rows.length > MAX_ROWS) { toast(`The file has ${rows.length} rows — up to ${MAX_ROWS.toLocaleString('en-IN')} at a time. Split it into smaller files.`, 'error'); return }
        setFileName(file.name); setHeaders(hs); setRaw(rows); setMapping(autoMap(fields, hs)); setEdits({}); setResult(null); setStep(2)
      },
      error: () => toast('Couldn’t read this file', 'error'),
    })
  }

  // ---------- 2/3. Rows with mapping + fixes ----------
  const value = (i: number, k: ImportFieldKey) => edits[i]?.[k] ?? (mapping[k] ? String(raw[i]?.[mapping[k]!] ?? '') : '')
  const mappedRows = useMemo(() => raw.map((_, i) => Object.fromEntries(fields.map((f) => [f.key, value(i, f.key)])) as Partial<Record<ImportFieldKey, string>>),
    [raw, mapping, edits, fields]) // eslint-disable-line react-hooks/exhaustive-deps
  const checked = useMemo(() => checkRows(mappedRows, { business: b, products, categories }), [mappedRows, b, products, categories])
  const ok = (r: CheckedRow) => !r.errors.length
  const isSel = (r: CheckedRow) => ok(r) && selected.has(r.index)
  const counts = {
    all: checked.length, ready: checked.filter((r) => ok(r) && !r.warnings.length && !r.existing).length, warnings: checked.filter((r) => ok(r) && r.warnings.length).length,
    errors: checked.filter((r) => !ok(r)).length, existing: checked.filter((r) => r.existing).length,
  }
  const shown = checked.filter((r) => filter === 'all' || (filter === 'ready' ? ok(r) && !r.warnings.length && !r.existing : filter === 'warnings' ? ok(r) && r.warnings.length > 0 : filter === 'errors' ? !ok(r) : !!r.existing))
  const missingRequired = fields.filter((f) => f.required && !mapping[f.key] && !(f.key === 'price' && mapping.variants))
  const unused = headers.filter((h) => !Object.values(mapping).includes(h))
  const extraCols = (['mrp', 'barcode', 'stock', 'unit', 'expiry', 'variants'] as ImportFieldKey[]).filter((k) => mapping[k]).slice(0, 3)
  const goCheck = () => { setSelected(new Set(checkRows(mappedRows, { business: b, products, categories }).filter(ok).map((r) => r.index))); setFilter('all'); setLimit(PAGE); setStep(3) }

  // ---------- 4. Import ----------
  const chosen = checked.filter(isSel)
  const summary = {
    add: chosen.filter((r) => !r.existing).length,
    existing: chosen.filter((r) => r.existing).length,
    cats: [...new Set(chosen.filter((r) => r.newCategory && !r.existing).map((r) => r.item.categoryName!.trim()))],
    stock: chosen.filter((r) => !r.existing).reduce((a, r) => a + (r.item.stock ?? 0), 0),
    left: checked.length - chosen.length,
  }
  const doImport = () => run(async () => {
    setResult(await api.products.importMany(chosen.map((r) => ({ ...r.item, row: r.index })), { onExisting, fileName }))
  })
  const downloadLeftOut = () => {
    const skipped = new Set(result?.skippedRows ?? [])
    const left = checked.filter((r) => !isSel(r) || skipped.has(r.index))
    const reason = (r: CheckedRow) => (r.errors.length ? r.errors.join('; ') : skipped.has(r.index) ? 'Already exists (skipped)' : 'Not selected')
    downloadCsv(`not-imported-${fileName || 'rows.csv'}`, Papa.unparse({ fields: [...headers, 'Reason'], data: left.map((r) => [...headers.map((h) => raw[r.index][h] ?? ''), reason(r)]) }))
  }

  return (
    <Modal open onClose={onClose} size="xl" title={`Import ${plural} from CSV`} subtitle={fileName ? `${fileName} · ${raw.length.toLocaleString('en-IN')} rows · ${headers.length} columns` : 'Bring your item list from Excel, Google Sheets or another billing app'}>
      {/* Stepper */}
      <ol className="mb-5 flex flex-wrap items-center gap-1.5 text-xs">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-1.5">
            <span className={clsx('inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium', step === i + 1 ? 'bg-brand-50 text-brand-700' : step > i + 1 ? 'bg-emerald-50 text-emerald-700' : 'border border-slate-200 text-slate-500')}>
              {step > i + 1 ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span>{i + 1}</span>}{s}
            </span>
            {i < STEPS.length - 1 && <ArrowRight className="h-3 w-3 text-slate-300" />}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <div>
          <button type="button" onClick={() => input.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) readFile(f) }}
            className={clsx('flex w-full flex-col items-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition', drag ? 'border-brand-400 bg-brand-50/50' : 'border-slate-300 hover:border-slate-400')}>
            <FileSpreadsheet className="h-9 w-9 text-slate-400" />
            <span className="mt-2 font-semibold">Drop your CSV file here, or choose a file</span>
            <span className="mt-1 text-sm text-slate-500">Excel or Google Sheets: File → Save as / Download → CSV (UTF-8). Tamil names work.</span>
          </button>
          <input ref={input} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = '' }} />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" icon={Download} write={false} onClick={() => downloadCsv(`sample-${b.subType.toLowerCase().replace(/\W+/g, '-')}.csv`, sampleCsv(b))}>Download sample CSV ({b.subType})</Button>
            <span className="text-xs text-slate-500">Up to {MAX_ROWS.toLocaleString('en-IN')} rows · first line = column names</span>
          </div>
          <details className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium text-slate-700">Columns you can import</summary>
            <ul className="mt-2 grid gap-x-6 gap-y-1 text-xs text-slate-600 sm:grid-cols-2">
              {fields.map((f) => <li key={f.key}><b className="font-medium text-slate-800">{f.label}</b>{f.required && <span className="text-red-600"> *</span>} — {f.hint}</li>)}
            </ul>
          </details>
        </div>
      )}

      {step === 2 && (
        <div>
          <p className="mb-3 text-sm text-slate-600">We matched your columns where we could. Check each one — choose <b>Don’t import</b> for anything you don’t need.</p>
          <div className="overflow-hidden rounded-xl border border-slate-200">
            <div className="hidden grid-cols-[1fr_1fr_1fr] gap-3 bg-slate-50 px-4 py-2 text-xs font-medium text-slate-500 sm:grid"><span>Field in BillPoodum</span><span>Your CSV column</span><span>First value</span></div>
            <ul className="max-h-[50vh] divide-y divide-slate-100 overflow-y-auto">
              {fields.map((f) => {
                const col = mapping[f.key]
                const first = col ? raw.find((r) => String(r[col] ?? '').trim())?.[col] ?? '' : ''
                return (
                  <li key={f.key} className="grid items-center gap-x-3 gap-y-1 px-4 py-2 sm:grid-cols-[1fr_1fr_1fr]">
                    <span className="text-sm">{f.label}{f.required && <span className="text-red-600"> *</span>}<span className="block text-[11px] text-slate-400">e.g. {f.hint}</span></span>
                    <Select value={col ?? ''} onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value || undefined })} aria-label={`Column for ${f.label}`}
                      className={clsx('h-9 text-sm', f.required && !col && !(f.key === 'price' && mapping.variants) && 'border-red-300')}>
                      <option value="">Don’t import</option>
                      {headers.map((h) => <option key={h} value={h} disabled={Object.entries(mapping).some(([k, v]) => v === h && k !== f.key)}>{h}</option>)}
                    </Select>
                    <span className="truncate text-sm text-slate-500" data-no-i18n>{col ? first || <i className="text-slate-400">empty</i> : '—'}</span>
                  </li>
                )
              })}
            </ul>
          </div>
          {unused.length > 0 && <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />Not used: {unused.join(', ')}</p>}
          {missingRequired.length > 0 && <p className="mt-2 text-sm text-red-600">Choose a column for {missingRequired.map((f) => f.label).join(' and ')}.</p>}
          <div className="mt-5 flex justify-between gap-2">
            <Button variant="ghost" icon={ArrowLeft} write={false} onClick={() => setStep(1)}>Choose another file</Button>
            <Button write={false} disabled={missingRequired.length > 0} onClick={goCheck}>Check rows <ArrowRight className="h-4 w-4" /></Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Segmented size="sm" value={filter} onChange={(v) => { setFilter(v); setLimit(PAGE) }} options={[
              { value: 'all', label: 'All', count: counts.all },
              { value: 'ready', label: 'Ready', count: counts.ready },
              { value: 'warnings', label: 'Warnings', count: counts.warnings },
              { value: 'errors', label: 'Errors', count: counts.errors },
              { value: 'existing', label: 'Already in shop', count: counts.existing },
            ]} />
            <span className="ml-auto text-sm text-slate-500"><b className="text-slate-900">{chosen.length}</b> selected</span>
          </div>
          <div className="max-h-[52vh] overflow-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="w-9 px-3 py-2 text-left">
                    <input type="checkbox" aria-label="Select all shown" checked={shown.filter(ok).length > 0 && shown.filter(ok).every(isSel)}
                      onChange={(e) => setSelected((s) => { const n = new Set(s); shown.filter(ok).forEach((r) => (e.target.checked ? n.add(r.index) : n.delete(r.index))); return n })} />
                  </th>
                  <th className="w-12 px-2 py-2 text-left font-medium">Row</th>
                  <th className="px-2 py-2 text-left font-medium">Name</th>
                  <th className="px-2 py-2 text-left font-medium">{t('category')}</th>
                  <th className="px-2 py-2 text-right font-medium">Price</th>
                  {extraCols.map((k) => <th key={k} className="px-2 py-2 text-left font-medium">{fields.find((f) => f.key === k)!.label}</th>)}
                  <th className="px-2 py-2 text-left font-medium">Check</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.slice(0, limit).map((r) => (
                  <tr key={r.index} className={clsx(!ok(r) ? 'bg-red-50/60' : isSel(r) ? '' : 'opacity-60')}>
                    <td className="px-3 py-1.5"><input type="checkbox" aria-label={`Import row ${r.index + 2}`} disabled={!ok(r)} checked={isSel(r)}
                      onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(r.index); else n.delete(r.index); return n })} /></td>
                    <td className="px-2 py-1.5 text-xs text-slate-400 tabular">{r.index + 2}</td>
                    <Cell v={value(r.index, 'name')} bad={r.errors.some((x) => x.startsWith('Name'))} onSave={(v) => setEdits({ ...edits, [r.index]: { ...edits[r.index], name: v } })} />
                    <td className="px-2 py-1.5"><span data-no-i18n>{r.item.categoryName || <span className="text-slate-400">—</span>}</span>{r.newCategory && <Badge tone="blue" className="ml-1.5">new</Badge>}</td>
                    <Cell v={value(r.index, 'price')} right display={r.item.variants?.length && !value(r.index, 'price') ? `from ${money(r.item.price)}` : value(r.index, 'price') && !Number.isNaN(Number(value(r.index, 'price').replace(/[₹,\s]/g, ''))) ? money(r.item.price) : undefined}
                      bad={r.errors.some((x) => x.startsWith('Price'))} onSave={(v) => setEdits({ ...edits, [r.index]: { ...edits[r.index], price: v } })} />
                    {extraCols.map((k) => <Cell key={k} v={value(r.index, k)} bad={r.errors.some((x) => x.toLowerCase().includes(fields.find((f) => f.key === k)!.label.toLowerCase().split(' ')[0]))} onSave={(v) => setEdits({ ...edits, [r.index]: { ...edits[r.index], [k]: v } })} />)}
                    <td className="max-w-[260px] px-2 py-1.5 text-xs">
                      {r.errors.map((e) => <p key={e} className="flex gap-1 text-red-600"><XCircle className="mt-px h-3.5 w-3.5 shrink-0" />{e}</p>)}
                      {!r.errors.length && r.existing && <p className="flex gap-1 text-sky-700"><Info className="mt-px h-3.5 w-3.5 shrink-0" />Already in shop — will be {onExisting === 'skip' ? 'skipped' : 'updated'}</p>}
                      {!r.errors.length && r.warnings.map((w) => <p key={w} className="flex gap-1 text-amber-700"><AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />{w}</p>)}
                      {ok(r) && !r.warnings.length && !r.existing && <p className="flex gap-1 text-emerald-700"><CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0" />Ready</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!shown.length && <p className="py-10 text-center text-sm text-slate-500">Nothing here</p>}
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span>Click a name, price or other value to fix it here. Rows with errors can’t be selected until they’re fixed.</span>
            {shown.length > limit && <Button size="sm" variant="ghost" write={false} onClick={() => setLimit(limit + PAGE)}>Show {Math.min(PAGE, shown.length - limit)} more</Button>}
          </div>
          <div className="mt-5 flex justify-between gap-2">
            <Button variant="ghost" icon={ArrowLeft} write={false} onClick={() => setStep(2)}>Match columns</Button>
            <Button write={false} disabled={!chosen.length} onClick={() => setStep(4)}>Review {chosen.length} row{chosen.length === 1 ? '' : 's'} <ArrowRight className="h-4 w-4" /></Button>
          </div>
        </div>
      )}

      {step === 4 && !result && (
        <div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={`New ${plural}`} value={summary.add} />
            <Stat label={`New ${t('category', true).toLowerCase()}`} value={summary.cats.length} hint={summary.cats.slice(0, 3).join(', ') + (summary.cats.length > 3 ? '…' : '')} />
            <Stat label="Opening stock" value={summary.stock.toLocaleString('en-IN')} />
            <Stat label="Not imported" value={summary.left} hint="errors or not selected" />
          </div>
          {summary.existing > 0 && (
            <div className="mt-4 rounded-xl border border-slate-200 p-4">
              <p className="text-sm font-medium">{summary.existing} row{summary.existing === 1 ? ' is' : 's are'} already in your shop (same barcode or name)</p>
              <Segmented size="sm" className="mt-2" value={onExisting} onChange={setOnExisting} options={[{ value: 'skip', label: 'Skip them' }, { value: 'update', label: 'Update them with the CSV values' }]} />
              <p className="mt-1.5 text-xs text-slate-500">{onExisting === 'update' ? 'Names, prices and other mapped fields are replaced. Stock isn’t changed — use Inventory for that.' : 'Nothing changes for those items.'}</p>
            </div>
          )}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" icon={ArrowLeft} write={false} onClick={() => setStep(3)}>Back to rows</Button>
            <Button icon={Upload} onClick={doImport} disabled={!chosen.length}>Import {summary.add + (onExisting === 'update' ? summary.existing : 0)} {plural}</Button>
          </div>
        </div>
      )}

      {step === 4 && result && (
        <div className="py-4 text-center">
          <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" />
          <h3 className="mt-2 text-lg font-semibold">Import done</h3>
          <p className="mt-1 text-sm text-slate-600">
            {result.created} added{result.updated ? ` · ${result.updated} updated` : ''}{result.skippedRows.length ? ` · ${result.skippedRows.length} already there (skipped)` : ''}
            {result.newCategories.length ? ` · new ${t('category', true).toLowerCase()}: ${result.newCategories.join(', ')}` : ''}
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {(summary.left > 0 || result.skippedRows.length > 0) && <Button variant="secondary" icon={Download} write={false} onClick={downloadLeftOut}>Download rows not imported</Button>}
            <Button icon={FileUp} write={false} onClick={onClose}>Done</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

/** Click to fix a value in place. */
function Cell({ v, display, bad, right, onSave }: { v: string; display?: string; bad?: boolean; right?: boolean; onSave: (v: string) => void }) {
  const [edit, setEdit] = useState(false)
  if (edit) {
    return (
      <td className="px-1 py-1">
        <input autoFocus defaultValue={v} aria-label="Edit value" className={clsx('h-8 w-full rounded border-brand-400 px-1.5 text-sm focus:ring-brand-500/20', right && 'text-right')}
          onBlur={(e) => { onSave(e.target.value); setEdit(false) }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEdit(false) }} />
      </td>
    )
  }
  return (
    <td className={clsx('max-w-[220px] cursor-text truncate px-2 py-1.5', right && 'text-right tabular', bad && 'font-medium text-red-600')} onClick={() => setEdit(true)} title="Click to edit" data-no-i18n>
      {display ?? (v || <span className="text-slate-300">empty</span>)}
    </td>
  )
}

const Stat = ({ label, value, hint }: { label: string; value: number | string; hint?: string }) => (
  <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">{label}</p><p className="text-2xl font-semibold tabular">{value}</p>{hint && <p className="truncate text-[11px] text-slate-400">{hint}</p>}</div>
)
