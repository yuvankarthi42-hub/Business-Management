import clsx from 'clsx'
import { Scale } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, Field, Input, Modal } from '@/components/ui'
import { r2 } from '@/core/pricing'
import type { Product } from '@/core/types'
import { money } from '@/lib/format'

const QUICK: Record<string, number[]> = {
  kg: [0.25, 0.5, 1, 2, 5, 10], g: [100, 250, 500, 1000], ltr: [0.5, 1, 2, 5], ml: [100, 250, 500, 1000],
}
const label = (q: number, unit: string) =>
  unit === 'kg' && q < 1 ? `${q * 1000} g` : unit === 'ltr' && q < 1 ? `${q * 1000} ml` : `${q} ${unit}`

/** Loose items: pick a quick weight, type the weight, or type the amount the customer wants. */
export function WeightModal({ product, initial, onClose, onAdd }: { product: Product | null; initial?: number; onClose: () => void; onAdd: (qty: number) => void }) {
  const [w, setW] = useState('')
  const [amt, setAmt] = useState('')
  useEffect(() => { if (product) { setW(initial ? String(initial) : ''); setAmt('') } }, [product, initial])
  if (!product) return null
  const qty = r2(Number(w) || 0) === 0 ? 0 : Math.round((Number(w) || 0) * 1000) / 1000
  const total = r2(qty * product.price)
  const fromAmount = (v: string) => { setAmt(v); const a = Number(v); if (a > 0) setW(String(Math.round((a / product.price) * 1000) / 1000)) }
  const add = () => { if (qty > 0) { onAdd(qty); onClose() } }
  return (
    <Modal open onClose={onClose} size="sm" title={<span className="flex items-center gap-2"><Scale className="h-5 w-5 text-brand-600" />{product.name}</span>}
      subtitle={`${money(product.price)} per ${product.unit}`}
      footer={<Button size="lg" block disabled={!qty} onClick={add}>Add · {money(total, { decimals: true })}</Button>}>
      <form onSubmit={(e) => { e.preventDefault(); add() }} className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {(QUICK[product.unit] ?? QUICK.kg).map((q) => (
            <button key={q} type="button" onClick={() => { setW(String(q)); setAmt('') }}
              className={clsx('rounded-full border px-3.5 py-1.5 text-sm font-medium transition', qty === q ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 hover:border-slate-300')}>
              {label(q, product.unit)}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Weight (${product.unit})`}><Input autoFocus inputMode="decimal" value={w} onChange={(e) => { setW(e.target.value.replace(/[^\d.]/g, '')); setAmt('') }} placeholder="1.250" className="h-12 text-lg font-semibold" /></Field>
          <Field label="or Amount (₹)"><Input inputMode="decimal" value={amt} onChange={(e) => fromAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="100" className="h-12 text-lg" /></Field>
        </div>
        {qty > 0 && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm"><b>{label(qty, product.unit)}</b> × {money(product.price)} = <b>{money(total, { decimals: true })}</b></p>}
      </form>
    </Modal>
  )
}
