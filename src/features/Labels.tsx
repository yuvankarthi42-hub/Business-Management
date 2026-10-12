import clsx from 'clsx'
import JsBarcode from 'jsbarcode'
import { Minus, Plus, Printer, Tag, Trash2, Wand2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { Button, Checkbox, Field, Input, Modal, SearchInput, Segmented, useAction } from '@/components/ui'
import type { Product } from '@/core/types'
import { api } from '@/data'
import { money } from '@/lib/format'
import { usePrint } from './Payment'

/** Label stock: thermal label rolls (one label per "page") or an A4 sticker sheet. */
const SIZES = {
  '50x25': { name: '50 × 25 mm roll', w: 50, h: 25, sheet: false },
  '38x25': { name: '38 × 25 mm roll', w: 38, h: 25, sheet: false },
  a4: { name: 'A4 sheet · 65 labels', w: 38.1, h: 21.2, sheet: true },
} as const
type SizeKey = keyof typeof SIZES
const PREF_KEY = 'billpoodum.labels'

interface Opts { size: SizeKey; shop: boolean; price: boolean; mrp: boolean; packed: string; expiry: string; useBatchExpiry: boolean }

const loadOpts = (): Opts => {
  const base: Opts = { size: '50x25', shop: true, price: true, mrp: true, packed: '', expiry: '', useBatchExpiry: true }
  try { return { ...base, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}'), packed: '', expiry: '' } } catch { return base }
}
const fmtD = (iso: string) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '')
const isEan13 = (c: string) => /^\d{13}$/.test(c)

/** SVG barcode (EAN-13 when the code is a valid 13-digit number, otherwise Code 128). */
export function BarcodeSvg({ value, height = 28, width = 1.4, fontSize = 10, className }: { value: string; height?: number; width?: number; fontSize?: number; className?: string }) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (!ref.current || !value) return
    const opts = { height, width, fontSize, margin: 0, textMargin: 1, background: 'transparent' }
    try { JsBarcode(ref.current, value, { ...opts, format: isEan13(value) ? 'EAN13' : 'CODE128' }) }
    catch { try { JsBarcode(ref.current, value, { ...opts, format: 'CODE128' }) } catch { /* unprintable */ } }
  }, [value, height, width, fontSize])
  return <svg ref={ref} className={className} />
}

function Label({ p, o, shopName }: { p: Product; o: Opts; shopName: string }) {
  const s = SIZES[o.size]
  const small = s.w < 45
  const expiry = o.expiry || (o.useBatchExpiry && p.trackExpiry ? p.nextExpiry ?? '' : '')
  const showMrp = o.mrp && p.mrp && p.mrp > p.price
  return (
    <div className="label" style={{ width: `${s.w}mm`, height: `${s.h}mm`, padding: '1.2mm 1.6mm', boxSizing: 'border-box', overflow: 'hidden', display: 'flex', flexDirection: 'column', fontFamily: 'Arial, sans-serif', color: '#000', lineHeight: 1.1 }}>
      {o.shop && <div style={{ fontSize: small ? '5.5pt' : '6.5pt', fontWeight: 700, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{shopName}</div>}
      <div style={{ fontSize: small ? '6.5pt' : '7.5pt', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
      {(o.price || showMrp) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '1mm' }}>
          {o.price && <span style={{ fontSize: small ? '8pt' : '9.5pt', fontWeight: 800 }}>{money(p.price)}{['kg', 'g', 'ltr', 'ml'].includes(p.unit) ? `/${p.unit}` : ''}</span>}
          {showMrp && <span style={{ fontSize: '6pt' }}>MRP {money(p.mrp!)}</span>}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {p.barcode ? <BarcodeSvg value={p.barcode} height={s.h < 24 ? 16 : 22} width={small ? 1 : 1.25} fontSize={8} className="max-h-full max-w-full" /> : <span style={{ fontSize: '6pt' }}>No barcode</span>}
      </div>
      {(o.packed || expiry) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '5.5pt' }}>
          {o.packed ? <span>Pkd {fmtD(o.packed)}</span> : <span />}
          {expiry && <span style={{ fontWeight: 700 }}>Exp {fmtD(expiry)}</span>}
        </div>
      )}
    </div>
  )
}

/** Sheet of labels for printing. Each roll label is its own page; A4 packs 5 × 13. */
function LabelSheet({ labels, o, shopName }: { labels: Product[]; o: Opts; shopName: string }) {
  const s = SIZES[o.size]
  const page = s.sheet ? '@page { size: A4; margin: 10.7mm 4.7mm; }' : `@page { size: ${s.w}mm ${s.h}mm; margin: 0; }`
  return (
    <>
      <style>{`${page} @media print { #print-area .label { break-inside: avoid; } ${s.sheet ? '' : '#print-area .label { break-after: page; }'} }`}</style>
      <div style={s.sheet ? { display: 'grid', gridTemplateColumns: `repeat(5, ${s.w}mm)`, columnGap: '2.5mm' } : undefined}>
        {labels.map((p, i) => <Label key={i} p={p} o={o} shopName={shopName} />)}
      </div>
    </>
  )
}

/** Choose products and counts, pick a label size and what to show, then print. */
export function LabelPrintModal({ initialIds = [], onClose }: { initialIds?: string[]; onClose: () => void }) {
  const { me, t } = useApp()
  const run = useAction()
  const { data: products = [] } = useData(() => api.products.list())
  const [rows, setRows] = useState<{ id: string; count: number }[]>(() => initialIds.map((id) => ({ id, count: 1 })))
  const [q, setQ] = useState('')
  const [o, setO] = useState<Opts>(loadOpts)
  const { print, portal } = usePrint()
  useEffect(() => { try { const { packed: _p, expiry: _e, ...keep } = o; localStorage.setItem(PREF_KEY, JSON.stringify(keep)) } catch { /* private mode */ } }, [o])

  const byId = (id: string) => products.find((p) => p.id === id)
  const chosen = rows.map((r) => ({ ...r, p: byId(r.id) })).filter((r): r is { id: string; count: number; p: Product } => !!r.p)
  const missing = chosen.filter((r) => !r.p.barcode.trim())
  const total = chosen.reduce((a, r) => a + r.count, 0)
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return []
    return products.filter((p) => p.active && !rows.some((r) => r.id === p.id) && (p.name.toLowerCase().includes(s) || p.barcode.includes(s) || p.sku.toLowerCase().includes(s))).slice(0, 8)
  }, [q, products, rows])
  const add = (id: string) => { setRows((r) => [...r, { id, count: 1 }]); setQ('') }
  const setCount = (id: string, n: number) => setRows((r) => r.map((x) => (x.id === id ? { ...x, count: Math.max(1, Math.min(500, n || 1)) } : x)))
  const labels = chosen.flatMap((r) => Array.from({ length: r.count }, () => r.p))
  const shopName = me?.business.name ?? ''
  const sample = chosen[0]?.p

  return (
    <Modal open onClose={onClose} size="xl" title="Print barcode labels" subtitle="For loose and own-packed items. Works with label printers (TSC, Zebra, TVS) and A4 sticker sheets.">
      {portal}
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <div className="min-w-0">
          <div className="relative">
            <SearchInput autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Add ${t('product').toLowerCase()} — name, barcode or SKU`}
              onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) { e.preventDefault(); add(matches[0].id) } }} />
            {!!matches.length && (
              <div className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
                {matches.map((p) => (
                  <button key={p.id} type="button" onClick={() => add(p.id)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50">
                    <span className="min-w-0 truncate font-medium">{p.name}</span>
                    <span className="shrink-0 font-mono text-xs text-slate-500">{p.barcode || 'no barcode'}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="mt-3 max-h-[46vh] divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200">
            {chosen.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.p.name}</p>
                  <p className="text-xs text-slate-500">
                    {r.p.barcode ? <span className="font-mono">{r.p.barcode}</span> : <span className="font-medium text-amber-700">No barcode</span>} · {money(r.p.price)}
                    {r.p.trackExpiry && r.p.nextExpiry && <> · exp {fmtD(r.p.nextExpiry)}</>}
                  </p>
                </div>
                <div className="flex items-center rounded-lg border border-slate-200">
                  <button type="button" aria-label="Fewer" className="p-1.5 text-slate-500 hover:text-slate-900" onClick={() => setCount(r.id, r.count - 1)}><Minus className="h-4 w-4" /></button>
                  <input aria-label="Labels" inputMode="numeric" value={r.count} onChange={(e) => setCount(r.id, Number(e.target.value.replace(/\D/g, '')))} className="w-12 border-0 p-0 text-center text-sm font-semibold tabular focus:ring-0" />
                  <button type="button" aria-label="More" className="p-1.5 text-slate-500 hover:text-slate-900" onClick={() => setCount(r.id, r.count + 1)}><Plus className="h-4 w-4" /></button>
                </div>
                <button type="button" aria-label="Remove" className="p-1 text-slate-400 hover:text-red-600" onClick={() => setRows((x) => x.filter((y) => y.id !== r.id))}><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
            {!chosen.length && <p className="flex flex-col items-center gap-2 py-12 text-center text-sm text-slate-500"><Tag className="h-6 w-6 text-slate-300" />Search above to add items to print</p>}
          </div>

          {!!missing.length && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
              <span className="flex-1">{missing.length} item{missing.length > 1 ? 's have' : ' has'} no barcode. Create in-store barcodes (start with 20) so they scan at billing.</span>
              <Button size="sm" variant="secondary" icon={Wand2} onClick={() => run(() => api.products.assignBarcodes(missing.map((m) => m.id)), 'Barcodes created')}>Create barcodes</Button>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <Field label="Label size">
            <Segmented size="sm" block value={o.size} onChange={(v) => setO({ ...o, size: v })} options={(Object.keys(SIZES) as SizeKey[]).map((k) => ({ value: k, label: k === 'a4' ? 'A4 sheet' : k.replace('x', '×') }))} />
            <p className="mt-1 text-xs text-slate-500">{SIZES[o.size].name}</p>
          </Field>
          <div className="flex flex-col items-start gap-2">
            <p className="text-xs font-medium text-slate-600">Show on label</p>
            <Checkbox checked={o.shop} onChange={(v) => setO({ ...o, shop: v })} label="Shop name" />
            <Checkbox checked={o.price} onChange={(v) => setO({ ...o, price: v })} label="Selling price" />
            <Checkbox checked={o.mrp} onChange={(v) => setO({ ...o, mrp: v })} label="MRP (when higher than price)" />
            <Checkbox checked={o.useBatchExpiry} onChange={(v) => setO({ ...o, useBatchExpiry: v })} label="Expiry from stock batch" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Packed on"><Input type="date" value={o.packed} onChange={(e) => setO({ ...o, packed: e.target.value })} /></Field>
            <Field label="Best before"><Input type="date" value={o.expiry} onChange={(e) => setO({ ...o, expiry: e.target.value })} /></Field>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-slate-600">Preview</p>
            <div className="flex min-h-[150px] items-center justify-center overflow-hidden rounded-xl bg-slate-100 p-4" data-no-i18n>
              {sample ? <div className={clsx('origin-center bg-white shadow ring-1 ring-slate-200', SIZES[o.size].w < 45 ? 'scale-[1.5]' : 'scale-[1.25]')}><Label p={sample} o={o} shopName={shopName} /></div> : <span className="text-xs text-slate-400">Add an item</span>}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-4">
        <span className="mr-auto text-sm text-slate-500">{total} label{total === 1 ? '' : 's'}{SIZES[o.size].sheet && total ? ` · ${Math.ceil(total / 65)} sheet${total > 65 ? 's' : ''}` : ''}</span>
        <Button variant="ghost" onClick={onClose}>Close</Button>
        <Button icon={Printer} disabled={!total} onClick={() => print(<LabelSheet labels={labels} o={o} shopName={shopName} />)}>Print {total || ''} label{total === 1 ? '' : 's'}</Button>
      </div>
    </Modal>
  )
}
