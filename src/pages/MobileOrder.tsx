import clsx from 'clsx'
import { Thumb } from '@/components/Thumb'
import { ArrowLeft, CalendarDays, ChefHat, Minus, Plus, ShoppingBag, ShoppingBasket, UtensilsCrossed, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApp, useData } from '@/app/AppContext'
import { Button, Chips, EmptyState, Input, SearchInput, Segmented, VegMark, useAction, useToast } from '@/components/ui'
import { ORDER_TYPE_LABEL } from '@/core/config'
import { itemLabel } from '@/core/orderItem'
import { lineTotal } from '@/core/pricing'
import type { OrderType, Product } from '@/core/types'
import { api } from '@/data'
import { money } from '@/lib/format'
import { useCart, type Cart } from '@/features/cart'
import { priceLabel, tintFor, useCatalog } from '@/features/Catalog'
import { ItemOptionsModal, needsOptions, optionsJustClosed } from '@/features/ItemOptions'
import { tableState, type TableState } from './Tables'
import { CustomerPicker } from '@/features/CustomerPicker'
import { DesktopSidebar, UserMenu, useQrAlerts } from '@/app/Layout'
import { BranchSwitcher } from '@/features/Branches'
import { SubscriptionBanner } from '@/features/SubscriptionBanner'
import { ShopLogo } from '@/components/ShopLogo'

const TABLE_STYLE: Record<TableState, string> = {
  available: 'border-emerald-200 bg-white',
  request: 'border-violet-300 bg-violet-50',
  occupied: 'border-red-200 bg-red-50',
  preparing: 'border-orange-200 bg-orange-50',
  ready: 'border-brand-300 bg-brand-50',
}
const TABLE_LABEL: Record<TableState, string> = { available: 'Available', request: 'QR order', occupied: 'Occupied', preparing: 'Preparing', ready: 'Food ready' }

/**
 * Order taking for waiters / counter staff.
 * Phone (<768px): list + cart sheet · Tablet portrait & landscape (768–1279px): card grid + cart sheet
 * · Web (≥1280px): app sidebar + card grid + fixed order panel.
 */
export default function MobileOrder() {
  const { me, t, mod } = useApp()
  const run = useAction()
  const toast = useToast()
  const cat = useCatalog()
  const cart = useCart()
  const qrPending = useQrAlerts()
  // Retail (hardware / supermarket): counter or delivery orders for a customer; food: dine-in / takeaway / delivery.
  const retail = me?.business.category === 'retail'
  const types = (me?.business.billing.orderTypes ?? []).filter((x) => retail ? x === 'counter' || x === 'delivery' : x !== 'counter')
  const [customerId, setCustomerId] = useState<string | null>(null)
  const [type, setType] = useState<OrderType>(mod('tables') && types.includes('dine_in') ? 'dine_in' : types[0] ?? 'takeaway')
  const [tableId, setTableId] = useState<string | null>(null)
  const [options, setOptions] = useState<Product | null>(null)
  const [sheet, setSheet] = useState(false)
  const { data: tables = [] } = useData(() => (mod('tables') ? api.tables.list() : Promise.resolve([])))
  const { data: running = [] } = useData(() => api.orders.running())
  const { data: kots = [] } = useData(() => (mod('kitchen') ? api.kitchen.list() : Promise.resolve([])))
  const existing = tableId ? running.find((o) => o.tableId === tableId) : undefined

  // Adding to an occupied table continues its running order.
  useEffect(() => { cart.reset(existing?.items ?? [], existing?.discount ?? 0) }, [tableId, existing?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (p: Product) => { if (!optionsJustClosed()) (needsOptions(p) ? setOptions(p) : cart.addProduct(p)) }
  const newCount = cart.items.reduce((a, i) => a + Math.max(0, i.qty - i.kotQty), 0)
  const choosingTable = type === 'dine_in' && !tableId
  const tableLabel = tables.find((x) => x.id === tableId)?.label
  const orderTitle = tableLabel ? `${t('table')} ${tableLabel}` : ORDER_TYPE_LABEL[type]

  const place = async () => {
    const ok = await run(async () => {
      if (retail && type === 'delivery' && !customerId) throw new Error('Select the customer for delivery')
      const r = await api.orders.save({
        id: existing?.id, type, tableId: type === 'dine_in' ? tableId : null, customerId: retail ? customerId : existing?.customerId ?? null,
        items: cart.items, discount: cart.discount, notes: '', source: 'mobile', ...(retail ? { fulfilment: 'new' as const } : {}),
      }, { sendToKitchen: !retail })
      toast(r.kot ? `${r.kot.number} sent to kitchen` : retail ? `${r.order.number} saved — see it in Customer Orders` : `${r.order.number} saved`)
    })
    if (ok) { setSheet(false); setTableId(null); cart.reset(); setCustomerId(null) }
  }
  const changeType = (v: OrderType) => { setType(v); setTableId(null) }

  const floors = [...new Set(tables.filter((x) => !x.mergedInto).map((x) => x.floor))]

  return (
    <div className="flex h-[100dvh] bg-slate-50">
      {/* Web: same sidebar as the rest of the app (hidden on tablet / phone) */}
      <DesktopSidebar from="xl" badges={{ '/qr-orders': qrPending }} />
      <div className="flex min-w-0 flex-1 flex-col">
        <SubscriptionBanner />
      {/* Phone / tablet: compact dark header */}
      <header className="z-10 flex shrink-0 items-center gap-2 bg-navy-800 px-3 py-3 text-white md:gap-3 md:px-5 xl:hidden">
        {tableId ? (
          <button onClick={() => setTableId(null)} className="rounded-lg p-1.5 hover:bg-white/10" aria-label="Back to tables"><ArrowLeft className="h-5 w-5" /></button>
        ) : (
          <Link to="/" className="rounded-lg p-1.5 hover:bg-white/10" aria-label="Home"><ArrowLeft className="h-5 w-5" /></Link>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold md:text-base">{tableLabel ? `${t('table')} ${tableLabel}` : me?.business.name}</p>
          <p className="truncate text-[11px] text-slate-300 md:text-xs">{existing ? `Adding to ${existing.number}` : `${me?.user.name} · Take order`}</p>
        </div>
        {types.length > 1 && (
          <>
            <select value={type} onChange={(e) => changeType(e.target.value as OrderType)} className="rounded-lg border-0 bg-white/10 py-1.5 pl-2.5 pr-7 text-sm font-medium text-white focus:ring-0 md:hidden">
              {types.map((o) => <option key={o} value={o} className="text-slate-900">{ORDER_TYPE_LABEL[o]}</option>)}
            </select>
            <div className="hidden gap-1 rounded-lg bg-white/10 p-1 md:flex">
              {types.map((o) => (
                <button key={o} onClick={() => changeType(o)} className={clsx('rounded-md px-3.5 py-1.5 text-sm font-medium transition', type === o ? 'bg-white text-navy-800' : 'text-slate-200 hover:text-white')}>{ORDER_TYPE_LABEL[o]}</button>
              ))}
            </div>
          </>
        )}
        <div className="hidden md:block"><BranchSwitcher onDark /></div>
        <UserMenu onDark />
      </header>

      {/* Web: same white header as the other pages */}
      <header className="hidden h-16 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-6 xl:flex">
        <Link to="/settings" className="flex min-w-0 items-center gap-2.5">
          <ShopLogo business={me?.business} />
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold text-slate-900">{me?.business.name}</p>
            <p className="truncate text-[11px] text-slate-500">{me?.business.subType}</p>
          </div>
        </Link>
        {tableId && (
          <button onClick={() => setTableId(null)} className="ml-3 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
            <ArrowLeft className="h-3.5 w-3.5" />{t('table', true)} · <b className="text-slate-900">{tableLabel}</b>{existing && <span className="text-slate-400">· {existing.number}</span>}
          </button>
        )}
        <BranchSwitcher />
        <div className="flex-1" />
        {types.length > 1 && (
          <Segmented value={type} onChange={changeType} options={types.map((o) => ({ value: o, label: ORDER_TYPE_LABEL[o] }))} />
        )}
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600">
          <CalendarDays className="h-4 w-4 text-slate-400" />{new Date().toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}
        </div>
        <UserMenu />
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          {choosingTable ? (
            <div className="flex-1 overflow-y-auto p-4 md:p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-700 md:text-base">Select a {t('table').toLowerCase()}</p>
                <div className="hidden flex-wrap gap-3 text-xs text-slate-500 md:flex">
                  {(['available', 'occupied', 'preparing', 'ready'] as TableState[]).map((s) => (
                    <span key={s} className="flex items-center gap-1.5"><span className={clsx('h-3 w-3 rounded border-2', TABLE_STYLE[s])} />{TABLE_LABEL[s]}</span>
                  ))}
                </div>
              </div>
              {floors.map((f) => (
                <section key={f} className="mb-5">
                  {floors.length > 1 && <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{f}</h3>}
                  <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:grid-cols-5 md:gap-3 lg:grid-cols-6 xl:grid-cols-8">
                    {tables.filter((x) => !x.mergedInto && x.floor === f).map((x) => {
                      const o = running.find((r) => r.tableId === x.id)
                      const st = tableState(o, kots)
                      return (
                        <button key={x.id} onClick={() => setTableId(x.id)} className={clsx('rounded-xl border-2 p-3 text-left transition active:scale-95 md:p-4 md:hover:shadow-card', TABLE_STYLE[st])}>
                          <UtensilsCrossed className={clsx('h-4 w-4 md:h-5 md:w-5', st === 'available' ? 'text-emerald-600' : 'text-slate-500')} />
                          <p className="mt-1.5 text-lg font-bold md:text-xl">{x.label}</p>
                          <p className="text-[11px] text-slate-500 md:text-xs">{TABLE_LABEL[st]}{o ? ` · ${money(o.total)}` : ''}</p>
                          <p className="hidden text-[11px] text-slate-400 md:block">{x.seats} seats</p>
                        </button>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <>
              <div className="shrink-0 space-y-2.5 border-b border-slate-200 bg-white px-3 py-3 md:px-5">
                <SearchInput value={cat.q} onChange={(e) => cat.setQ(e.target.value)} placeholder={`Search ${t('product', true).toLowerCase()}`} className="md:max-w-md" />
                <Chips value={cat.q ? '' : cat.cat} onChange={(v) => { cat.setQ(''); cat.setCat(v) }} options={cat.chips} />
              </div>
              <div className="flex-1 overflow-y-auto pb-24 xl:pb-6">
                {!cat.visible.length && <EmptyState icon={ShoppingBasket} title={`No ${t('product', true).toLowerCase()} found`} />}

                {/* Phone: compact list */}
                <ul className="divide-y divide-slate-100 bg-white md:hidden">
                  {cat.visible.map((p) => (
                    <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
                      <Thumb item={p} className={clsx('h-16 w-16 rounded-xl text-3xl', tintFor(p.id))} />
                      <ItemInfo p={p} veg={!retail} special={cat.specialInfo.get(p.id)?.special.tag} />
                      <AddControl p={p} cart={cart} onPick={pick} />
                    </li>
                  ))}
                </ul>

                {/* Tablet / Web: photo cards */}
                <div className="hidden grid-cols-3 gap-3 p-5 md:grid lg:grid-cols-4 xl:grid-cols-3 min-[1440px]:grid-cols-4">
                  {cat.visible.map((p) => (
                    <div key={p.id} className={clsx('flex flex-col overflow-hidden rounded-2xl border bg-white transition hover:shadow-card', cart.qtyOf(p.id) ? 'border-brand-400 ring-2 ring-brand-500/15' : 'border-slate-200')}>
                      <button onClick={() => pick(p)} className="relative" aria-label={`Add ${p.name}`}>
                        <Thumb full item={p} className={clsx('aspect-[4/3] w-full text-5xl', tintFor(p.id))} />
                        {cat.specialInfo.has(p.id) && <span className="absolute left-2 top-2 rounded-md bg-orange-500 px-1.5 py-0.5 text-[10px] font-bold text-white">🔥 {cat.specialInfo.get(p.id)!.special.tag || 'Special'}</span>}
                      </button>
                      <div className="flex flex-1 flex-col p-3">
                        <p className="flex items-start gap-1.5 text-sm font-semibold leading-tight">{!retail && <span className="mt-0.5"><VegMark veg={p.isVeg} /></span>}<span className="line-clamp-2">{p.name}</span></p>
                        <div className="mt-auto flex items-end justify-between gap-2 pt-2">
                          <div>
                            <p className="text-sm font-bold">{priceLabel(p)}</p>
                            {needsOptions(p) && <p className="text-[11px] text-slate-400">Customisable</p>}
                          </div>
                          <AddControl p={p} cart={cart} onPick={pick} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </main>

        {/* Web: order panel always visible */}
        <aside className="hidden w-[360px] shrink-0 border-l border-slate-200 bg-white xl:flex 2xl:w-[400px]">
          <CartPanel cart={cart} title={choosingTable ? 'New order' : orderTitle} existing={existing?.number} newCount={newCount} onPlace={place}
            customer={retail ? <CustomerPicker value={customerId} onChange={setCustomerId} compact /> : undefined}
            onChangeTable={tableId ? () => setTableId(null) : undefined} emptyHint={choosingTable ? `Pick a ${t('table').toLowerCase()} to start` : 'Tap items to add them'} />
        </aside>
      </div>

      {/* Phone / Tablet: cart bar + sheet */}
      {cart.items.length > 0 && !choosingTable && (
        <div className="safe-bottom fixed inset-x-0 bottom-0 z-20 p-3 xl:hidden">
          <button onClick={() => setSheet(true)} className="mx-auto flex w-full max-w-xl items-center justify-between rounded-xl bg-emerald-600 px-4 py-3.5 text-white shadow-pop active:scale-[.99]">
            <span className="flex items-center gap-2 text-sm font-semibold"><ShoppingBag className="h-5 w-5" />{cart.count} Items | {money(cart.totals.total)}</span>
            <span className="rounded-lg bg-white/20 px-3 py-1 text-sm font-semibold">View Cart</span>
          </button>
        </div>
      )}
      {sheet && (
        <div className="fixed inset-0 z-40 flex items-end justify-center md:items-center md:p-6 xl:hidden">
          <div className="absolute inset-0 bg-slate-900/50 animate-fade" onClick={() => setSheet(false)} />
          <div className="safe-bottom relative flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white animate-pop md:max-w-xl md:rounded-2xl">
            <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-slate-300 md:hidden" />
            <CartPanel cart={cart} title={orderTitle} existing={existing?.number} newCount={newCount} onPlace={place} onClose={() => setSheet(false)} emptyHint="Tap items to add them"
              customer={retail ? <CustomerPicker value={customerId} onChange={setCustomerId} compact /> : undefined} />
          </div>
        </div>
      )}
      <ItemOptionsModal product={options} onClose={() => setOptions(null)} onAdd={cart.add} />
      </div>
    </div>
  )
}

function ItemInfo({ p, special, veg }: { p: Product; special?: string; veg: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="flex items-center gap-1.5 text-[15px] font-medium leading-tight">{veg && <VegMark veg={p.isVeg} />}<span className="truncate">{p.name}</span></p>
      <p className="mt-1 text-sm font-semibold text-slate-700">{priceLabel(p)}</p>
      {needsOptions(p) && <p className="text-[11px] text-slate-400">Customisable</p>}
      {special !== undefined && <span className="mt-0.5 inline-block rounded bg-orange-100 px-1.5 text-[10px] font-bold text-orange-700">🔥 {special || 'Special'}</span>}
    </div>
  )
}

/** "+" button, or a −/+ stepper once a simple item is in the cart. Sent-to-kitchen qty can't be reduced here. */
function AddControl({ p, cart, onPick }: { p: Product; cart: Cart; onPick: (p: Product) => void }) {
  const q = cart.qtyOf(p.id)
  const line = !needsOptions(p) ? cart.items.find((i) => i.productId === p.id) : undefined
  if (line && q > 0) {
    return (
      <div className="flex shrink-0 items-center rounded-full bg-brand-600 text-white">
        <button onClick={() => cart.setQty(line.id, line.qty - 1)} disabled={line.qty <= line.kotQty} className="p-2 disabled:opacity-40" aria-label="Less"><Minus className="h-4 w-4" /></button>
        <span className="w-5 text-center text-sm font-bold">{q}</span>
        <button onClick={() => cart.setQty(line.id, line.qty + 1)} className="p-2" aria-label="More"><Plus className="h-4 w-4" /></button>
      </div>
    )
  }
  return (
    <button onClick={() => onPick(p)} className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-brand-600 text-brand-600 transition hover:bg-brand-50 active:scale-90" aria-label={`Add ${p.name}`}>
      <Plus className="h-5 w-5" />
      {q > 0 && <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-bold text-white">{q}</span>}
    </button>
  )
}

function CartPanel({ cart, title, existing, newCount, onPlace, onClose, onChangeTable, emptyHint, customer }: {
  cart: Cart; title: string; existing?: string; newCount: number; onPlace: () => void; onClose?: () => void; onChangeTable?: () => void; emptyHint: string
  customer?: React.ReactNode
}) {
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate font-semibold">{title}</p>
          <p className="text-xs text-slate-500">{existing ? `Running order ${existing} · ` : ''}{cart.count} item{cart.count === 1 ? '' : 's'}</p>
        </div>
        {onChangeTable && <button onClick={onChangeTable} className="text-xs font-medium text-brand-600 hover:underline">Change</button>}
        {onClose && <button onClick={onClose} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Close"><X className="h-4 w-4" /></button>}
      </div>
      {customer && <div className="border-b border-slate-100 px-4 py-2.5">{customer}</div>}
      {!cart.items.length ? (
        <div className="flex flex-1 items-center justify-center p-6"><EmptyState icon={ShoppingBasket} title="No items yet" description={emptyHint} /></div>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto">
          {cart.items.map((i) => (
            <li key={i.id} className="px-4 py-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{itemLabel(i)}</p>
                  {i.addOns.length > 0 && <p className="text-xs text-slate-500">+ {i.addOns.map((a) => a.name).join(', ')}</p>}
                  {i.kotQty > 0 && <p className="text-[11px] font-medium text-emerald-600">{i.kotQty} already sent</p>}
                </div>
                <div className="flex items-center rounded-lg border border-slate-200">
                  <button onClick={() => cart.setQty(i.id, i.qty - 1)} disabled={i.qty <= i.kotQty} className="p-2 disabled:opacity-30" aria-label="Less"><Minus className="h-3.5 w-3.5" /></button>
                  <span className="w-6 text-center text-sm font-semibold">{i.qty}</span>
                  <button onClick={() => cart.setQty(i.id, i.qty + 1)} className="p-2" aria-label="More"><Plus className="h-3.5 w-3.5" /></button>
                </div>
                <span className="w-16 text-right text-sm font-semibold">{money(lineTotal(i))}</span>
              </div>
              {i.qty > i.kotQty && (
                <Input value={i.notes} onChange={(e) => cart.setItems((x) => x.map((y) => (y.id === i.id ? { ...y, notes: e.target.value } : y)))} placeholder="Note for kitchen" className="mt-2 h-8 text-xs" />
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-3 border-t border-slate-100 bg-slate-50/60 p-4">
        <div className="flex justify-between text-base font-semibold"><span>Total</span><span>{money(cart.totals.total)}</span></div>
        <Button size="lg" block icon={ChefHat} disabled={!newCount} onClick={onPlace}>
          {newCount ? `Place order · ${newCount} new item${newCount > 1 ? 's' : ''}` : cart.items.length ? 'Nothing new to send' : 'Place order'}
        </Button>
      </div>
    </div>
  )
}

