import { Barcode } from 'lucide-react'
import { useState } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { Button, Field, Input, Modal, Select, useAction } from '@/components/ui'
import type { Product } from '@/core/types'
import { api } from '@/data'

const UNITS: [string, string][] = [['pc', 'Piece'], ['pack', 'Pack'], ['kg', 'Kg (loose)'], ['g', 'Gram'], ['ltr', 'Litre (loose)'], ['ml', 'ml'], ['box', 'Box'], ['bottle', 'Bottle'], ['dozen', 'Dozen']]

/** Minimal "new product" form for a scanned barcode — billing and scan-to-add both use it. */
export function QuickAddForm({ barcode, onSaved, onCancel, compact }: { barcode: string; onSaved: (p: Product) => void; onCancel?: () => void; compact?: boolean }) {
  const { me, mod } = useApp()
  const run = useAction()
  const { data: categories = [] } = useData(() => api.categories.list())
  const billing = me!.business.billing
  const [f, setF] = useState({ name: '', categoryId: '', mrp: '', price: '', taxRateId: '', unit: 'pc', stock: '' })
  const priceTouched = f.price !== ''
  const save = async () => {
    let saved: Product | null = null
    const ok = await run(async () => {
      saved = await api.products.save({
        name: f.name, barcode, categoryId: f.categoryId || categories[0]?.id || null, unit: f.unit,
        mrp: f.mrp ? Number(f.mrp) : null, price: Number(f.price || f.mrp || 0), taxRateId: f.taxRateId || null,
        trackStock: mod('inventory'), stock: Number(f.stock) || 0, kind: 'goods', emoji: '', sendToKitchen: false, isVeg: true, active: true,
      })
    }, `${f.name} added`)
    if (ok && saved) onSaved(saved)
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); save() }} className="space-y-3">
      <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 font-mono text-sm"><Barcode className="h-4 w-4 text-slate-400" />{barcode}</div>
      <div className={compact ? 'grid gap-3 sm:grid-cols-6' : 'grid grid-cols-2 gap-3'}>
        <Field label="Product name" className={compact ? 'sm:col-span-2' : 'col-span-2'}><Input autoFocus required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Maggi Noodles 70 g" /></Field>
        <Field label="MRP (₹)"><Input type="number" inputMode="decimal" step="0.01" value={f.mrp} onChange={(e) => setF({ ...f, mrp: e.target.value })} placeholder="14" /></Field>
        <Field label="Selling price (₹)"><Input type="number" inputMode="decimal" step="0.01" required={!f.mrp} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} placeholder={f.mrp || '0'} /></Field>
        <Field label="Category">
          <Select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="GST">
          <Select value={f.taxRateId} onChange={(e) => setF({ ...f, taxRateId: e.target.value })}>
            <option value="">{billing.taxRates.find((r) => r.id === billing.defaultTaxRateId)?.rate ?? 0}% (default)</option>
            {billing.taxRates.map((r) => <option key={r.id} value={r.id}>{r.rate}%</option>)}
          </Select>
        </Field>
        <Field label="Sold per"><Select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>{UNITS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        {mod('inventory') && <Field label="Opening stock"><Input type="number" inputMode="decimal" value={f.stock} onChange={(e) => setF({ ...f, stock: e.target.value })} placeholder="0" /></Field>}
      </div>
      {!priceTouched && f.mrp && <p className="text-xs text-slate-500">Selling price will be the MRP (₹{f.mrp}) unless you change it.</p>}
      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Skip</Button>}
        <Button type="submit">Save{compact ? '' : ' & add to bill'}</Button>
      </div>
    </form>
  )
}

export function QuickAddModal({ barcode, onClose, onSaved }: { barcode: string | null; onClose: () => void; onSaved: (p: Product) => void }) {
  if (!barcode) return null
  return (
    <Modal open onClose={onClose} size="md" title="New barcode" subtitle="Not in your products yet — add it and continue billing">
      <QuickAddForm barcode={barcode} onCancel={onClose} onSaved={(p) => { onSaved(p); onClose() }} />
    </Modal>
  )
}
