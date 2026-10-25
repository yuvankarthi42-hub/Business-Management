import clsx from 'clsx'
import { Banknote, ChefHat, ClipboardList, CreditCard, MoreHorizontal, ScanLine, ShoppingBag, Smartphone } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSaveOnce } from '@/features/billKey'
import { useApp, useData } from '@/app/AppContext'
import { Badge, Button, Chips, Drawer, SearchInput, Segmented, Select, useAction, useToast } from '@/components/ui'
import { ORDER_TYPE_LABEL, usesRetailPos } from '@/core/config'
import SuperBilling from '@/features/supermarket/SuperBilling'
import type { OrderType, PaymentMethod, Product } from '@/core/types'
import { api, type OrderDraft, type PaymentInput } from '@/data'
import { money, timeAgo } from '@/lib/format'
import { useCart } from '@/features/cart'
import { ProductGrid, useCatalog } from '@/features/Catalog'
import { CartLines, ClearButton, TotalsBlock } from '@/features/CartView'
import { CustomerPicker } from '@/features/CustomerPicker'
import { UsePoints } from '@/features/loyalty/Points'
import { loyaltyOn } from '@/core/loyalty'
import { ItemOptionsModal, needsOptions } from '@/features/ItemOptions'
import { BillSuccessModal, PaymentModal } from '@/features/Payment'
import { ExchangeNote } from '@/features/Returns'

/** Supermarket and hardware shops get the scan-first screen; everyone else the tile POS below. */
export default function Billing() {
  const { me } = useApp()
  return me && usesRetailPos(me.business) ? <SuperBilling /> : <TileBilling />
}

function TileBilling() {
  const { me, t, mod, can } = useApp()
  const toast = useToast()
  const run = useAction()
  const cat = useCatalog()
  const cart = useCart()
  const billing = me!.business.billing
  const orderTypes = billing.orderTypes.length ? billing.orderTypes : (['counter'] as OrderType[])
  const [type, setType] = useState<OrderType>(orderTypes.includes('takeaway') ? 'takeaway' : orderTypes[0])
  const [tableId, setTableId] = useState<string | null>(null)
  const [customerId, setCustomerId] = useState<string | null>(null)
  const [orderId, setOrderId] = useState<string | null>(null) // when settling a running order
  const [orderNumber, setOrderNumber] = useState<string | null>(null)
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [options, setOptions] = useState<Product | null>(null)
  const [payOpen, setPayOpen] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [runningOpen, setRunningOpen] = useState(false)
  const [mobileCart, setMobileCart] = useState(false)
  const [billKey, setBillKey] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  // QR orders awaiting approval are handled in the QR Orders inbox, not here.
  const { data: running = [] } = useData(() => api.orders.running().then((r) => r.filter((o) => o.qrStatus !== 'pending')))
  const { data: tables = [] } = useData(() => (mod('tables') ? api.tables.list() : Promise.resolve([])))
  const busyTables = new Set(running.filter((o) => o.id !== orderId).map((o) => o.tableId))
  const kitchenOn = mod('kitchen') && type !== 'counter'

  const pick = useCallback((p: Product) => {
    if (needsOptions(p)) setOptions(p)
    else cart.addProduct(p)
  }, [cart])

  const newBill = () => {
    cart.reset(); setCustomerId(null); setOrderId(null); setOrderNumber(null); setTableId(null); setSuccess(null); setMethod('cash')
    setBillKey((k) => k + 1); cat.setQ(''); setMobileCart(false)
    setTimeout(() => searchRef.current?.focus(), 50)
  }

  const draft = (): OrderDraft => ({ id: orderId ?? undefined, type, tableId: type === 'dine_in' ? tableId : null, customerId, items: cart.items, discount: cart.discount, notes: '', source: 'pos', ...(cart.points ? { pointsToRedeem: cart.points } : {}) })
  const { data: customers = [] } = useData(() => (loyaltyOn(me!.business) ? api.customers.list() : Promise.resolve([])))
  useEffect(() => { cart.setPoints(0) }, [customerId]) // eslint-disable-line react-hooks/exhaustive-deps

  // A bill is saved once: taps while saving are ignored, and a retry after a dropped connection reuses its id.
  const { once, saving } = useSaveOnce()
  const checkout = async (pays: PaymentInput[]) => {
    const d = draft()
    const r = await once({ bill: billKey, d, pays }, async () => {
      let id = ''
      const ok = await run(async () => { id = (await api.orders.checkout(d, pays)).id })
      if (ok) { setSuccess(id); setMobileCart(false) }
      return ok
    })
    return r ?? false
  }

  const quickPay = () => {
    if (!cart.items.length) return toast('Add at least one item', 'error')
    if (type === 'dine_in' && !tableId) return toast(`Select a ${t('table').toLowerCase()}`, 'error')
    if (new URLSearchParams(location.search).get('cn')) return setPayOpen(true) // exchange: pay with the credit note
    checkout([{ method, amount: cart.totals.total }])
  }

  const hold = async () => {
    if (!cart.items.length) return
    const d = { ...draft(), pointsToRedeem: undefined }
    const ok = await once({ hold: billKey, d }, () => run(async () => {
      const r = await api.orders.save(d, { sendToKitchen: kitchenOn })
      toast(r.kot ? `${r.kot.number} sent to kitchen · ${r.order.number}` : `${r.order.number} saved as running ${t('order').toLowerCase()}`)
    }))
    if (ok) newBill()
  }

  const loadRunning = (id: string) => {
    const o = running.find((x) => x.id === id)
    if (!o) return
    cart.reset(o.items, o.discount); setType(o.type); setTableId(o.tableId); setCustomerId(o.customerId)
    setOrderId(o.id); setOrderNumber(o.number); setRunningOpen(false); setBillKey((k) => k + 1)
  }

  // Keyboard: F2 or / = search, Ctrl+Enter = collect payment, Esc = clear search
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (payOpen || success || options) return
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT'
      if (e.key === 'F2' || (e.key === '/' && !typing)) { e.preventDefault(); searchRef.current?.focus() }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); quickPay() }
      else if (e.key === 'F8') { e.preventDefault(); if (cart.items.length) setPayOpen(true) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && cat.q.trim()) {
      // Barcode scanners type the code + Enter: exact barcode/SKU match wins, otherwise first result.
      const exact = cat.products.find((p) => p.barcode && p.barcode === cat.q.trim()) ?? cat.products.find((p) => p.sku.toLowerCase() === cat.q.trim().toLowerCase())
      const hit = exact ?? cat.visible[0]
      if (hit) { pick(hit); cat.setQ('') }
    }
    if (e.key === 'Escape') cat.setQ('')
  }

  const payButtons: { m: PaymentMethod; icon: typeof Banknote }[] = ([{ m: 'cash', icon: Banknote }, { m: 'upi', icon: Smartphone }, { m: 'card', icon: CreditCard }] as const)
    .filter((x) => billing.paymentMethods.includes(x.m))
    .map((x) => ({ ...x }))

  const billPanel = (
    <div className="flex h-full flex-col bg-white">
      <div className="space-y-3 border-b border-slate-100 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">{orderNumber ? `Settle ${orderNumber}` : `Current ${t('invoice')}`}</h2>
            <p className="text-xs text-slate-500">{cart.count} item{cart.count === 1 ? '' : 's'}</p>
          </div>
          {cart.items.length > 0 && <ClearButton onClick={newBill} />}
        </div>
        {orderTypes.length > 1 && (
          <Segmented size="sm" block value={type} onChange={setType}
            options={orderTypes.map((o) => ({ value: o, label: ORDER_TYPE_LABEL[o] }))} />
        )}
        {type === 'dine_in' && (
          <Select value={tableId ?? ''} onChange={(e) => setTableId(e.target.value || null)}>
            <option value="">Select {t('table').toLowerCase()}…</option>
            {tables.filter((tb) => !tb.mergedInto).map((tb) => <option key={tb.id} value={tb.id} disabled={busyTables.has(tb.id)}>{tb.label} · {tb.floor}{busyTables.has(tb.id) ? ' (occupied)' : ''}</option>)}
          </Select>
        )}
        <CustomerPicker value={customerId} onChange={setCustomerId} />
        <UsePoints customer={customers.find((c) => c.id === customerId)} billTotal={cart.totalBeforePoints} points={cart.points} onChange={cart.setPoints} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto"><CartLines cart={cart} showKot={!!orderId && kitchenOn} /></div>

      <div className="space-y-3 border-t border-slate-100 bg-slate-50/60 p-4">
        <TotalsBlock key={billKey} totals={cart.totals} cart={cart} allowDiscount={can('billing.discount')} big />
        <ExchangeNote />
        <div className="grid grid-cols-4 gap-2">
          {payButtons.map(({ m, icon: I }) => (
            <button key={m} onClick={() => setMethod(m)} className={clsx('flex h-10 items-center justify-center gap-1.5 rounded-lg border text-sm font-semibold transition',
              method === m ? 'border-brand-600 bg-brand-600 text-white shadow-sm' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300')}>
              <I className="h-4 w-4" />{m === 'upi' ? 'UPI' : m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
          <button onClick={() => cart.items.length && setPayOpen(true)} title="Split, credit, change (F8)" className="flex h-10 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:border-slate-300"><MoreHorizontal className="h-4 w-4" />More</button>
        </div>
        <div className="flex gap-2">
          {kitchenOn && !orderId && (
            <Button variant="secondary" size="lg" icon={ChefHat} onClick={hold} disabled={!cart.items.length || saving} title="Save as running order and send to kitchen">KOT</Button>
          )}
          {orderId && kitchenOn && cart.items.some((i) => i.qty > i.kotQty) && (
            <Button variant="secondary" size="lg" icon={ChefHat} onClick={hold} disabled={saving}>Send new</Button>
          )}
          <Button variant="success" size="lg" className="flex-1" onClick={quickPay} disabled={!cart.items.length || saving}>
            {saving ? 'Saving…' : <>Collect {money(cart.totals.total)}</>}
          </Button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="flex h-full">
      {/* Catalogue */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="space-y-3 border-b border-slate-200 bg-white px-4 py-3">
          <div className="flex items-center gap-2">
            <SearchInput ref={searchRef} autoFocus value={cat.q} onChange={(e) => cat.setQ(e.target.value)} onKeyDown={onSearchKey}
              placeholder={`Search ${t('product', true).toLowerCase()}, SKU or scan barcode…`} kbd="F2" className="flex-1" />
            <Button variant="secondary" icon={ScanLine} onClick={() => { searchRef.current?.focus(); toast('Scanner ready — scan a barcode', 'info') }} className="hidden sm:inline-flex">Scan</Button>
            {mod('orders') && (
              <Button variant="secondary" icon={ClipboardList} onClick={() => setRunningOpen(true)} className="relative">
                <span className="hidden sm:inline">Running</span>
                {running.length > 0 && <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-orange-500 px-1 text-[11px] font-bold text-white">{running.length}</span>}
              </Button>
            )}
          </div>
          <Chips value={cat.q ? '' : cat.cat} onChange={(v) => { cat.setQ(''); cat.setCat(v) }} options={cat.chips} />
        </div>
        <div className="flex-1 overflow-y-auto p-4 pb-28 lg:pb-4">
          <ProductGrid products={cat.visible} onPick={pick} qtyOf={cart.qtyOf} specials={cat.specialInfo} />
          <p className="mt-6 hidden text-center text-xs text-slate-400 lg:block">
            Shortcuts: <kbd className="rounded border px-1">F2</kbd> search · <kbd className="rounded border px-1">Enter</kbd> add first match / barcode · <kbd className="rounded border px-1">Ctrl+Enter</kbd> collect · <kbd className="rounded border px-1">F8</kbd> split/credit
          </p>
        </div>
      </section>

      {/* Bill panel — desktop */}
      <aside className="hidden w-[400px] shrink-0 border-l border-slate-200 lg:block">{billPanel}</aside>

      {/* Mobile: sticky cart bar + sheet */}
      <div className="fixed inset-x-0 bottom-0 z-30 p-3 safe-bottom lg:hidden">
        <button onClick={() => setMobileCart(true)} className="flex w-full items-center justify-between rounded-xl bg-emerald-600 px-4 py-3 text-white shadow-pop">
          <span className="flex items-center gap-2 text-sm font-semibold"><ShoppingBag className="h-5 w-5" />{cart.count} items | {money(cart.totals.total)}</span>
          <span className="rounded-lg bg-white/20 px-3 py-1 text-sm font-semibold">View {t('invoice')}</span>
        </button>
      </div>
      {mobileCart && <Drawer open onClose={() => setMobileCart(false)} title={`Current ${t('invoice')}`} width="max-w-full sm:max-w-md"><div className="h-full">{billPanel}</div></Drawer>}

      <ItemOptionsModal product={options} onClose={() => setOptions(null)} onAdd={cart.add} />
      <PaymentModal open={payOpen} onClose={() => setPayOpen(false)} total={cart.totals.total} customerId={customerId} onCustomerChange={setCustomerId} onConfirm={checkout} />
      <BillSuccessModal orderId={success} onClose={newBill} onNew={newBill} />

      <Drawer open={runningOpen} onClose={() => setRunningOpen(false)} title={`Running ${t('order', true).toLowerCase()}`} subtitle="Pick one to add items or collect payment">
        <ul className="divide-y divide-slate-100">
          {running.map((o) => (
            <li key={o.id}>
              <button onClick={() => loadRunning(o.id)} className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-slate-50">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{o.number} <Badge tone={o.type === 'dine_in' ? 'violet' : 'blue'} className="ml-1">{ORDER_TYPE_LABEL[o.type]}{o.tableId ? ` · ${tables.find((x) => x.id === o.tableId)?.label ?? ''}` : ''}</Badge></p>
                  <p className="mt-0.5 truncate text-xs text-slate-500">{o.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold">{money(o.total)}</p>
                  <p className="text-[11px] text-slate-400">{timeAgo(o.createdAt)}</p>
                </div>
              </button>
            </li>
          ))}
          {!running.length && <li className="px-5 py-10 text-center text-sm text-slate-500">No running {t('order', true).toLowerCase()}.</li>}
        </ul>
      </Drawer>
    </div>
  )
}
