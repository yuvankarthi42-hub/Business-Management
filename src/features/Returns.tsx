import clsx from 'clsx'
import { Minus, PackageCheck, PackageX, Plus, Printer, RotateCcw, ShoppingCart, TicketCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useApp, useData } from '@/app/AppContext'
import { Badge, Button, Field, Input, Modal, Segmented, Select, useAction } from '@/components/ui'
import { PAYMENT_LABEL, RETURN_REASON } from '@/core/config'
import type { Order, PaymentMethod, ReturnReason, SaleReturn } from '@/core/types'
import { api } from '@/data'
import { fmtDateTime, money } from '@/lib/format'
import { usePrint } from './Payment'

const r2 = (n: number) => Math.round(n * 100) / 100

/** Return items from a bill → stock back (unless damaged) → refund or credit note (for an exchange). */
export function ReturnModal({ order: o, onClose }: { order: Order; onClose: () => void }) {
  const { me, t } = useApp()
  const run = useAction()
  const nav = useNavigate()
  const { data } = useData(() => api.returns.forOrder(o.id), [o.id])
  const [qty, setQty] = useState<Record<string, number>>({})
  const [restock, setRestock] = useState<Record<string, boolean>>({})
  const [reason, setReason] = useState<ReturnReason>('not_needed')
  const [note, setNote] = useState('')
  const [settle, setSettle] = useState<'refund' | 'exchange' | 'credit_note'>('refund')
  const methods = (me?.business.billing.paymentMethods ?? ['cash']).filter((m) => !['credit', 'credit_note'].includes(m))
  const [method, setMethod] = useState<PaymentMethod>(methods[0] ?? 'cash')
  const [done, setDone] = useState<SaleReturn | null>(null)
  const { print, portal } = usePrint()

  // Damaged / expired goods don't go back on the shelf by default.
  useEffect(() => { if (reason === 'damaged' || reason === 'expired') setRestock({}) }, [reason])
  const keepDefault = reason !== 'damaged' && reason !== 'expired'
  const back = (id: string) => restock[id] ?? keepDefault

  const items = data?.items ?? []
  const ratio = data?.ratio ?? 0
  const lines = items.filter((i) => (qty[i.id] ?? 0) > 0)
  const exact = r2(lines.reduce((a, i) => a + i.unitPrice * qty[i.id] * ratio, 0))
  const alreadyBack = (data?.returns ?? []).reduce((a, r) => a + r.total, 0)
  const total = r2(Math.min(me?.business.billing.roundOff ? Math.round(exact) : exact, o.total - alreadyBack))
  const due = r2(Math.min(total, o.balance))
  const rest = r2(total - due)
  const step = (i: (typeof items)[number], d: number) => {
    const isWeight = ['kg', 'g', 'ltr', 'ml'].includes(i.unit)
    const unit = isWeight && i.returnable < 1 ? i.returnable : 1
    setQty((q) => ({ ...q, [i.id]: Math.max(0, Math.min(i.returnable, r2((q[i.id] ?? 0) + d * unit))) }))
  }

  if (done) {
    return (
      <Modal open onClose={onClose} size="sm" title={`Return saved · ${done.number}`}>
        {portal}
        <div className="space-y-2 text-sm">
          <p>{money(done.total)} returned from {done.invoiceNumber}.</p>
          {done.dueAdjusted > 0 && <p className="text-slate-600">{money(done.dueAdjusted)} taken off the pending due.</p>}
          {done.refunded > 0 && <p className="font-semibold text-emerald-700">Give back {money(done.refunded)} by {PAYMENT_LABEL[done.refundMethod ?? 'cash']}.</p>}
          {done.creditIssued > 0 && <p className="rounded-lg bg-emerald-50 px-3 py-2 font-semibold text-emerald-800">Credit note {done.number} · {money(done.creditIssued)} — use it as payment on the new bill.</p>}
          <p className="text-xs text-slate-500">{done.lines.filter((l) => l.restock).length ? 'Returned items are back in stock.' : 'Items were not added back to stock.'}</p>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" icon={Printer} write={false} onClick={() => print(<CreditNoteSlip r={done} />)}>{done.creditIssued > 0 ? 'Print credit note' : 'Print return slip'}</Button>
          {done.creditIssued > 0 && <Button icon={ShoppingCart} write={false} onClick={() => { onClose(); nav(`/billing?cn=${encodeURIComponent(done.number)}`) }}>Start exchange bill</Button>}
          {!done.creditIssued && <Button write={false} onClick={onClose}>Done</Button>}
        </div>
      </Modal>
    )
  }

  return (
    <Modal open onClose={onClose} size="lg" title={`Return items · ${o.invoiceNumber}`} subtitle={`Billed ${fmtDateTime(o.billedAt ?? o.createdAt)} · ${money(o.total)}${o.balance > 0 ? ` · ${money(o.balance)} still due` : ''}`}>
      {portal}
      <div className="space-y-4">
        <div className="overflow-hidden rounded-xl border border-slate-200">
          {items.map((i) => {
            const q = qty[i.id] ?? 0
            return (
              <div key={i.id} className={clsx('flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-2.5 last:border-0', q > 0 && 'bg-brand-50/40')}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{i.variantName ? `${i.name} (${i.variantName})` : i.name}</p>
                  <p className="text-xs text-slate-500">Bought {i.qty} · {money(i.unitPrice)} each{i.returned > 0 && <> · <span className="text-amber-700">{i.returned} already returned</span></>}</p>
                </div>
                {i.returnable > 0 ? (
                  <>
                    {q > 0 && (
                      <button type="button" onClick={() => setRestock({ ...restock, [i.id]: !back(i.id) })} title={back(i.id) ? 'Goes back to stock — tap if damaged' : 'Not added to stock — tap if it can be sold again'}
                        className={clsx('inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium', back(i.id) ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700')}>
                        {back(i.id) ? <PackageCheck className="h-3.5 w-3.5" /> : <PackageX className="h-3.5 w-3.5" />}{back(i.id) ? 'Back to stock' : 'Damaged'}
                      </button>
                    )}
                    <div className="flex items-center rounded-lg border border-slate-200">
                      <button type="button" aria-label="Less" className="p-1.5 text-slate-500 disabled:opacity-30" disabled={!q} onClick={() => step(i, -1)}><Minus className="h-4 w-4" /></button>
                      <input aria-label={`Return quantity for ${i.name}`} inputMode="decimal" value={q || ''} placeholder="0"
                        onChange={(e) => setQty({ ...qty, [i.id]: Math.max(0, Math.min(i.returnable, Number(e.target.value) || 0)) })} className="w-12 border-0 p-0 text-center text-sm font-semibold tabular focus:ring-0" />
                      <button type="button" aria-label="More" className="p-1.5 text-slate-500 disabled:opacity-30" disabled={q >= i.returnable} onClick={() => step(i, 1)}><Plus className="h-4 w-4" /></button>
                    </div>
                    <button type="button" className="text-xs text-brand-600 hover:underline" onClick={() => setQty({ ...qty, [i.id]: i.returnable })}>All {i.returnable}</button>
                  </>
                ) : <Badge>Fully returned</Badge>}
              </div>
            )
          })}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field required label="Reason">
            <Select value={reason} onChange={(e) => setReason(e.target.value as ReturnReason)}>
              {(Object.keys(RETURN_REASON) as ReturnReason[]).map((r) => <option key={r} value={r}>{RETURN_REASON[r]}</option>)}
            </Select>
          </Field>
          <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Seal broken" maxLength={300} /></Field>
        </div>

        {total > 0 && (
          <div className="rounded-xl bg-slate-50 p-4">
            <div className="flex justify-between text-sm"><span>Return value <span className="text-xs text-slate-500">(with the bill’s discount and tax)</span></span><b className="tabular">{money(total, { decimals: true })}</b></div>
            {due > 0 && <div className="mt-1 flex justify-between text-sm text-slate-600"><span>Taken off the pending due</span><span className="tabular">− {money(due, { decimals: true })}</span></div>}
            {rest > 0 && (
              <div className="mt-3 space-y-2">
                <p className="text-sm font-medium">{money(rest, { decimals: true })} to the {t('customer').toLowerCase()} as</p>
                <Segmented size="sm" value={settle} onChange={setSettle} options={[{ value: 'refund', label: 'Refund money' }, { value: 'exchange', label: 'Exchange — buy other items' }, { value: 'credit_note', label: 'Credit note — use later' }]} />
                {settle === 'refund' && <div className="flex flex-wrap gap-1.5">{methods.map((m) => <button key={m} type="button" onClick={() => setMethod(m)} className={clsx('rounded-lg border px-3 py-1.5 text-sm font-medium', method === m ? 'border-brand-600 bg-white text-brand-700' : 'border-slate-200 bg-white text-slate-600')}>{PAYMENT_LABEL[m]}</button>)}</div>}
                {settle === 'exchange' && <p className="text-xs text-slate-600">After saving, billing opens for the new items. This value is taken off the new bill; the {t('customer').toLowerCase()} pays only the difference (any amount left stays as a credit note).</p>}
                {settle === 'credit_note' && <p className="text-xs text-slate-600">A credit note number is printed. The {t('customer').toLowerCase()} can use it as payment on any bill later.</p>}
              </div>
            )}
            {rest === 0 && due > 0 && <p className="mt-2 text-xs text-slate-600">Nothing to give back — the whole value reduces the due.</p>}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
          <Button variant="ghost" write={false} onClick={onClose}>Cancel</Button>
          <Button icon={settle === 'exchange' && rest > 0 ? ShoppingCart : RotateCcw} disabled={!lines.length} onClick={() => run(async () => {
            const r = await api.returns.create({ orderId: o.id, lines: lines.map((i) => ({ orderItemId: i.id, qty: qty[i.id], restock: back(i.id) })), reason, note, settle: settle === 'refund' ? 'refund' : 'credit_note', refundMethod: method })
            // Exchange: go straight to a new bill that uses this credit.
            if (settle === 'exchange' && r.creditIssued > 0) { onClose(); nav(`/billing?cn=${encodeURIComponent(r.number)}`) } else setDone(r)
          }, settle === 'exchange' && rest > 0 ? 'Return saved — add the new items' : undefined)}>{settle === 'exchange' && rest > 0 ? `Save & start exchange bill · ${money(total)}` : `Save return · ${money(total)}`}</Button>
        </div>
      </div>
    </Modal>
  )
}

/** Returns already made on a bill (shown in the bill details). */
export function BillReturns({ orderId }: { orderId: string }) {
  const { data } = useData(() => api.returns.forOrder(orderId), [orderId])
  const { print, portal } = usePrint()
  const list = useMemo(() => data?.returns ?? [], [data])
  if (!list.length) return null
  return (
    <section>
      {portal}
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Returns</h4>
      <ul className="space-y-2">
        {list.map((r) => (
          <li key={r.id} className="rounded-xl border border-slate-200 px-3 py-2 text-sm">
            <div className="flex items-center gap-2">
              <TicketCheck className="h-4 w-4 text-slate-400" /><b>{r.number}</b><span className="text-slate-500">{fmtDateTime(r.createdAt)}</span>
              <span className="ml-auto font-semibold tabular">− {money(r.total)}</span>
              <Button size="sm" variant="ghost" icon={Printer} write={false} onClick={() => print(<CreditNoteSlip r={r} />)} aria-label="Print credit note" title="Print credit note" />
            </div>
            <p className="mt-1 text-xs text-slate-600">{r.lines.map((l) => `${l.qty} × ${l.name}${l.restock ? '' : ' (damaged)'}`).join(', ')} · {RETURN_REASON[r.reason]}</p>
            <p className="text-xs text-slate-500">
              {[r.dueAdjusted > 0 && `${money(r.dueAdjusted)} off due`, r.refunded > 0 && `${money(r.refunded)} refunded (${PAYMENT_LABEL[r.refundMethod ?? 'cash']})`,
                r.creditIssued > 0 && `credit note ${money(r.creditIssued)}${r.creditRemaining < r.creditIssued ? ` · ${money(r.creditRemaining)} left` : ''}`].filter(Boolean).join(' · ')}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Printed credit note (thermal width). */
export function CreditNoteSlip({ r }: { r: SaleReturn }) {
  const { me } = useApp()
  const b = me!.business
  return (
    <div data-no-i18n className="font-mono text-[11.5px] leading-snug text-black" style={{ maxWidth: '80mm' }}>
      <p className="text-center text-[15px] font-bold uppercase">{b.name}</p>
      {b.gstin && <p className="text-center">GSTIN: {b.gstin}</p>}
      <div className="my-1.5 border-t-2 border-black" />
      <p className="text-center font-bold">CREDIT NOTE</p>
      <div className="my-1.5 border-t border-dashed border-black" />
      <div className="flex justify-between"><span>No: <b>{r.number}</b></span><span>{new Date(r.createdAt).toLocaleDateString('en-IN')}</span></div>
      <p>Against bill: {r.invoiceNumber}</p>
      <div className="my-1.5 border-t border-dashed border-black" />
      {r.lines.map((l, i) => <div key={i} className="flex justify-between gap-2"><span>{l.qty} × {l.name}</span><span>{l.amount.toFixed(2)}</span></div>)}
      <div className="my-1.5 border-t-2 border-black" />
      <div className="flex justify-between font-bold"><span>TOTAL</span><span>{b.currencySymbol}{r.total.toFixed(2)}</span></div>
      {r.tax > 0 && <div className="flex justify-between"><span>Incl. tax</span><span>{r.tax.toFixed(2)}</span></div>}
      {r.dueAdjusted > 0 && <div className="flex justify-between"><span>Adjusted in due</span><span>{r.dueAdjusted.toFixed(2)}</span></div>}
      {r.refunded > 0 && <div className="flex justify-between"><span>Refunded ({PAYMENT_LABEL[r.refundMethod ?? 'cash']})</span><span>{r.refunded.toFixed(2)}</span></div>}
      {r.creditIssued > 0 && <><div className="flex justify-between font-bold"><span>Credit available</span><span>{b.currencySymbol}{r.creditRemaining.toFixed(2)}</span></div><p className="mt-1 text-center">Show this number at billing to use it.</p></>}
      <p className="mt-1 text-center">Reason: {RETURN_REASON[r.reason]}</p>
    </div>
  )
}

/** On the billing screen during an exchange: which credit note will be used. */
export function ExchangeNote() {
  const [params, setParams] = useSearchParams()
  const no = params.get('cn')
  const { data } = useData(() => (no ? api.returns.creditNote(no).catch(() => null) : Promise.resolve(null)), [no])
  if (!no) return null
  return (
    <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
      <TicketCheck className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">Exchange · credit note <b>{no}</b>{data ? ` · ${money(data.creditRemaining)} will be used at payment` : ''}</span>
      <button type="button" className="font-semibold underline" onClick={() => { params.delete('cn'); setParams(params, { replace: true }) }}>Remove</button>
    </div>
  )
}
