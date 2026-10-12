import clsx from 'clsx'
import { CategoryLabel, Thumb } from '@/components/Thumb'
import { Bike, Check, ChefHat, Clock, Flame, Minus, Phone, Plus, ShoppingBag, ShoppingBasket, UtensilsCrossed, XCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useData, useNow } from '@/app/AppContext'
import { Button, Chips, Field, Input, SearchInput, Textarea, VegMark, useAction } from '@/components/ui'
import { ORDER_TYPE_LABEL } from '@/core/config'
import { itemLabel } from '@/core/orderItem'
import { lineTotal } from '@/core/pricing'
import type { OrderType, Product } from '@/core/types'
import { api } from '@/data'
import { money, setCurrencySymbol } from '@/lib/format'
import { useCart } from '@/features/cart'
import { PhoneInput } from '@/components/PhoneInput'
import { normalizePhone } from '@/core/phone'
import { priceLabel, tintFor } from '@/features/Catalog'
import { ItemOptionsModal, needsOptions, optionsJustClosed } from '@/features/ItemOptions'

type Menu = Awaited<ReturnType<typeof api.public.menu>>
const TYPE_ICON: Record<OrderType, typeof ShoppingBag> = { dine_in: UtensilsCrossed, takeaway: ShoppingBag, delivery: Bike, counter: ShoppingBag }

/** Public customer menu opened by scanning a QR code. ?t=<tableId> means dine-in at that table. */
export default function CustomerMenu() {
  const { businessId = '' } = useParams()
  const [params] = useSearchParams()
  const branchParam = params.get('b')
  const tableParam = params.get('t')
  const { data: menu, error } = useData(() => api.public.menu(businessId, branchParam, tableParam), [businessId, branchParam, tableParam])
  useEffect(() => { if (menu) { setCurrencySymbol(menu.business.currencySymbol); document.title = `${menu.business.name} — Order` } }, [menu])

  if (error) return <Message icon={XCircle} title="Menu not available" text="This menu could not be loaded on this device. Please ask the staff for help." />
  if (!menu) return <div className="flex h-[100dvh] items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-[3px] border-brand-200 border-t-brand-600" /></div>
  if (!menu.business.modules.qrOrdering) return <Message icon={XCircle} title="Online ordering is off" text="Please order with our staff at the counter." />
  return <MenuApp menu={menu} tableId={tableParam} />
}

function Message({ icon: Icon, title, text }: { icon: typeof XCircle; title: string; text: string }) {
  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center bg-slate-50 px-8 text-center">
      <Icon className="h-10 w-10 text-slate-400" /><p className="mt-3 text-lg font-semibold">{title}</p><p className="mt-1 text-sm text-slate-500">{text}</p>
    </div>
  )
}

function MenuApp({ menu, tableId }: { menu: Menu; tableId: string | null }) {
  const b = menu.business
  const table = menu.tables.find((t) => t.id === tableId) ?? null
  const types: OrderType[] = table ? (b.qr.orderTypes.includes('dine_in') ? ['dine_in'] : []) : b.qr.orderTypes.filter((t) => t !== 'dine_in')
  const storeKey = `billpoodum.qr.${b.id}.${table?.id ?? 'out'}`
  const [type, setType] = useState<OrderType | null>(types[0] ?? null)
  const [view, setView] = useState<'menu' | 'cart' | 'track'>(() => { try { return localStorage.getItem(storeKey) ? 'track' : 'menu' } catch { return 'menu' } })
  const [orderId, setOrderId] = useState<string | null>(() => { try { return localStorage.getItem(storeKey) } catch { return null } })
  const cart = useCart([], 0, b.billing)
  const [options, setOptions] = useState<Product | null>(null)
  const [cat, setCat] = useState('all')
  const [q, setQ] = useState('')
  const special = useMemo(() => new Map(menu.specialInfo.map((s) => [s.productId, s])), [menu])

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (s) return menu.products.filter((p) => p.name.toLowerCase().includes(s))
    if (cat === 'specials') return menu.specials
    return cat === 'all' ? menu.products : menu.products.filter((p) => p.categoryId === cat)
  }, [menu, cat, q])
  const chips = [
    { value: 'all', label: 'All' },
    ...(menu.specials.length ? [{ value: 'specials', label: '🔥 Specials' }] : []),
    ...menu.categories.filter((c) => menu.products.some((p) => p.categoryId === c.id)).map((c) => ({ value: c.id, label: <CategoryLabel c={c} /> })),
  ]
  const pick = (p: Product) => { if (!optionsJustClosed()) (needsOptions(p) ? setOptions(p) : cart.addProduct(p)) }

  if (!types.length || !type) return <Message icon={XCircle} title="Ordering not available" text={table ? 'Table ordering is switched off. Please call a waiter.' : 'Please scan the QR code on your table, or order at the counter.'} />

  if (view === 'track' && orderId) {
    return <Tracking businessId={b.id} orderId={orderId} onNew={() => { try { localStorage.removeItem(storeKey) } catch { /* ignore */ } setOrderId(null); cart.reset(); setView('menu') }} table={table?.label ?? null} />
  }

  if (view === 'cart') {
    return <Checkout menu={menu} cart={cart} type={type} table={table} onBack={() => setView('menu')}
      onPlaced={(id) => { try { localStorage.setItem(storeKey, id) } catch { /* ignore */ } setOrderId(id); setView('track') }} />
  }

  return (
    <div className="mx-auto min-h-[100dvh] max-w-md bg-white pb-28">
      <header className="bg-gradient-to-br from-navy-800 to-navy-700 px-4 pb-5 pt-5 text-white">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10 text-2xl">{b.logoEmoji}</span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-bold">{b.name}</h1>
            <p className="truncate text-xs text-slate-300">{menu.branchCount > 1 ? `${menu.branch.name} · ` : ''}{menu.branch.address || b.address || b.subType}</p>
          </div>
        </div>
        {table ? (
          <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1.5 text-sm font-semibold"><UtensilsCrossed className="h-4 w-4" />Dine in · Table {table.label}</p>
        ) : types.length > 1 ? (
          <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl bg-white/10 p-1">
            {types.map((x) => {
              const I = TYPE_ICON[x]
              return <button key={x} onClick={() => setType(x)} className={clsx('flex items-center justify-center gap-2 rounded-lg py-2 text-sm font-semibold', type === x ? 'bg-white text-navy-800' : 'text-white')}><I className="h-4 w-4" />{ORDER_TYPE_LABEL[x]}</button>
            })}
          </div>
        ) : <p className="mt-4 text-sm font-semibold">{ORDER_TYPE_LABEL[type]}</p>}
      </header>

      {menu.specials.length > 0 && !q && cat === 'all' && (
        <section className="pt-4">
          <h2 className="flex items-center gap-1.5 px-4 text-base font-bold"><Flame className="h-4 w-4 text-orange-500" />Today’s Specials</h2>
          <div className="mt-2 flex gap-3 overflow-x-auto px-4 pb-1 no-scrollbar">
            {menu.specials.map((p) => {
              const s = special.get(p.id)!
              return (
                <button key={p.id} onClick={() => pick(p)} className="w-36 shrink-0 rounded-2xl border border-orange-200 bg-orange-50 p-2.5 text-left active:scale-[.98]">
                  <Thumb full item={p} className="h-20 w-full rounded-xl bg-white text-4xl" />
                  {s.tag && <span className="mt-2 inline-block rounded bg-orange-500 px-1.5 text-[10px] font-bold text-white">{s.tag}</span>}
                  <p className="mt-1 line-clamp-2 text-sm font-semibold leading-tight">{p.name}</p>
                  <p className="mt-1 text-sm font-bold">{priceLabel(p)} {s.specialPrice != null && !p.variants.length && s.specialPrice < s.originalPrice && <span className="text-xs font-normal text-slate-400 line-through">{money(s.originalPrice)}</span>}</p>
                </button>
              )
            })}
          </div>
        </section>
      )}

      <div className="sticky top-0 z-10 space-y-2.5 border-b border-slate-100 bg-white/95 px-4 py-3 backdrop-blur">
        <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the menu" />
        <Chips value={q ? '' : cat} onChange={(v) => { setQ(''); setCat(v) }} options={chips} />
      </div>

      <ul className="divide-y divide-slate-100">
        {list.map((p) => {
          const qty = cart.qtyOf(p.id)
          const line = !needsOptions(p) ? cart.items.find((i) => i.productId === p.id) : undefined
          const s = special.get(p.id)
          return (
            <li key={p.id} className="flex items-center gap-3 px-4 py-3">
              <Thumb item={p} className={clsx('h-20 w-20 rounded-2xl text-4xl', tintFor(p.id))} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 font-semibold leading-tight"><VegMark veg={p.isVeg} /><span className="truncate">{p.name}</span></p>
                {s && <span className="mt-1 inline-block rounded bg-orange-100 px-1.5 text-[10px] font-bold text-orange-700">🔥 {s.tag || 'Special'}</span>}
                <p className="mt-1 text-sm font-semibold text-slate-700">{priceLabel(p)}</p>
                {needsOptions(p) && <p className="text-[11px] text-slate-400">Customisable</p>}
              </div>
              {line ? (
                <div className="flex items-center rounded-full bg-brand-600 text-white">
                  <button onClick={() => cart.setQty(line.id, line.qty - 1)} className="p-2" aria-label="Less"><Minus className="h-4 w-4" /></button>
                  <span className="w-5 text-center text-sm font-bold">{line.qty}</span>
                  <button onClick={() => cart.setQty(line.id, line.qty + 1)} className="p-2" aria-label="More"><Plus className="h-4 w-4" /></button>
                </div>
              ) : (
                <button onClick={() => pick(p)} className="relative rounded-full border-2 border-brand-600 px-4 py-1.5 text-sm font-bold text-brand-600 active:scale-95" aria-label={`Add ${p.name}`}>
                  ADD{qty > 0 && <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] text-white">{qty}</span>}
                </button>
              )}
            </li>
          )
        })}
      </ul>

      {cart.items.length > 0 && (
        <div className="safe-bottom fixed inset-x-0 bottom-0 z-20 mx-auto max-w-md p-3">
          <button onClick={() => setView('cart')} className="flex w-full items-center justify-between rounded-2xl bg-emerald-600 px-4 py-3.5 text-white shadow-pop">
            <span className="flex items-center gap-2 text-sm font-semibold"><ShoppingBasket className="h-5 w-5" />{cart.count} item{cart.count > 1 ? 's' : ''} · {money(cart.totals.total)}</span>
            <span className="text-sm font-bold">View cart →</span>
          </button>
        </div>
      )}
      <ItemOptionsModal product={options} onClose={() => setOptions(null)} onAdd={cart.add} billing={b.billing} />
    </div>
  )
}

function Checkout({ menu, cart, type, table, onBack, onPlaced }: {
  menu: Menu; cart: ReturnType<typeof useCart>; type: OrderType; table: { id: string; label: string } | null; onBack: () => void; onPlaced: (id: string) => void
}) {
  const run = useAction()
  const [guest, setGuest] = useState(() => {
    try {
      const g = JSON.parse(localStorage.getItem('billpoodum.qr.guest') || '')
      // older saves kept a bare 10-digit number — upgrade it to +country format
      return { ...g, phone: (() => { try { return normalizePhone(g.phone, menu.business.defaultCountry) ?? '' } catch { return '' } })() }
    } catch { return { name: '', phone: '', address: '' } }
  })
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const b = menu.business
  const needContact = type !== 'dine_in'

  const place = async () => {
    setBusy(true)
    let id = ''
    const ok = await run(async () => {
      const r = await api.public.placeOrder(b.id, {
        type, tableId: table?.id ?? null, notes, guest, branchId: menu.branch.id,
        items: cart.items.map((i) => ({ productId: i.productId, variantId: i.variantId, addOnIds: i.addOns.map((a) => a.id), qty: i.qty, notes: i.notes })),
      })
      id = r.orderId
    })
    setBusy(false)
    if (ok) {
      try { localStorage.setItem('billpoodum.qr.guest', JSON.stringify(guest)) } catch { /* ignore */ }
      onPlaced(id)
    }
  }

  return (
    <div className="mx-auto min-h-[100dvh] max-w-md bg-slate-50 pb-32">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <button onClick={onBack} className="text-sm font-semibold text-brand-600">← Menu</button>
        <h1 className="flex-1 text-center font-semibold">Your order</h1><span className="w-12" />
      </header>
      <div className="space-y-3 p-4">
        <div className="rounded-2xl bg-white p-4 shadow-card">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{table ? `Dine in · Table ${table.label}` : ORDER_TYPE_LABEL[type]}</p>
          <ul className="divide-y divide-slate-100">
            {cart.items.map((i) => (
              <li key={i.id} className="flex items-start gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{itemLabel(i)}</p>
                  {i.addOns.length > 0 && <p className="text-xs text-slate-500">+ {i.addOns.map((a) => a.name).join(', ')}</p>}
                  {i.notes && <p className="text-xs italic text-amber-700">“{i.notes}”</p>}
                </div>
                <div className="flex items-center rounded-lg border border-slate-200">
                  <button onClick={() => cart.setQty(i.id, i.qty - 1)} className="p-1.5" aria-label="Less"><Minus className="h-3.5 w-3.5" /></button>
                  <span className="w-6 text-center text-sm font-semibold">{i.qty}</span>
                  <button onClick={() => cart.setQty(i.id, i.qty + 1)} className="p-1.5" aria-label="More"><Plus className="h-3.5 w-3.5" /></button>
                </div>
                <span className="w-16 text-right text-sm font-semibold">{money(lineTotal(i))}</span>
              </li>
            ))}
          </ul>
          {!cart.items.length && <p className="py-4 text-center text-sm text-slate-500">Your cart is empty</p>}
        </div>

        <div className="space-y-3 rounded-2xl bg-white p-4 shadow-card">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{needContact ? 'Your details' : 'Your name (optional)'}</p>
          <Field><Input value={guest.name} onChange={(e) => setGuest({ ...guest, name: e.target.value })} placeholder="Name" autoComplete="name" /></Field>
          {needContact && <PhoneInput value={guest.phone} onChange={(v) => setGuest({ ...guest, phone: v })} defaultCountry={menu.business.defaultCountry} placeholder="Mobile number" required />}
          {type === 'delivery' && <Field><Textarea value={guest.address} onChange={(e) => setGuest({ ...guest, address: e.target.value })} placeholder="Full delivery address with landmark" autoComplete="street-address" /></Field>}
          <Field><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any request? (e.g. less spicy)" /></Field>
        </div>

        <div className="space-y-1.5 rounded-2xl bg-white p-4 text-sm shadow-card">
          <div className="flex justify-between text-slate-600"><span>Item total</span><span>{money(cart.totals.subtotal, { decimals: true })}</span></div>
          {cart.totals.tax > 0 && <div className="flex justify-between text-slate-600"><span>Taxes</span><span>{money(cart.totals.tax, { decimals: true })}</span></div>}
          <div className="flex justify-between border-t border-dashed border-slate-200 pt-2 text-base font-bold"><span>To pay</span><span>{money(cart.totals.total)}</span></div>
          <p className="pt-1 text-xs text-slate-500">{type === 'delivery' ? 'Pay by cash or UPI when your order is delivered.' : type === 'takeaway' ? 'Pay at the counter when you pick up.' : 'Pay at the table or counter after your meal.'}</p>
        </div>
      </div>
      <div className="safe-bottom fixed inset-x-0 bottom-0 mx-auto max-w-md border-t border-slate-200 bg-white p-3">
        <Button size="lg" block variant="success" disabled={busy || !cart.items.length} onClick={place}>{busy ? 'Placing order…' : `Place order · ${money(cart.totals.total)}`}</Button>
      </div>
    </div>
  )
}

function Tracking({ businessId, orderId, table, onNew }: { businessId: string; orderId: string; table: string | null; onNew: () => void }) {
  const tick = useNow(5000) // poll — a real backend would push updates
  const { data: o, error } = useData(() => api.public.order(businessId, orderId), [orderId, tick])
  if (error) return <Message icon={XCircle} title="Order not found" text="Please ask the staff." />
  if (!o) return null
  const rejected = o.qrStatus === 'rejected' || (o.status === 'cancelled' && o.cancelReason)
  const done = o.status === 'completed' || o.kitchen === 'completed'
  const readyText = o.type === 'delivery' ? 'Packed — out for delivery soon' : o.type === 'takeaway' ? 'Ready for pickup' : 'Ready — serving now'
  const steps = [
    { key: 'sent', label: 'Order sent', icon: Check, done: true },
    { key: 'ok', label: 'Confirmed by restaurant', icon: Check, done: o.qrStatus === 'accepted' },
    { key: 'cook', label: 'Being prepared', icon: ChefHat, done: ['preparing', 'ready', 'completed'].includes(o.kitchen ?? '') || done },
    { key: 'ready', label: readyText, icon: Clock, done: ['ready', 'completed'].includes(o.kitchen ?? '') || done },
  ]
  return (
    <div className="mx-auto min-h-[100dvh] max-w-md bg-slate-50 p-4">
      <div className="rounded-2xl bg-white p-5 text-center shadow-card">
        {rejected ? <XCircle className="mx-auto h-12 w-12 text-red-500" /> : <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"><Check className="h-8 w-8" /></div>}
        <h1 className="mt-3 text-xl font-bold">{rejected ? 'Order not accepted' : done ? 'Enjoy your meal!' : o.qrStatus === 'pending' ? 'Order sent!' : 'Order confirmed'}</h1>
        <p className="text-sm text-slate-500">Order {o.number}{table ? ` · Table ${table}` : ` · ${ORDER_TYPE_LABEL[o.type]}`}</p>
        {rejected && <p className="mt-2 text-sm text-red-600">{o.cancelReason}. Please talk to our staff.</p>}
      </div>
      {!rejected && (
        <ol className="mt-4 space-y-0 rounded-2xl bg-white p-5 shadow-card">
          {steps.map((s, i) => (
            <li key={s.key} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span className={clsx('flex h-8 w-8 items-center justify-center rounded-full', s.done ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-400')}><s.icon className="h-4 w-4" /></span>
                {i < steps.length - 1 && <span className={clsx('h-6 w-0.5', steps[i + 1].done ? 'bg-emerald-600' : 'bg-slate-200')} />}
              </div>
              <p className={clsx('pt-1.5 text-sm font-medium', s.done ? 'text-slate-900' : 'text-slate-400')}>{s.label}</p>
            </li>
          ))}
        </ol>
      )}
      <div className="mt-4 rounded-2xl bg-white p-4 shadow-card">
        {o.items.map((i) => <div key={i.id} className="flex justify-between py-1 text-sm"><span>{i.qty} × {itemLabel(i)}</span><span>{money(lineTotal(i))}</span></div>)}
        <div className="mt-2 flex justify-between border-t border-dashed border-slate-200 pt-2 font-bold"><span>Total</span><span>{money(o.total)}</span></div>
        <p className="mt-1 text-xs text-slate-500">{o.paymentStatus === 'paid' ? 'Paid ✓' : 'Pay at the counter / on delivery'}</p>
      </div>
      <div className="mt-4 grid gap-2">
        <Button size="lg" variant="secondary" icon={Plus} onClick={onNew}>{table ? 'Order more' : 'New order'}</Button>
        <p className="flex items-center justify-center gap-1 text-center text-xs text-slate-400"><Phone className="h-3 w-3" />Need help? Ask our staff</p>
      </div>
    </div>
  )
}

