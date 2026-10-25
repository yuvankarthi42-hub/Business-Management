import clsx from 'clsx'
import { Banknote, Check, ClipboardList, Truck, CreditCard, MoreHorizontal, Pause, Play, Scale, ScanBarcode, ShoppingBasket, Smartphone, Trash2, UserRound, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useSaveOnce } from '@/features/billKey'
import { useApp, useData } from '@/app/AppContext'
import { Thumb } from '@/components/Thumb'
import { Badge, Button, Drawer, EmptyState, Input, Modal, SearchInput, Segmented, Select, useAction, useToast } from '@/components/ui'
import { isSupermarket, isTextile, WEIGHT_UNITS } from '@/core/config'
import { detailsLine } from '@/core/stickers'
import { itemKey, itemLabel, makeItem, repriceItems, wholesaleLabel, wholesaleOn } from '@/core/orderItem'
import { lineTotal, r2, taxableValue } from '@/core/pricing'
import type { OrderItem, OrderType, PaymentMethod, Product, PriceTier } from '@/core/types'
import { api, type PaymentInput } from '@/data'
import { fmtTime, money } from '@/lib/format'
import { looksLikeBarcode } from '@/lib/barcode'
import { formatPhone } from '@/core/phone'
import { useCart } from '@/features/cart'
import { CustomerPicker } from '@/features/CustomerPicker'
import { ItemOptionsModal } from '@/features/ItemOptions'
import { BillSuccessModal, PaymentModal } from '@/features/Payment'
import { ExchangeNote } from '@/features/Returns'
import { UsePoints } from '@/features/loyalty/Points'
import { PriceEditModal } from '@/features/PriceEdit'
import { QuickAddModal } from './QuickAdd'
import { WeightModal } from './WeightModal'

interface HeldBill { id: string; at: string; items: OrderItem[]; customerId: string | null; type: OrderType; discount: number; salespersonId?: string | null }

const isWeighed = (unit: string) => WEIGHT_UNITS.includes(unit)
const fmtQty = (q: number, unit: string) => (isWeighed(unit) ? `${Number.isInteger(q) ? q : q.toFixed(3).replace(/0+$/, '')} ${unit}` : String(q))

/** Supermarket billing: scan box first, item table with MRP, hold bills, weight popup, quick add for new barcodes. */
export default function SuperBilling() {
  const { me, can, mod } = useApp()
  const run = useAction()
  const toast = useToast()
  const cart = useCart()
  const billing = me!.business.billing
  const { data: products = [] } = useData(() => api.products.list())
  // Quick picks: last 7 finished days' best sellers (cached on the server; not re-worked on every bill).
  const { data: popular = [] } = useData(() => api.reports.topProducts(7, 10).then((t) => t.map((p) => p.productId)))
  const active = useMemo(() => products.filter((p) => p.active), [products])
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])

  const [q, setQ] = useState('')
  const [hl, setHl] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null)
  // The message under the scan box goes away by itself: 3 s for "Added …", 5 s for warnings.
  useEffect(() => {
    if (!flash) return
    const id = setTimeout(() => setFlash(null), flash.tone === 'ok' ? 3000 : 5000)
    return () => clearTimeout(id)
  }, [flash])
  const [weighFor, setWeighFor] = useState<{ product: Product; lineId?: string; qty?: number } | null>(null)
  const [options, setOptions] = useState<Product | null>(null)
  const [priceFor, setPriceFor] = useState<OrderItem | null>(null)
  const [quickAdd, setQuickAdd] = useState<string | null>(null)
  const [loosePicker, setLoosePicker] = useState(false)
  const [customerId, setCustomerId] = useState<string | null>(null)
  // Contractor / wholesale price list: follows the customer, or switched on for a walk-in contractor.
  const [tier, setTier] = useState<PriceTier>('retail')
  const [type, setType] = useState<OrderType>('counter')
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [given, setGiven] = useState('')
  const [payOpen, setPayOpen] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [heldOpen, setHeldOpen] = useState(false)
  const [ordersOpen, setOrdersOpen] = useState(false)
  // A saved (open) order loaded into the bill — paying it bills that same order.
  const [order, setOrder] = useState<{ id: string; number: string } | null>(null)
  const { data: running = [] } = useData(() => api.orders.running().then((r) => r.filter((o) => o.qrStatus !== 'pending')))
  const { data: customers = [] } = useData(() => api.customers.list())
  const [qtyDraft, setQtyDraft] = useState<Record<string, string>>({})
  const [scanFocused, setScanFocused] = useState(true)
  // Textile counters: who showed the customer the sarees (commission goes to them).
  const textile = isTextile(me!.business)
  const [salespersonId, setSalespersonId] = useState<string | null>(null)
  const { data: users = [] } = useData(() => (textile ? api.users.list() : Promise.resolve([])))
  const sellers = users.filter((u) => u.active && (u.id === salespersonId || [u.branchId, ...(u.branchIds ?? [])].includes(me!.branch.id)))
  const scanRef = useRef<HTMLInputElement>(null)
  const customerRef = useRef<HTMLDivElement>(null)
  const types = billing.orderTypes.filter((t) => t === 'counter' || t === 'delivery')
  const wsOn = wholesaleOn(billing)
  useEffect(() => { if (wsOn) setTier(customers.find((c) => c.id === customerId)?.priceTier ?? 'retail') }, [customerId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { cart.setPoints(0) }, [customerId]) // eslint-disable-line react-hooks/exhaustive-deps
  const firstTier = useRef(true)
  useEffect(() => {
    if (firstTier.current) { firstTier.current = false; return }
    cart.setItems((items) => repriceItems(items, products, billing, tier))
    if (cart.items.length) say(tier === 'wholesale' ? `${wholesaleLabel(billing)} applied to the bill` : 'Retail prices applied to the bill')
  }, [tier]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- held bills (kept on this device) ----------
  const heldKey = `billpoodum.held.${me!.branch.id}`
  const readHeld = (): HeldBill[] => { try { return JSON.parse(localStorage.getItem(heldKey) || '[]') } catch { return [] } }
  const [held, setHeld] = useState<HeldBill[]>(readHeld)
  const writeHeld = (list: HeldBill[]) => { setHeld(list); try { localStorage.setItem(heldKey, JSON.stringify(list)) } catch { /* storage unavailable */ } }

  const focusScan = () => setTimeout(() => scanRef.current?.focus(), 30)
  const say = (text: string, tone: 'ok' | 'warn' = 'ok') => setFlash({ text, tone })

  // ---------- adding items ----------
  const addItem = useCallback((raw: OrderItem) => {
    const item = tier === 'wholesale' ? repriceItems([raw], products, billing, 'wholesale')[0] : raw
    const existing = cart.items.find((i) => itemKey(i) === itemKey(item))
    cart.add(item)
    setSelectedId(existing?.id ?? item.id)
    const qty = r2((existing?.qty ?? 0) + item.qty)
    say(`Added: ${itemLabel(item)} — ${money(item.unitPrice)}${item.mrp ? ` (MRP ${money(item.mrp)})` : ''}${item.priceTier ? ` (${wholesaleLabel(billing).toLowerCase()})` : ''}${qty > 1 || isWeighed(item.unit) ? ` (qty ${fmtQty(qty, item.unit)})` : ''}`)
  }, [cart, tier, products, billing])

  const addProduct = useCallback((p: Product, qty?: number) => {
    if (p.variants.length) return setOptions(p)
    if (qty === undefined && isWeighed(p.unit)) return setWeighFor({ product: p })
    if (mod('inventory') && p.trackStock && p.stock <= 0) toast(`${p.name}: stock shows 0 — check shelf count`, 'info')
    else if (p.trackExpiry && p.nextExpiry && p.nextExpiry < new Date().toISOString().slice(0, 10)) toast(`${p.name}: oldest batch expired on ${p.nextExpiry} — check the packet date`, 'error')
    addItem(makeItem(p, billing, { qty: qty ?? 1 }))
  }, [addItem, billing, mod, toast])

  const s = q.trim().toLowerCase()
  const suggestions = useMemo(() => (s.length >= 2 && !looksLikeBarcode(s)
    ? active.filter((p) => p.name.toLowerCase().includes(s) || p.sku.toLowerCase() === s).slice(0, 8) : []), [active, s])
  useEffect(() => setHl(0), [s])

  const submitScan = () => {
    const code = q.trim()
    if (!code) return
    const hit = active.find((p) => p.barcode && p.barcode === code) ?? active.find((p) => p.sku && p.sku.toLowerCase() === code.toLowerCase())
    setQ('')
    if (hit) return addProduct(hit)
    if (suggestions[hl]) return addProduct(suggestions[hl])
    if (looksLikeBarcode(code)) {
      if (can('products.manage')) return setQuickAdd(code)
      return say(`Barcode ${code} not found — ask the manager to add it`, 'warn')
    }
    say(`No product matches “${code}”`, 'warn')
  }

  // ---------- qty edits ----------
  const selected = cart.items.find((i) => i.id === selectedId) ?? cart.items[cart.items.length - 1]
  const step = (i: OrderItem, dir: 1 | -1) => {
    if (isWeighed(i.unit)) { const p = byId.get(i.productId); if (p) setWeighFor({ product: p, lineId: i.id, qty: i.qty }); return }
    cart.setQty(i.id, r2(i.qty + dir))
  }
  const commitQty = (i: OrderItem) => {
    const raw = qtyDraft[i.id]
    if (raw === undefined) return
    const n = Number(raw)
    if (n > 0) cart.setQty(i.id, Math.round(n * 1000) / 1000)
    setQtyDraft(({ [i.id]: _, ...rest }) => rest)
  }

  // ---------- totals ----------
  const t = cart.totals
  const mrpTotal = r2(cart.items.reduce((a, i) => {
    const p = byId.get(i.productId)
    const mrp = p?.mrp && !i.variantId && p.mrp > i.unitPrice ? p.mrp : i.unitPrice
    return a + mrp * i.qty
  }, 0))
  const saved = r2(mrpTotal - t.subtotal + t.discount)
  const qtySum = r2(cart.items.reduce((a, i) => a + (isWeighed(i.unit) ? 1 : i.qty), 0))
  const change = method === 'cash' && Number(given) > t.total ? r2(Number(given) - t.total) : 0

  // ---------- bill actions ----------
  const reset = () => { cart.reset(); setCustomerId(null); setTier('retail'); setType('counter'); setGiven(''); setMethod('cash'); setSelectedId(null); setFlash(null); setQtyDraft({}); setOrder(null); setSalespersonId(null) }
  const draft = () => ({ id: order?.id, type, tableId: null, customerId, items: cart.items, discount: cart.discount, notes: '', source: 'pos' as const, ...(textile ? { salespersonId } : {}), ...(cart.points ? { pointsToRedeem: cart.points } : {}) })

  /** Home delivery: save now, collect payment when delivered (then open it from Orders and pay). */
  const saveOrder = async () => {
    if (!cart.items.length) return say('Scan a product first', 'warn')
    if (!customerId) return say('Select the customer for delivery (F4)', 'warn')
    let num = ''
    const d = { ...draft(), pointsToRedeem: undefined, fulfilment: 'new' as const }
    if (await once({ delivery: d }, () => run(async () => { num = (await api.orders.save(d)).order.number }))) {
      toast(`${num} saved — see it in Customer Orders`); reset(); focusScan()
    }
  }
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    const id = params.get('order')
    if (id && running.some((o) => o.id === id)) { openOrder(id); setParams({}, { replace: true }) }
    if (params.get('new') === 'delivery') { reset(); setType('delivery'); setParams({}, { replace: true }); focusScan() }
  }, [params, running]) // eslint-disable-line react-hooks/exhaustive-deps

  const openOrder = (id: string) => {
    const o = running.find((x) => x.id === id)
    if (!o) return
    if (cart.items.length && !order) writeHeld([...held, { id: `h${Date.now()}`, at: new Date().toISOString(), items: cart.items, customerId, type, discount: cart.discount, salespersonId }])
    cart.reset(o.items, o.discount); setCustomerId(o.customerId); setType(o.type === 'takeaway' ? 'counter' : o.type); setSalespersonId(o.salespersonId ?? null)
    setOrder({ id: o.id, number: o.number }); setOrdersOpen(false); setSelectedId(null); setQtyDraft({})
    say(`${o.number} opened — check items, then Pay`); focusScan()
  }
  // A bill is saved once: taps while saving are ignored, and a retry after a dropped connection reuses its id.
  const { once, saving } = useSaveOnce()
  const checkout = async (pays: PaymentInput[]) => {
    const d = draft()
    const r = await once({ d, pays }, async () => {
      let id = ''
      const ok = await run(async () => { id = (await api.orders.checkout(d, pays)).id })
      if (ok) setSuccess(id)
      return ok
    })
    return r ?? false
  }
  const pay = () => {
    if (!cart.items.length) return say('Scan a product first', 'warn')
    if (params.get('cn')) return setPayOpen(true) // exchange: pay with the credit note in the payment window
    if (method === 'cash' && given && Number(given) < t.total) return say(`Cash given is less than ${money(t.total)}`, 'warn')
    checkout([{ method, amount: t.total }])
  }
  const hold = () => {
    if (order) { // an opened order: keep it as an order instead of parking it on this counter
      run(async () => { await api.orders.save({ ...draft(), pointsToRedeem: undefined }) }, `${order.number} saved`).then((ok) => { if (ok) { reset(); focusScan() } })
      return
    }
    if (!cart.items.length) return setHeldOpen(true)
    writeHeld([...held, { id: `h${Date.now()}`, at: new Date().toISOString(), items: cart.items, customerId, type, discount: cart.discount, salespersonId }])
    reset(); say('Bill on hold — serve the next customer'); focusScan()
  }
  const resume = (h: HeldBill) => {
    const rest = held.filter((x) => x.id !== h.id)
    // Park the current bill first so nothing is lost.
    if (cart.items.length) rest.push({ id: `h${Date.now()}`, at: new Date().toISOString(), items: cart.items, customerId, type, discount: cart.discount, salespersonId })
    writeHeld(rest)
    cart.reset(h.items, h.discount); setCustomerId(h.customerId); setType(h.type); setSalespersonId(h.salespersonId ?? null); setHeldOpen(false); setSelectedId(null); say('Held bill resumed'); focusScan()
  }

  // ---------- keyboard ----------
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (payOpen || success || options || weighFor || quickAdd || loosePicker || heldOpen || ordersOpen || priceFor) return
      if (e.key === 'F2') { e.preventDefault(); scanRef.current?.focus() }
      else if (e.key === 'F4') { e.preventDefault(); customerRef.current?.querySelector('button')?.click() }
      else if (e.key === 'F8') { e.preventDefault(); hold() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })
  const onScanKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); submitScan() }
    else if (e.key === 'ArrowDown' && suggestions.length) { e.preventDefault(); setHl((x) => Math.min(suggestions.length - 1, x + 1)) }
    else if (e.key === 'ArrowUp' && suggestions.length) { e.preventDefault(); setHl((x) => Math.max(0, x - 1)) }
    else if (e.key === 'Escape') setQ('')
    else if (!q && selected && (e.key === '+' || e.key === '=')) { e.preventDefault(); step(selected, 1) }
    else if (!q && selected && e.key === '-') { e.preventDefault(); step(selected, -1) }
    else if (!q && selected && e.key === 'Delete') { e.preventDefault(); cart.remove(selected.id); say(`Removed ${itemLabel(selected)}`, 'warn') }
  }

  const looseItems = active.filter((p) => isWeighed(p.unit))
  const ordersOn = mod('customerOrders')
  const quickPicks = popular.map((id) => byId.get(id)).filter((p): p is Product => !!p && p.active).slice(0, 8)

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* ---------- Left: scan + items ---------- */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="space-y-2 border-b border-slate-200 bg-white px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <div onClick={() => scanRef.current?.focus()}
                className={clsx('flex h-14 cursor-text items-center overflow-hidden rounded-xl border-2 bg-white shadow-sm transition',
                  scanFocused ? 'border-brand-500 ring-4 ring-brand-500/10' : 'border-amber-300')}>
                <span className={clsx('flex h-full shrink-0 items-center gap-2 px-4 text-sm font-semibold text-white transition', scanFocused ? 'bg-brand-600' : 'bg-slate-400')}>
                  <ScanBarcode className="h-6 w-6" />Scan
                </span>
                <input
                  ref={scanRef} autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onScanKey}
                  onFocus={() => setScanFocused(true)} onBlur={() => setScanFocused(false)}
                  placeholder="Scan barcode, or type item name / code"
                  className="h-full min-w-0 flex-1 border-0 bg-transparent px-3 text-base focus:outline-none focus:ring-0"
                />
                <span className={clsx('mr-3 hidden shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold md:inline-flex',
                  scanFocused ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700')}>
                  <span className={clsx('h-2 w-2 rounded-full', scanFocused ? 'animate-pulse bg-emerald-500' : 'bg-amber-500')} />
                  {scanFocused ? 'Ready to scan' : 'Click here to scan · F2'}
                </span>
              </div>
              {suggestions.length > 0 && (
                <ul className="absolute inset-x-0 top-[60px] z-30 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-pop">
                  {suggestions.map((p, i) => (
                    <li key={p.id}>
                      <button onMouseDown={(e) => { e.preventDefault(); setQ(''); addProduct(p) }} onMouseEnter={() => setHl(i)}
                        className={clsx('flex w-full items-center gap-3 px-3 py-2 text-left text-sm', i === hl ? 'bg-brand-50' : 'hover:bg-slate-50')}>
                        <Thumb item={p} className="h-8 w-8 rounded-md bg-slate-100 text-base" />
                        <span className="min-w-0 flex-1"><span className="block truncate font-medium">{p.name}</span><span className="block truncate font-mono text-[11px] text-slate-400">{p.barcode || p.sku}</span></span>
                        <span className="text-right"><span className="block font-semibold">{money(p.price)}{isWeighed(p.unit) && <span className="text-xs font-normal text-slate-500">/{p.unit}</span>}</span>
                          {mod('inventory') && p.trackStock && <span className={clsx('block text-[11px]', p.stock <= p.lowStockAt ? 'text-amber-600' : 'text-slate-400')}>{fmtQty(p.stock, p.unit)} in stock</span>}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {/* Only for shops that sell by weight / volume (kg, g, ltr, ml). */}
            {looseItems.length > 0 && <Button variant="secondary" size="lg" icon={Scale} onClick={() => setLoosePicker(true)} className="hidden h-14 sm:inline-flex">Loose item</Button>}
            {/* Saved delivery / pickup orders: only when Customer Orders is turned on (Settings → Modules). */}
            {ordersOn && (
              <Button variant="secondary" size="lg" icon={ClipboardList} onClick={() => setOrdersOpen(true)} className="relative h-14" title="Saved orders (delivery, pickup)">
                <span className="hidden sm:inline">Orders</span>
                {running.length > 0 && <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-600 px-1 text-[11px] font-bold text-white">{running.length}</span>}
              </Button>
            )}
            <Button variant="secondary" size="lg" icon={Pause} onClick={hold} className="relative h-14" title="Hold bill (F8)">
              <span className="hidden sm:inline">Hold</span>
              {held.length > 0 && <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-orange-500 px-1 text-[11px] font-bold text-white">{held.length}</span>}
            </Button>
          </div>
          {order && (
            <div className="flex items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-sm text-brand-800">
              <ClipboardList className="h-4 w-4" /><span className="flex-1">Billing saved order <b>{order.number}</b> — paying will complete this order</span>
              <button onClick={() => { reset(); focusScan() }} className="text-xs font-medium text-brand-600 hover:underline">Close order</button>
            </div>
          )}
          {flash && (
            <div className={clsx('flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium', flash.tone === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800')}>
              {flash.tone === 'ok' ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}{flash.text}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-white">
          {!cart.items.length ? (
            <div className="p-6">
              <EmptyState icon={ShoppingBasket} title="Scan a product to start" description="Scan with the barcode gun, or type a name and press Enter. Scan the same item again to add one more." />
              {quickPicks.length > 0 && (
                <div className="mx-auto max-w-xl">
                  <p className="mb-2 text-center text-xs font-medium text-slate-500">Quick add — frequently sold</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {quickPicks.map((p) => <button key={p.id} onClick={() => { addProduct(p); focusScan() }} className="rounded-full border border-slate-200 px-3 py-1.5 text-sm hover:border-brand-300 hover:bg-brand-50">{p.name} · {money(p.price)}</button>)}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="w-8 px-3 py-2 text-left font-semibold">#</th>
                  <th className="px-3 py-2 text-left font-semibold">Item</th>
                  <th className="hidden px-3 py-2 text-right font-semibold md:table-cell">MRP</th>
                  <th className="px-3 py-2 text-right font-semibold">Rate</th>
                  <th className="w-36 px-3 py-2 text-center font-semibold">Qty</th>
                  <th className="hidden px-3 py-2 text-right font-semibold sm:table-cell">GST</th>
                  <th className="px-3 py-2 text-right font-semibold">Amount</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {cart.items.map((i, idx) => {
                  const p = byId.get(i.productId)
                  const mrp = p?.mrp && !i.variantId ? p.mrp : null
                  const isSel = selected?.id === i.id
                  return (
                    <tr key={i.id} onClick={() => setSelectedId(i.id)} className={clsx('cursor-pointer border-b border-slate-100', isSel ? 'bg-brand-50/70' : 'hover:bg-slate-50')}>
                      <td className="px-3 py-2 text-slate-400">{idx + 1}</td>
                      <td className="px-3 py-2">
                        <p className="font-medium text-slate-900">{itemLabel(i)}</p>
                        <p className="font-mono text-[11px] text-slate-400">{isWeighed(i.unit) ? 'Weighed · ' : ''}{p?.barcode || p?.sku}{textile && p?.details?.design ? <span className="font-sans"> · {[p.details.design, detailsLine(p.details, ['fabric'])].filter(Boolean).join(' · ')}</span> : null}</p>
                      </td>
                      <td className="hidden px-3 py-2 text-right text-slate-400 tabular md:table-cell">{mrp && mrp > i.unitPrice ? <s>{mrp.toFixed(2)}</s> : mrp ? mrp.toFixed(2) : '—'}</td>
                      <td className="px-3 py-2 text-right tabular" onClick={(e) => e.stopPropagation()}>
                        {can('billing.price') ? (
                          <button type="button" onClick={() => setPriceFor(i)} title="Change price / line discount" className={clsx('rounded px-1.5 py-0.5 hover:bg-brand-50 hover:text-brand-700', i.listPrice !== undefined && 'font-semibold text-emerald-700')}>{i.unitPrice.toFixed(2)}</button>
                        ) : i.unitPrice.toFixed(2)}
                        {i.listPrice !== undefined && <span className="block text-[10px] text-slate-400">was {i.listPrice.toFixed(2)}</span>}
                      </td>
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <div className="mx-auto flex w-fit items-center rounded-lg border border-slate-200 bg-white">
                          <button onClick={() => step(i, -1)} className="px-2 py-1.5 text-slate-500 hover:bg-slate-50" aria-label="Less">−</button>
                          {isWeighed(i.unit) ? (
                            <button onClick={() => p && setWeighFor({ product: p, lineId: i.id, qty: i.qty })} className="min-w-[72px] border-x border-slate-200 px-2 py-1 text-center text-sm font-semibold tabular">{fmtQty(i.qty, i.unit)}</button>
                          ) : (
                            <input value={qtyDraft[i.id] ?? String(i.qty)} inputMode="numeric"
                              onFocus={() => setSelectedId(i.id)}
                              onChange={(e) => setQtyDraft({ ...qtyDraft, [i.id]: e.target.value.replace(/[^\d.]/g, '') })}
                              onBlur={() => commitQty(i)} onKeyDown={(e) => { if (e.key === 'Enter') { commitQty(i); focusScan() } }}
                              className="w-12 border-x border-slate-200 py-1 text-center text-sm font-semibold tabular focus:outline-none" />
                          )}
                          <button onClick={() => step(i, 1)} className="px-2 py-1.5 text-slate-500 hover:bg-slate-50" aria-label="More">+</button>
                        </div>
                      </td>
                      <td className="hidden px-3 py-2 text-right text-xs text-slate-500 sm:table-cell">{i.taxRate}%</td>
                      <td className="px-3 py-2 text-right font-semibold tabular">{lineTotal(i).toFixed(2)}</td>
                      <td className="pr-2"><button onClick={(e) => { e.stopPropagation(); cart.remove(i.id) }} className="p-1 text-slate-300 hover:text-red-600" aria-label="Remove"><Trash2 className="h-4 w-4" /></button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="hidden border-t border-slate-200 bg-slate-50 px-4 py-2 text-[11px] text-slate-500 lg:block">
          <Kbd k="Enter" /> add · <Kbd k="+" /> <Kbd k="−" /> qty of selected · <Kbd k="Del" /> remove selected · <Kbd k="F4" /> customer · <Kbd k="F8" /> hold
        </div>
      </section>

      {/* ---------- Right: customer + totals + payment ---------- */}
      <aside className="flex w-full shrink-0 flex-col gap-3 border-t border-slate-200 bg-white p-4 lg:w-[340px] lg:border-l lg:border-t-0">
        {types.length > 1 && <Segmented size="sm" block value={type} onChange={setType} options={types.map((x) => ({ value: x, label: x === 'counter' ? 'Counter' : isSupermarket(me!.business) ? 'Home delivery' : 'Delivery' }))} />}
        <div ref={customerRef}><CustomerPicker value={customerId} onChange={setCustomerId} /></div>
        <UsePoints customer={customers.find((c) => c.id === customerId)} billTotal={cart.totalBeforePoints} points={cart.points} onChange={cart.setPoints} />
        {textile && sellers.length > 1 && (
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 focus-within:border-brand-500">
            <UserRound className="h-4 w-4 shrink-0 text-slate-400" />
            <span className="shrink-0 text-xs font-medium text-slate-500">Salesperson</span>
            <Select aria-label="Salesperson" value={salespersonId ?? ''} onChange={(e) => setSalespersonId(e.target.value || null)} className="h-8 min-w-0 flex-1 border-0 bg-transparent py-0 text-sm font-medium shadow-none focus:ring-0">
              <option value="">{me!.user.name} (me)</option>
              {sellers.filter((u) => u.id !== me!.user.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </label>
        )}
        {wsOn && (
          <button type="button" onClick={() => setTier(tier === 'wholesale' ? 'retail' : 'wholesale')} aria-pressed={tier === 'wholesale'}
            className={clsx('flex w-full items-center justify-between rounded-lg border px-3 py-2 text-sm font-medium transition', tier === 'wholesale' ? 'border-violet-300 bg-violet-50 text-violet-800' : 'border-slate-200 text-slate-600 hover:border-slate-300')}>
            <span>{wholesaleLabel(billing)}</span>
            <span className={clsx('rounded-full px-2 py-0.5 text-[11px] font-semibold', tier === 'wholesale' ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-500')}>{tier === 'wholesale' ? 'ON' : 'OFF'}</span>
          </button>
        )}
        <div className="space-y-1.5 text-sm">
          <Row l="Items / Qty" r={`${cart.items.length} / ${qtySum}`} />
          {saved > 0 && <Row l="MRP total" r={money(mrpTotal, { decimals: true })} />}
          {saved > 0 && <div className="flex justify-between font-medium text-emerald-700"><span>You save</span><span className="tabular">−{money(saved, { decimals: true })}</span></div>}
          {r2(t.discount - cart.pointsOff) > 0 && <Row l="Discount" r={`−${money(r2(t.discount - cart.pointsOff), { decimals: true })}`} />}
          {cart.pointsOff > 0 && <div className="flex justify-between text-violet-700"><span>Points used ({cart.points})</span><span className="tabular">−{money(cart.pointsOff, { decimals: true })}</span></div>}
          {billing.taxEnabled && billing.taxMode === 'inclusive' && t.tax > 0 && <Row l="Taxable value" r={money(taxableValue(t), { decimals: true })} />}
          {billing.taxEnabled && <Row l={billing.taxMode === 'inclusive' ? 'GST (included)' : 'GST'} r={money(t.tax, { decimals: true })} />}
          {t.roundOff !== 0 && <Row l="Round off" r={money(t.roundOff, { decimals: true })} />}
          <div className="flex items-baseline justify-between border-t border-dashed border-slate-200 pt-2"><span className="text-base font-semibold">Total</span><span className="text-2xl font-bold tabular">{money(t.total, { decimals: true })}</span></div>
        </div>
        <ExchangeNote />
        <div className="grid grid-cols-4 gap-2">
          {([['cash', Banknote, 'Cash'], ['upi', Smartphone, 'UPI'], ['card', CreditCard, 'Card']] as const).filter(([m]) => billing.paymentMethods.includes(m)).map(([m, I, l]) => (
            <button key={m} onClick={() => setMethod(m)} className={clsx('flex h-10 items-center justify-center gap-1 rounded-lg border text-sm font-semibold', method === m ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 hover:border-slate-300')}><I className="h-4 w-4" />{l}</button>
          ))}
          <button onClick={() => cart.items.length && setPayOpen(true)} title="Split, credit" className="flex h-10 items-center justify-center rounded-lg border border-slate-200 text-sm font-semibold hover:border-slate-300"><MoreHorizontal className="h-4 w-4" /></button>
        </div>
        {method === 'cash' && (
          <div className="grid grid-cols-2 items-center gap-2">
            <Input inputMode="decimal" value={given} onChange={(e) => setGiven(e.target.value.replace(/[^\d.]/g, ''))} placeholder="Cash given" />
            <div className={clsx('text-right text-sm font-semibold', change ? 'text-emerald-700' : 'text-slate-400')}>{change ? `Return ${money(change, { decimals: true })}` : 'No change'}</div>
          </div>
        )}
        <Button variant="success" size="lg" block onClick={pay} disabled={!cart.items.length || saving}>{saving ? 'Saving…' : <>Pay {money(t.total)}</>}</Button>
        {ordersOn && type === 'delivery' && !order && cart.items.length > 0 && (
          <Button variant="secondary" block icon={Truck} onClick={saveOrder}>Save order · pay on delivery</Button>
        )}
        {order && <Button variant="secondary" block onClick={hold}>Save changes · pay later</Button>}
        {cart.items.length > 0 && <button onClick={() => { reset(); focusScan() }} className="text-center text-xs text-slate-400 hover:text-red-600">Clear bill</button>}
      </aside>

      {/* ---------- popups ---------- */}
      <WeightModal product={weighFor?.product ?? null} initial={weighFor?.qty} onClose={() => { setWeighFor(null); focusScan() }}
        onAdd={(qty) => {
          if (!weighFor) return
          if (weighFor.lineId) { cart.setQty(weighFor.lineId, qty); say(`${weighFor.product.name} → ${fmtQty(qty, weighFor.product.unit)}`) }
          else addProduct(weighFor.product, qty)
        }} />
      {priceFor && <PriceEditModal item={priceFor} product={byId.get(priceFor.productId)} onClose={() => { setPriceFor(null); focusScan() }}
        onSave={(n) => { cart.setItems((xs) => xs.map((x) => (x.id === n.id ? n : x))); say(n.listPrice !== undefined ? `${itemLabel(n)} — price ${money(n.unitPrice)} (was ${money(n.listPrice)})` : `${itemLabel(n)} — back to ${money(n.unitPrice)}`) }} />}
      <ItemOptionsModal product={options} onClose={() => { setOptions(null); focusScan() }} onAdd={addItem} />
      <QuickAddModal barcode={quickAdd} onClose={() => { setQuickAdd(null); focusScan() }} onSaved={(p) => addProduct(p)} />
      <PaymentModal open={payOpen} onClose={() => setPayOpen(false)} total={t.total} customerId={customerId} onCustomerChange={setCustomerId} onConfirm={checkout} />
      <BillSuccessModal orderId={success} onClose={() => { setSuccess(null); reset(); focusScan() }} onNew={() => { setSuccess(null); reset(); focusScan() }} />

      <Modal open={loosePicker} onClose={() => setLoosePicker(false)} size="sm" title="Loose item" subtitle="Items sold by weight or volume">
        <LoosePicker items={looseItems} onPick={(p) => { setLoosePicker(false); setWeighFor({ product: p }) }} />
      </Modal>

      <Drawer open={ordersOpen} onClose={() => setOrdersOpen(false)} title="Saved orders" subtitle="Home delivery, pickup and Take Order — open one to bill it">
        <ul className="divide-y divide-slate-100">
          {running.map((o) => {
            const c = customers.find((x) => x.id === o.customerId)
            return (
              <li key={o.id}>
                <button onClick={() => openOrder(o.id)} className={clsx('flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-slate-50', order?.id === o.id && 'bg-brand-50')}>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-semibold">{o.number}
                      <Badge tone={o.type === 'delivery' ? 'violet' : 'blue'}>{o.type === 'delivery' ? 'Home delivery' : o.type === 'takeaway' ? 'Pickup' : 'Counter'}</Badge>
                    </p>
                    <p className="truncate text-xs text-slate-600">{c ? `${c.name} · ${formatPhone(c.phone)}` : o.guest?.name || 'Walk-in'}{(o.guest?.address || c?.address) && o.type === 'delivery' ? ` · ${o.guest?.address || c?.address}` : ''}</p>
                    <p className="truncate text-xs text-slate-400">{o.items.length} items · {o.items.map((i) => i.name).join(', ')}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold">{money(o.total)}</p>
                    <p className="text-[11px] text-slate-400">{fmtTime(o.createdAt)}</p>
                  </div>
                </button>
              </li>
            )
          })}
          {!running.length && <li className="px-5 py-10 text-center text-sm text-slate-500">No saved orders. Choose <b>Home delivery</b> and press <b>Save order</b> to create one.</li>}
        </ul>
      </Drawer>

      <Drawer open={heldOpen} onClose={() => setHeldOpen(false)} title="Bills on hold" subtitle="Saved on this counter">
        <ul className="divide-y divide-slate-100">
          {held.map((h) => {
            const total = h.items.reduce((a, i) => a + lineTotal(i), 0)
            return (
              <li key={h.id} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{h.items.length} items · {money(total)}</p>
                  <p className="truncate text-xs text-slate-500">{fmtTime(h.at)} · {h.items.map((i) => i.name).join(', ')}</p>
                </div>
                <Button size="sm" icon={Play} onClick={() => resume(h)}>Resume</Button>
                <button onClick={() => writeHeld(held.filter((x) => x.id !== h.id))} className="p-1 text-slate-400 hover:text-red-600" aria-label="Discard"><Trash2 className="h-4 w-4" /></button>
              </li>
            )
          })}
          {!held.length && <li className="px-5 py-10 text-center text-sm text-slate-500">No bills on hold. Press <Badge>F8</Badge> or Hold to park the current bill.</li>}
        </ul>
      </Drawer>
    </div>
  )
}

function LoosePicker({ items, onPick }: { items: Product[]; onPick: (p: Product) => void }) {
  const [q, setQ] = useState('')
  const list = items.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
  return (
    <div>
      <SearchInput autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rice, sugar, dal…" />
      <ul className="-mx-2 mt-2 max-h-80 overflow-y-auto">
        {list.map((p) => (
          <li key={p.id}>
            <button onClick={() => onPick(p)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-slate-50">
              <Thumb item={p} className="h-8 w-8 rounded-md bg-slate-100 text-base" /><span className="flex-1">{p.name}</span><span className="font-semibold">{money(p.price)}/{p.unit}</span>
            </button>
          </li>
        ))}
        {!list.length && <li className="py-6 text-center text-sm text-slate-500">No loose items. Set “Sold per” to Kg or Litre on a product.</li>}
      </ul>
    </div>
  )
}

const Row = ({ l, r }: { l: string; r: string }) => <div className="flex justify-between text-slate-600"><span>{l}</span><span className="tabular">{r}</span></div>
const Kbd = ({ k }: { k: string }) => <kbd className="rounded border border-slate-300 bg-white px-1">{k}</kbd>
