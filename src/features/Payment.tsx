import clsx from 'clsx'
import { Banknote, Check, CheckCircle2, TicketCheck, CreditCard, Download, Landmark, MessageCircle, Plus, Printer, Share2, Smartphone, Split, Wallet } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'react-router-dom'
import { useApp, useData } from '@/app/AppContext'
import { Button, Input, Modal, useAction, useToast } from '@/components/ui'
import { isTextile, ORDER_TYPE_LABEL, PAYMENT_LABEL } from '@/core/config'
import { itemLabel } from '@/core/orderItem'
import { discountParts, lineMrp, lineTotal, mrpSaved, preGstLines, r2, taxableValue, taxBreakup, taxIncluded } from '@/core/pricing'
import { stateLabel } from '@/core/gst'
import type { Branch, Business, Customer, Order, Payment, PaymentMethod } from '@/core/types'
import { api, type PaymentInput } from '@/data'
import { formatPhone } from '@/core/phone'
import { useWhatsApp } from './whatsapp/useWhatsApp'
import { amountInWords, fmtDateTime, money } from '@/lib/format'
import { CustomerPicker } from './CustomerPicker'
import { needsImage, receiptDoc } from './printing/doc'
import { encodeImage, encodeText } from './printing/escpos'
import { printerFor, sendToPrinter, usePrinterSettings } from './printing/printer'

const ICON: Record<PaymentMethod | 'split', typeof Banknote> = { cash: Banknote, upi: Smartphone, card: CreditCard, bank: Landmark, credit: Wallet, credit_note: TicketCheck, split: Split }

export function PaymentModal({ open, onClose, total, customerId, onCustomerChange, onConfirm, title }: {
  open: boolean; onClose: () => void; total: number; customerId: string | null; onCustomerChange: (id: string | null) => void
  onConfirm: (pays: PaymentInput[]) => Promise<boolean>; title?: string
}) {
  const { me, t } = useApp()
  const methods = me?.business.billing.paymentMethods ?? ['cash']
  const [mode, setMode] = useState<PaymentMethod | 'split'>('cash')
  const [tendered, setTendered] = useState('')
  const [paidNow, setPaidNow] = useState('')
  const [split, setSplit] = useState<Partial<Record<PaymentMethod, string>>>({})
  const [busy, setBusy] = useState(false)
  // Credit note (exchange / earlier return) used as payment, with the rest paid another way.
  const [cnNo, setCnNo] = useState('')
  const [cn, setCn] = useState<{ number: string; remaining: number } | null>(null)
  const [cnError, setCnError] = useState('')
  const [cnRest, setCnRest] = useState<PaymentMethod>('cash')

  // Exchange: Returns → "Start exchange bill" opens billing with ?cn=CN-1001, used here automatically.
  const [params, setParams] = useSearchParams()
  const linkedCn = params.get('cn')
  useEffect(() => {
    if (!open) return
    setTendered(''); setPaidNow(''); setSplit({}); setCn(null); setCnError('')
    if (linkedCn) { setMode('credit_note'); setCnNo(linkedCn); void findCn(linkedCn) } else { setMode('cash'); setCnNo('') }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const findCn = async (no = cnNo) => {
    setCnError(''); setCn(null)
    try {
      const r = await api.returns.creditNote(no)
      if (r.creditRemaining <= 0) setCnError(`${r.number} is already used`)
      else setCn({ number: r.number, remaining: r.creditRemaining })
    } catch (e) { setCnError((e as Error).message) }
  }

  const splitSum = r2(Object.values(split).reduce((a, v) => a + (Number(v) || 0), 0))
  let pays: PaymentInput[] = []
  let balance = 0
  if (mode === 'credit') { const p = Math.min(total, Number(paidNow) || 0); pays = p ? [{ method: 'cash', amount: p }] : []; balance = r2(total - p) }
  else if (mode === 'split') { pays = (Object.entries(split) as [PaymentMethod, string][]).filter(([, v]) => Number(v) > 0).map(([m, v]) => ({ method: m, amount: Number(v) })); balance = r2(total - splitSum) }
  else if (mode === 'credit_note') {
    const use = cn ? r2(Math.min(cn.remaining, total)) : 0
    const rest = r2(total - use)
    pays = [...(use ? [{ method: 'credit_note' as const, amount: use, reference: cn!.number }] : []), ...(rest > 0 && cnRest !== 'credit' ? [{ method: cnRest, amount: rest }] : [])]
    balance = rest > 0 && cnRest === 'credit' ? rest : 0
  }
  else pays = [{ method: mode, amount: total }]
  const change = mode === 'cash' && Number(tendered) > total ? r2(Number(tendered) - total) : 0
  const overpaid = mode === 'split' && splitSum > total
  const needCustomer = balance > 0 && !customerId
  const error = mode === 'credit_note' && !cn ? 'Find the credit note first' : overpaid ? 'Split amounts are more than the bill' : needCustomer ? `Select a ${t('customer').toLowerCase()} to keep ${money(balance)} as credit` : ''

  const confirm = async () => {
    if (error || busy) return
    setBusy(true)
    const ok = await onConfirm(pays)
    setBusy(false)
    if (ok) {
      if (linkedCn && pays.some((p) => p.method === 'credit_note')) { params.delete('cn'); setParams(params, { replace: true }) }
      onClose()
    }
  }

  const options: (PaymentMethod | 'split')[] = [...methods.filter((m) => m !== 'credit' && m !== 'credit_note'), ...(methods.length > 1 ? ['split' as const] : []), ...(methods.includes('credit') ? ['credit' as const] : []), 'credit_note']

  return (
    <Modal open={open} onClose={onClose} size="md" title={title ?? 'Collect payment'}
      footer={<Button size="lg" variant="success" block disabled={!!error || busy} onClick={confirm}>
        {busy ? 'Processing…' : balance > 0 ? `Save · ${money(total - balance)} paid, ${money(balance)} credit` : `Collect ${money(total)}`}
      </Button>}
    >
      <form onSubmit={(e) => { e.preventDefault(); confirm() }} className="space-y-5">
        <div className="rounded-xl bg-slate-900 px-5 py-4 text-white">
          <p className="text-xs text-slate-300">Amount to collect</p>
          <p className="mt-0.5 text-3xl font-bold tabular">{money(total)}</p>
        </div>

        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {options.map((m) => {
            const I = ICON[m]
            return (
              <button type="button" key={m} onClick={() => setMode(m)}
                className={clsx('flex flex-col items-center gap-1 rounded-xl border-2 py-2.5 text-xs font-semibold transition', mode === m ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:border-slate-300')}>
                <I className="h-5 w-5" />{m === 'split' ? 'Split' : PAYMENT_LABEL[m].replace(' Transfer', '')}
              </button>
            )
          })}
        </div>

        {mode === 'cash' && (
          <div>
            <p className="mb-2 text-xs font-medium text-slate-600">Cash received (optional — to calculate change)</p>
            <Input autoFocus type="number" inputMode="decimal" placeholder={String(total)} value={tendered} onChange={(e) => setTendered(e.target.value)} className="h-12 text-lg font-semibold" />
            <div className="mt-2 flex flex-wrap gap-2">
              {[total, ...[100, 200, 500, 2000].filter((n) => n > total).slice(0, 3)].map((n, i) => (
                <button type="button" key={i} onClick={() => setTendered(String(n))} className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium hover:bg-slate-50">{i === 0 ? 'Exact' : money(n)}</button>
              ))}
            </div>
            {change > 0 && <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">Return change: {money(change)}</p>}
          </div>
        )}

        {(mode === 'upi' || mode === 'card' || mode === 'bank') && (
          <div className="flex items-center gap-4 rounded-xl border border-slate-200 p-4">
            {mode === 'upi' && <FakeQr />}
            <p className="text-sm text-slate-600">{mode === 'upi' ? 'Ask the customer to scan & pay. Confirm after you see the payment on your UPI app.' : mode === 'card' ? 'Swipe / tap the card on your card machine, then confirm.' : 'Confirm once the bank transfer is received.'}</p>
          </div>
        )}

        {mode === 'split' && (
          <div className="space-y-2">
            {methods.filter((m) => m !== 'credit').map((m) => (
              <div key={m} className="flex items-center gap-3">
                <span className="w-24 text-sm font-medium">{PAYMENT_LABEL[m]}</span>
                <Input type="number" inputMode="decimal" placeholder="0" value={split[m] ?? ''} onChange={(e) => setSplit({ ...split, [m]: e.target.value })} />
                <Button type="button" size="sm" variant="ghost" icon={Plus} onClick={() => setSplit({ ...split, [m]: String(r2((Number(split[m]) || 0) + Math.max(0, total - splitSum))) })}>Rest</Button>
              </div>
            ))}
            <p className={clsx('text-sm font-medium', balance > 0 ? 'text-amber-700' : 'text-emerald-700')}>
              {balance > 0 ? `Remaining ${money(balance)} — will be kept as credit` : overpaid ? '' : 'Fully paid ✓'}
            </p>
          </div>
        )}

        {mode === 'credit_note' && (
          <div className="space-y-3">
            <div>
              <p className="mb-2 text-xs font-medium text-slate-600">Credit note number (from a return / exchange)</p>
              <div className="flex gap-2">
                <Input autoFocus value={cnNo} onChange={(e) => { setCnNo(e.target.value.toUpperCase()); setCn(null); setCnError('') }} placeholder="CN-1001" className="font-mono uppercase"
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void findCn() } }} />
                <Button type="button" variant="secondary" write={false} onClick={() => findCn()} disabled={!cnNo.trim()}>Find</Button>
              </div>
              {cnError && <p className="mt-1.5 text-sm text-red-600">{cnError}</p>}
            </div>
            {cn && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 text-sm">
                <p><b>{cn.number}</b> · {money(cn.remaining)} available · using <b>{money(Math.min(cn.remaining, total))}</b></p>
                {cn.remaining > total && <p className="mt-0.5 text-xs text-slate-600">{money(r2(cn.remaining - total))} stays on the credit note for next time.</p>}
                {cn.remaining < total && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-slate-700">Rest {money(r2(total - cn.remaining))} by</span>
                    {[...methods.filter((m) => m !== 'credit_note')].map((m) => (
                      <button key={m} type="button" onClick={() => setCnRest(m)} className={clsx('rounded-lg border px-2.5 py-1 text-xs font-semibold', cnRest === m ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 bg-white text-slate-600')}>{PAYMENT_LABEL[m]}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {mode === 'credit' && (
          <div>
            <p className="mb-2 text-xs font-medium text-slate-600">Paid now in cash (optional)</p>
            <Input autoFocus type="number" inputMode="decimal" placeholder="0" value={paidNow} onChange={(e) => setPaidNow(e.target.value)} />
            <p className="mt-2 text-sm text-amber-700">{money(balance)} will be added to the {t('customer').toLowerCase()}’s outstanding.</p>
          </div>
        )}

        <div>
          <p className="mb-2 text-xs font-medium text-slate-600">{t('customer')}</p>
          <CustomerPicker value={customerId} onChange={onCustomerChange} />
        </div>
        {error && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{error}</p>}
      </form>
    </Modal>
  )
}

function FakeQr() {
  // Decorative placeholder. Real UPI QR = upi://pay?pa=<vpa>&am=<amount> rendered by a QR lib.
  const cells = Array.from({ length: 81 }, (_, i) => ((i * 7919) % 13) % 3 === 0 || [0, 1, 2, 9, 11, 18, 19, 20, 6, 7, 8, 15, 17, 24, 25, 26, 54, 55, 56, 63, 65, 72, 73, 74].includes(i))
  return <div className="grid h-20 w-20 shrink-0 grid-cols-9 gap-px rounded border border-slate-200 bg-white p-1">{cells.map((c, i) => <span key={i} className={c ? 'bg-slate-900' : ''} />)}</div>
}

// ---------- Receipt ----------

export function receiptText(o: Order, b: Business, customer?: Customer | null) {
  const pre = isTextile(b) && taxIncluded(b.billing, o.tax) ? preGstLines(o) : null
  const gst = b.billing.taxRates.some((r) => /gst/i.test(r.name))
  const taxes = taxBreakup(o.items, o.discount, b.billing, o.tax).flatMap((t) => o.igst ? [`IGST @ ${t.rate}%: ${money(t.tax, { decimals: true })}`] : gst
    ? [`CGST @ ${t.rate / 2}%: ${money(r2(t.tax / 2), { decimals: true })}`, `SGST @ ${t.rate / 2}%: ${money(r2(t.tax - r2(t.tax / 2)), { decimals: true })}`]
    : [`Tax @ ${t.rate}%: ${money(t.tax, { decimals: true })}`])
  const lines = [
    `*${b.name}*`, b.address, b.gstin ? `GSTIN: ${b.gstin}` : '', '',
    `Bill No: ${o.invoiceNumber ?? o.number}`, fmtDateTime(o.billedAt ?? o.createdAt), customer ? `${b.terminology.customer.singular}: ${customer.name}` : '',
    o.customerGstin ? `Buyer GSTIN: ${o.customerGstin}` : '', (o.customerGstin || o.igst) && o.placeOfSupply ? `Place of supply: ${stateLabel(o.placeOfSupply)}` : '', '',
    ...o.items.map((i, k) => (isTextile(b)
      ? `${itemLabel(i)}${i.qty !== 1 ? ` × ${i.qty}` : ''} — MRP ${money(lineMrp(i), { decimals: true })} · ${pre ? 'Disc. price' : 'Final'} ${money(pre ? pre.lines[k] : lineTotal(i), { decimals: true })}`
      : `${i.qty} x ${itemLabel(i)} = ${money(lineTotal(i))}`)), '',
    ...(pre ? [pre.discount > 0 ? `Bill discount: -${money(pre.discount, { decimals: true })}` : '', ...taxes] : taxIncluded(b.billing, o.tax)
      ? [o.discount ? `Items total: ${money(o.subtotal, { decimals: true })}` : '', o.discount ? `Discount: -${money(o.discount, { decimals: true })}` : '', `Taxable value: ${money(taxableValue(o), { decimals: true })}`, ...taxes]
      : [`Subtotal: ${money(o.subtotal, { decimals: true })}`, o.discount ? `Discount: -${money(o.discount, { decimals: true })}` : '', ...taxes]),
    `*TOTAL: ${money(o.total, { decimals: true })}*`, o.balance > 0 ? `Balance due: ${money(o.balance, { decimals: true })}` : '',
    mrpSaved(o) > 0 ? `You saved ${money(mrpSaved(o), { decimals: true })} on MRP` : '',
    o.pointsRedeemed ? `Points used: ${o.pointsRedeemed} (−${money(o.pointsValue ?? 0, { decimals: true })})` : '',
    o.pointsEarned ? `Points earned: ${o.pointsEarned}` : '', o.pointsBalance != null && o.customerId ? `Points balance: ${o.pointsBalance}` : '',
    b.billing.receiptFooter.trim() ? `\n${b.billing.receiptFooter}` : '',
  ]
  return lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n').trim()
}

export interface ReceiptProps {
  order: Order
  business: Business
  /** Branch that made the bill — its address / phone are printed when set. */
  branch?: Branch | null
  customer?: Customer | null
  /** Staff list used to print cashier / waiter names. */
  users?: { id: string; name: string }[]
  tableLabel?: string | null
}

const d2 = (n: number) => n.toFixed(2)
const fmtBillDate = (d: string) => { const x = new Date(d); return `${String(x.getDate()).padStart(2, '0')}-${String(x.getMonth() + 1).padStart(2, '0')}-${x.getFullYear()}` }
const fmtBillTime = (d: string) => new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase()

/** Thermal-printer tax invoice (58mm / 80mm). Same component is used for preview and print. */
export function Receipt({ order: o, business: b, branch, customer, users = [], tableLabel }: ReceiptProps) {
  const address = branch?.address || b.address
  const phone = branch?.phone || b.phone
  const narrow = b.billing.paperWidth === '58mm'
  const who = (id: string) => (id === 'guest' ? 'QR order' : users.find((u) => u.id === id)?.name)
  const cashier = o.billedAt ? who(o.updatedBy) : null
  const waiter = o.type === 'dine_in' ? who(o.createdBy) : o.salespersonId ? who(o.salespersonId) : null
  const gst = b.billing.taxRates.some((r) => /gst/i.test(r.name))
  const taxes = taxBreakup(o.items, o.discount, b.billing, o.tax)
  const qty = o.items.reduce((s, i) => s + i.qty, 0)
  const saved = mrpSaved(o)
  const textileBill = isTextile(b)
  const textile = textileBill
  const incl = taxIncluded(b.billing, o.tax)
  const pre = textileBill && incl ? preGstLines(o) : null
  const parts = discountParts(o)
  const preParts = pre ? discountParts(o, pre.discount) : null
  const cols = narrow ? 'grid-cols-[1fr_22px_52px]' : 'grid-cols-[1fr_24px_48px_56px]'
  const tCols = narrow ? 'grid-cols-[1fr_52px_62px]' : 'grid-cols-[1fr_64px_80px]'
  const Hr = ({ strong }: { strong?: boolean }) => <div className={strong ? 'my-1.5 border-t-2 border-black' : 'my-1.5 border-t border-dashed border-black'} />
  return (
    <div data-no-i18n className={clsx('font-mono leading-snug text-black', narrow ? 'text-[10px]' : 'text-[11.5px]')} style={{ maxWidth: narrow ? '58mm' : '80mm' }}>
      <div className="text-center">
        <p className={clsx('font-bold uppercase tracking-wide', narrow ? 'text-[13px]' : 'text-[15px]')}>{b.name}</p>
        {b.subType && <p>{b.subType}</p>}
        {branch && !branch.isDefault && <p className="font-bold">{branch.name} branch</p>}
        {address && <p>{address}</p>}
        {phone && <p>Ph: {formatPhone(phone)}</p>}
        {b.gstin && <p>GSTIN: {b.gstin}</p>}
      </div>
      <Hr strong />
      <p className="text-center font-bold">{o.tax > 0 ? 'TAX INVOICE' : 'BILL'}</p>
      <Hr />
      <Kv l={<>Bill No: <b>{o.invoiceNumber ?? '—'}</b></>} r={fmtBillDate(o.billedAt ?? o.createdAt)} />
      <Kv l={`Order: ${o.number}`} r={fmtBillTime(o.billedAt ?? o.createdAt)} />
      <p className="font-bold uppercase">{ORDER_TYPE_LABEL[o.type]}{tableLabel ? ` · Table ${tableLabel}` : ''}</p>
      {(cashier || waiter) && <Kv l={cashier ? `Cashier: ${cashier}` : ''} r={waiter ? `${o.type === 'dine_in' ? 'Waiter' : 'Sales'}: ${waiter}` : ''} />}
      {customer && <Kv l={`${b.terminology.customer.singular}: ${customer.name}`} r={formatPhone(customer.phone)} />}
      {!customer && o.guest?.name && <Kv l={`Name: ${o.guest.name}`} r={formatPhone(o.guest.phone)} />}
      {/* B2B tax invoice: the buyer's GSTIN; another state → place of supply (IGST). */}
      {o.customerGstin && <p>Buyer GSTIN: <b>{o.customerGstin}</b></p>}
      {(o.customerGstin || o.igst) && o.placeOfSupply && <p>Place of supply: {stateLabel(o.placeOfSupply)}</p>}
      {o.type === 'delivery' && (o.guest?.address || customer?.address) && <p>Deliver to: {o.guest?.address || customer?.address}</p>}
      <Hr />
      {textile ? (
        <>
          {/* Textile: Item | MRP | Final amount (quantity under the name when more than one). */}
          <div className={clsx('grid gap-x-1 font-bold', tCols)}><span>Item</span><span className="text-right">MRP</span><span className="whitespace-nowrap text-right">{pre ? 'Disc. Price' : 'Final Amt'}</span></div>
          <Hr />
          {o.items.map((i, k) => (
            <div key={i.id} className={clsx('mb-0.5 grid gap-x-1', tCols)}>
              <span className="break-words">{itemLabel(i)}{(i.qty !== 1 || i.hsn) && <span className="block text-[10px]">{[i.qty !== 1 ? `${i.qty} × ${d2(i.mrp ?? i.unitPrice)}` : '', i.hsn ? `HSN ${i.hsn}` : ''].filter(Boolean).join(' · ')}</span>}</span>
              <span className="text-right">{d2(lineMrp(i))}</span>
              <span className="text-right font-bold">{d2(pre ? pre.lines[k] : lineTotal(i))}</span>
            </div>
          ))}
        </>
      ) : <>
      <div className={clsx('grid gap-x-1 font-bold', cols)}>
        <span>Item</span><span className="text-right">Qty</span>{!narrow && <span className="text-right">Rate</span>}<span className="text-right">Amt</span>
      </div>
      <Hr />
      {o.items.map((i) => (
        <div key={i.id} className="mb-0.5">
          <div className={clsx('grid gap-x-1', cols)}>
            <span className="break-words">{itemLabel(i)}</span>
            <span className="text-right">{i.qty}</span>
            {!narrow && <span className="text-right">{d2(i.unitPrice)}</span>}
            <span className="text-right">{d2(lineTotal(i))}</span>
          </div>
          {(i.addOns.length > 0 || narrow || !!i.mrp || !!i.hsn || i.listPrice !== undefined) && (
            <p className="pl-2 text-[10px]">{[narrow ? `@ ${d2(i.unitPrice)}` : '', i.listPrice !== undefined && !i.mrp ? `was ${d2(i.listPrice)}` : '', i.mrp ? `MRP ${d2(i.mrp)}` : '', i.hsn ? `HSN ${i.hsn}` : '', i.addOns.length ? `+ ${i.addOns.map((a) => a.name).join(', ')}` : ''].filter(Boolean).join(' · ')}</p>
          )}
        </div>
      ))}
      </>}
      <Hr />
      <p>Items: {o.items.length} · Qty: {qty}</p>
      {/* Prices include GST: Taxable value + CGST + SGST (+ round off) = TOTAL, so the lines add up. */}
      {pre ? <>
        {/* Textile: lines are before GST, so  lines − discount + CGST + SGST = TOTAL. */}
        {(o.items.length > 1 || pre.discount > 0) && <Kv l="Total before GST" r={d2(pre.lines.reduce((a, x) => a + x, 0))} />}
        {preParts!.manual > 0 && <Kv l="Bill discount" r={`-${d2(preParts!.manual)}`} />}
        {preParts!.points > 0 && <Kv l={`Points used (${o.pointsRedeemed})`} r={`-${d2(preParts!.points)}`} />}
      </> : <>
        {(!incl || o.discount > 0) && <Kv l={incl ? 'Items total' : 'Subtotal'} r={d2(o.subtotal)} />}
        {parts.manual > 0 && <Kv l="Discount" r={`-${d2(parts.manual)}`} />}
        {parts.points > 0 && <Kv l={`Points used (${o.pointsRedeemed})`} r={`-${d2(parts.points)}`} />}
        {incl && <Kv l="Taxable value" r={d2(taxableValue(o))} />}
      </>}
      {taxes.map((t) => o.igst ? <Kv key={t.rate} l={`IGST @ ${t.rate}%`} r={d2(t.tax)} /> : gst ? (
        <div key={t.rate}>
          <Kv l={`CGST @ ${t.rate / 2}%`} r={d2(r2(t.tax / 2))} />
          <Kv l={`SGST @ ${t.rate / 2}%`} r={d2(r2(t.tax - r2(t.tax / 2)))} />
        </div>
      ) : <Kv key={t.rate} l={`Tax @ ${t.rate}%`} r={d2(t.tax)} />)}
      {b.billing.roundOff && <Kv l="Round off" r={d2(o.roundOff)} />}
      <Hr strong />
      <div className={clsx('flex justify-between font-bold', narrow ? 'text-[13px]' : 'text-[15px]')}><span>TOTAL</span><span>{b.currencySymbol}{d2(o.total)}</span></div>
      <p className="text-center text-[10px]">{amountInWords(o.total)}</p>
      {incl && !pre && <p className="text-center text-[10px]">(Prices include GST)</p>}
      {saved > 0 && <p className="mt-1 border border-dashed border-black py-0.5 text-center font-bold">You saved {b.currencySymbol}{d2(saved)} on MRP</p>}
      {(!!o.pointsEarned || !!o.pointsRedeemed || o.pointsBalance != null) && o.customerId && (
        <p className="mt-1 text-center">{[o.pointsRedeemed ? `Points used ${o.pointsRedeemed}` : '', o.pointsEarned ? `Earned ${o.pointsEarned}` : '', o.pointsBalance != null ? `Points balance: ${o.pointsBalance}` : ''].filter(Boolean).join(' · ')}</p>
      )}
      {o.balance > 0 && (
        <>
          <Hr />
          <Kv l="Paid" r={d2(o.paid)} />
          <div className="flex justify-between font-bold"><span>Balance due</span><span>{b.currencySymbol}{d2(o.balance)}</span></div>
        </>
      )}
      {b.billing.receiptFooter.trim() && (<><Hr /><p className="text-center">{b.billing.receiptFooter}</p></>)}
    </div>
  )
}
const Kv = ({ l, r }: { l: ReactNode; r: ReactNode }) => <div className="flex justify-between gap-2"><span>{l}</span><span className="text-right">{r}</span></div>

/** Renders children into the hidden #print-area and opens the browser print dialog. */
export function usePrint() {
  const [node, setNode] = useState<ReactNode>(null)
  useEffect(() => {
    if (!node) return
    const id = setTimeout(() => {
      document.body.classList.add('print-receipt')
      window.print()
      document.body.classList.remove('print-receipt')
      setNode(null)
    }, 50)
    return () => clearTimeout(id)
  }, [node])
  const portal = node ? createPortal(<div id="print-area">{node}</div>, document.body) : null
  return { print: setNode, portal }
}

/**
 * Prints a bill on the counter's printer: straight to the thermal printer when one is connected
 * (Settings → Printer), otherwise through the browser print dialog. Falls back to the dialog on errors.
 */
export function useReceiptPrinter() {
  const toast = useToast()
  const { print: browserPrint, portal } = usePrint()
  const { me } = useApp()
  const s = usePrinterSettings()
  const printReceipt = async (props: ReceiptProps, payments: Payment[] = []) => {
    const node = <Receipt {...props} />
    // The bill's own branch decides the printer (matters in the All branches view).
    const branchId = props.order.branchId
    const s = printerFor(me?.branches.find((b) => b.id === branchId))
    if (s.transport === 'browser') { browserPrint(node); return }
    const paper = s.paper ?? props.business.billing.paperWidth ?? '80mm'
    const doc = receiptDoc(props, paper)
    const image = s.mode === 'image' || (s.mode === 'auto' && needsImage(doc))
    const cash = payments.some((p) => p.method === 'cash' && !p.voided && p.amount > 0)
    try {
      for (let i = 0; i < Math.max(1, s.copies); i++) {
        const job = { cut: s.cut, drawer: s.drawer && cash && i === 0 }
        await sendToPrinter(branchId, s, image ? encodeImage(doc, paper, job) : encodeText(doc, paper, job))
      }
    } catch (e) {
      toast(`${e instanceof Error ? e.message : 'Printer error'} Opening the print dialog instead.`, 'error')
      browserPrint(node)
    }
  }
  return { printReceipt, portal, direct: s.transport !== 'browser', autoPrint: s.autoPrint }
}

export function BillSuccessModal({ orderId, onClose, onNew }: { orderId: string | null; onClose: () => void; onNew: () => void }) {
  const { me, mod } = useApp()
  const toast = useToast()
  const { data } = useData(() => (orderId ? api.orders.get(orderId) : Promise.resolve(null)), [orderId])
  const { data: customers } = useData(() => api.customers.list())
  const { data: users = [] } = useData(() => api.users.list())
  const { data: tables = [] } = useData(() => (mod('tables') ? api.tables.list() : Promise.resolve([])), [mod('tables')])
  const { print, portal } = usePrint()
  const rp = useReceiptPrinter()
  const autoDone = useRef<string | null>(null)
  const wa = useWhatsApp()
  const run = useAction()
  const [waSent, setWaSent] = useState<string | null>(null)
  const waDone = useRef<string | null>(null)
  const ready = !!(orderId && data && me && customers && data.order.id === orderId)
  const props: ReceiptProps | null = ready ? {
    order: data!.order, business: me!.business, branch: me!.branches.find((x) => x.id === data!.order.branchId),
    customer: customers!.find((c) => c.id === data!.order.customerId) ?? null, users, tableLabel: tables.find((x) => x.id === data!.order.tableId)?.label,
  } : null
  // Auto-print once per bill when the counter has it switched on.
  useEffect(() => {
    if (!props || !rp.autoPrint || autoDone.current === orderId) return
    autoDone.current = orderId
    void rp.printReceipt(props, data!.payments)
  }, [ready, orderId]) // eslint-disable-line react-hooks/exhaustive-deps
  const waPhone = props ? (props.customer?.phone || data!.order.guest?.phone || '') : ''
  const canWa = !!wa?.ready.bill && !!waPhone
  const sendWa = () => run(async () => { await api.whatsapp.sendBill(orderId!); setWaSent(orderId) }, 'Bill sent on WhatsApp')
  // Auto-send once per bill when the owner switched it on (Settings → Integrations).
  useEffect(() => {
    if (!props || !canWa || !wa?.config?.autoSendBill || waDone.current === orderId) return
    waDone.current = orderId
    void sendWa()
  }, [ready, orderId, canWa]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!orderId || !data || !me || !props) return null
  const { order } = data
  const customer = props.customer ?? null
  const b = me.business
  const text = receiptText(order, b, customer)
  const receipt = <Receipt {...props} />

  return (
    <Modal open onClose={onClose} size="sm" title="">
      {portal}{rp.portal}
      <div className="-mt-4 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"><CheckCircle2 className="h-8 w-8" /></div>
        <h3 className="mt-3 text-lg font-semibold">{order.balance > 0 ? 'Saved with credit' : 'Payment Successful'}</h3>
        <p className="text-sm text-slate-500">{b.terminology.invoice.singular} {order.invoiceNumber} · {money(order.total)}</p>
        {order.balance > 0 && <p className="mt-1 text-sm font-medium text-amber-700">{money(order.balance)} added to {customer?.name}’s outstanding</p>}
      </div>
      <div className="mt-4 max-h-56 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3">{receipt}</div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        <Button variant="secondary" icon={Printer} onClick={() => rp.printReceipt(props, data.payments)}>Print</Button>
        <Button variant="secondary" icon={Download} onClick={() => { toast('Choose “Save as PDF” in the print dialog', 'info'); print(receipt) }}>PDF</Button>
        <Button variant="secondary" icon={Share2} onClick={async () => {
          if (navigator.share) { try { await navigator.share({ title: `${b.name} ${order.invoiceNumber}`, text }) } catch { /* cancelled */ } }
          else { await navigator.clipboard.writeText(text); toast('Bill copied to clipboard') }
        }}>Share</Button>
      </div>
      {/* Only after WhatsApp is set up and the bill template is approved (Settings → Integrations). */}
      {canWa && (waSent === orderId
        ? <p className="mt-2 flex items-center justify-center gap-1.5 rounded-lg bg-emerald-50 py-2 text-sm font-medium text-emerald-700"><Check className="h-4 w-4" />Sent on WhatsApp to {formatPhone(waPhone)}</p>
        : <Button variant="secondary" block icon={MessageCircle} className="mt-2 !text-emerald-700" onClick={sendWa}>Send on WhatsApp</Button>)}
      <Button size="lg" block className="mt-3" onClick={onNew}>New {b.terminology.invoice.singular} <kbd className="ml-1 rounded bg-white/20 px-1.5 text-[10px]">Enter</kbd></Button>
      <EnterKey onEnter={onNew} />
    </Modal>
  )
}

function EnterKey({ onEnter }: { onEnter: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); onEnter() } }
    const id = setTimeout(() => window.addEventListener('keydown', h), 300)
    return () => { clearTimeout(id); window.removeEventListener('keydown', h) }
  }, [onEnter])
  return null
}
