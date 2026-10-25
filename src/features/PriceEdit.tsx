// Billing: change one line's price at the counter — a new price, or a discount in ₹ / % on that line.
// Needs "Change item price / line discount at billing"; the server checks the same permission and the MRP limit.
import clsx from 'clsx'
import { RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { Button, Field, Input, Modal, Segmented } from '@/components/ui'
import { clearCounterPrice, itemLabel, priceOverrideError, withCounterPrice } from '@/core/orderItem'
import { r2 } from '@/core/pricing'
import type { OrderItem, Product } from '@/core/types'
import { money } from '@/lib/format'

type Mode = 'price' | 'amount' | 'pct'

export function PriceEditModal({ item, product, onClose, onSave }: { item: OrderItem; product: Product | undefined; onClose: () => void; onSave: (i: OrderItem) => void }) {
  const list = item.listPrice ?? item.unitPrice
  const [mode, setMode] = useState<Mode>('price')
  const [v, setV] = useState(item.listPrice !== undefined ? String(item.unitPrice) : '')
  const n = v.trim() === '' ? NaN : Number(v)
  const price = !Number.isFinite(n) ? NaN : mode === 'price' ? r2(n) : mode === 'amount' ? r2(list - n) : r2(list * (1 - n / 100))
  const mrp = item.variantId ? null : product?.mrp ?? null
  const err = Number.isFinite(price) ? (mode === 'pct' && (n < 0 || n > 100) ? 'Discount must be between 0 and 100%' : priceOverrideError(price, mrp)) : ''
  const off = Number.isFinite(price) ? r2(list - price) : 0
  const save = () => { if (Number.isFinite(price) && !err) { onSave(withCounterPrice(item, price, product)); onClose() } }
  return (
    <Modal open onClose={onClose} size="sm" title="Change price" subtitle={`${itemLabel(item)} · price ${money(list, { decimals: true })}${mrp ? ` · MRP ${money(mrp)}` : ''}`}
      footer={<>
        {item.listPrice !== undefined && <Button variant="ghost" icon={RotateCcw} className="mr-auto" onClick={() => { onSave(clearCounterPrice(item, product)); onClose() }}>Back to {money(list)}</Button>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={!Number.isFinite(price) || !!err} onClick={save}>Apply</Button>
      </>}>
      <div className="space-y-4">
        <Segmented size="sm" block value={mode} onChange={(m) => { setMode(m); setV('') }} options={[{ value: 'price', label: 'New price' }, { value: 'amount', label: 'Discount ₹' }, { value: 'pct', label: 'Discount %' }]} />
        <Field required label={mode === 'price' ? 'Price for 1 piece' : mode === 'amount' ? 'Discount on 1 piece (₹)' : 'Discount %'} error={err || undefined}>
          <div className="relative">
            {mode !== 'pct' && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">₹</span>}
            <Input autoFocus type="number" inputMode="decimal" min={0} step="0.01" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save() }}
              className={clsx('h-12 text-lg font-semibold', mode !== 'pct' ? 'pl-7' : 'pr-8')} placeholder={mode === 'price' ? String(list) : '0'} />
            {mode === 'pct' && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">%</span>}
          </div>
        </Field>
        {Number.isFinite(price) && !err && (
          <div className="rounded-lg bg-slate-50 px-3 py-2.5 text-sm">
            <div className="flex justify-between"><span className="text-slate-500">New price</span><span className="font-semibold tabular">{money(price, { decimals: true })}</span></div>
            {item.qty !== 1 && <div className="flex justify-between"><span className="text-slate-500">× {item.qty}</span><span className="tabular">{money(r2(price * item.qty), { decimals: true })}</span></div>}
            {off !== 0 && <div className={clsx('flex justify-between', off > 0 ? 'text-emerald-700' : 'text-amber-700')}><span>{off > 0 ? 'Customer saves' : 'Above the usual price by'}</span><span className="tabular">{money(Math.abs(r2(off * item.qty)), { decimals: true })}</span></div>}
          </div>
        )}
      </div>
    </Modal>
  )
}
