// Textile shops (silk, sarees, garments): add a design in many colours / sizes at once, and discount a category.
// Both end with "print the stickers" so new prices and new pieces are labelled straight away.
import clsx from 'clsx'
import { CheckCircle2, Layers, Percent, Printer, X } from 'lucide-react'
import { useMemo, useState, type KeyboardEvent } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { PhotoDrop } from '@/components/Thumb'
import { Button, Field, Input, Modal, Select, useAction } from '@/components/ui'
import { discountedPrice } from '@/core/stickers'
import { MAX_DESIGN_ROWS, planDiscount, type DesignInput } from '@/core/textile'
import type { Product } from '@/core/types'
import { api } from '@/data'
import { money } from '@/lib/format'
import { LabelPrintModal } from '../Labels'
import { HsnInput } from '../gst/GstFields'

const SIZE_SETS = [
  { name: 'S – XXL', sizes: ['S', 'M', 'L', 'XL', 'XXL'] },
  { name: 'Kids', sizes: ['1-2Y', '3-4Y', '5-6Y', '7-8Y', '9-10Y'] },
  { name: '28 – 40', sizes: ['28', '30', '32', '34', '36', '38', '40'] },
  { name: 'Free size', sizes: ['Free size'] },
]

/** Type a word and press Enter or comma; click × to remove. */
function TagInput({ values, onChange, placeholder, label }: { values: string[]; onChange: (v: string[]) => void; placeholder: string; label: string }) {
  const [draft, setDraft] = useState('')
  const addAll = (text: string) => {
    const next = [...values]
    for (const raw of text.split(',')) {
      const v = raw.replace(/\s+/g, ' ').trim().slice(0, 30)
      if (v && !next.some((x) => x.toLowerCase() === v.toLowerCase())) next.push(v)
    }
    onChange(next)
    setDraft('')
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',') && draft.trim()) { e.preventDefault(); addAll(draft) }
    else if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1))
  }
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1.5 focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500">
      {values.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded-md bg-slate-100 py-0.5 pl-2 pr-1 text-sm">
          {v}<button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))} className="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"><X className="h-3 w-3" /></button>
        </span>
      ))}
      <input aria-label={label} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={() => draft.trim() && addAll(draft)}
        placeholder={values.length ? '' : placeholder} className="min-w-[8rem] flex-1 border-0 p-0.5 text-sm focus:ring-0" />
    </div>
  )
}

const num = (s: string) => (s.trim() === '' ? NaN : Number(s))

/** One design → one item per colour × size, each with its own code, stock and sticker. */
export function AddDesignModal({ onClose }: { onClose: () => void }) {
  const { me, t } = useApp()
  const run = useAction()
  const { data: categories = [] } = useData(() => api.categories.list())
  const billing = me!.business.billing
  const [f, setF] = useState({ name: '', categoryId: '', design: '', fabric: '', mrp: '', pct: '', price: '', cost: '', taxRateId: '', unit: 'pc', hsn: '' })
  const [img, setImg] = useState<{ imageUrl: string; thumbUrl: string } | null>(null)
  const [colours, setColours] = useState<string[]>([])
  const [sizes, setSizes] = useState<string[]>([])
  const [stock, setStock] = useState<Record<string, string>>({})
  const [all, setAll] = useState('')
  const [made, setMade] = useState<Product[] | null>(null)
  const [printing, setPrinting] = useState(false)
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))
  const categoryId = f.categoryId || categories[0]?.id || ''

  // Price: type the discount % or the selling price — the other follows.
  const mrp = num(f.mrp)
  const setMrp = (v: string) => setF((x) => { const m = num(v), p = num(x.pct); return { ...x, mrp: v, price: m > 0 && p >= 0 ? String(discountedPrice(m, p)) : x.price } })
  const setPct = (v: string) => setF((x) => { const m = num(x.mrp), p = num(v); return { ...x, pct: v, price: m > 0 && p >= 0 && p < 100 ? String(discountedPrice(m, p)) : x.price } })
  const setPrice = (v: string) => setF((x) => { const m = num(x.mrp), p = num(v); return { ...x, price: v, pct: m > 0 && p > 0 && p <= m ? String(Math.round(((m - p) / m) * 1000) / 10) : '' } })
  const price = num(f.price) > 0 ? num(f.price) : mrp

  const cells = useMemo(() => {
    const cs = colours.length ? colours : ['']
    const ss = sizes.length ? sizes : ['']
    return cs.flatMap((colour) => ss.map((size) => ({ colour, size, key: `${colour}|${size}` }))).filter((c) => c.colour || c.size)
  }, [colours, sizes])
  const pieces = cells.reduce((a, c) => a + (Number(stock[c.key]) || 0), 0)
  const fillAll = (v: string) => { setAll(v); setStock(Object.fromEntries(cells.map((c) => [c.key, v]))) }
  const problem = !f.name.trim() ? 'Enter the item name' : !(mrp > 0) ? 'Enter the MRP' : price > mrp ? 'Selling price is above the MRP' : !cells.length ? 'Add at least one colour or size'
    : cells.length > MAX_DESIGN_ROWS ? `Up to ${MAX_DESIGN_ROWS} sizes × colours at a time` : ''

  const save = () => run(async () => {
    const input: DesignInput = {
      name: f.name, categoryId: categoryId || null, design: f.design, fabric: f.fabric, mrp, price, costPrice: num(f.cost) || 0, taxRateId: f.taxRateId || null,
      unit: f.unit, lowStockAt: 1, hsn: f.hsn || null, imageUrl: img?.imageUrl ?? null, thumbUrl: img?.thumbUrl ?? null,
      rows: cells.map((c) => ({ colour: c.colour, size: c.size, stock: Math.max(0, Math.floor(Number(stock[c.key]) || 0)) })),
    }
    setMade(await api.products.saveDesign(input))
  }, `${cells.length} item${cells.length === 1 ? '' : 's'} added`)

  if (made && printing) {
    return <LabelPrintModal title="Print stickers for the new design" initial={made.map((p) => ({ id: p.id, count: Math.max(1, p.stock) }))} onClose={onClose} />
  }
  if (made) {
    const total = made.reduce((a, p) => a + Math.max(1, p.stock), 0)
    return (
      <Modal open onClose={onClose} size="sm" title="Design added">
        <div className="flex flex-col items-center gap-2 py-2 text-center">
          <CheckCircle2 className="h-10 w-10 text-emerald-500" />
          <p className="text-sm text-slate-600"><b>{made.length}</b> item{made.length === 1 ? '' : 's'} with {pieces} piece{pieces === 1 ? '' : 's'} in stock. Each has its own code for its sticker.</p>
          <ul className="mt-2 w-full divide-y divide-slate-100 rounded-xl border border-slate-200 text-left text-sm">
            {made.slice(0, 6).map((p) => <li key={p.id} className="flex justify-between gap-3 px-3 py-2"><span className="truncate">{p.name}</span><span className="shrink-0 font-mono text-xs text-slate-500">{p.barcode}</span></li>)}
            {made.length > 6 && <li className="px-3 py-2 text-xs text-slate-500">+ {made.length - 6} more</li>}
          </ul>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Later</Button>
          <Button icon={Printer} onClick={() => setPrinting(true)}>Print {total} sticker{total === 1 ? '' : 's'}</Button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open onClose={onClose} size="xl" title="Add design" subtitle="One design in many colours and sizes — each becomes its own item with its own stock and QR sticker"
      footer={<>
        <span className="mr-auto self-center text-sm text-slate-500">{problem || <><b className="text-slate-800">{cells.length}</b> item{cells.length === 1 ? '' : 's'} · {pieces} piece{pieces === 1 ? '' : 's'}</>}</span>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button icon={Layers} disabled={!!problem} onClick={async () => { await save() }}>Add {cells.length || ''} item{cells.length === 1 ? '' : 's'}</Button>
      </>}>
      <div className="space-y-6">
        <section className="grid gap-5 sm:grid-cols-[150px_1fr]">
          <div className="mx-auto sm:mx-0"><PhotoDrop size={150} imageUrl={img?.imageUrl} onChange={setImg} /></div>
          <div className="grid content-start gap-4 sm:grid-cols-2">
            <Field required label="Item name" className="sm:col-span-2"><Input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Kanchipuram Silk Saree" /></Field>
            <Field label="Design no." hint="Same for every colour and size"><Input value={f.design} onChange={(e) => set('design', e.target.value.toUpperCase())} placeholder="KS-1024" className="font-mono" /></Field>
            <Field label="Fabric"><Input value={f.fabric} onChange={(e) => set('fabric', e.target.value)} placeholder="Pure silk" /></Field>
            <Field label={t('category')}>
              <Select value={categoryId} onChange={(e) => set('categoryId', e.target.value)}>
                <option value="">No {t('category').toLowerCase()}</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Sold per">
              <Select value={f.unit} onChange={(e) => set('unit', e.target.value)}>
                <option value="pc">Piece</option><option value="set">Set</option><option value="pair">Pair</option><option value="mtr">Metre</option>
              </Select>
            </Field>
            {billing.taxEnabled && <HsnInput value={f.hsn} onChange={(v) => set('hsn', v)} label="HSN code" hint={!f.hsn && categories.find((c) => c.id === categoryId)?.hsn ? `Empty = category’s ${categories.find((c) => c.id === categoryId)!.hsn}` : 'Optional'} />}
          </div>
        </section>

        <section className="border-t border-slate-100 pt-5">
          <h3 className="mb-3 text-sm font-semibold text-slate-800">Price (same for every colour and size)</h3>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <Field required label="MRP"><MoneyBox value={f.mrp} onChange={setMrp} /></Field>
            <Field label="Discount %"><div className="relative"><Input type="number" inputMode="decimal" min={0} max={90} value={f.pct} onChange={(e) => setPct(e.target.value)} placeholder="0" className="pr-7" /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">%</span></div></Field>
            <Field label="Selling price">
              <MoneyBox value={f.price} onChange={setPrice} placeholder={f.mrp || '0'} />
              {mrp > 0 && price < mrp && <span className="mt-1 block text-xs font-medium text-emerald-600">Customer saves {money(mrp - price)}</span>}
              {mrp > 0 && price > mrp && <span className="mt-1 block text-xs font-medium text-red-600">Above MRP</span>}
            </Field>
            <Field label="Cost price" hint="For profit reports"><MoneyBox value={f.cost} onChange={(v) => set('cost', v)} /></Field>
            <Field label="GST">
              <Select value={f.taxRateId} onChange={(e) => set('taxRateId', e.target.value)} disabled={!billing.taxEnabled}>
                <option value="">{billing.taxEnabled ? `${billing.taxRates.find((r) => r.id === billing.defaultTaxRateId)?.rate ?? 0}% (default)` : 'Tax off'}</option>
                {billing.taxRates.map((r) => <option key={r.id} value={r.id}>{r.rate}%</option>)}
              </Select>
            </Field>
          </div>
        </section>

        <section className="grid gap-4 border-t border-slate-100 pt-5 sm:grid-cols-2">
          <Field label="Colours" hint="Type and press Enter. Leave empty if there’s one colour."><TagInput label="Colours" values={colours} onChange={setColours} placeholder="Maroon, Green, Gold" /></Field>
          <div>
            <Field label="Sizes" hint="Leave empty for sarees and other free-size items."><TagInput label="Sizes" values={sizes} onChange={setSizes} placeholder="S, M, L, XL" /></Field>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {SIZE_SETS.map((s) => <button key={s.name} type="button" onClick={() => setSizes(s.sizes)} className="rounded-full border border-slate-200 px-2.5 py-0.5 text-xs text-slate-600 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700">{s.name}</button>)}
            </div>
          </div>
        </section>

        {!!cells.length && (
          <section className="border-t border-slate-100 pt-5">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
              <div><h3 className="text-sm font-semibold text-slate-800">Opening stock (pieces)</h3><p className="text-xs text-slate-500">One sticker is printed per piece afterwards. 0 is fine — add stock later in Inventory.</p></div>
              <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-slate-600">Same for all<span className="w-20"><Input type="number" inputMode="numeric" min={0} value={all} onChange={(e) => fillAll(e.target.value)} className="h-8 text-center" /></span></label>
            </div>
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-sm">
                {sizes.length > 0 && colours.length > 0 ? (
                  <>
                    <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="whitespace-nowrap px-3 py-2 text-left font-medium">Colour \ Size</th>{sizes.map((s) => <th key={s} className="px-2 py-2 font-medium">{s}</th>)}</tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {colours.map((c) => (
                        <tr key={c}><td className="whitespace-nowrap px-3 py-1.5 font-medium">{c}</td>{sizes.map((s) => <td key={s} className="px-1.5 py-1.5"><StockCell value={stock[`${c}|${s}`] ?? ''} onChange={(v) => setStock((x) => ({ ...x, [`${c}|${s}`]: v }))} label={`${c} ${s}`} /></td>)}</tr>
                      ))}
                    </tbody>
                  </>
                ) : (
                  <tbody className="divide-y divide-slate-100">
                    {cells.map((c) => (
                      <tr key={c.key}><td className="px-3 py-1.5 font-medium">{c.colour || c.size}</td><td className="w-28 px-1.5 py-1.5"><StockCell value={stock[c.key] ?? ''} onChange={(v) => setStock((x) => ({ ...x, [c.key]: v }))} label={c.colour || c.size} /></td></tr>
                    ))}
                  </tbody>
                )}
              </table>
            </div>
            <p className="mt-2 text-xs text-slate-500">Items will be named like <b>{[f.name.trim() || 'Item name', [cells[0].colour, cells[0].size].filter(Boolean).join(' / ')].join(' · ')}</b>.</p>
          </section>
        )}
      </div>
    </Modal>
  )
}

function StockCell({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return <Input type="number" inputMode="numeric" min={0} step={1} aria-label={`Stock ${label}`} value={value} placeholder="0" onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ''))} className="h-9 min-w-[4rem] text-center" />
}

function MoneyBox({ value, onChange, placeholder = '0' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">₹</span>
      <Input type="number" inputMode="decimal" min={0} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="pl-7" />
    </div>
  )
}

/** "20% off all cotton sarees": new selling prices from MRP for a whole category, then reprint their stickers. */
export function CategoryDiscountModal({ onClose, initialCategory }: { onClose: () => void; initialCategory?: string }) {
  const { t } = useApp()
  const run = useAction()
  const { data: categories = [] } = useData(() => api.categories.list())
  const { data: products = [] } = useData(() => api.products.list())
  const [categoryId, setCategoryId] = useState(initialCategory && initialCategory !== 'all' && initialCategory !== 'inactive' ? initialCategory : '')
  const [pct, setPct] = useState('10')
  const [round, setRound] = useState<1 | 5 | 10>(10)
  const [done, setDone] = useState<{ updated: number; ids: string[] } | null>(null)
  const [printing, setPrinting] = useState(false)
  const p = Number(pct)
  const valid = pct.trim() !== '' && p >= 0 && p <= 90
  const plan = useMemo(() => { try { return valid ? planDiscount({ categoryId: categoryId || null, pct: p, round }, products) : null } catch { return null } }, [valid, categoryId, p, round, products])
  const byId = new Map(products.map((x) => [x.id, x]))
  const preview = (plan?.ids ?? []).slice(0, 8).map((id) => { const x = byId.get(id)!; return { x, now: plan!.changes.find((c) => c.id === id)?.price ?? x.price } })
  const catName = categories.find((c) => c.id === categoryId)?.name ?? 'all items'

  if (done && printing) return <LabelPrintModal title="Print the new price stickers" initial={done.ids.map((id) => ({ id, count: Math.max(1, byId.get(id)?.trackStock ? byId.get(id)!.stock : 1) }))} onClose={onClose} />
  if (done) {
    return (
      <Modal open onClose={onClose} size="sm" title="Prices updated">
        <div className="flex flex-col items-center gap-2 py-2 text-center">
          <CheckCircle2 className="h-10 w-10 text-emerald-500" />
          <p className="text-sm text-slate-600">{done.updated ? <><b>{done.updated}</b> price{done.updated === 1 ? '' : 's'} changed in {catName}.</> : 'All prices were already at this discount.'} Bills use the new prices from now on.</p>
          <p className="text-xs text-slate-500">Stickers already on the items still show the old price — print new ones.</p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Later</Button>
          <Button icon={Printer} disabled={!done.ids.length} onClick={() => setPrinting(true)}>Print new stickers</Button>
        </div>
      </Modal>
    )
  }
  return (
    <Modal open onClose={onClose} size="lg" title="Discount for a category" subtitle="Sets the selling price of every item to its MRP less this %. 0% removes the discount."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button icon={Percent} disabled={!plan || !plan.ids.length} onClick={() => run(async () => setDone(await api.products.setDiscount({ categoryId: categoryId || null, pct: p, round })))}>
          {p === 0 ? 'Remove discount' : `Apply ${p}% off`}{plan?.ids.length ? ` · ${plan.ids.length} item${plan.ids.length === 1 ? '' : 's'}` : ''}
        </Button>
      </>}>
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_160px_140px]">
          <Field label={t('category')}>
            <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">All items</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field required label="Discount % off MRP"><div className="relative"><Input type="number" inputMode="decimal" min={0} max={90} value={pct} onChange={(e) => setPct(e.target.value)} className="pr-7" /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">%</span></div></Field>
          <Field label="Round price to">
            <Select value={round} onChange={(e) => setRound(Number(e.target.value) as 1 | 5 | 10)}><option value={1}>₹1</option><option value={5}>₹5</option><option value={10}>₹10</option></Select>
          </Field>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {[0, 5, 10, 15, 20, 25, 30, 40, 50].map((v) => (
            <button key={v} type="button" onClick={() => setPct(String(v))} className={clsx('rounded-full border px-3 py-1 text-xs font-medium', p === v && pct !== '' ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:border-slate-300')}>{v === 0 ? 'No discount' : `${v}%`}</button>
          ))}
        </div>
        {!valid && <p className="text-sm text-red-600">Enter a discount between 0 and 90%.</p>}
        {plan && (
          <div>
            <p className="mb-2 text-sm text-slate-600"><b>{plan.ids.length}</b> item{plan.ids.length === 1 ? '' : 's'} in {catName}{plan.changes.length !== plan.ids.length ? ` · ${plan.changes.length} price${plan.changes.length === 1 ? '' : 's'} will change` : ''}</p>
            {!!preview.length && (
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="w-full table-fixed text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-3 py-2 text-left font-medium">Item</th><th className="w-24 px-3 py-2 text-right font-medium">MRP</th><th className="w-24 px-3 py-2 text-right font-medium">Now</th><th className="w-28 px-3 py-2 text-right font-medium">New price</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {preview.map(({ x, now }) => (
                      <tr key={x.id}><td className="truncate px-3 py-2" title={x.name}>{x.name}</td><td className="px-3 py-2 text-right tabular text-slate-500">{money(x.mrp ?? 0)}</td><td className="px-3 py-2 text-right tabular text-slate-500">{money(x.price)}</td><td className={clsx('px-3 py-2 text-right font-semibold tabular', now !== x.price && 'text-emerald-700')}>{money(now)}</td></tr>
                    ))}
                  </tbody>
                </table>
                {plan.ids.length > preview.length && <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">+ {plan.ids.length - preview.length} more</p>}
              </div>
            )}
            {(plan.noMrp > 0 || plan.withSizes > 0) && (
              <p className="mt-2 text-xs text-amber-700">Left as they are: {[plan.noMrp && `${plan.noMrp} without an MRP`, plan.withSizes && `${plan.withSizes} with size options`].filter(Boolean).join(' and ')}.</p>
            )}
          </div>
        )}
        {!plan && valid && <p className="text-sm text-slate-500">No items in {catName}.</p>}
      </div>
    </Modal>
  )
}
