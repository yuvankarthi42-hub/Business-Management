import clsx from 'clsx'
import { Boxes, FileUp, FolderPlus, IndianRupee, PackageSearch, Pencil, Plus, ScanLine, Tag, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { Badge, Button, Card, Chips, EmptyState, Field, Input, Modal, PageHeader, SearchInput, Select, Table, Td, Th, Toggle, VegMark, useAction } from '@/components/ui'
import { productFormFor, templateFor, usesRetailPos } from '@/core/config'
import { ScanAddModal } from '@/features/supermarket/ScanAdd'
import { LabelPrintModal } from '@/features/Labels'
import { ProductImportModal } from '@/features/ProductImport'
import type { AddOn, Product, Variant } from '@/core/types'
import { api } from '@/data'
import { CategoryLabel, ImagePicker, PhotoDrop, Thumb } from '@/components/Thumb'
import { money, uid } from '@/lib/format'
import { priceLabel, tintFor } from '@/features/Catalog'
import { wholesaleLabel, wholesaleOn } from '@/core/orderItem'

export default function Products() {
  const { t, mod, me } = useApp()
  const food = me?.business.category === 'food' || me?.business.category === 'restaurant'
  const superMode = !!me && usesRetailPos(me.business)
  const [scanAdd, setScanAdd] = useState(false)
  const { data: products } = useData(() => api.products.list())
  const { data: categories = [] } = useData(() => api.categories.list())
  const [cat, setCat] = useState('all')
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Partial<Product> | null>(null)
  const [catModal, setCatModal] = useState(false)
  const [labelsFor, setLabelsFor] = useState<string[] | null>(null)
  const [importing, setImporting] = useState(false)
  // Barcode labels: shops that sell packed goods (supermarket, hardware, bakery) — not dine-in menus.
  const labels = superMode || /bakery|sweet/i.test(me?.business.subType ?? '')
  const list = useMemo(() => (products ?? []).filter((p) => (cat === 'all' || (cat === 'inactive' ? !p.active : p.categoryId === cat)) && (!q || p.name.toLowerCase().includes(q.toLowerCase()) || p.sku.toLowerCase().includes(q.toLowerCase()))), [products, cat, q])
  const catName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? '—'

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title={t('product', true)} subtitle={`${products?.filter((p) => p.active).length ?? 0} active ${t('product', true).toLowerCase()}`}
        actions={<>
          <Button variant="secondary" icon={FolderPlus} onClick={() => setCatModal(true)}>{t('category', true)}</Button>
          {labels && <Button variant="secondary" icon={Tag} onClick={() => setLabelsFor([])}>Print labels</Button>}
          <Button variant="secondary" icon={FileUp} write onClick={() => setImporting(true)}>Import</Button>
          {superMode ? <>
            <Button variant="secondary" icon={Pencil} onClick={() => setEditing({})}>Add manually</Button>
            <Button icon={ScanLine} onClick={() => setScanAdd(true)}>Scan to add</Button>
          </> : <Button icon={Plus} onClick={() => setEditing({})}>Add {t('product')}</Button>}
        </>} />
      <Card>
        <div className="space-y-3 border-b border-slate-100 p-3">
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${t('product', true).toLowerCase()} or SKU`} className="max-w-md" />
          <Chips value={cat} onChange={setCat} options={[{ value: 'all', label: 'All' }, ...categories.map((c) => ({ value: c.id, label: <CategoryLabel c={c} /> })), { value: 'inactive', label: 'Inactive' }]} />
        </div>
        {products && !list.length ? <EmptyState icon={PackageSearch} title={`No ${t('product', true).toLowerCase()}`} action={<Button icon={Plus} onClick={() => setEditing({})}>Add {t('product')}</Button>} /> : (
          <Table>
            <thead><tr><Th>{t('product')}</Th><Th>{t('category')}</Th><Th className="text-right">Price</Th>{mod('inventory') && <Th className="text-right">Stock</Th>}<Th>Status</Th><Th /></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <Td>
                    <div className="flex items-center gap-3">
                      <Thumb item={p} className={clsx('h-11 w-11 rounded-lg text-xl', tintFor(p.id))} />
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 font-medium text-slate-900">{food && <VegMark veg={p.isVeg} />}{p.name}</p>
                        <p className="text-xs text-slate-500">{p.barcode ? <span className="font-mono">{p.barcode}</span> : p.sku || 'No SKU'} · per {UNIT_LABEL[p.unit]?.toLowerCase() ?? p.unit}{p.variants.length ? ` · ${p.variants.length} sizes` : ''}{p.addOns.length ? ` · ${p.addOns.length} add-ons` : ''}</p>
                      </div>
                    </div>
                  </Td>
                  <Td>{catName(p.categoryId)}</Td>
                  <Td className="text-right font-medium tabular">{priceLabel(p)}</Td>
                  {mod('inventory') && <Td className="text-right tabular">{p.trackStock ? <span className={p.stock <= p.lowStockAt ? 'font-semibold text-amber-600' : ''}>{p.stock}</span> : <span className="text-slate-400">—</span>}</Td>}
                  <Td>
                    {!p.active ? <Badge>Inactive</Badge> : p.trackStock && p.stock <= 0 ? <Badge tone="red">Out of stock</Badge> : p.trackStock && p.stock <= p.lowStockAt ? <Badge tone="amber">Low stock</Badge> : <Badge tone="green">{p.kind === 'service' ? 'Available' : 'In stock'}</Badge>}
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    {labels && <Button size="sm" variant="ghost" icon={Tag} onClick={() => setLabelsFor([p.id])} aria-label="Print labels" title="Print labels" />}
                    <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(p)}>Edit</Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {editing && <ProductForm initial={editing} onClose={() => setEditing(null)} />}
      {catModal && <CategoryModal onClose={() => setCatModal(false)} />}
      {importing && <ProductImportModal onClose={() => setImporting(false)} />}
      {labelsFor && <LabelPrintModal initialIds={labelsFor} onClose={() => setLabelsFor(null)} />}
      {scanAdd && <ScanAddModal onClose={() => setScanAdd(false)} onEdit={(p) => { setScanAdd(false); setEditing(p) }} />}
    </div>
  )
}

export function ProductForm({ initial, onClose }: { initial: Partial<Product>; onClose: () => void }) {
  const { me, t, mod } = useApp()
  const run = useAction()
  const { data: categories = [] } = useData(() => api.categories.list())
  const tpl = templateFor(me!.business.category)
  const form = productFormFor(me!.business)
  const isNew = !initial.id
  const [p, setP] = useState<Partial<Product>>({
    name: '', emoji: '', unit: tpl.units[0], price: 0, costPrice: 0, kind: form.isService ? 'service' : 'goods',
    isVeg: true, sendToKitchen: mod('kitchen') && form.showKitchen, trackStock: mod('inventory') && form.trackStockByDefault, lowStockAt: 5, stock: 0, active: true, variants: [], addOns: [],
    categoryId: categories[0]?.id ?? null, taxRateId: null, sku: '', barcode: '', ...initial,
  })
  const set = <K extends keyof Product>(k: K, v: Product[K]) => setP((x) => ({ ...x, [k]: v }))
  const billing = me!.business.billing
  const ws = me!.business.category === 'retail' && wholesaleOn(billing)
  const gst = billing.taxRates.some((r) => /gst/i.test(r.name))
  const defaultRate = billing.taxRates.find((r) => r.id === billing.defaultTaxRateId)?.rate ?? 0
  const margin = (p.price ?? 0) > 0 && (p.costPrice ?? 0) > 0
    ? { value: (p.price ?? 0) - (p.costPrice ?? 0), pct: Math.round((((p.price ?? 0) - (p.costPrice ?? 0)) / (p.price ?? 1)) * 100) }
    : null
  const [newCat, setNewCat] = useState<string | null>(null)
  const [openingBatch, setOpeningBatch] = useState({ batchNo: '', expiry: '' })
  // Categories load asynchronously: pick the first one for a new item once they arrive.
  useEffect(() => { if (isNew && !initial.categoryId && categories.length) setP((x) => (x.categoryId ? x : { ...x, categoryId: categories[0].id })) }, [categories.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const addCategory = async () => {
    if (!newCat?.trim()) return
    let id = ''
    if (await run(async () => { id = (await api.categories.save({ name: newCat.trim(), emoji: '' })).id }, `${t('category')} added`)) { set('categoryId', id); setNewCat(null) }
  }

  return (
    <Modal open onClose={onClose} size="lg" title={isNew ? `Add ${t('product')}` : `Edit ${initial.name}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={async () => { if (await run(() => api.products.save({ ...p, name: p.name ?? '', ...(isNew && p.trackExpiry && (p.stock ?? 0) > 0 ? { openingBatch } : {}) }), isNew ? `${t('product')} added` : 'Saved')) onClose() }}>Save</Button></>}>
      <div className="space-y-5">
        {/* Photo + basic details */}
        <div className="grid gap-5 sm:grid-cols-[176px_1fr]">
          <div className="mx-auto sm:mx-0"><PhotoDrop imageUrl={p.imageUrl} onChange={(img) => setP((x) => ({ ...x, imageUrl: img?.imageUrl ?? null, thumbUrl: img?.thumbUrl ?? null }))} /></div>
          <div className="grid content-start gap-4">
            <Field label="Item name"><Input autoFocus value={p.name} onChange={(e) => set('name', e.target.value)} placeholder={form.namePlaceholder} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Field label={t('category')}>
                  <Select value={p.categoryId ?? ''} onChange={(e) => set('categoryId', e.target.value || null)}>
                    <option value="">No {t('category').toLowerCase()}</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </Field>
                {newCat === null ? (
                  <button type="button" onClick={() => setNewCat('')} className="mt-1.5 text-xs font-medium text-brand-600 hover:underline">+ New {t('category').toLowerCase()}</button>
                ) : (
                  <div className="mt-2 flex gap-1.5">
                    <Input autoFocus value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="Desserts" className="h-8 text-xs"
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCategory() } if (e.key === 'Escape') setNewCat(null) }} />
                    <Button type="button" size="sm" onClick={addCategory} disabled={!newCat.trim()}>Add</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setNewCat(null)} aria-label="Cancel">✕</Button>
                  </div>
                )}
              </div>
              {form.barcodeFirst && (
                <Field label="Barcode" hint="Click here and scan the packet. No barcode (loose / own-packed)? Create one in Print labels.">
                  <div className="relative flex gap-1.5">
                    <ScanLine className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <Input value={p.barcode} onChange={(e) => set('barcode', e.target.value.trim())} placeholder="Scan or type" className="pl-9 font-mono" inputMode="numeric"
                      onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() /* scanners send Enter — don't submit */ }} />
                  </div>
                </Field>
              )}
              {form.showFoodType && p.kind !== 'service' && (
                <div>
                  <span className="mb-1.5 block text-xs font-medium text-slate-600">Food type</span>
                  <div className="flex gap-2">
                    {[true, false].map((veg) => (
                      <button key={String(veg)} type="button" onClick={() => set('isVeg', veg)}
                        className={clsx('inline-flex h-10 items-center gap-2 rounded-full border px-4 text-sm font-medium transition',
                          p.isVeg === veg ? (veg ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-red-300 bg-red-50 text-red-700') : 'border-slate-200 text-slate-600 hover:border-slate-300')}>
                        <VegMark veg={veg} />{veg ? 'Veg' : 'Non-veg'}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Pricing */}
        <section className="border-t border-slate-100 pt-5">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800"><IndianRupee className="h-4 w-4" />Pricing</h3>
          <div className={clsx('grid grid-cols-2 gap-4', form.showMrp || ws ? 'sm:grid-cols-5' : 'sm:grid-cols-4', form.showMrp && ws && 'lg:grid-cols-6')}>
            {form.showMrp && (
              <Field label="MRP">
                <MoneyInput value={p.mrp ?? undefined} onChange={(v) => setP((x) => ({ ...x, mrp: v || null, price: x.price ? x.price : v }))} />
                {!!p.mrp && !!p.price && p.mrp > p.price && <span className="mt-1 block text-xs font-medium text-emerald-600">Customer saves {money(p.mrp - p.price)}</span>}
                {!!p.mrp && !!p.price && p.price > p.mrp && <span className="mt-1 block text-xs font-medium text-red-600">Price is above MRP</span>}
              </Field>
            )}
            <Field label={p.variants?.length ? 'Base price' : 'Selling price'}><MoneyInput value={p.price} onChange={(v) => set('price', v)} /></Field>
            {ws && (
              <Field label={wholesaleLabel(billing)}>
                <MoneyInput value={p.wholesalePrice ?? undefined} onChange={(v) => set('wholesalePrice', v || null)} />
                <span className="mt-1 block text-xs text-slate-400">{p.wholesalePrice && p.price && p.wholesalePrice < p.price ? `${money(p.price - p.wholesalePrice)} less than retail` : 'Empty = retail price'}</span>
              </Field>
            )}
            <Field label="Cost price">
              <MoneyInput value={p.costPrice} onChange={(v) => set('costPrice', v)} />
              {margin && <span className={clsx('mt-1 block text-xs font-medium', margin.value >= 0 ? 'text-emerald-600' : 'text-red-600')}>{margin.value >= 0 ? 'Margin' : 'Loss'} {money(Math.abs(margin.value))} · {Math.abs(margin.pct)}%</span>}
              {!margin && <span className="mt-1 block text-xs text-slate-400">For profit reports</span>}
            </Field>
            <Field label="Sold per">
              <Select value={p.unit} onChange={(e) => set('unit', e.target.value)}>
                {[...new Set([p.unit!, ...tpl.units, 'pc', 'plate', 'kg', 'g', 'ltr', 'service'])].map((u) => <option key={u} value={u}>{UNIT_LABEL[u] ?? u}</option>)}
              </Select>
            </Field>
            <Field label={gst ? 'GST' : 'Tax'}>
              <Select value={p.taxRateId ?? ''} onChange={(e) => set('taxRateId', e.target.value || null)} disabled={!billing.taxEnabled}>
                <option value="">{billing.taxEnabled ? `${defaultRate}% (default)` : 'Tax off'}</option>
                {billing.taxRates.map((r) => <option key={r.id} value={r.id}>{r.rate}%{r.rate === 0 ? ' (exempt)' : ''}</option>)}
              </Select>
            </Field>
          </div>
        </section>

        {form.barcodeFirst && mod('inventory') && (
          <section className="border-t border-slate-100 pt-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800"><Boxes className="h-4 w-4" />Stock</h3>
              <Toggle checked={!!p.trackStock} onChange={(v) => set('trackStock', v)} label="Track stock" />
            </div>
            {p.trackStock ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {isNew && <Field label={`Opening stock (${UNIT_LABEL[p.unit ?? ''] ?? p.unit})`}><Input type="number" inputMode="decimal" value={p.stock || ''} placeholder="0" onChange={(e) => set('stock', Number(e.target.value))} /></Field>}
                <Field label="Low stock alert at"><Input type="number" inputMode="decimal" value={p.lowStockAt} onChange={(e) => set('lowStockAt', Number(e.target.value))} /></Field>
                <Field label="SKU / item code"><Input value={p.sku} onChange={(e) => set('sku', e.target.value)} placeholder="Optional" /></Field>
                <div className="col-span-2 flex items-center justify-between gap-4 rounded-xl border border-slate-200 px-4 py-3 sm:col-span-3">
                  <div><p className="text-sm font-medium">Track batch & expiry</p><p className="text-xs text-slate-500">For milk, curd, bread, medicines — oldest stock is sold first and you get expiry alerts</p></div>
                  <Toggle checked={!!p.trackExpiry} onChange={(v) => set('trackExpiry', v)} label="Track batch and expiry" />
                </div>
                {isNew && p.trackExpiry && (p.stock ?? 0) > 0 && (
                  <>
                    <Field label="Opening stock expiry"><Input type="date" required value={openingBatch.expiry} onChange={(e) => setOpeningBatch({ ...openingBatch, expiry: e.target.value })} /></Field>
                    <Field label="Batch no." hint="Optional"><Input value={openingBatch.batchNo} onChange={(e) => setOpeningBatch({ ...openingBatch, batchNo: e.target.value })} placeholder="B2410A" /></Field>
                  </>
                )}
              </div>
            ) : <p className="text-xs text-slate-500">Stock isn’t tracked for this item. Turn on to reduce stock on every bill and get low-stock alerts.</p>}
          </section>
        )}

        <OptionList title={form.variants.title} hint={form.variants.hint} rows={p.variants ?? []} onChange={(v) => set('variants', v as Variant[])} placeholder={form.variants.placeholder} wholesale={ws ? wholesaleLabel(billing) : undefined} />
        {form.addOns && <OptionList title={form.addOns.title} hint={form.addOns.hint} rows={p.addOns ?? []} onChange={(v) => set('addOns', v as AddOn[])} placeholder={form.addOns.placeholder} />}

        <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {!form.barcodeFirst && <ToggleRow label="Is a service (no stock)" checked={p.kind === 'service'} onChange={(v) => setP((x) => ({ ...x, kind: v ? 'service' : 'goods', trackStock: v ? false : x.trackStock }))} />}
          {mod('kitchen') && form.showKitchen && <ToggleRow label="Send to kitchen (KOT)" hint="Turn off for packaged drinks, water etc." checked={!!p.sendToKitchen} onChange={(v) => set('sendToKitchen', v)} />}
          {!form.barcodeFirst && mod('inventory') && p.kind !== 'service' && <ToggleRow label="Track stock" hint="Stock reduces automatically on every bill" checked={!!p.trackStock} onChange={(v) => set('trackStock', v)} />}
          {!form.barcodeFirst && mod('inventory') && p.trackStock && (
            <div className="grid grid-cols-2 gap-4 px-4 py-3 sm:grid-cols-4">
              {isNew && <Field label="Opening stock"><Input type="number" value={p.stock} onChange={(e) => set('stock', Number(e.target.value))} /></Field>}
              <Field label="Low stock alert at"><Input type="number" value={p.lowStockAt} onChange={(e) => set('lowStockAt', Number(e.target.value))} /></Field>
              <Field label="SKU"><Input value={p.sku} onChange={(e) => set('sku', e.target.value)} /></Field>
              <Field label="Barcode"><Input value={p.barcode} onChange={(e) => set('barcode', e.target.value)} placeholder="Scan or type" /></Field>
            </div>
          )}
          <ToggleRow label="Active" hint="Inactive items are hidden from billing" checked={!!p.active} onChange={(v) => set('active', v)} />
        </div>
      </div>
    </Modal>
  )
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div><p className="text-sm font-medium">{label}</p>{hint && <p className="text-xs text-slate-500">{hint}</p>}</div>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  )
}

type OptRow = { id: string; name: string; price: number; wholesalePrice?: number | null }
function OptionList({ title, hint, rows, onChange, placeholder, wholesale }: { title: string; hint: string; rows: OptRow[]; onChange: (r: OptRow[]) => void; placeholder: string; wholesale?: string }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div><p className="text-sm font-medium">{title}</p><p className="text-xs text-slate-500">{hint}</p></div>
        <Button size="sm" variant="soft" icon={Plus} onClick={() => onChange([...rows, { id: uid('opt_'), name: '', price: 0 }])}>Add</Button>
      </div>
      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={r.id} className="flex gap-2">
              <Input value={r.name} placeholder={placeholder} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <Input type="number" value={r.price} className="w-28" aria-label="Price" onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, price: Number(e.target.value) } : x)))} />
              {wholesale && <Input type="number" value={r.wholesalePrice ?? ''} placeholder={wholesale} title={wholesale} aria-label={wholesale} className="w-32" onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, wholesalePrice: e.target.value === '' ? null : Number(e.target.value) } : x)))} />}
              <button onClick={() => onChange(rows.filter((_, j) => j !== i))} className="px-2 text-slate-400 hover:text-red-600" aria-label="Remove"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CategoryModal({ onClose }: { onClose: () => void }) {
  const { t } = useApp()
  const run = useAction()
  const { data: categories = [] } = useData(() => api.categories.list())
  const { data: products = [] } = useData(() => api.products.list())
  const blank = { id: undefined as string | undefined, name: '', emoji: '🍽️', imageUrl: null as string | null | undefined }
  const [form, setForm] = useState(blank)
  const editing = !!form.id
  return (
    <Modal open onClose={onClose} size="md" title={t('category', true)} subtitle="Tap a row to change its name or photo">
      <form
        className="mb-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3"
        onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.categories.save(form), editing ? 'Saved' : `${t('category')} added`)) setForm(blank) }}
      >
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{editing ? `Edit ${t('category').toLowerCase()}` : `New ${t('category').toLowerCase()}`}</p>
        <div className="flex items-start gap-3">
          <ImagePicker compact imageUrl={form.imageUrl} emoji={form.emoji} onChange={(v) => setForm((x) => ({ ...x, ...v }))} />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex gap-2">
              <Input value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} className="w-14 text-center" maxLength={4} aria-label="Emoji" />
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Biryani & Rice" required />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" icon={editing ? undefined : Plus}>{editing ? 'Save' : 'Add'}</Button>
              {form.imageUrl && <Button type="button" size="sm" variant="ghost" icon={Trash2} className="!text-red-600" onClick={() => setForm({ ...form, imageUrl: null })}>Remove photo</Button>}
              {editing && <Button type="button" size="sm" variant="ghost" onClick={() => setForm(blank)}>Cancel</Button>}
              {editing && !products.some((p) => p.categoryId === form.id) && (
                <Button type="button" size="sm" variant="ghost" icon={Trash2} className="!text-red-600" onClick={async () => { if (await run(() => api.categories.remove(form.id!), `${t('category')} deleted`)) setForm(blank) }}>Delete</Button>
              )}
              <span className="text-[11px] text-slate-400">Tap the square to add a photo</span>
            </div>
          </div>
        </div>
      </form>
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
        {categories.map((c) => (
          <li key={c.id}>
            <button onClick={() => setForm({ id: c.id, name: c.name, emoji: c.emoji, imageUrl: c.imageUrl ?? null })}
              className={clsx('flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-slate-50', form.id === c.id && 'bg-brand-50')}>
              <Thumb item={c} className="h-10 w-10 rounded-lg bg-slate-100 text-xl" />
              <span className="flex-1 font-medium">{c.name}</span>
              <span className="text-xs text-slate-500">{products.filter((p) => p.categoryId === c.id).length} items</span>
              <Pencil className="h-3.5 w-3.5 text-slate-400" />
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  )
}


const UNIT_LABEL: Record<string, string> = {
  pc: 'Piece', plate: 'Plate', kg: 'Kg', g: 'Gram', ltr: 'Litre', ml: 'ml', cup: 'Cup', glass: 'Glass', bowl: 'Bowl', box: 'Box',
  pack: 'Pack', dozen: 'Dozen', bottle: 'Bottle', scoop: 'Scoop', half: 'Half', full: 'Full', service: 'Service', hr: 'Hour',
  mtr: 'Metre', ft: 'Feet', coil: 'Coil', roll: 'Roll', set: 'Set', bag: 'Bag', pair: 'Pair', jar: 'Jar',
}

function MoneyInput({ value, onChange }: { value: number | undefined; onChange: (v: number) => void }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">₹</span>
      <Input type="number" inputMode="decimal" min={0} value={value || ''} placeholder="0" onChange={(e) => onChange(Number(e.target.value))} className="pl-7" />
    </div>
  )
}
