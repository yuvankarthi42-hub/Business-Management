import clsx from 'clsx'
import { ChefHat, ShoppingBasket, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useApp } from '@/app/AppContext'
import { EmptyState } from '@/components/ui'
import { itemLabel } from '@/core/orderItem'
import { lineTotal, r2, type Totals } from '@/core/pricing'
import { money } from '@/lib/format'
import type { Cart } from './cart'
import { QtyStepper } from './ItemOptions'

export function CartLines({ cart, showKot }: { cart: Cart; showKot?: boolean }) {
  const { t } = useApp()
  if (!cart.items.length) return <EmptyState icon={ShoppingBasket} title="No items yet" description={`Tap a ${t('product').toLowerCase()} to add it.`} />
  return (
    <ul className="divide-y divide-slate-100">
      {cart.items.map((i) => {
        const pending = showKot && i.qty > i.kotQty
        return (
          <li key={i.id} className="flex items-start gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-tight text-slate-800">{itemLabel(i)}</p>
              {i.addOns.length > 0 && <p className="mt-0.5 text-xs text-slate-500">+ {i.addOns.map((a) => a.name).join(', ')}</p>}
              {i.notes && <p className="mt-0.5 text-xs italic text-amber-700">“{i.notes}”</p>}
              <p className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                {money(i.unitPrice)} / {i.unit}
                {showKot && (pending
                  ? <span className="inline-flex items-center gap-0.5 font-medium text-orange-600"><ChefHat className="h-3 w-3" />{i.kotQty ? `+${r2(i.qty - i.kotQty)} new` : 'Not sent'}</span>
                  : <span className="inline-flex items-center gap-0.5 font-medium text-emerald-600"><ChefHat className="h-3 w-3" />Sent</span>)}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <QtyStepper size="sm" value={i.qty} onChange={(v) => cart.setQty(i.id, v)} />
              <span className="text-sm font-semibold tabular">{money(lineTotal(i))}</span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function TotalsBlock({ totals, cart, allowDiscount, big }: { totals: Totals; cart?: Cart; allowDiscount?: boolean; big?: boolean }) {
  const { me } = useApp()
  const [mode, setMode] = useState<'amt' | 'pct'>('amt')
  const [raw, setRaw] = useState('')
  const billing = me!.business.billing
  const apply = (v: string, m = mode) => {
    setRaw(v)
    const n = Number(v) || 0
    cart?.setDiscount(m === 'pct' ? r2((totals.subtotal * Math.min(100, n)) / 100) : n)
  }
  return (
    <div className="space-y-1.5 text-sm">
      <Line l="Subtotal" r={money(totals.subtotal, { decimals: true })} />
      {allowDiscount && cart && billing.discountEnabled ? (
        <div className="flex items-center justify-between gap-2 text-slate-600">
          <span>Discount</span>
          <div className="flex items-center gap-1.5">
            <div className="flex overflow-hidden rounded-md border border-slate-200 text-[11px] font-semibold">
              {(['amt', 'pct'] as const).map((m) => (
                <button key={m} type="button" onClick={() => { setMode(m); apply(raw, m) }} className={clsx('px-1.5 py-0.5', mode === m ? 'bg-slate-800 text-white' : 'text-slate-500')}>{m === 'amt' ? '₹' : '%'}</button>
              ))}
            </div>
            <input value={raw} onChange={(e) => apply(e.target.value)} inputMode="decimal" placeholder="0" className="h-7 w-16 rounded-md border border-slate-200 px-2 text-right text-sm focus:border-brand-500 focus:outline-none" />
            <span className="w-16 text-right tabular text-emerald-700">-{money(totals.discount)}</span>
          </div>
        </div>
      ) : totals.discount > 0 && <Line l="Discount" r={`-${money(totals.discount, { decimals: true })}`} />}
      {billing.taxEnabled && <Line l={`Tax ${billing.taxMode === 'inclusive' ? '(incl.)' : ''}`} r={money(totals.tax, { decimals: true })} />}
      {totals.roundOff !== 0 && <Line l="Round off" r={money(totals.roundOff, { decimals: true })} />}
      <div className={clsx('flex items-center justify-between border-t border-dashed border-slate-200 pt-2 font-semibold text-slate-900', big ? 'text-xl' : 'text-base')}>
        <span>Total</span><span className="tabular">{money(totals.total, { decimals: true })}</span>
      </div>
    </div>
  )
}

const Line = ({ l, r }: { l: string; r: string }) => <div className="flex items-center justify-between text-slate-600"><span>{l}</span><span className="tabular">{r}</span></div>

export function ClearButton({ onClick }: { onClick: () => void }) {
  return <button onClick={onClick} className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" />Clear</button>
}
