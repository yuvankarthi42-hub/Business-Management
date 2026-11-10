import clsx from 'clsx'
import { CircleAlert, Scale } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useApp } from '@/app/AppContext'
import { Button, Field, Input, Modal } from '@/components/ui'
import { r2 } from '@/core/pricing'
import { billWeight } from '@/core/scale'
import type { Product } from '@/core/types'
import { money } from '@/lib/format'
import { useScale } from '@/features/scale/scaleDevice'

const QUICK: Record<string, number[]> = {
  kg: [0.25, 0.5, 1, 2, 5, 10], g: [100, 250, 500, 1000], ltr: [0.5, 1, 2, 5], ml: [100, 250, 500, 1000],
}
const label = (q: number, unit: string) =>
  unit === 'kg' && q < 1 ? `${q * 1000} g` : unit === 'ltr' && q < 1 ? `${q * 1000} ml` : `${q} ${unit}`
/** Items the scale can weigh (volume items are typed as before). */
const BY_SCALE: Record<string, number> = { kg: 1, g: 1000 }
/** How long a steady weight waits before it goes on the bill by itself. */
const AUTO_MS = 900

/**
 * Loose items: the weight from the branch's scale (when it has one), or pick a quick weight, type the weight, or
 * type the amount the customer wants.
 */
export function WeightModal({ product, initial, onClose, onAdd }: { product: Product | null; initial?: number; onClose: () => void; onAdd: (qty: number) => void }) {
  const { me } = useApp()
  const [w, setW] = useState('')
  const [amt, setAmt] = useState('')
  // Typing or a quick weight takes over from the scale until the window closes.
  const [manual, setManual] = useState(false)
  useEffect(() => { if (product) { setW(initial ? String(initial) : ''); setAmt(''); setManual(false) } }, [product, initial])
  const sc = useScale(me?.branch)
  const factor = product ? BY_SCALE[product.unit] : undefined
  const useScaleNow = !!product && !!factor && sc.status !== 'off' && !manual
  const scaleQty = useScaleNow && sc.kg !== null ? Math.round(billWeight(sc.kg, sc.settings) * factor! * 1000) / 1000 : 0
  const typed = Math.round((Number(w) || 0) * 1000) / 1000
  const qty = useScaleNow ? scaleQty : typed
  const total = product ? r2(qty * product.price) : 0
  const ready = useScaleNow && sc.stable && scaleQty > 0

  // Steady weight → onto the bill by itself (branch setting), unless the cashier starts typing.
  const addRef = useRef<() => void>(() => {})
  const [counting, setCounting] = useState(false)
  useEffect(() => {
    if (!ready || !sc.settings.autoAdd) { setCounting(false); return }
    setCounting(true)
    const t = setTimeout(() => addRef.current(), AUTO_MS)
    return () => clearTimeout(t)
  }, [ready, scaleQty, sc.settings.autoAdd])

  if (!product) return null
  const fromAmount = (v: string) => { setManual(true); setAmt(v); const a = Number(v); if (a > 0) setW(String(Math.round((a / product.price) * 1000) / 1000)) }
  const add = () => { if (qty > 0) { onAdd(qty); onClose() } }
  addRef.current = add
  const live = useScaleNow
  const scaleNote = sc.status === 'unsupported' ? 'This browser can’t read the scale — type the weight.'
    : sc.status === 'not-paired' ? 'Scale not connected on this computer (Settings → Printer, scale and bill).'
    : sc.status === 'disconnected' || sc.status === 'error' ? 'Scale not connected — check the cable, or type the weight.'
    : sc.status === 'silent' ? 'The scale is not sending its weight — type the weight.'
    : sc.status === 'connecting' ? 'Connecting to the scale…' : ''
  return (
    <Modal open onClose={onClose} size="sm" title={<span className="flex items-center gap-2"><Scale className="h-5 w-5 text-brand-600" />{product.name}</span>}
      subtitle={`${money(product.price)} per ${product.unit}`}
      footer={<Button size="lg" block disabled={!qty} onClick={add}>Add · {money(total, { decimals: true })}</Button>}>
      <form onSubmit={(e) => { e.preventDefault(); add() }} className="space-y-4">
        {live && (
          <div className={clsx('rounded-xl border-2 p-4', ready ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-slate-50')}>
            {scaleNote && sc.status !== 'connected' ? (
              <p className="flex items-start gap-2 text-sm text-amber-800"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />{scaleNote}</p>
            ) : (
              <div className="flex items-end justify-between gap-3">
                <div>
                  <p className="text-xs text-slate-500">Weight from scale</p>
                  <p className="font-mono text-3xl font-semibold tabular-nums" data-no-i18n>{scaleQty > 0 ? label(scaleQty, product.unit) : '—'}</p>
                  <p className={clsx('text-xs font-medium', ready ? 'text-emerald-700' : 'text-amber-700')}>
                    {sc.kg === null ? 'Waiting for the scale…' : scaleQty <= 0 ? 'Put the item on the scale' : ready ? (counting ? 'Steady · adding…' : 'Steady · press Enter to add') : 'Waiting for a steady weight…'}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-slate-500">Amount</p>
                  <p className="text-3xl font-semibold tabular-nums">{money(total, { decimals: true })}</p>
                </div>
              </div>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {(QUICK[product.unit] ?? QUICK.kg).map((q) => (
            <button key={q} type="button" onClick={() => { setManual(true); setW(String(q)); setAmt('') }}
              className={clsx('rounded-full border px-3.5 py-1.5 text-sm font-medium transition', !live && qty === q ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 hover:border-slate-300')}>
              {label(q, product.unit)}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Weight (${product.unit})`}><Input autoFocus={!live} inputMode="decimal" value={live ? '' : w} onChange={(e) => { setManual(true); setW(e.target.value.replace(/[^\d.]/g, '')); setAmt('') }} placeholder={live ? 'Type to override' : '1.250'} className="h-12 text-lg font-semibold" /></Field>
          <Field label="or Amount (₹)"><Input inputMode="decimal" value={amt} onChange={(e) => fromAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="100" className="h-12 text-lg" /></Field>
        </div>
        {!live && qty > 0 && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm"><b>{label(qty, product.unit)}</b> × {money(product.price)} = <b>{money(total, { decimals: true })}</b></p>}
        {/* Enter adds the steady weight even while the cursor is nowhere. */}
        {live && <button type="submit" className="sr-only" autoFocus>Add</button>}
      </form>
    </Modal>
  )
}
