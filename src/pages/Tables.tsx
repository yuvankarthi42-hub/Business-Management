import clsx from 'clsx'
import { ArrowRightLeft, ChefHat, Combine, ReceiptText, Users, UtensilsCrossed, XCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSaveOnce } from '@/features/billKey'
import { useApp, useData, useNow } from '@/app/AppContext'
import { Badge, Button, Chips, Drawer, EmptyState, Input, Modal, PageHeader, SearchInput, Segmented, useAction, useToast } from '@/components/ui'
import type { DiningTable, KitchenTicket, Order, Product } from '@/core/types'
import { api, withRequestId } from '@/data'
import { fmtTime, minutesSince, money } from '@/lib/format'
import { useCart } from '@/features/cart'
import { ProductGrid, useCatalog } from '@/features/Catalog'
import { CartLines, TotalsBlock } from '@/features/CartView'
import { CustomerPicker } from '@/features/CustomerPicker'
import { ItemOptionsModal, needsOptions } from '@/features/ItemOptions'
import { BillSuccessModal, PaymentModal } from '@/features/Payment'

export type TableState = 'available' | 'request' | 'occupied' | 'preparing' | 'ready'

export function tableState(order: Order | undefined, kots: KitchenTicket[]): TableState {
  if (!order) return 'available'
  if (order.qrStatus === 'pending') return 'request'
  const mine = kots.filter((k) => k.orderId === order.id)
  if (mine.some((k) => k.status === 'ready')) return 'ready'
  if (mine.some((k) => k.status === 'new' || k.status === 'preparing')) return 'preparing'
  return 'occupied'
}

const STYLE: Record<TableState, { card: string; icon: string; text: string; label: string }> = {
  available: { card: 'border-emerald-200 bg-white hover:border-emerald-300', icon: 'bg-emerald-50 text-emerald-600', text: 'text-emerald-600', label: 'Available' },
  request: { card: 'border-violet-300 bg-violet-50 hover:border-violet-400 animate-pulse', icon: 'bg-violet-100 text-violet-600', text: 'text-violet-700', label: 'New QR order' },
  occupied: { card: 'border-red-200 bg-red-50/40 hover:border-red-300', icon: 'bg-red-100 text-red-600', text: 'text-red-600', label: 'Occupied' },
  preparing: { card: 'border-orange-200 bg-orange-50/50 hover:border-orange-300', icon: 'bg-orange-100 text-orange-600', text: 'text-orange-600', label: 'Preparing' },
  ready: { card: 'border-brand-200 bg-brand-50/50 hover:border-brand-300', icon: 'bg-brand-100 text-brand-600', text: 'text-brand-600', label: 'Food ready' },
}

export default function Tables() {
  const { t } = useApp()
  const now = useNow(30000)
  const { data: tables = [] } = useData(() => api.tables.list())
  const { data: running = [] } = useData(() => api.orders.running())
  const { data: kots = [] } = useData(() => api.kitchen.list())
  const floors = useMemo(() => [...new Set(tables.map((x) => x.floor))], [tables])
  const [floor, setFloor] = useState('all')
  const [filter, setFilter] = useState<'all' | TableState>('all')
  const [openTable, setOpenTable] = useState<string | null>(null)

  const orderFor = (tb: DiningTable) => running.find((o) => o.tableId === (tb.mergedInto ?? tb.id))
  const rows = tables.map((tb) => ({ tb, order: orderFor(tb), state: tableState(orderFor(tb), kots) }))
  const visible = rows.filter((r) => (floor === 'all' || r.tb.floor === floor) && (filter === 'all' || r.state === filter))
  const count = (s: TableState) => rows.filter((r) => r.state === s).length

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title={`${t('table')} Management`} subtitle={`${count('available')} of ${tables.length} ${t('table', true).toLowerCase()} available`}
        actions={floors.length > 1 && <Segmented value={floor} onChange={setFloor} options={[{ value: 'all', label: 'All floors' }, ...floors.map((f) => ({ value: f, label: f }))]} />} />
      <div className="mb-4">
        <Chips value={filter} onChange={setFilter} options={[
          { value: 'all', label: `All (${tables.length})` },
          ...(['available', 'request', 'occupied', 'preparing', 'ready'] as TableState[]).filter((st) => st !== 'request' || count('request') > 0).map((s) => ({ value: s, label: `${STYLE[s].label} (${count(s)})` })),
        ]} />
      </div>

      {!tables.length ? <EmptyState icon={UtensilsCrossed} title={`No ${t('table', true).toLowerCase()} yet`} description="Add tables from Settings → Tables." /> : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
          {visible.map(({ tb, order, state }) => {
            const st = STYLE[state]
            const primary = tb.mergedInto ? tables.find((x) => x.id === tb.mergedInto) : null
            return (
              <button key={tb.id} onClick={() => setOpenTable(tb.mergedInto ?? tb.id)} className={clsx('flex flex-col rounded-xl border-2 p-3.5 text-left transition active:scale-[.98]', st.card)}>
                <div className="flex items-start justify-between">
                  <span className={clsx('flex h-10 w-10 items-center justify-center rounded-lg', st.icon)}><UtensilsCrossed className="h-5 w-5" /></span>
                  <span className="flex items-center gap-1 text-[11px] text-slate-400"><Users className="h-3 w-3" />{tb.seats}</span>
                </div>
                <p className="mt-3 text-lg font-bold text-slate-900">{tb.label}</p>
                <p className={clsx('text-xs font-semibold', st.text)}>{primary ? `Merged → ${primary.label}` : st.label}</p>
                {order ? (
                  <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                    <span>{fmtTime(order.createdAt)} · {minutesSince(order.createdAt, now)}m</span>
                    {!primary && <span className="font-semibold text-slate-800">{money(order.total)}</span>}
                  </div>
                ) : <p className="mt-2 text-[11px] text-slate-400">Tap to start</p>}
              </button>
            )
          })}
        </div>
      )}
      {openTable && <TableOrderDrawer tableId={openTable} tables={tables} running={running} onClose={() => setOpenTable(null)} />}
    </div>
  )
}

function TableOrderDrawer({ tableId, tables, running, onClose }: { tableId: string; tables: DiningTable[]; running: Order[]; onClose: () => void }) {
  const { t, can } = useApp()
  const run = useAction()
  const toast = useToast()
  const table = tables.find((x) => x.id === tableId)!
  const order = running.find((o) => o.tableId === tableId)
  const cart = useCart(order?.items ?? [], order?.discount ?? 0)
  const cat = useCatalog()
  const [customerId, setCustomerId] = useState<string | null>(order?.customerId ?? null)
  const [options, setOptions] = useState<Product | null>(null)
  const [pay, setPay] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'transfer' | 'merge' | 'cancel' | null>(null)
  const [mobileTab, setMobileTab] = useState<'menu' | 'order'>(order ? 'order' : 'menu')

  // Pick up changes saved elsewhere (e.g. waiter's phone) when nothing is pending locally.
  const dirty = JSON.stringify(cart.items) !== JSON.stringify(order?.items ?? []) || cart.discount !== (order?.discount ?? 0)
  useEffect(() => { if (order && !dirty) cart.reset(order.items, order.discount) }, [order?.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (p: Product) => (needsOptions(p) ? setOptions(p) : cart.addProduct(p))
  const draft = () => ({ id: order?.id, type: 'dine_in' as const, tableId, customerId, items: cart.items, discount: cart.discount, notes: '', source: 'table' as const })
  const save = (kitchen: boolean) => run(async () => {
    const r = await api.orders.save(draft(), { sendToKitchen: kitchen })
    toast(r.kot ? `${r.kot.number} sent to kitchen` : 'Order saved')
  })
  // Saved and paid once, even if Pay is tapped twice or the connection drops after the server saved it.
  const { once } = useSaveOnce()
  const settle = async (pays: Parameters<typeof api.orders.settle>[1]) => {
    const d = draft()
    const r = await once({ d, pays, customerId }, async (key) => {
      let id = ''
      const ok = await run(async () => {
        const saved = await api.orders.save(d)
        id = (await withRequestId(`${key}s`, () => api.orders.settle(saved.order.id, pays, { customerId }))).id
      })
      if (ok) setSuccess(id)
      return ok
    })
    return r ?? false
  }
  const pendingKot = cart.items.some((i) => i.qty > i.kotQty)
  const freeTables = tables.filter((x) => x.id !== tableId && !x.mergedInto && !running.some((o) => o.tableId === x.id))
  const mergeable = tables.filter((x) => x.id !== tableId && !x.mergedInto)

  if (success) return <BillSuccessModal orderId={success} onClose={onClose} onNew={onClose} />

  return (
    <Drawer open onClose={onClose} width="max-w-5xl"
      title={<span className="flex items-center gap-2">{table.label} <Badge tone={order ? 'red' : 'green'}>{order ? order.number : 'Available'}</Badge></span>}
      subtitle={`${table.floor} · ${table.seats} seats${tables.filter((x) => x.mergedInto === tableId).length ? ` · merged with ${tables.filter((x) => x.mergedInto === tableId).map((x) => x.label).join(', ')}` : ''}`}
    >
      <div className="flex h-full flex-col md:flex-row">
        <div className="border-b border-slate-100 p-2 md:hidden">
          <Segmented block value={mobileTab} onChange={setMobileTab} options={[{ value: 'menu', label: 'Menu' }, { value: 'order', label: `Order (${cart.count})` }]} />
        </div>
        {/* Menu */}
        <div className={clsx('min-h-0 flex-1 flex-col border-slate-100 md:flex md:border-r', mobileTab === 'menu' ? 'flex' : 'hidden')}>
          <div className="space-y-2 p-3">
            <SearchInput value={cat.q} onChange={(e) => cat.setQ(e.target.value)} placeholder={`Search ${t('product', true).toLowerCase()}…`} />
            <Chips value={cat.q ? '' : cat.cat} onChange={(v) => { cat.setQ(''); cat.setCat(v) }} options={cat.chips} />
          </div>
          <div className="flex-1 overflow-y-auto px-3 pb-3"><ProductGrid dense products={cat.visible} onPick={pick} qtyOf={cart.qtyOf} specials={cat.specialInfo} /></div>
        </div>
        {/* Order */}
        <div className={clsx('min-h-0 w-full flex-col md:flex md:w-[380px]', mobileTab === 'order' ? 'flex flex-1' : 'hidden')}>
          <div className="space-y-2 border-b border-slate-100 p-3">
            {order?.qrStatus === 'pending' && (
              <div className="rounded-lg border border-violet-200 bg-violet-50 p-3">
                <p className="text-sm font-semibold text-violet-800">QR order from the {t('table').toLowerCase()}</p>
                <p className="text-xs text-violet-700">Check the items, then accept to send them to the kitchen.</p>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="success" onClick={async () => { if (await run(() => api.qr.accept(order.id), 'Accepted · sent to kitchen')) onClose() }}>Accept</Button>
                  <Button size="sm" variant="ghost" className="!text-red-600" onClick={async () => { if (await run(() => api.qr.reject(order.id, 'Rejected by staff'), 'QR order rejected')) onClose() }}>Reject</Button>
                </div>
              </div>
            )}
            <CustomerPicker value={customerId} onChange={setCustomerId} compact />
            {order && (
              <div className="flex gap-1.5">
                <Button size="sm" variant="secondary" icon={ArrowRightLeft} onClick={() => setDialog('transfer')}>Transfer</Button>
                <Button size="sm" variant="secondary" icon={Combine} onClick={() => setDialog('merge')}>Merge</Button>
                {can('orders.cancel') && <Button size="sm" variant="ghost" icon={XCircle} className="!text-red-600" onClick={() => setDialog('cancel')}>Cancel</Button>}
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto"><CartLines cart={cart} showKot /></div>
          <div className="space-y-3 border-t border-slate-100 bg-slate-50/60 p-3">
            <TotalsBlock totals={cart.totals} cart={cart} allowDiscount={can('billing.discount')} />
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" icon={ChefHat} disabled={!pendingKot} onClick={() => save(true)}>{pendingKot ? 'Send to kitchen' : 'All sent'}</Button>
              <Button variant="secondary" disabled={!dirty || !cart.items.length} onClick={() => save(false)}>Save</Button>
            </div>
            {can('billing.create') && (
              <Button variant="success" size="lg" block icon={ReceiptText} disabled={!cart.items.length} onClick={() => setPay(true)}>Generate {t('invoice')} · {money(cart.totals.total)}</Button>
            )}
          </div>
        </div>
      </div>

      <ItemOptionsModal product={options} onClose={() => setOptions(null)} onAdd={cart.add} />
      <PaymentModal open={pay} onClose={() => setPay(false)} total={cart.totals.total - (order?.paid ?? 0)} customerId={customerId} onCustomerChange={setCustomerId} onConfirm={settle} title={`${t('invoice')} for ${table.label}`} />

      <Modal open={dialog === 'transfer'} onClose={() => setDialog(null)} title={`Move ${table.label} to…`} size="sm">
        <TablePickerGrid tables={freeTables} onPick={async (id) => { if (await run(() => api.orders.transferTable(order!.id, id), `Moved to ${tables.find((x) => x.id === id)?.label}`)) onClose() }} empty="No free tables" />
      </Modal>
      <Modal open={dialog === 'merge'} onClose={() => setDialog(null)} title={`Merge into ${table.label}`} subtitle="The other table’s items move to this bill." size="sm">
        <TablePickerGrid tables={mergeable} running={running} onPick={async (id) => { if (await run(() => api.orders.mergeTables(order!.id, id), 'Tables merged')) setDialog(null) }} empty="No tables to merge" />
      </Modal>
      {dialog === 'cancel' && order && <CancelOrderModal orderId={order.id} onClose={() => setDialog(null)} onDone={onClose} />}
    </Drawer>
  )
}

function TablePickerGrid({ tables, running, onPick, empty }: { tables: DiningTable[]; running?: Order[]; onPick: (id: string) => void; empty: string }) {
  if (!tables.length) return <p className="py-6 text-center text-sm text-slate-500">{empty}</p>
  return (
    <div className="grid grid-cols-4 gap-2">
      {tables.map((x) => {
        const busy = running?.some((o) => o.tableId === x.id)
        return (
          <button key={x.id} onClick={() => onPick(x.id)} className={clsx('rounded-lg border-2 py-3 text-center font-semibold transition hover:border-brand-500', busy ? 'border-red-200 bg-red-50' : 'border-slate-200')}>
            {x.label}<span className="block text-[10px] font-normal text-slate-500">{busy ? 'occupied' : 'free'}</span>
          </button>
        )
      })}
    </div>
  )
}

export function CancelOrderModal({ orderId, onClose, onDone }: { orderId: string; onClose: () => void; onDone?: () => void }) {
  const run = useAction()
  const { t } = useApp()
  const [reason, setReason] = useState('')
  const presets = ['Customer left', 'Wrong order', 'Duplicate entry', 'Item not available']
  return (
    <Modal open onClose={onClose} size="sm" title={`Cancel ${t('order').toLowerCase()}?`} subtitle="The record is kept for audit; payments and stock are reversed."
      footer={<><Button variant="ghost" onClick={onClose}>Keep</Button><Button variant="danger" disabled={!reason.trim()} onClick={async () => { if (await run(() => api.orders.cancel(orderId, reason), `${t('order')} cancelled`)) { onClose(); onDone?.() } }}>Cancel {t('order').toLowerCase()}</Button></>}>
      <div className="mb-3 flex flex-wrap gap-2">
        {presets.map((p) => <button key={p} onClick={() => setReason(p)} className={clsx('rounded-full border px-3 py-1 text-xs', reason === p ? 'border-red-500 bg-red-50 text-red-700' : 'border-slate-200')}>{p}</button>)}
      </div>
      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" />
    </Modal>
  )
}

