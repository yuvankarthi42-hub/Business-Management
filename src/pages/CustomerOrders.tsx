import clsx from 'clsx'
import { Bike, Clock, Maximize2, PackageOpen, Pencil, Phone, Plus, ShoppingBag, Undo2, XCircle } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp, useData, useNow } from '@/app/AppContext'
import { Badge, Button, EmptyState, Segmented, useAction } from '@/components/ui'
import { usesRetailPos } from '@/core/config'
import { itemLabel } from '@/core/orderItem'
import type { Order } from '@/core/types'
import { api } from '@/data'
import { formatPhone } from '@/core/phone'
import { fmtTime, minutesSince, money } from '@/lib/format'
import { PaymentModal } from '@/features/Payment'
import { CancelOrderModal } from './Tables'

type Stage = 'new' | 'packing' | 'ready' | 'delivered'
const LABEL: Record<Stage, string> = { new: 'New', packing: 'Packing', ready: 'Ready', delivered: 'Delivered' }
const DOT: Record<Stage, string> = { new: 'bg-brand-500', packing: 'bg-orange-500', ready: 'bg-emerald-500', delivered: 'bg-slate-400' }
const TONE: Record<Stage, 'blue' | 'orange' | 'green' | 'slate'> = { new: 'blue', packing: 'orange', ready: 'green', delivered: 'slate' }
const stageOf = (o: Order): Stage => (o.status === 'completed' ? 'delivered' : o.fulfilment === 'packing' ? 'packing' : o.fulfilment === 'ready' ? 'ready' : 'new')
const fmtQty = (q: number, unit: string) => (['kg', 'g', 'ltr', 'ml'].includes(unit) ? `${q} ${unit}` : `${q}`)

/** Supermarket customer orders (phone / home delivery), shown like the kitchen display: New → Packing → Ready. */
export default function CustomerOrders() {
  const { me } = useApp()
  const nav = useNavigate()
  const now = useNow(15000)
  const { data: orders = [] } = useData(() => api.orders.board())
  const { data: customers = [] } = useData(() => api.customers.list())
  const [tab, setTab] = useState<'board' | Stage>('board')
  const [paying, setPaying] = useState<Order | null>(null)
  const [payCustomer, setPayCustomer] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const run = useAction()
  const count = (s: Stage) => orders.filter((o) => stageOf(o) === s).length

  if (me && !usesRetailPos(me.business)) return <EmptyState icon={PackageOpen} title="Customer orders are for supermarket and hardware shops" description="Food and restaurant orders use the Kitchen (KOT) screen." />

  const ticket = (o: Order) => (
    <OrderTicket key={o.id} o={o} now={now} customer={customers.find((c) => c.id === o.customerId)}
      onStage={(s) => run(() => api.orders.setFulfilment(o.id, s))}
      onCollect={() => { setPaying(o); setPayCustomer(o.customerId) }}
      onEdit={() => nav(`/billing?order=${o.id}`)}
      onCancel={() => setCancelling(o.id)} />
  )

  return (
    <div className="flex h-full flex-col bg-slate-100">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <h1 className="flex items-center gap-2 text-lg font-semibold"><PackageOpen className="h-5 w-5 text-brand-600" />Customer Orders</h1>
        <Segmented size="sm" value={tab} onChange={setTab} options={[
          { value: 'board', label: 'Live board' },
          { value: 'new', label: 'New', count: count('new') },
          { value: 'packing', label: 'Packing', count: count('packing') },
          { value: 'ready', label: 'Ready', count: count('ready') },
          { value: 'delivered', label: 'Delivered today', count: count('delivered') },
        ]} />
        <div className="flex-1" />
        <Button size="sm" variant="secondary" icon={Maximize2} onClick={() => document.documentElement.requestFullscreen?.()} className="hidden md:inline-flex">Full screen</Button>
        <Button size="sm" icon={Plus} onClick={() => nav('/billing?new=delivery')}>New order</Button>
      </div>

      {tab === 'board' ? (
        <div className="grid flex-1 gap-3 overflow-y-auto p-3 md:grid-cols-3 md:overflow-hidden">
          {(['new', 'packing', 'ready'] as Stage[]).map((s) => (
            <section key={s} className="flex min-h-0 flex-col rounded-xl bg-slate-200/50">
              <header className="flex items-center justify-between px-3 py-2.5">
                <span className="flex items-center gap-2 text-sm font-semibold text-slate-700"><span className={clsx('h-2 w-2 rounded-full', DOT[s])} />{s === 'ready' ? 'Ready / Out for delivery' : LABEL[s]}</span>
                <Badge tone={TONE[s]}>{count(s)}</Badge>
              </header>
              <div className="flex-1 space-y-2.5 overflow-y-auto px-2.5 pb-2.5">
                {orders.filter((o) => stageOf(o) === s).map(ticket)}
                {!count(s) && <p className="py-10 text-center text-xs text-slate-400">{s === 'new' ? 'New phone / delivery orders appear here' : 'Nothing here'}</p>}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3">
          {count(tab) ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{orders.filter((o) => stageOf(o) === tab).slice().reverse().map(ticket)}</div>
          ) : (
            <EmptyState icon={ShoppingBag} title={`No ${tab === 'delivered' ? 'deliveries today' : `${LABEL[tab].toLowerCase()} orders`}`}
              description={tab === 'new' ? 'Billing → Home delivery → scan items → Save order.' : undefined}
              action={tab === 'new' ? <Button icon={Plus} onClick={() => nav('/billing?new=delivery')}>New order</Button> : undefined} />
          )}
        </div>
      )}

      <PaymentModal open={!!paying} onClose={() => setPaying(null)} total={paying?.balance ?? 0} customerId={payCustomer} onCustomerChange={setPayCustomer}
        title={paying ? `Collect payment · ${paying.number}` : undefined}
        onConfirm={(pays) => run(() => api.orders.settle(paying!.id, pays, { customerId: payCustomer }), `${paying?.number} delivered`)} />
      {cancelling && <CancelOrderModal orderId={cancelling} onClose={() => setCancelling(null)} />}
    </div>
  )
}

function OrderTicket({ o, now, customer, onStage, onCollect, onEdit, onCancel }: {
  o: Order; now: number; customer?: { name: string; phone: string; address: string }
  onStage: (s: 'new' | 'packing' | 'ready') => void; onCollect: () => void; onEdit: () => void; onCancel: () => void
}) {
  const stage = stageOf(o)
  const mins = minutesSince(o.createdAt, now)
  const late = stage !== 'delivered' && mins >= 60
  const warn = stage !== 'delivered' && mins >= 30
  const name = customer?.name || o.guest?.name || 'Walk-in'
  const phone = customer?.phone || o.guest?.phone
  const address = o.guest?.address || customer?.address
  return (
    <article className={clsx('rounded-xl border bg-white shadow-card', late ? 'border-red-300 ring-2 ring-red-200' : 'border-slate-200')}>
      <header className="flex items-start justify-between gap-2 border-b border-dashed border-slate-200 px-3.5 py-2.5">
        <div className="min-w-0">
          <p className="text-[15px] font-bold">{o.number}</p>
          <p className="truncate text-xs text-slate-600">{name}{phone && <> · <a href={`tel:${phone}`} className="text-brand-600"><Phone className="mb-0.5 inline h-3 w-3" /> {formatPhone(phone)}</a></>}</p>
        </div>
        <div className="text-right">
          <span className={clsx('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-bold text-white', o.type === 'delivery' ? 'bg-violet-600' : 'bg-slate-900')}>
            {o.type === 'delivery' ? <><Bike className="h-3.5 w-3.5" />Delivery</> : 'Pickup'}
          </span>
          <p className={clsx('mt-1 flex items-center justify-end gap-1 text-xs font-semibold', late ? 'text-red-600' : warn ? 'text-amber-600' : 'text-slate-500')}>
            <Clock className="h-3 w-3" />{stage === 'delivered' ? fmtTime(o.billedAt ?? o.updatedAt) : mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`}
          </p>
        </div>
      </header>
      {o.type === 'delivery' && address && <p className="border-b border-slate-100 bg-slate-50 px-3.5 py-1.5 text-xs text-slate-600">📍 {address}</p>}
      <ul className="space-y-1 px-3.5 py-2.5">
        {o.items.map((i) => (
          <li key={i.id} className="flex items-start gap-2 text-sm">
            <span className="min-w-[34px] rounded bg-slate-100 px-1 text-center text-sm font-bold">{fmtQty(i.qty, i.unit)}</span>
            <span className={clsx('flex-1 leading-snug', stage === 'delivered' && 'text-slate-500')}>{itemLabel(i)}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between px-3.5 pb-2 text-sm">
        <span className="font-bold tabular">{money(o.total)}</span>
        {stage === 'delivered'
          ? <span className="text-xs font-medium text-emerald-700">{o.balance > 0 ? `Credit ${money(o.balance)}` : `Paid · ${o.invoiceNumber}`}</span>
          : <span className="text-xs text-amber-700">Pay on {o.type === 'delivery' ? 'delivery' : 'pickup'}</span>}
      </div>
      {stage !== 'delivered' && (
        <footer className="flex gap-1.5 px-3.5 pb-3">
          {stage !== 'new' && <Button size="sm" variant="ghost" icon={Undo2} onClick={() => onStage(stage === 'ready' ? 'packing' : 'new')} aria-label="Move back" title="Move back" />}
          <Button size="sm" variant="ghost" icon={Pencil} onClick={onEdit} aria-label="Edit items" title="Edit items" />
          <Button size="sm" variant="ghost" icon={XCircle} onClick={onCancel} aria-label="Cancel order" title="Cancel order" className="!text-red-500" />
          {stage === 'new' && <Button size="sm" block onClick={() => onStage('packing')}>Start packing</Button>}
          {stage === 'packing' && <Button size="sm" block variant="success" onClick={() => onStage('ready')}>Mark ready</Button>}
          {stage === 'ready' && <Button size="sm" block variant="secondary" onClick={onCollect}>{o.type === 'delivery' ? 'Delivered · collect' : 'Picked up · collect'}</Button>}
        </footer>
      )}
    </article>
  )
}
