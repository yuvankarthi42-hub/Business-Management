import clsx from 'clsx'
import JsBarcode from 'jsbarcode'
import { Minus, Plus, Printer, QrCode, ScanBarcode, Settings2, Tag, Trash2, Wand2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { QrSvg } from '@/components/Qr'
import { Button, Checkbox, Field, Input, Modal, SearchInput, Segmented, useAction } from '@/components/ui'
import { detailsLine, isTextileShop, mrpDiscountsOn, STICKER_SIZES, stickerPrice, stickerSettings } from '@/core/stickers'
import type { BillingSettings, Product, StickerSettings, StickerSize } from '@/core/types'
import { api } from '@/data'
import { money } from '@/lib/format'
import { usePrint } from './Payment'

const fmtD = (iso: string) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '')
const isEan13 = (c: string) => /^\d{13}$/.test(c)
const rs = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const SIZE_KEYS = Object.keys(STICKER_SIZES) as StickerSize[]

/** SVG barcode (EAN-13 when the code is a valid 13-digit number, otherwise Code 128). */
export function BarcodeSvg({ value, height = 28, width = 1.4, fontSize = 10, className, text = true }: { value: string; height?: number; width?: number; fontSize?: number; className?: string; text?: boolean }) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (!ref.current || !value) return
    const opts = { height, width, fontSize, margin: 0, textMargin: 1, background: 'transparent', displayValue: text }
    try { JsBarcode(ref.current, value, { ...opts, format: isEan13(value) ? 'EAN13' : 'CODE128' }) }
    catch { try { JsBarcode(ref.current, value, { ...opts, format: 'CODE128' }) } catch { /* unprintable */ } }
  }, [value, height, width, fontSize, text])
  return <svg ref={ref} className={className} />
}

/** Extra lines for packed goods (grocery / bakery): packed-on and best-before dates. */
export interface StickerExtras { packed?: string; expiry?: string; useBatchExpiry?: boolean }

/**
 * One price sticker, drawn in millimetres so the printout matches the label roll exactly.
 * Discount on (and below MRP): MRP struck through, the % off and the offer price. Otherwise MRP only.
 */
export function PriceSticker({ p, st, billing, shopName, extras = {} }: {
  p: Product; st: StickerSettings; billing: Pick<BillingSettings, 'mrpDiscounts'>; shopName: string; extras?: StickerExtras
}) {
  const s = STICKER_SIZES[st.size]
  const compact = s.h < 30
  const narrow = s.w < 45
  const price = stickerPrice(p, billing, st.priceMode)
  const code = p.barcode.trim()
  const perKg = ['kg', 'g', 'ltr', 'ml', 'mtr'].includes(p.unit) ? `/${p.unit}` : ''
  const design = st.showDesign ? p.details?.design || p.sku : ''
  const info = [design, st.showDetails ? detailsLine(p.details) : ''].filter(Boolean).join(' · ')
  const expiry = extras.expiry || (extras.useBatchExpiry && p.trackExpiry ? p.nextExpiry ?? '' : '')
  const dates = (extras.packed || expiry) && (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '5.5pt' }}>
      {extras.packed ? <span>Pkd {fmtD(extras.packed)}</span> : <span />}
      {expiry && <span style={{ fontWeight: 700 }}>Exp {fmtD(expiry)}</span>}
    </div>
  )
  const one = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const
  const box = { width: `${s.w}mm`, height: `${s.h}mm`, padding: compact ? '1mm 1.4mm' : '1.6mm 2mm', boxSizing: 'border-box', overflow: 'hidden', display: 'flex', flexDirection: 'column', fontFamily: 'Arial, Helvetica, sans-serif', color: '#000', background: '#fff', lineHeight: 1.12 } as const

  const priceBlock = (big: number, align: 'left' | 'right' = 'left') => price.off > 0 ? (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align === 'left' ? 'flex-start' : 'flex-end', gap: '0.3mm' }}>
      <span style={{ fontSize: `${big * 0.55}pt` }}>MRP <s>{rs(price.mrp)}</s></span>
      <span style={{ fontSize: `${big * 0.5}pt`, fontWeight: 800, background: '#000', color: '#fff', padding: '0.2mm 1mm', borderRadius: '0.6mm' }}>{price.pct > 0 ? `${price.pct}% OFF` : `SAVE ${rs(price.off)}`}</span>
      <span style={{ fontSize: `${big}pt`, fontWeight: 800, letterSpacing: '-0.02em' }}>{rs(price.price)}{perKg}</span>
    </div>
  ) : (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align === 'left' ? 'flex-start' : 'flex-end' }}>
      <span style={{ fontSize: `${big * 0.5}pt`, fontWeight: 700 }}>MRP</span>
      <span style={{ fontSize: `${big}pt`, fontWeight: 800, letterSpacing: '-0.02em' }}>{rs(price.mrp)}{perKg}</span>
      {!compact && <span style={{ fontSize: '5pt' }}>Incl. of all taxes</span>}
    </div>
  )
  const noCode = <span style={{ fontSize: '6pt', border: '0.3mm dashed #000', padding: '1mm' }}>No code</span>

  // ---- QR stickers ----
  if (st.code === 'qr') {
    const qr = compact ? s.h - 2.2 : Math.min(21, s.h - 15)
    return (
      <div className="label" style={box} data-no-i18n>
        {!compact && st.showShop && <div style={{ ...one, fontSize: '7pt', fontWeight: 800, textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{shopName}</div>}
        {!compact && st.showName && <div style={{ ...one, fontSize: '7.5pt', fontWeight: 600, marginTop: '0.4mm' }}>{p.name}</div>}
        {!compact && info && <div style={{ ...one, fontSize: '6pt', marginTop: '0.2mm' }}>{info}</div>}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', gap: compact ? '1.2mm' : '2mm', marginTop: compact ? 0 : '0.8mm' }}>
          <div style={{ flexShrink: 0, width: `${qr}mm`, height: `${qr}mm`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{code ? <QrSvg value={code} size={`${qr}mm`} /> : noCode}</div>
          <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '0.3mm' }}>
            {compact && st.showShop && <div style={{ ...one, fontSize: '5.5pt', fontWeight: 800, textTransform: 'uppercase' }}>{shopName}</div>}
            {compact && st.showName && <div style={{ ...one, fontSize: narrow ? '5.5pt' : '6.5pt', fontWeight: 600 }}>{p.name}</div>}
            {compact && info && <div style={{ ...one, fontSize: '5pt' }}>{info}</div>}
            {priceBlock(compact ? (narrow ? 8 : 9) : 13)}
          </div>
        </div>
        {!compact && (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1mm', fontSize: '5.5pt', marginTop: '0.4mm' }}>
            <span style={{ fontFamily: 'monospace' }}>{code}</span>
            {st.footer && <span style={{ ...one, minWidth: 0 }}>{st.footer}</span>}
          </div>
        )}
        {dates}
      </div>
    )
  }

  // ---- Barcode stickers (1D laser scanners) ----
  return (
    <div className="label" style={box} data-no-i18n>
      {st.showShop && <div style={{ ...one, fontSize: compact ? '5.5pt' : '7pt', fontWeight: 700, textAlign: 'center' }}>{shopName}</div>}
      {st.showName && <div style={{ ...one, fontSize: compact ? '6.5pt' : '7.5pt', fontWeight: 600 }}>{p.name}</div>}
      {!compact && info && <div style={{ ...one, fontSize: '6pt' }}>{info}</div>}
      {compact ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '1mm' }}>
          <span style={{ fontSize: narrow ? '8pt' : '9.5pt', fontWeight: 800 }}>{rs(price.price)}{perKg}</span>
          {price.off > 0 ? <span style={{ fontSize: '6pt' }}>MRP <s>{rs(price.mrp)}</s></span> : <span style={{ fontSize: '6pt' }}>MRP</span>}
        </div>
      ) : <div style={{ marginTop: '0.6mm' }}>{priceBlock(11)}</div>}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {code ? <BarcodeSvg value={code} height={compact ? (s.h < 24 ? 16 : 22) : 30} width={narrow ? 1 : 1.25} fontSize={8} className="max-h-full max-w-full" /> : noCode}
      </div>
      {!compact && st.footer && <div style={{ ...one, fontSize: '5.5pt', textAlign: 'center' }}>{st.footer}</div>}
      {dates}
    </div>
  )
}

/** Stickers laid out for printing. Each roll sticker is its own page; A4 packs 5 × 13. */
function StickerSheet({ items, st, billing, shopName, extras }: { items: Product[]; st: StickerSettings; billing: BillingSettings; shopName: string; extras: StickerExtras }) {
  const s = STICKER_SIZES[st.size]
  const page = s.sheet ? '@page { size: A4; margin: 10.7mm 4.7mm; }' : `@page { size: ${s.w}mm ${s.h}mm; margin: 0; }`
  return (
    <>
      <style>{`${page} @media print { #print-area .label { break-inside: avoid; } ${s.sheet ? '' : '#print-area .label { break-after: page; }'} }`}</style>
      <div style={s.sheet ? { display: 'grid', gridTemplateColumns: `repeat(5, ${s.w}mm)`, columnGap: '2.5mm' } : undefined}>
        {items.map((p, i) => <PriceSticker key={i} p={p} st={st} billing={billing} shopName={shopName} extras={extras} />)}
      </div>
    </>
  )
}

/** A made-up item for the settings preview when the shop has none yet. */
export const SAMPLE_PRODUCT: Product = {
  id: 'sample', businessId: '', name: 'Kanchipuram Silk Saree', categoryId: null, kind: 'goods', emoji: '', sku: 'KS-1024', barcode: '2000000010248', unit: 'pc',
  price: 10800, mrp: 12000, costPrice: 0, variants: [], addOns: [], taxRateId: null, trackStock: false, stock: 0, lowStockAt: 0, isVeg: true, sendToKitchen: false, active: true,
  details: { design: 'KS-1024', fabric: 'Pure silk', colour: 'Maroon' }, createdAt: '', createdBy: '', updatedAt: '', updatedBy: '',
}

/** Sticker preview, scaled up for the screen. */
export function StickerPreview({ p, st, billing, shopName, extras }: { p: Product; st: StickerSettings; billing: Pick<BillingSettings, 'mrpDiscounts'>; shopName: string; extras?: StickerExtras }) {
  const s = STICKER_SIZES[st.size]
  const scale = s.w < 45 ? 1.6 : s.h < 30 ? 1.45 : 1.35
  return (
    <div className="flex items-center justify-center overflow-hidden rounded-xl bg-[repeating-linear-gradient(45deg,#f1f5f9,#f1f5f9_8px,#e9eef5_8px,#e9eef5_16px)] p-4" style={{ minHeight: `calc(${s.h * scale}mm + 2rem)` }} data-no-i18n>
      <div style={{ transform: `scale(${scale})`, transformOrigin: 'center' }} className="rounded-[1mm] shadow-md ring-1 ring-slate-300">
        <PriceSticker p={p} st={st} billing={billing} shopName={shopName} extras={extras} />
      </div>
    </div>
  )
}

/** Size, code type, what to print and the price rule. Used by Settings → Price stickers and the print window. */
export function StickerOptions({ st, onChange, billing, compact }: { st: StickerSettings; onChange: (st: StickerSettings) => void; billing: Pick<BillingSettings, 'mrpDiscounts'>; compact?: boolean }) {
  const set = <K extends keyof StickerSettings>(k: K, v: StickerSettings[K]) => onChange({ ...st, [k]: v })
  return (
    <div className="space-y-4">
      <Field label="Sticker size">
        <Segmented size="sm" block value={st.size} onChange={(v) => set('size', v)} options={SIZE_KEYS.map((k) => ({ value: k, label: k === 'a4' ? 'A4 sheet' : k.replace('x', '×') }))} />
        <p className="mt-1 text-xs text-slate-500">{STICKER_SIZES[st.size].name}{st.size === '50x38' ? ' — best for sarees and garments' : ''}</p>
      </Field>
      <Field label="Code on the sticker">
        <div className="grid grid-cols-2 gap-2">
          {([['qr', QrCode, 'QR code', '2D / camera scanners'], ['barcode', ScanBarcode, 'Barcode', 'Laser (1D) scanners']] as const).map(([v, Icon, label, hint]) => (
            <button key={v} type="button" onClick={() => set('code', v)} aria-pressed={st.code === v}
              className={clsx('flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition', st.code === v ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-slate-200 hover:border-slate-300')}>
              <Icon className={clsx('h-5 w-5 shrink-0', st.code === v ? 'text-brand-600' : 'text-slate-400')} />
              <span className="min-w-0"><span className="block text-sm font-medium">{label}</span><span className="block text-[11px] text-slate-500">{hint}</span></span>
            </button>
          ))}
        </div>
      </Field>
      <div>
        <p className="mb-1.5 text-xs font-medium text-slate-600">Show on the sticker</p>
        <div className={clsx('grid gap-2', compact ? 'grid-cols-1' : 'sm:grid-cols-2')}>
          <Checkbox checked={st.showShop} onChange={(v) => set('showShop', v)} label="Shop name" />
          <Checkbox checked={st.showName} onChange={(v) => set('showName', v)} label="Item name" />
          <Checkbox checked={st.showDesign} onChange={(v) => set('showDesign', v)} label="Design no. / SKU" />
          <Checkbox checked={st.showDetails} onChange={(v) => set('showDetails', v)} label="Colour, size and fabric" />
        </div>
      </div>
      <Field label="Price on the sticker">
        <Segmented size="sm" block value={st.priceMode} onChange={(v) => set('priceMode', v)} options={[{ value: 'auto', label: 'MRP + discount' }, { value: 'mrp', label: 'MRP only' }]} />
        <p className="mt-1 text-xs text-slate-500">
          {!mrpDiscountsOn(billing) ? 'Customer discount is off (Settings → Billing), so stickers show MRP only and bills charge MRP.'
            : st.priceMode === 'auto' ? 'Items sold below MRP show MRP struck through, the % off and the offer price. Others show MRP only.'
              : 'Only the MRP is printed. The bill still gives the item’s discount.'}
        </p>
      </Field>
      {!compact && (
        <div className="grid gap-4 sm:grid-cols-[1fr_150px]">
          <Field label="Bottom line" hint="Optional, up to 40 letters"><Input value={st.footer} maxLength={40} onChange={(e) => set('footer', e.target.value)} placeholder="No exchange after 7 days" /></Field>
          <Field label="Stickers per item" hint="When printing"><Input type="number" min={1} max={50} inputMode="numeric" value={st.copies} onChange={(e) => set('copies', Math.max(1, Math.min(50, Math.floor(Number(e.target.value)) || 1)))} /></Field>
        </div>
      )}
    </div>
  )
}

/** Settings → Price stickers: the shop's sticker layout, with a live preview and a test print. */
export function StickerSettingsPanel({ Section }: { Section: (p: { title: string; subtitle?: string; children: ReactNode; onSave?: () => void; dirty?: boolean }) => ReactNode }) {
  const { me } = useApp()
  const run = useAction()
  const saved = stickerSettings(me!.business)
  const [st, setSt] = useState<StickerSettings>(saved)
  const original = JSON.stringify(saved)
  useEffect(() => { setSt(stickerSettings(me!.business)) }, [original]) // eslint-disable-line react-hooks/exhaustive-deps
  const { data: products = [] } = useData(() => api.products.list())
  const sample = useMemo(() => products.find((p) => p.active && p.barcode && p.mrp && p.mrp > p.price) ?? products.find((p) => p.active && p.barcode) ?? SAMPLE_PRODUCT, [products])
  const { print, portal } = usePrint()
  const billing = me!.business.billing
  return (
    <Section title="Price stickers" subtitle="QR or barcode stickers with shop name, MRP and discount — scanned at billing, returns and stock-in" onSave={() => run(() => api.business.update({ stickers: st }), 'Sticker settings saved')} dirty={JSON.stringify(st) !== original}>
      {portal}
      <div className="grid gap-6 lg:grid-cols-[1fr_minmax(260px,340px)]">
        <StickerOptions st={st} onChange={setSt} billing={billing} />
        <div className="space-y-3">
          <p className="text-xs font-medium text-slate-600">Preview {sample === SAMPLE_PRODUCT ? <span className="font-normal text-slate-400">· sample item</span> : <span className="font-normal text-slate-400">· {sample.name}</span>}</p>
          <StickerPreview p={sample} st={st} billing={billing} shopName={me!.business.name} />
          <div className="rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
            <p className="font-medium text-slate-700">Printing tips</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>Label printer (TSC, Zebra, TVS): set the paper to {STICKER_SIZES[st.size].sheet ? 'A4' : `${STICKER_SIZES[st.size].w} × ${STICKER_SIZES[st.size].h} mm`} and scale to 100% (“Actual size”).</li>
              <li>Print one test sticker and scan it at billing before printing a whole lot.</li>
            </ul>
          </div>
          <Button variant="secondary" icon={Printer} block onClick={() => print(<StickerSheet items={[sample]} st={st} billing={billing} shopName={me!.business.name} extras={{}} />)}>Print a test sticker</Button>
        </div>
      </div>
    </Section>
  )
}

/**
 * Choose items and how many stickers of each, then print. `initial` sets the counts (e.g. one per piece after
 * stock-in or a new design); otherwise each item gets the shop's "stickers per item".
 */
export function LabelPrintModal({ initialIds = [], initial, onClose, title }: { initialIds?: string[]; initial?: { id: string; count: number }[]; onClose: () => void; title?: string }) {
  const { me, t, can } = useApp()
  const run = useAction()
  const b = me!.business
  const textile = isTextileShop(b)
  const { data: products = [] } = useData(() => api.products.list())
  const [st, setSt] = useState<StickerSettings>(() => stickerSettings(b))
  const [rows, setRows] = useState<{ id: string; count: number }[]>(() => initial ?? initialIds.map((id) => ({ id, count: stickerSettings(b).copies })))
  const [q, setQ] = useState('')
  const [extras, setExtras] = useState<StickerExtras>({ useBatchExpiry: true })
  const [showOptions, setShowOptions] = useState(false)
  const { print, portal } = usePrint()

  const byId = (id: string) => products.find((p) => p.id === id)
  const chosen = rows.map((r) => ({ ...r, p: byId(r.id) })).filter((r): r is { id: string; count: number; p: Product } => !!r.p)
  const missing = chosen.filter((r) => !r.p.barcode.trim())
  const printable = chosen.filter((r) => r.p.barcode.trim())
  const total = printable.reduce((a, r) => a + r.count, 0)
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return []
    return products.filter((p) => p.active && !rows.some((r) => r.id === p.id) && (p.name.toLowerCase().includes(s) || p.barcode.includes(s) || p.sku.toLowerCase().includes(s) || (p.details?.design ?? '').toLowerCase().includes(s))).slice(0, 8)
  }, [q, products, rows])
  const add = (id: string) => { setRows((r) => [...r, { id, count: st.copies }]); setQ('') }
  const setCount = (id: string, n: number) => setRows((r) => r.map((x) => (x.id === id ? { ...x, count: Math.max(1, Math.min(500, n || 1)) } : x)))
  const labels = printable.flatMap((r) => Array.from({ length: r.count }, () => r.p))
  const sample = (printable[0] ?? chosen[0])?.p
  const changed = JSON.stringify(st) !== JSON.stringify(stickerSettings(b))
  const sheet = STICKER_SIZES[st.size]

  return (
    <Modal open onClose={onClose} size="xl" title={title ?? (textile ? 'Print price stickers' : 'Print barcode labels')}
      subtitle={st.code === 'qr' ? 'QR stickers scan at billing, returns and stock-in. Works with label printers (TSC, Zebra, TVS) and A4 sticker sheets.' : 'For loose and own-packed items. Works with label printers (TSC, Zebra, TVS) and A4 sticker sheets.'}>
      {portal}
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0">
          <div className="relative">
            <SearchInput autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Add ${t('product').toLowerCase()} — name, ${textile ? 'design no.' : 'SKU'} or code`}
              onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) { e.preventDefault(); add(matches[0].id) } }} />
            {!!matches.length && (
              <div className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
                {matches.map((p) => (
                  <button key={p.id} type="button" onClick={() => add(p.id)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50">
                    <span className="min-w-0 truncate font-medium">{p.name}</span>
                    <span className="shrink-0 font-mono text-xs text-slate-500">{p.barcode || 'no code'}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="mt-3 max-h-[46vh] divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200">
            {chosen.map((r) => {
              const pr = stickerPrice(r.p, b.billing, st.priceMode)
              return (
                <div key={r.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{r.p.name}</p>
                    <p className="text-xs text-slate-500">
                      {r.p.barcode ? <span className="font-mono">{r.p.barcode}</span> : <span className="font-medium text-amber-700">No code</span>}
                      {' · '}{pr.off > 0 ? <><s className="text-slate-400">{money(pr.mrp)}</s> <b className="text-emerald-700">{money(pr.price)}</b> ({pr.pct}% off)</> : <>MRP {money(pr.mrp)}</>}
                      {r.p.trackStock && <> · {r.p.stock} in stock</>}
                      {r.p.trackExpiry && r.p.nextExpiry && <> · exp {fmtD(r.p.nextExpiry)}</>}
                    </p>
                  </div>
                  <div className="flex items-center rounded-lg border border-slate-200">
                    <button type="button" aria-label="Fewer" className="p-1.5 text-slate-500 hover:text-slate-900" onClick={() => setCount(r.id, r.count - 1)}><Minus className="h-4 w-4" /></button>
                    <input aria-label="Stickers" inputMode="numeric" value={r.count} onChange={(e) => setCount(r.id, Number(e.target.value.replace(/\D/g, '')))} className="w-12 border-0 p-0 text-center text-sm font-semibold tabular focus:ring-0" />
                    <button type="button" aria-label="More" className="p-1.5 text-slate-500 hover:text-slate-900" onClick={() => setCount(r.id, r.count + 1)}><Plus className="h-4 w-4" /></button>
                  </div>
                  {r.p.trackStock && r.p.stock > 0 && r.count !== r.p.stock && <button type="button" className="hidden whitespace-nowrap text-xs font-medium text-brand-600 hover:underline sm:block" onClick={() => setCount(r.id, r.p.stock)} title="One sticker per piece in stock">= stock</button>}
                  <button type="button" aria-label="Remove" className="p-1 text-slate-400 hover:text-red-600" onClick={() => setRows((x) => x.filter((y) => y.id !== r.id))}><Trash2 className="h-4 w-4" /></button>
                </div>
              )
            })}
            {!chosen.length && <p className="flex flex-col items-center gap-2 py-12 text-center text-sm text-slate-500"><Tag className="h-6 w-6 text-slate-300" />Search above to add items to print</p>}
          </div>

          {!!missing.length && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
              <span className="flex-1">{missing.length} item{missing.length > 1 ? 's have' : ' has'} no code, so {missing.length > 1 ? 'they' : 'it'} can’t be scanned. Create in-store codes (they start with 20).</span>
              <Button size="sm" variant="secondary" icon={Wand2} onClick={() => run(() => api.products.assignBarcodes(missing.map((m) => m.id)), 'Codes created')}>Create codes</Button>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div>
            <p className="mb-1.5 text-xs font-medium text-slate-600">Preview</p>
            {sample ? <StickerPreview p={sample} st={st} billing={b.billing} shopName={b.name} extras={extras} />
              : <div className="flex min-h-[150px] items-center justify-center rounded-xl bg-slate-100 text-xs text-slate-400">Add an item</div>}
          </div>
          <button type="button" onClick={() => setShowOptions((v) => !v)} className="flex w-full items-center justify-between rounded-xl border border-slate-200 px-3 py-2.5 text-left text-sm hover:bg-slate-50" aria-expanded={showOptions}>
            <span className="flex items-center gap-2"><Settings2 className="h-4 w-4 text-slate-400" /><span><span className="font-medium">{st.size === 'a4' ? 'A4 sheet' : st.size.replace('x', ' × ') + ' mm'}</span> · {st.code === 'qr' ? 'QR code' : 'Barcode'} · {st.priceMode === 'auto' && mrpDiscountsOn(b.billing) ? 'MRP + discount' : 'MRP only'}</span></span>
            <span className="text-xs font-medium text-brand-600">{showOptions ? 'Done' : 'Change'}</span>
          </button>
          {showOptions && (
            <div className="rounded-xl border border-slate-200 p-3">
              <StickerOptions st={st} onChange={setSt} billing={b.billing} compact />
              {!textile && (
                <div className="mt-4 space-y-3 border-t border-slate-100 pt-3">
                  <Checkbox checked={!!extras.useBatchExpiry} onChange={(v) => setExtras({ ...extras, useBatchExpiry: v })} label="Expiry from stock batch" />
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Packed on"><Input type="date" value={extras.packed ?? ''} onChange={(e) => setExtras({ ...extras, packed: e.target.value })} /></Field>
                    <Field label="Best before"><Input type="date" value={extras.expiry ?? ''} onChange={(e) => setExtras({ ...extras, expiry: e.target.value })} /></Field>
                  </div>
                </div>
              )}
              {changed && can('settings.manage') && (
                <button type="button" className="mt-3 text-xs font-medium text-brand-600 hover:underline" onClick={() => run(() => api.business.update({ stickers: st }), 'Saved as the shop’s sticker settings')}>Save as the shop’s default</button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-4">
        <span className="mr-auto text-sm text-slate-500">{total} sticker{total === 1 ? '' : 's'}{sheet.sheet && total ? ` · ${Math.ceil(total / (sheet.perSheet ?? 65))} sheet${total > (sheet.perSheet ?? 65) ? 's' : ''}` : ''}{missing.length ? ` · ${missing.length} without a code skipped` : ''}</span>
        <Button variant="ghost" onClick={onClose}>Close</Button>
        <Button icon={Printer} disabled={!total} onClick={() => print(<StickerSheet items={labels} st={st} billing={b.billing} shopName={b.name} extras={extras} />)}>Print {total || ''} sticker{total === 1 ? '' : 's'}</Button>
      </div>
    </Modal>
  )
}
