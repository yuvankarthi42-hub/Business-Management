// "+ Add as a new item" on the purchase bill: an item the supplier sent that isn't in the products yet.
// Shown inside the bill (not a second window, so nothing typed on the bill is lost). Stock comes from the bill
// itself when it's saved — the new item starts at 0.
import { PackagePlus, X } from 'lucide-react'
import { useState } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { Button, Field, Input, Select, useAction } from '@/components/ui'
import { productFormFor } from '@/core/config'
import type { Product } from '@/core/types'
import { api } from '@/data'

const UNITS: [string, string][] = [['pc', 'Piece'], ['pack', 'Pack'], ['box', 'Box'], ['kg', 'Kg'], ['g', 'Gram'], ['ltr', 'Litre'], ['ml', 'ml'], ['mtr', 'Metre'], ['set', 'Set'], ['pair', 'Pair'], ['dozen', 'Dozen'], ['bunch', 'Bunch'], ['bottle', 'Bottle'], ['bag', 'Bag'], ['roll', 'Roll']]

/** What was typed in the search: a scanned code goes to the barcode, anything else is the name. */
export function splitTyped(typed: string) {
  const t = typed.trim()
  return /^[A-Za-z0-9-]{6,}$/.test(t) && /\d/.test(t) && !/\s/.test(t) ? { name: '', barcode: t } : { name: t, barcode: '' }
}

export function NewItemPanel({ typed, onSaved, onCancel }: { typed: string; onSaved: (p: Product) => void; onCancel: () => void }) {
  const { me, mod } = useApp()
  const run = useAction()
  const b = me!.business
  const form = productFormFor(b)
  const { data: categories = [] } = useData(() => api.categories.list())
  const first = splitTyped(typed)
  const [f, setF] = useState({ name: first.name, barcode: first.barcode, design: '', categoryId: '', price: '', mrp: '', taxRateId: '', unit: 'pc', hsn: '' })
  const set = (x: Partial<typeof f>) => setF((o) => ({ ...o, ...x }))
  const mrp = Number(f.mrp) || 0
  const price = Number(f.price) || mrp
  const problem = !f.name.trim() ? 'Enter the item name' : !(price > 0) ? 'Enter the selling price' : form.showMrp && mrp && price > mrp ? 'Selling price is above the MRP' : ''

  const save = async () => {
    let made: Product | null = null
    const ok = await run(async () => {
      made = await api.products.save({
        name: f.name.trim(), barcode: f.barcode.trim(), categoryId: f.categoryId || categories[0]?.id || null, unit: f.unit,
        price, mrp: form.showMrp && mrp ? mrp : null, taxRateId: f.taxRateId || null, hsn: f.hsn || null,
        ...(form.textile && f.design.trim() ? { details: { design: f.design.trim() } } : {}),
        // Bought from a supplier: goods with stock (it goes up when this bill is saved), never sent to the kitchen.
        kind: 'goods', trackStock: mod('inventory'), stock: 0, sendToKitchen: false, isVeg: true, active: true, emoji: '',
      })
    }, `${f.name.trim()} added`)
    if (ok && made) onSaved(made)
  }

  return (
    <div className="mt-2 rounded-xl border border-brand-200 bg-brand-50/40 p-3" role="group" aria-label="New item">
      <div className="mb-2 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800"><PackagePlus className="h-4 w-4 text-brand-600" />New item</p>
        <button type="button" aria-label="Close new item" onClick={onCancel} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X className="h-4 w-4" /></button>
      </div>
      <div className="grid gap-2 sm:grid-cols-6">
        <Field required label="Item name" className="sm:col-span-3"><Input autoFocus={!first.name} value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder={form.namePlaceholder} /></Field>
        <Field label="Barcode / code" className="sm:col-span-3"><Input value={f.barcode} onChange={(e) => set({ barcode: e.target.value })} placeholder="Scan or type (optional)" className="font-mono" /></Field>
        {form.textile && <Field label="Design no." className="sm:col-span-2"><Input value={f.design} onChange={(e) => set({ design: e.target.value })} placeholder="D-1024" /></Field>}
        {form.showMrp && <Field label="MRP (₹)" className="sm:col-span-2"><Input type="number" inputMode="decimal" min={0} step="0.01" value={f.mrp} onChange={(e) => set({ mrp: e.target.value })} placeholder="0" /></Field>}
        <Field required label="Selling price (₹)" className="sm:col-span-2"><Input type="number" inputMode="decimal" min={0} step="0.01" value={f.price} onChange={(e) => set({ price: e.target.value })} placeholder={f.mrp || '0'} /></Field>
        <Field label="Category" className="sm:col-span-2">
          <Select value={f.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        </Field>
        <Field label="Sold per" className="sm:col-span-2"><Select value={f.unit} onChange={(e) => set({ unit: e.target.value })}>{UNITS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        {b.billing.taxEnabled && <>
          <Field label="GST" className="sm:col-span-2">
            <Select value={f.taxRateId} onChange={(e) => set({ taxRateId: e.target.value })}>
              <option value="">{b.billing.taxRates.find((r) => r.id === b.billing.defaultTaxRateId)?.rate ?? 0}% (default)</option>
              {b.billing.taxRates.map((r) => <option key={r.id} value={r.id}>{r.rate}%</option>)}
            </Select>
          </Field>
          <Field label="HSN" className="sm:col-span-2"><Input value={f.hsn} onChange={(e) => set({ hsn: e.target.value.replace(/\D/g, '').slice(0, 8) })} placeholder="Optional" className="font-mono" /></Field>
        </>}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-xs text-slate-500">{problem || 'Cost and quantity are entered on the bill row. Stock goes up when the bill is saved.'}</span>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="button" size="sm" icon={PackagePlus} disabled={!!problem} onClick={save}>Add item to bill</Button>
      </div>
    </div>
  )
}
