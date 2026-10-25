import { Printer, ReceiptText, RotateCcw, ShoppingBag, XCircle, MessageCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSaveOnce } from '@/features/billKey'
import { useApp, useData } from '@/app/AppContext'
import { Badge, Button, Card, Drawer, EmptyState, PageHeader, SearchInput, Segmented, Select, Table, Td, Th, useAction, type Tone } from '@/components/ui'
import { ORDER_TYPE_LABEL, PAYMENT_LABEL } from '@/core/config'
import { itemLabel } from '@/core/orderItem'
import { lineTotal, taxableValue, taxIncluded } from '@/core/pricing'
import type { Order, OrderType } from '@/core/types'
import { api } from '@/data'
import { fmtDateTime, fmtTime, money, rangeFor, type RangeKey } from '@/lib/format'
import { PaymentModal, useReceiptPrinter } from '@/features/Payment'
import { useWhatsApp } from '@/features/whatsapp/useWhatsApp'
import { CancelOrderModal } from './Tables'
import { BillReturns, ReturnModal } from '@/features/Returns'
import { formatPhone } from '@/core/phone'

export const statusBadge = (o: Order): { tone: Tone; label: string } =>
  o.status === 'cancelled' ? { tone: 'red', label: 'Cancelled' }
    : o.qrStatus === 'pending' ? { tone: 'violet', label: 'QR · waiting' }
    : o.status === 'open' ? { tone: 'orange', label: 'Running' }
      : o.paymentStatus === 'paid' ? { tone: 'green', label: 'Paid' }
        : o.paymentStatus === 'partial' ? { tone: 'amber', label: 'Partly paid' } : { tone: 'amber', label: 'Credit' }

export default function Orders() {
  return <OrdersList />
}

function OrdersList({ toggle }: { toggle?: React.ReactNode }) {
  const { t, me } = useApp()
  const showBranch = !!me?.isAll
  const branchName = (id: string) => me?.branches.find((b) => b.id === id)?.name ?? '—'
  const [range, setRange] = useState<RangeKey>('today')
  const [status, setStatus] = useState<'all' | Order['status']>('all')
  const [type, setType] = useState<'all' | OrderType>('all')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const r = rangeFor(range)
  const { data: orders } = useData(() => api.orders.list({ from: r.from, to: r.to, status }), [range, status])
  const { data: customers = [] } = useData(() => api.customers.list())
  const { data: tables = [] } = useData(() => api.tables.list())
  const cname = (id: string | null) => customers.find((c) => c.id === id)?.name
  const list = useMemo(() => (orders ?? []).filter((o) => {
    if (type !== 'all' && o.type !== type) return false
    const s = q.trim().toLowerCase()
    return !s || o.number.toLowerCase().includes(s) || (o.invoiceNumber ?? '').toLowerCase().includes(s) || (cname(o.customerId) ?? '').toLowerCase().includes(s)
  }), [orders, type, q, customers]) // eslint-disable-line react-hooks/exhaustive-deps
  const total = list.filter((o) => o.status === 'completed').reduce((a, o) => a + o.total, 0)

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title={t('order', true)} subtitle={`${list.length} ${t('order', true).toLowerCase()} · ${money(total)} billed`}
        actions={<>{toggle}<Segmented value={range} onChange={setRange} options={[{ value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: 'week', label: 'This Week' }, { value: 'month', label: 'This Month' }]} /></>} />
      <Card>
        <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row">
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${t('order').toLowerCase()} #, ${t('invoice').toLowerCase()} # or ${t('customer').toLowerCase()}`} className="flex-1" />
          <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="sm:w-40">
            <option value="all">All status</option><option value="open">Running</option><option value="completed">Billed</option><option value="cancelled">Cancelled</option>
          </Select>
          <Select value={type} onChange={(e) => setType(e.target.value as typeof type)} className="sm:w-40">
            <option value="all">All types</option>{(Object.keys(ORDER_TYPE_LABEL) as OrderType[]).map((k) => <option key={k} value={k}>{ORDER_TYPE_LABEL[k]}</option>)}
          </Select>
        </div>
        {!list.length && orders ? <EmptyState icon={ShoppingBag} title={`No ${t('order', true).toLowerCase()} found`} description="Try another date range or filter." /> : (
          <Table>
            <thead><tr><Th>{t('order')}</Th>{showBranch && <Th>Branch</Th>}<Th>{t('invoice')}</Th><Th>Time</Th><Th>Type</Th><Th className="hidden md:table-cell">{t('customer')}</Th><Th className="hidden lg:table-cell">Items</Th><Th className="text-right">Total</Th><Th>Status</Th></tr></thead>
            <tbody>
              {list.slice(0, 300).map((o) => {
                const b = statusBadge(o)
                return (
                  <tr key={o.id} onClick={() => setOpen(o.id)} className="cursor-pointer hover:bg-slate-50">
                    <Td className="font-semibold text-slate-900">{o.number}</Td>
                    {showBranch && <Td><Badge>{branchName(o.branchId)}</Badge></Td>}
                    <Td>{o.invoiceNumber ?? <span className="text-slate-400">—</span>}</Td>
                    <Td className="whitespace-nowrap text-slate-500">{range === 'today' ? fmtTime(o.createdAt) : fmtDateTime(o.createdAt)}</Td>
                    <Td className="whitespace-nowrap">{ORDER_TYPE_LABEL[o.type]}{o.tableId && <span className="text-slate-400"> · {tables.find((x) => x.id === o.tableId)?.label}</span>}</Td>
                    <Td className="hidden md:table-cell">{cname(o.customerId) ?? <span className="text-slate-400">Walk-in</span>}</Td>
                    <Td className="hidden max-w-[240px] truncate text-slate-500 lg:table-cell">{o.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</Td>
                    <Td className="text-right font-semibold tabular">{money(o.total)}</Td>
                    <Td><Badge tone={b.tone}>{b.label}</Badge></Td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </Card>
      {open && <OrderDetail id={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

export function OrderDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { me, t, can } = useApp()
  const run = useAction()
  const { data } = useData(() => api.orders.get(id), [id])
  const { once } = useSaveOnce() // collect once, even after a dropped connection
  // Only this bill's customer (not the whole customer list).
  const billCustomerId = data?.order.customerId ?? null
  const { data: oneCustomer = null } = useData(() => (billCustomerId ? api.customers.one(billCustomerId) : Promise.resolve(null)), [billCustomerId])
  const { data: users = [] } = useData(() => api.users.list().catch(() => []))
  const { data: tables = [] } = useData(() => api.tables.list())
  const [cancel, setCancel] = useState(false)
  const [pay, setPay] = useState(false)
  const [returning, setReturning] = useState(false)
  const [cid, setCid] = useState<string | null | undefined>(undefined)
  const { printReceipt, portal } = useReceiptPrinter()
  const wa = useWhatsApp()
  const runWa = useAction()
  if (!data || !me) return null
  const { order: o, payments, kots } = data
  const incl = taxIncluded(me!.business.billing, o.tax)
  const customer = oneCustomer && oneCustomer.id === o.customerId ? oneCustomer : null
  const customerId = cid === undefined ? o.customerId : cid
  const who = (uid: string) => users.find((u) => u.id === uid)?.name ?? '—'
  const tableLabel = tables.find((x) => x.id === o.tableId)?.label
  const b = statusBadge(o)

  return (
    <Drawer open onClose={onClose} title={<span className="flex items-center gap-2">{o.number}<Badge tone={b.tone}>{b.label}</Badge></span>}
      subtitle={`${ORDER_TYPE_LABEL[o.type]} · ${fmtDateTime(o.createdAt)}${me.branches.length > 1 ? ` · ${me.branches.find((b) => b.id === o.branchId)?.name ?? ''}` : ''}`}
      footer={
        <div className="flex flex-wrap gap-2">
          {o.status === 'completed' && <Button variant="secondary" icon={Printer} onClick={() => printReceipt({ order: o, business: me.business, branch: me.branches.find((b) => b.id === o.branchId), customer, users, tableLabel })}>Print</Button>}
          {o.status === 'completed' && wa?.ready.bill && (customer?.phone || o.guest?.phone) && <Button variant="secondary" icon={MessageCircle} className="!text-emerald-700" onClick={() => runWa(() => api.whatsapp.sendBill(o.id), 'Bill sent on WhatsApp')}>Send on WhatsApp</Button>}
          {o.status === 'open' && can('billing.create') && <Button variant="success" icon={ReceiptText} onClick={() => setPay(true)}>Collect {money(o.balance)}</Button>}
          {o.status === 'completed' && can('orders.cancel') && <Button variant="secondary" icon={RotateCcw} write onClick={() => setReturning(true)}>Return / exchange</Button>}
          <div className="flex-1" />
          {o.status !== 'cancelled' && can('orders.cancel') && <Button variant="ghost" icon={XCircle} className="!text-red-600" onClick={() => setCancel(true)}>{o.status === 'completed' ? 'Void' : 'Cancel'}</Button>}
        </div>
      }>
      {portal}
      <div className="space-y-5 p-5">
        {o.status === 'cancelled' && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">Cancelled {o.cancelledAt && fmtDateTime(o.cancelledAt)} — {o.cancelReason}</div>}
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Info k={t('invoice')} v={o.invoiceNumber ?? '—'} />
          <Info k={t('customer')} v={customer ? `${customer.name} · ${formatPhone(customer.phone)}` : 'Walk-in'} />
          <Info k="Created by" v={o.source === 'qr' ? 'Customer (QR)' : who(o.createdBy)} />
          {o.guest && (o.guest.phone || o.guest.address) && <Info k="Contact" v={[o.guest.name, formatPhone(o.guest.phone), o.guest.address].filter(Boolean).join(' · ')} />}
          <Info k="Billed" v={o.billedAt ? `${fmtTime(o.billedAt)} by ${who(o.updatedBy)}` : '—'} />
        </dl>
        <div className="rounded-xl border border-slate-200">
          {o.items.map((i) => (
            <div key={i.id} className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-2.5 text-sm last:border-0">
              <div><p className="font-medium">{i.qty} × {itemLabel(i)}</p>{i.addOns.length > 0 && <p className="text-xs text-slate-500">+ {i.addOns.map((a) => a.name).join(', ')}</p>}{i.notes && <p className="text-xs italic text-amber-700">{i.notes}</p>}</div>
              <span className="font-medium tabular">{money(lineTotal(i))}</span>
            </div>
          ))}
          <div className="space-y-1 bg-slate-50 px-4 py-3 text-sm">
            {(!incl || o.discount > 0) && <Row k={incl ? 'Items total' : 'Subtotal'} v={money(o.subtotal, { decimals: true })} />}
            {o.discount > 0 && <Row k="Discount" v={`-${money(o.discount, { decimals: true })}`} />}
            {incl && <Row k="Taxable value" v={money(taxableValue(o), { decimals: true })} />}
            {o.tax > 0 && <Row k={incl ? 'GST (included)' : 'Tax'} v={money(o.tax, { decimals: true })} />}
            {o.roundOff !== 0 && <Row k="Round off" v={money(o.roundOff, { decimals: true })} />}
            <div className="flex justify-between pt-1 text-base font-semibold"><span>Total</span><span>{money(o.total, { decimals: true })}</span></div>
            <Row k="Paid" v={money(o.paid, { decimals: true })} />
            {o.balance > 0 && <div className="flex justify-between font-semibold text-amber-700"><span>Balance</span><span>{money(o.balance, { decimals: true })}</span></div>}
          </div>
        </div>
        {payments.length > 0 && (
          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t('payment', true)}</h4>
            <ul className="space-y-1.5">
              {payments.map((p) => (
                <li key={p.id} className="flex items-center gap-2 text-sm">
                  <Badge tone={p.voided ? 'red' : 'slate'}>{PAYMENT_LABEL[p.method]}</Badge>
                  <span className="text-slate-500">{p.kind === 'due_collection' ? 'Due collected' : p.kind === 'refund' ? 'Refund' : p.method === 'credit_note' ? `Credit note ${p.reference}` : 'At billing'} · {fmtDateTime(p.createdAt)}</span>
                  <span className={`ml-auto font-medium ${p.voided ? 'text-slate-400 line-through' : p.kind === 'refund' ? 'text-red-600' : ''}`}>{p.kind === 'refund' ? '− ' : ''}{money(p.amount)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {o.status === 'completed' && <BillReturns orderId={o.id} />}
        {kots.length > 0 && (
          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Kitchen tickets</h4>
            <div className="flex flex-wrap gap-2">{kots.map((k) => <Badge key={k.id} tone="blue">{k.number} · {k.status}</Badge>)}</div>
          </section>
        )}
      </div>
      {cancel && <CancelOrderModal orderId={o.id} onClose={() => setCancel(false)} />}
      {returning && <ReturnModal order={o} onClose={() => setReturning(false)} />}
      <PaymentModal open={pay} onClose={() => setPay(false)} total={o.balance} customerId={customerId} onCustomerChange={setCid}
        onConfirm={async (pays) => (await once({ o: o.id, pays, customerId }, () => run(() => api.orders.settle(o.id, pays, { customerId }), `${t('invoice')} generated`))) ?? false} />
    </Drawer>
  )
}

const Info = ({ k, v }: { k: string; v: string }) => <div><dt className="text-xs text-slate-500">{k}</dt><dd className="mt-0.5 font-medium">{v}</dd></div>
const Row = ({ k, v }: { k: string; v: string }) => <div className="flex justify-between text-slate-600"><span>{k}</span><span className="tabular">{v}</span></div>
