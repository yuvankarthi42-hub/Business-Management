import clsx from 'clsx'
import { Thumb } from '@/components/Thumb'
import { Minus, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useApp } from '@/app/AppContext'
import { Button, Input, Modal, VegMark } from '@/components/ui'
import { makeItem } from '@/core/orderItem'
import { r2 } from '@/core/pricing'
import type { AddOn, BillingSettings, OrderItem, Product, Variant } from '@/core/types'
import { money } from '@/lib/format'

export const needsOptions = (p: Product) => p.variants.length > 0 || p.addOns.length > 0

// A double-tap on "Add" must not land on the product tile underneath and reopen the picker.
let lastClosed = 0
export const optionsJustClosed = () => Date.now() - lastClosed < 400

export function QtyStepper({ value, onChange, min = 0, size = 'md' }: { value: number; onChange: (v: number) => void; min?: number; size?: 'sm' | 'md' | 'lg' }) {
  const s = { sm: 'h-7 w-7', md: 'h-8 w-8', lg: 'h-11 w-11' }[size]
  return (
    <div className="inline-flex items-center rounded-lg border border-slate-200 bg-white">
      <button type="button" aria-label="Decrease" onClick={() => onChange(Math.max(min, r2(value - 1)))} className={clsx(s, 'flex items-center justify-center text-slate-600 hover:bg-slate-50 rounded-l-lg')}><Minus className="h-3.5 w-3.5" /></button>
      <input
        value={value} inputMode="decimal"
        onChange={(e) => { const v = Number(e.target.value); if (!Number.isNaN(v)) onChange(Math.max(min, v)) }}
        className={clsx('w-10 border-x border-slate-200 text-center text-sm font-semibold tabular focus:outline-none', size === 'lg' ? 'h-11 w-14 text-base' : size === 'sm' ? 'h-7' : 'h-8')}
      />
      <button type="button" aria-label="Increase" onClick={() => onChange(r2(value + 1))} className={clsx(s, 'flex items-center justify-center text-slate-600 hover:bg-slate-50 rounded-r-lg')}><Plus className="h-3.5 w-3.5" /></button>
    </div>
  )
}

/** Variant / add-on / quantity / note picker. Used by POS, tables and mobile ordering. */
export function ItemOptionsModal({ product, onClose: close, onAdd, billing: billingOverride }: { product: Product | null; onClose: () => void; onAdd: (item: OrderItem) => void; billing?: BillingSettings }) {
  const { me } = useApp()
  const billing = billingOverride ?? me?.business.billing
  const food = !me || me.business.category === 'food' || me.business.category === 'restaurant'
  const onClose = () => { lastClosed = Date.now(); close() }
  const [variant, setVariant] = useState<Variant | null>(null)
  const [addOns, setAddOns] = useState<AddOn[]>([])
  const [qty, setQty] = useState(1)
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (product) { setVariant(product.variants[0] ?? null); setAddOns([]); setQty(1); setNotes('') }
  }, [product])

  if (!product || !billing) return null
  const unit = (variant?.price ?? product.price) + addOns.reduce((s, a) => s + a.price, 0)
  const toggle = (a: AddOn) => setAddOns((x) => (x.some((y) => y.id === a.id) ? x.filter((y) => y.id !== a.id) : [...x, a]))

  return (
    <Modal
      open onClose={onClose} size="sm"
      title={<span className="flex items-center gap-2"><Thumb item={product} className="h-9 w-9 rounded-lg text-2xl" />{product.name}</span>}
      footer={
        <div className="flex w-full items-center gap-3">
          <QtyStepper value={qty} onChange={setQty} min={1} size="lg" />
          <Button size="lg" className="flex-1" onClick={() => { onAdd(makeItem(product, billing, { variant, addOns, qty, notes: notes.trim() })); onClose() }}>
            Add · {money(r2(unit * qty))}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        {product.variants.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{food ? 'Size' : 'Variant'}</p>
            <div className="grid grid-cols-3 gap-2">
              {product.variants.map((v) => (
                <button key={v.id} onClick={() => setVariant(v)} className={clsx('rounded-xl border-2 px-2 py-2.5 text-center transition', variant?.id === v.id ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:border-slate-300')}>
                  <span className="block text-sm font-semibold">{v.name}</span>
                  <span className="block text-xs text-slate-500">{money(v.price)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {product.addOns.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Add-ons</p>
            <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
              {product.addOns.map((a) => {
                const on = addOns.some((x) => x.id === a.id)
                return (
                  <label key={a.id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-slate-50">
                    <input type="checkbox" checked={on} onChange={() => toggle(a)} className="h-4 w-4 rounded border-slate-300 text-brand-600" />
                    <span className="flex-1 text-sm">{a.name}</span>
                    <span className="text-sm text-slate-500">+ {money(a.price)}</span>
                  </label>
                )
              })}
            </div>
          </div>
        )}
        {food && <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Note for kitchen</p>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. less spicy, no onion" />
        </div>}
        {food && <div className="flex items-center gap-2 text-xs text-slate-500"><VegMark veg={product.isVeg} />{product.isVeg ? 'Vegetarian' : 'Non-vegetarian'}</div>}
      </div>
    </Modal>
  )
}
