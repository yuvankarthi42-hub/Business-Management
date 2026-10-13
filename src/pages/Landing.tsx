// Public landing page (/ when signed out, and /welcome). Its own look — ink and receipt paper — so it doesn't feel
// like the app screens. Everything shown here is something the product really does.
import clsx from 'clsx'
import {
  ArrowRight, BarChart3, Boxes, ChefHat, Clock, CreditCard, Flame, LayoutDashboard, Languages, MessageCircle,
  NotebookPen, PackageOpen, QrCode, ReceiptText, Scissors, ShieldCheck, ShoppingCart, Sparkles, Store, Tag, UserCheck,
  Users, UtensilsCrossed, Wallet, type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '@/app/AppContext'
import { LanguageToggle } from '@/i18n/LanguagePicker'
import './landing.css'

/** Price shown on the page (₹ per branch per month). Keep it the same as Admin → Settings → price per branch. */
const PRICE_PER_BRANCH = 499
/** "Get your account" opens WhatsApp when this is set (digits with country code, e.g. 919876543210); else sign-in. */
const CONTACT_WHATSAPP = (import.meta.env.VITE_CONTACT_WHATSAPP ?? '').replace(/\D/g, '')
const getStartedHref = CONTACT_WHATSAPP
  ? `https://wa.me/${CONTACT_WHATSAPP}?text=${encodeURIComponent('Hi, I would like a BillPoodum account for my shop.')}`
  : null

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
const rupee = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Adds .is-in to [data-reveal] elements as they scroll into view. */
function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll('.lp [data-reveal]')
    if (!('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('is-in')); return }
    const io = new IntersectionObserver((list) => list.forEach((x) => { if (x.isIntersecting) { x.target.classList.add('is-in'); io.unobserve(x.target) } }), { rootMargin: '0px 0px -10% 0px' })
    els.forEach((e) => io.observe(e))
    return () => io.disconnect()
  }, [])
}
function useInView<T extends Element>(margin = '0px') {
  const ref = useRef<T>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    const io = new IntersectionObserver(([x]) => { if (x.isIntersecting) { setSeen(true); io.disconnect() } }, { rootMargin: margin, threshold: 0.25 })
    io.observe(el)
    return () => io.disconnect()
  }, [seen, margin])
  return [ref, seen] as const
}

function GetStarted({ className, label = 'Get your account' }: { className?: string; label?: string }) {
  const cls = clsx('lp-btn lp-btn-gold px-6 py-3 text-[15px]', className)
  return getStartedHref
    ? <a href={getStartedHref} target="_blank" rel="noreferrer" className={cls}><MessageCircle className="h-4 w-4" />{label}</a>
    : <Link to="/login" className={cls}>{label}<ArrowRight className="h-4 w-4" /></Link>
}

function Mark({ className }: { className?: string }) {
  return (
    <div className={clsx('flex items-center gap-2.5', className)}>
      <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#4d86ff] to-[#1f55eb] text-white shadow-[0_8px_24px_-8px_rgba(59,115,246,.9)]">
        <ReceiptText className="h-[18px] w-[18px]" />
      </div>
      <span className="text-[17px] font-semibold tracking-tight" data-no-i18n>BillPoodum</span>
    </div>
  )
}

// ======================================================================= the printing receipt

interface Shop {
  name: string; place: string; meta: string; bill: string
  items: [string, number, number][] // name, qty, price
  tax: { label: string; rate: number; inclusive?: boolean }
  pay: string
  chips: [string, string]
}
const SHOPS: Shop[] = [
  {
    name: 'Murugan Tea Stall', place: 'Madurai', meta: 'Counter · Takeaway', bill: 'INV-10482',
    items: [['Filter Coffee', 2, 25], ['Masala Tea', 1, 20], ['Onion Samosa', 3, 15], ['Medu Vada', 2, 12]],
    tax: { label: 'GST 5%', rate: 0.05 }, pay: 'UPI',
    chips: ['Bill sent on WhatsApp', 'Coffee powder · 2.1 kg left'],
  },
  {
    name: 'FreshMart Supermarket', place: 'Coimbatore', meta: 'Counter 3 · Scanned', bill: 'FM-20931',
    items: [['Aavin Milk 500 ml', 2, 27], ['Ponni Rice 5 kg', 1, 365], ['Sunflower Oil 1 L', 1, 148], ['Toor Dal 1 kg', 1, 162], ['Brown Bread', 1, 45]],
    tax: { label: 'GST (incl.)', rate: 0.05, inclusive: true }, pay: 'CASH',
    chips: ['Stock updated · Milk 56 left', 'Expiry first · Batch B-114'],
  },
  {
    name: 'Glow Unisex Salon', place: 'Chennai', meta: 'Stylist · Priya', bill: 'GL-1207',
    items: [['Haircut', 1, 250], ['Beard Styling', 1, 120], ['Hair Spa', 1, 799]],
    tax: { label: 'GST 18%', rate: 0.18 }, pay: 'CARD',
    chips: ['Priya · commission added', 'Next visit reminder ready'],
  },
  {
    name: 'Annapoorna Restaurant', place: 'Trichy', meta: 'Table 4 · Dine in', bill: 'AN-5530',
    items: [['Veg Meals', 2, 140], ['Paneer Butter Masala', 1, 220], ['Butter Naan', 3, 45], ['Sweet Lassi', 2, 70]],
    tax: { label: 'GST 5%', rate: 0.05 }, pay: 'UPI',
    chips: ['KOT-0042 → Kitchen', 'Table 4 is free again'],
  },
]
function totals(s: Shop) {
  const sub = s.items.reduce((a, [, q, p]) => a + q * p, 0)
  const tax = s.tax.inclusive ? sub - sub / (1 + s.tax.rate) : sub * s.tax.rate
  const raw = s.tax.inclusive ? sub : sub + tax
  const total = Math.round(raw)
  return { sub, tax, round: total - raw, total }
}

function PrintingReceipt() {
  const [shop, setShop] = useState(0)
  const [step, setStep] = useState(0)
  const [torn, setTorn] = useState(false)
  const s = SHOPS[shop]
  const t = useMemo(() => totals(s), [s])
  const steps = 3 + s.items.length + 4 // header rows, items, totals, stamp

  useEffect(() => {
    if (reduced()) { setStep(steps); const id = setTimeout(() => setShop((i) => (i + 1) % SHOPS.length), 6000); return () => clearTimeout(id) }
    if (step < steps) { const id = setTimeout(() => setStep((x) => x + 1), step === 0 ? 500 : 240); return () => clearTimeout(id) }
    const hold = setTimeout(() => setTorn(true), 3200)
    const next = setTimeout(() => { setTorn(false); setStep(0); setShop((i) => (i + 1) % SHOPS.length) }, 3900)
    return () => { clearTimeout(hold); clearTimeout(next) }
  }, [step, steps])

  const show = (n: number) => step >= n
  const itemsFrom = 3, totalsFrom = 3 + s.items.length
  return (
    <div className="relative mx-auto w-full max-w-[380px]" data-no-i18n>
      <div className="lp-printer"><span className={clsx('lp-led', step < steps && 'is-busy')} /></div>
      <div className="relative -mt-[14px] px-[30px]">
        <div className="lp-receipt-wrap">
          <div className={clsx('lp-receipt lp-paper lp-mono min-h-[60px] px-6 pb-8 pt-6 text-[12.5px] leading-[1.75]', torn && 'is-torn')} key={shop}>
            {show(1) && (
              <div className="lp-row text-center">
                <div className="text-[15px] font-bold uppercase tracking-wider">{s.name}</div>
                <div className="text-[11px] opacity-60">{s.place} · GSTIN 33ABCDE1234F1Z5</div>
              </div>
            )}
            {show(2) && <div className="lp-row mt-2 flex justify-between text-[11px] opacity-70"><span>{s.bill}</span><span>{s.meta}</span></div>}
            {show(3) && <div className="lp-row my-2 border-t border-dashed border-black/25" />}
            {s.items.map(([name, q, p], i) => show(itemsFrom + i + 1) && (
              <div key={name} className="lp-row flex items-baseline">
                <span className="truncate">{name}</span><span className="ml-1 shrink-0 opacity-60">×{q}</span>
                <span className="lp-dots" />
                <span className="tabular shrink-0">{rupee(q * p)}</span>
              </div>
            ))}
            {show(totalsFrom + 1) && <div className="lp-row mt-2 border-t border-dashed border-black/25 pt-2 flex justify-between opacity-75"><span>Subtotal</span><span className="tabular">{rupee(t.sub)}</span></div>}
            {show(totalsFrom + 2) && <div className="lp-row flex justify-between opacity-75"><span>{s.tax.label}</span><span className="tabular">{rupee(t.tax)}</span></div>}
            {show(totalsFrom + 3) && (
              <div className="lp-row mt-1 flex items-end justify-between border-t-2 border-black/80 pt-2">
                <span className="text-[13px] font-bold">TOTAL</span>
                <span className="tabular text-[22px] font-bold leading-none">{rupee(t.total)}</span>
              </div>
            )}
            {show(totalsFrom + 4) && (
              <>
                <div className="mt-4 flex justify-center"><span className="lp-stamp pointer-events-none inline-block px-3 py-0.5 text-[13px] font-bold">PAID · {s.pay}</span></div>
                <div className="lp-row mt-2 text-center text-[11px] opacity-60">Thank you! Visit again.</div>
              </>
            )}
          </div>
        </div>
      </div>
      {/* what happened behind the bill */}
      {step >= steps && !torn && (
        <>
          <div className="lp-chip absolute right-[calc(100%-26px)] top-[30%] hidden whitespace-nowrap rounded-2xl px-3.5 py-2.5 text-xs text-white xl:flex xl:items-center xl:gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px] shadow-emerald-400" />{s.chips[0]}
          </div>
          <div className="lp-chip absolute left-[calc(100%-26px)] top-[64%] hidden whitespace-nowrap rounded-2xl px-3.5 py-2.5 text-xs text-white xl:flex xl:items-center xl:gap-2" style={{ animationDelay: '180ms' }}>
            <Sparkles className="h-3.5 w-3.5 text-[#f5a524]" />{s.chips[1]}
          </div>
        </>
      )}
      <div className="mt-5 flex min-h-[34px] flex-wrap justify-center gap-2 xl:hidden">
        {step >= steps && !torn && s.chips.map((c, k) => <span key={c} className="lp-chip rounded-full px-3 py-1.5 text-[11px] text-white" style={{ animationDelay: `${k * 150}ms` }}>{c}</span>)}
      </div>
      <div className="mt-6 flex justify-center gap-1.5">
        {SHOPS.map((x, i) => <span key={x.name} className={clsx('h-1.5 rounded-full transition-all duration-500', i === shop ? 'w-6 bg-[#f5a524]' : 'w-1.5 bg-white/25')} />)}
      </div>
    </div>
  )
}

// ======================================================================= one app, four shapes

interface Shape {
  key: string; label: string; sub: string; icon: LucideIcon
  nav: [LucideIcon, string][]
  title: string; search: string
  tiles?: [string, number][]; tables?: [string, 'free' | 'busy' | 'bill'][]
  cart: [string, number][]
  extras: string[]
}
const SHAPES: Shape[] = [
  {
    key: 'retail', label: 'Retail', sub: 'Supermarket · Grocery · Hardware', icon: ShoppingCart,
    nav: [[LayoutDashboard, 'Dashboard'], [ReceiptText, 'Billing'], [PackageOpen, 'Customer Orders'], [Tag, 'Products'], [Boxes, 'Inventory'], [Users, 'Customers'], [BarChart3, 'Reports']],
    title: 'Billing', search: 'Scan barcode or search products…',
    tiles: [['Aavin Milk 500 ml', 27], ['Ponni Rice 5 kg', 365], ['Sunflower Oil 1 L', 148], ['Toor Dal 1 kg', 162], ['Brown Bread', 45], ['Bath Soap', 38]],
    cart: [['Ponni Rice 5 kg', 365], ['Aavin Milk ×2', 54], ['Brown Bread', 45]],
    extras: ['Barcode scanning', 'Batch & expiry', 'Wholesale prices'],
  },
  {
    key: 'food', label: 'Food', sub: 'Tea shop · Bakery · Fast food', icon: ChefHat,
    nav: [[LayoutDashboard, 'Dashboard'], [ReceiptText, 'Billing'], [ChefHat, 'Kitchen (KOT)'], [Tag, 'Menu Items'], [Flame, 'Daily Specials'], [QrCode, 'QR Orders'], [BarChart3, 'Reports']],
    title: 'Billing', search: 'Search menu items…',
    tiles: [['Filter Coffee', 25], ['Masala Tea', 20], ['Veg Puff', 22], ['Onion Samosa', 15], ['Plum Cake', 60], ['Rose Milk', 35]],
    cart: [['Filter Coffee ×2', 50], ['Veg Puff ×2', 44], ['Rose Milk', 35]],
    extras: ['Kitchen tickets', "Today's specials", 'QR menu'],
  },
  {
    key: 'restaurant', label: 'Restaurant', sub: 'Hotel · Cafe · Dine-in', icon: UtensilsCrossed,
    nav: [[LayoutDashboard, 'Dashboard'], [UtensilsCrossed, 'Tables'], [NotebookPen, 'Take Order'], [ChefHat, 'Kitchen (KOT)'], [Tag, 'Menu Items'], [Users, 'Guests'], [BarChart3, 'Reports']],
    title: 'Tables', search: 'Ground floor · 8 tables',
    tables: [['T1', 'busy'], ['T2', 'free'], ['T3', 'bill'], ['T4', 'busy'], ['T5', 'free'], ['T6', 'busy'], ['T7', 'free'], ['T8', 'bill']],
    cart: [['Veg Meals ×2', 280], ['Paneer Butter Masala', 220], ['Butter Naan ×3', 135]],
    extras: ['Table transfer & merge', 'Waiter phones', 'QR at the table'],
  },
  {
    key: 'service', label: 'Service', sub: 'Salon · Spa · Laundry · Repair', icon: Scissors,
    nav: [[LayoutDashboard, 'Dashboard'], [ReceiptText, 'Billing'], [Tag, 'Services'], [Users, 'Clients'], [UserCheck, 'Staff'], [CreditCard, 'Payments'], [BarChart3, 'Reports']],
    title: 'Billing', search: 'Search services…',
    tiles: [['Haircut', 250], ['Beard Styling', 120], ['Hair Spa', 799], ['Facial', 650], ['Manicure', 400], ['Hair Colour', 1200]],
    cart: [['Haircut', 250], ['Hair Spa', 799], ['Beard Styling', 120]],
    extras: ['Staff commission', 'Client history', 'Dues & credit'],
  },
]
const AUTO_MS = 5200

function ShapeShifter() {
  const [i, setI] = useState(0)
  const [auto, setAuto] = useState(true)
  const [ref, seen] = useInView<HTMLDivElement>('0px 0px -20% 0px')
  useEffect(() => {
    if (!auto || !seen || reduced()) return
    const id = setTimeout(() => setI((x) => (x + 1) % SHAPES.length), AUTO_MS)
    return () => clearTimeout(id)
  }, [i, auto, seen])
  const s = SHAPES[i]
  const total = s.cart.reduce((a, [, p]) => a + p, 0)
  return (
    <div ref={ref}>
      <div className="relative mx-auto grid w-full max-w-xl grid-cols-4 rounded-full border border-black/10 bg-white/70 p-1.5">
        <span className="lp-tab-ind absolute bottom-1.5 left-1.5 top-1.5 w-[calc((100%-12px)/4)] rounded-full bg-[#17140e]" style={{ transform: `translateX(${i * 100}%)` }} />
        {SHAPES.map((x, k) => (
          <button key={x.key} onClick={() => { setI(k); setAuto(false) }}
            className={clsx('relative z-10 flex items-center justify-center gap-1.5 rounded-full px-1 py-2 text-xs font-semibold transition-colors sm:gap-2 sm:text-sm', k === i ? 'text-white' : 'text-[#6b6457] hover:text-[#17140e]')}>
            <x.icon className="hidden h-4 w-4 min-[400px]:block" />{x.label}
          </button>
        ))}
      </div>
      <p className="lp-muted mt-3 text-center text-sm" key={`sub-${s.key}`}><span className="lp-swap inline-block">{s.sub}</span></p>
      {auto && seen && <div className="mx-auto mt-3 h-0.5 w-24 overflow-hidden rounded bg-black/10"><div key={`p-${i}`} className="lp-progress h-full bg-[#f5a524]" style={{ animationDuration: `${AUTO_MS}ms` }} /></div>}

      <div className="lp-window mx-auto mt-10 max-w-5xl overflow-hidden">
        <div className="flex items-center gap-2 border-b border-black/5 px-4 py-3">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" /><span className="h-3 w-3 rounded-full bg-[#febc2e]" /><span className="h-3 w-3 rounded-full bg-[#28c840]" />
          <div className="mx-auto hidden rounded-md bg-slate-100 px-10 py-1 text-[11px] text-slate-500 sm:block">app.billpoodum.in</div>
        </div>
        <div className="grid min-h-[420px] grid-cols-12" key={s.key}>
          <aside className="col-span-3 hidden border-r border-slate-100 bg-[#0f1f3d] p-3 text-[13px] md:block">
            <div className="mb-4 flex items-center gap-2 px-2 pt-1 text-white"><Store className="h-4 w-4 text-[#93bbfd]" /><span className="font-semibold">Main branch</span></div>
            {s.nav.map(([I, l], k) => (
              <div key={l} className={clsx('lp-swap mb-1 flex items-center gap-2.5 rounded-lg px-2.5 py-2', l === s.title ? 'bg-white/10 text-white' : 'text-slate-400')} style={{ ['--d' as string]: `${k * 45}ms` }}>
                <I className="h-4 w-4" />{l}
              </div>
            ))}
          </aside>
          <main className="col-span-12 bg-slate-50 p-4 sm:p-5 md:col-span-6">
            <div className="flex items-center justify-between">
              <div className="text-lg font-bold text-slate-900">{s.title}</div>
              <div className="flex gap-1.5">{s.extras.map((e, k) => <span key={e} className="lp-swap hidden rounded-full bg-[#fff4dc] px-2.5 py-1 text-[11px] font-medium text-[#8a5a00] lg:inline" style={{ ['--d' as string]: `${200 + k * 80}ms` }}>{e}</span>)}</div>
            </div>
            <div className="mt-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-400">{s.search}</div>
            {s.tiles && (
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {s.tiles.map(([n, p], k) => (
                  <div key={n} className="lp-swap rounded-xl border border-slate-200 bg-white p-3 shadow-card" style={{ ['--d' as string]: `${k * 55}ms` }}>
                    <div className="mb-6 h-8 w-8 rounded-lg bg-gradient-to-br from-brand-100 to-orange-100" />
                    <div className="truncate text-[13px] font-medium text-slate-800" data-no-i18n>{n}</div>
                    <div className="text-[13px] font-semibold text-brand-700">₹{p}</div>
                  </div>
                ))}
              </div>
            )}
            {s.tables && (
              <div className="mt-4 grid grid-cols-4 gap-3">
                {s.tables.map(([n, st], k) => (
                  <div key={n} className={clsx('lp-swap flex aspect-square flex-col items-center justify-center rounded-2xl border-2 text-sm font-bold',
                    st === 'free' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : st === 'busy' ? 'border-brand-200 bg-brand-50 text-brand-700' : 'border-amber-300 bg-amber-50 text-amber-700')}
                    style={{ ['--d' as string]: `${k * 50}ms` }}>
                    {n}<span className="mt-1 text-[10px] font-medium opacity-70">{st === 'free' ? 'Free' : st === 'busy' ? 'Running' : 'Bill'}</span>
                  </div>
                ))}
              </div>
            )}
          </main>
          <section className="col-span-12 border-l border-slate-100 bg-white p-5 md:col-span-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">{s.key === 'restaurant' ? 'Table 4' : 'Current bill'}</div>
            <div className="mt-3 space-y-2.5">
              {s.cart.map(([n, p], k) => (
                <div key={n} className="lp-swap flex justify-between gap-2 text-[13px]" style={{ ['--d' as string]: `${150 + k * 70}ms` }}>
                  <span className="truncate text-slate-700" data-no-i18n>{n}</span><span className="font-medium text-slate-900">₹{p}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 flex justify-between border-t border-slate-100 pt-3 text-sm font-bold text-slate-900"><span>Total</span><span>₹{total}</span></div>
            <div className="mt-4 rounded-xl bg-brand-600 py-2.5 text-center text-sm font-semibold text-white">Pay · UPI / Cash / Card</div>
          </section>
        </div>
      </div>
    </div>
  )
}

// ======================================================================= a day in the shop

const DAY: { time: string; title: string; body: string; icon: LucideIcon }[] = [
  { time: '06:30', title: 'Shutter up.', body: 'Open BillPoodum on the counter PC, a tablet or your phone. Pick your branch — yesterday’s numbers are already waiting.', icon: Store },
  { time: '09:15', title: 'The morning rush.', body: 'Every counter bills at the same time. Each bill gets its own number, stock goes down item by item, UPI, cash and card are split correctly.', icon: ReceiptText },
  { time: '13:00', title: 'Kitchen in sync.', body: 'Orders reach the kitchen screen as tickets. Guests order from the QR code on their table; waiters take orders on their phones.', icon: ChefHat },
  { time: '17:30', title: 'Fill the evening.', body: 'Send today’s offer to your regular customers on WhatsApp — with a poster made from your own menu.', icon: MessageCircle },
  { time: '22:00', title: 'Close with clarity.', body: 'Sales, expenses, staff salary and dues in one report. Every branch, from home.', icon: BarChart3 },
]

function DayTimeline() {
  const [active, setActive] = useState(0)
  const refs = useRef<(HTMLDivElement | null)[]>([])
  useEffect(() => {
    const io = new IntersectionObserver((list) => list.forEach((x) => { if (x.isIntersecting) setActive(Number((x.target as HTMLElement).dataset.i)) }), { rootMargin: '-45% 0px -45% 0px' })
    refs.current.forEach((r) => r && io.observe(r))
    return () => io.disconnect()
  }, [])
  const [h, m] = DAY[active].time.split(':').map(Number)
  const hourDeg = (h % 12) * 30 + m * 0.5, minDeg = m * 6
  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="lg:sticky lg:top-28 lg:h-[70vh]">
        <div className="flex items-center gap-8 lg:flex-col lg:items-start">
          <svg viewBox="0 0 200 200" className="h-28 w-28 shrink-0 sm:h-40 sm:w-40 lg:h-56 lg:w-56" aria-hidden>
            <circle cx="100" cy="100" r="92" fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="2" />
            {Array.from({ length: 12 }, (_, k) => <line key={k} x1="100" y1="14" x2="100" y2={k % 3 ? 22 : 28} stroke="rgba(255,255,255,.45)" strokeWidth={k % 3 ? 1.5 : 3} strokeLinecap="round" transform={`rotate(${k * 30} 100 100)`} />)}
            <line className="lp-hand" x1="100" y1="100" x2="100" y2="52" stroke="#fff" strokeWidth="5" strokeLinecap="round" style={{ transform: `rotate(${hourDeg}deg)` }} />
            <line className="lp-hand" x1="100" y1="100" x2="100" y2="30" stroke="#f5a524" strokeWidth="3" strokeLinecap="round" style={{ transform: `rotate(${minDeg}deg)` }} />
            <circle cx="100" cy="100" r="6" fill="#f5a524" />
          </svg>
          <div>
            <div className="lp-serif text-6xl leading-none text-white sm:text-7xl lg:text-8xl" data-no-i18n key={DAY[active].time}><span className="lp-swap inline-block">{DAY[active].time}</span></div>
            <div className="mt-3 text-sm uppercase tracking-[.25em] text-white/50">A day in the shop</div>
          </div>
        </div>
      </div>
      <div className="space-y-6 lg:space-y-[22vh] lg:py-[18vh]">
        {DAY.map((d, k) => (
          <div key={d.time} ref={(el) => { refs.current[k] = el }} data-i={k} className={clsx('lp-step rounded-3xl border border-white/10 bg-white/[.03] p-7 sm:p-9', k === active && 'is-active')}>
            <div className="flex items-center gap-3 text-[#f5a524]"><d.icon className="h-5 w-5" /><span className="lp-mono text-sm" data-no-i18n>{d.time}</span></div>
            <h3 className="lp-serif mt-4 text-4xl text-white sm:text-5xl">{d.title}</h3>
            <p className="mt-4 max-w-lg text-[17px] leading-relaxed text-white/65">{d.body}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ======================================================================= built for the rush

function Rush() {
  const [ref, seen] = useInView<HTMLDivElement>('0px 0px -15% 0px')
  // Twenty counters press "Pay" within the same second. Whoever is saved first gets the next number.
  const plan = useMemo(() => {
    const delays = Array.from({ length: 20 }, () => 150 + Math.random() * 1500)
    const order = delays.map((d, i) => ({ d, i })).sort((a, b) => a.d - b.d)
    const num = new Array<number>(20)
    order.forEach((x, rank) => { num[x.i] = 10501 + rank })
    return { delays, num }
  }, [])
  const [done, setDone] = useState<boolean[]>(() => new Array(20).fill(false))
  useEffect(() => {
    if (!seen) return
    const ids = plan.delays.map((d, i) => setTimeout(() => setDone((x) => { const n = [...x]; n[i] = true; return n }), reduced() ? 0 : d))
    return () => ids.forEach(clearTimeout)
  }, [seen, plan])
  const all = done.every(Boolean)
  return (
    <div ref={ref} className="grid items-center gap-12 lg:grid-cols-2">
      <div>
        <div className="text-sm font-semibold uppercase tracking-[.2em] text-[#f5a524]">Built for the rush</div>
        <h2 className="lp-serif mt-4 text-5xl leading-[1.02] text-white sm:text-6xl">Twenty counters. One second. Zero mix-ups.</h2>
        <p className="mt-6 max-w-lg text-lg leading-relaxed text-white/65">When every counter presses Pay at once, each bill is saved completely or not at all — its own number, the exact stock, the right payment. Nothing is half-saved, nothing is counted twice.</p>
        <div className="mt-8 grid max-w-lg grid-cols-3 gap-3">
          {[['Own database', 'for every shop'], ['Saved instantly', 'on every device'], ['Every change', 'in the audit log']].map(([a, b]) => (
            <div key={a} className="rounded-2xl border border-white/10 bg-white/[.03] p-4">
              <div className="text-[15px] font-semibold text-white">{a}</div><div className="mt-1 text-xs text-white/50">{b}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="relative">
        <div className="grid grid-cols-4 gap-2 sm:gap-2.5 xl:grid-cols-5">
          {done.map((d, i) => (
            <div key={i} className={clsx('lp-counter rounded-xl border border-white/10 bg-white/[.03] p-2.5 sm:p-3', d && 'is-done')}>
              <div className="whitespace-nowrap text-[9px] uppercase tracking-wider text-white/40 sm:text-[10px]">Counter {String(i + 1).padStart(2, '0')}</div>
              <div className="lp-mono mt-2 h-4 text-[11px] text-emerald-300 sm:text-xs" data-no-i18n>{d ? <span className="lp-counter-num inline-block">INV-{plan.num[i]}</span> : <span className="text-white/25">· · ·</span>}</div>
            </div>
          ))}
        </div>
        <div className={clsx('mt-5 flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm transition-all duration-500', all ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200' : 'border-white/10 text-white/40')}>
          <ShieldCheck className="h-5 w-5 shrink-0" />{all ? '20 bills saved · 20 different numbers · stock exact' : 'Saving…'}
        </div>
      </div>
    </div>
  )
}

// ======================================================================= pricing as a receipt

const INCLUDED = ['Billing & POS', 'Unlimited bills & items', 'Stock, batches & expiry', 'Kitchen display (KOT)', 'Tables & QR ordering', 'Customers, credit & dues', 'Staff, attendance & salary', 'WhatsApp bills & offers', 'Reports & data export', 'Tamil & English', 'Updates & support']

function PriceReceipt() {
  return (
    <div className="relative mx-auto max-w-md" data-reveal>
      <div className="lp-paper lp-mono rotate-[1.2deg] px-7 pb-10 pt-8 text-[13px] leading-[1.9] text-[#1d1a14] sm:px-9">
        <div className="text-center">
          <div className="text-[15px] font-bold uppercase tracking-[.2em]" data-no-i18n>BillPoodum</div>
          <div className="text-[11px] opacity-60">One plan · everything included</div>
        </div>
        <div className="my-4 border-t border-dashed border-black/25" />
        {INCLUDED.map((x) => (
          <div key={x} className="flex items-baseline"><span>{x}</span><span className="lp-dots" /><span className="text-[11px] font-semibold text-[#1f9d63]">INCLUDED</span></div>
        ))}
        <div className="mt-4 border-t-2 border-black/80 pt-3">
          <div className="flex items-end justify-between">
            <span className="font-bold">PER BRANCH</span>
            <span className="leading-none"><span className="text-[34px] font-bold" data-no-i18n>₹{PRICE_PER_BRANCH}</span><span className="text-xs opacity-60"> / month</span></span>
          </div>
        </div>
        <div className="mt-4 text-center text-[11px] opacity-60">Add a branch any time · Pay for the branches you use</div>
      </div>
    </div>
  )
}

// ======================================================================= page

const KINDS = ['Tea shops', 'Supermarkets', 'Bakeries', 'Restaurants', 'Salons', 'Hardware stores', 'Juice shops', 'Cafes', 'Sweet stalls', 'Laundries', 'Grocery / Maligai', 'Cloud kitchens', 'Stationery', 'Spas', 'Dhabas', 'Electronics']

const FAQ: [string, string][] = [
  ['Do I need the internet?', 'Yes. Every bill is saved online the moment you press Pay, so all your counters and your own phone always see the same numbers — and nothing is lost if a device breaks.'],
  ['Is my shop’s data kept separate?', 'Yes. Every shop gets its own private database. Only you and the staff you add can sign in, each with the permissions you choose.'],
  ['Which printers work?', 'Common 58 mm and 80 mm thermal receipt printers — through the browser, USB, serial or Bluetooth — set separately for each branch.'],
  ['I have more than one branch.', 'Add branches any time. Each branch has its own bill numbers, stock and printer, and you see all of them together in one view.'],
  ['Can my staff use it in Tamil?', 'Yes. Each person can switch between Tamil and English on their own device.'],
]

export default function Landing() {
  useReveal()
  const { me } = useApp()
  const [stuck, setStuck] = useState(false)
  const hero = useRef<HTMLElement>(null)
  useEffect(() => {
    const on = () => setStuck(window.scrollY > 24)
    on(); window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])
  useEffect(() => { document.title = 'BillPoodum — Billing & business management for every shop' }, [])
  const onMove = (e: React.PointerEvent) => {
    const el = hero.current
    if (!el || e.pointerType !== 'mouse') return
    const r = el.getBoundingClientRect()
    el.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`)
    el.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`)
  }
  const signIn = me
    ? <Link to="/dashboard" className="lp-btn lp-btn-ghost whitespace-nowrap px-5 py-2.5 text-sm">Open the app<ArrowRight className="h-4 w-4" /></Link>
    : <Link to="/login" className="lp-btn lp-btn-ghost whitespace-nowrap px-5 py-2.5 text-sm">Sign in</Link>

  return (
    <div className="lp min-h-[100dvh]">
      {/* ---------------- nav ---------------- */}
      <header className={clsx('lp-nav fixed inset-x-0 top-0 z-50', stuck && 'is-stuck')}>
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <Mark className="text-white" />
          <nav className="hidden items-center gap-7 whitespace-nowrap text-sm text-white/70 lg:flex [html[lang=ta]_&]:hidden [html[lang=ta]_&]:xl:flex">
            <a href="#shapes" className="hover:text-white">For your business</a>
            <a href="#day" className="hover:text-white">How it works</a>
            <a href="#pricing" className="hover:text-white">Pricing</a>
            <a href="#faq" className="hover:text-white">FAQ</a>
          </nav>
          <div className="flex items-center gap-3">
            <LanguageToggle className="hidden !border-white/15 !bg-white/5 sm:inline-flex [&_button:not(.bg-brand-600)]:!text-white/70 [&_button:not(.bg-brand-600)]:hover:!bg-white/10" />
            {signIn}
          </div>
        </div>
      </header>

      {/* ---------------- hero ---------------- */}
      <section ref={hero} onPointerMove={onMove} className="lp-hero lp-grain relative overflow-hidden pb-20 pt-32 sm:pt-40 lg:pb-28">
        <div className="lp-hero-glow" /><div className="lp-floor" />
        <div className="mx-auto grid max-w-7xl items-center gap-16 px-5 sm:px-8 lg:grid-cols-[1.15fr_1fr]">
          <div>
            <div className="lp-rise inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[.04] px-3.5 py-1.5 text-xs text-white/75">
              <span className="h-1.5 w-1.5 rounded-full bg-[#f5a524] shadow-[0_0_8px_#f5a524]" />Billing & business management · made for Indian shops
            </div>
            <h1 style={{ ['--d' as string]: '80ms' }} className="lp-rise lp-serif mt-7 text-[56px] leading-[.95] text-white sm:text-[84px] lg:text-[104px]">
              Every bill,<br /><em className="lp-gold">beautifully</em><br />in order.
            </h1>
            <p style={{ ['--d' as string]: '160ms' }} className="lp-rise mt-8 max-w-xl text-lg leading-relaxed text-white/65 sm:text-xl">
              One app for billing, stock, kitchen, tables, staff and the day’s money — that takes the shape of your business, from a tea stall to a supermarket.
            </p>
            <div style={{ ['--d' as string]: '240ms' }} className="lp-rise mt-10 flex flex-wrap items-center gap-3">
              <GetStarted />
              <a href="#shapes" className="lp-btn lp-btn-ghost px-6 py-3 text-[15px]">See it in your shop</a>
            </div>
            <div style={{ ['--d' as string]: '320ms' }} className="lp-rise mt-12 flex flex-wrap gap-x-8 gap-y-3 text-sm text-white/55">
              {[[ShieldCheck, 'Private database per shop'], [Languages, 'Tamil & English'], [Store, 'Multi-branch']].map(([I, l]) => {
                const Icon = I as LucideIcon
                return <span key={l as string} className="flex items-center gap-2"><Icon className="h-4 w-4 text-white/40" />{l as string}</span>
              })}
            </div>
          </div>
          <div style={{ ['--d' as string]: '200ms' }} className="lp-rise lp-float">
            <PrintingReceipt />
          </div>
        </div>
      </section>

      {/* ---------------- marquee ---------------- */}
      <section className="border-y border-white/[.06] bg-[#0a0f1e] py-7">
        <div className="lp-marquee overflow-hidden" data-no-i18n>
          <div className="lp-marquee-track flex gap-10 whitespace-nowrap">
            {[...KINDS, ...KINDS].map((k, i) => (
              <span key={i} className="lp-serif flex items-center gap-10 text-3xl italic text-white/40">{k}<span className="text-[#f5a524]/60 not-italic text-xl">✦</span></span>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- one app, four shapes ---------------- */}
      <section id="shapes" className="lp-light scroll-mt-20 px-5 py-24 sm:px-8 sm:py-32">
        <div className="mx-auto max-w-3xl text-center">
          <div data-reveal className="text-sm font-semibold uppercase tracking-[.2em] text-[#b7791f]">One app · four shapes</div>
          <h2 data-reveal style={{ ['--d' as string]: '80ms' }} className="lp-serif mt-4 text-5xl leading-[1.02] sm:text-7xl">It speaks your shop’s language.</h2>
          <p data-reveal style={{ ['--d' as string]: '160ms' }} className="lp-muted mx-auto mt-6 max-w-xl text-lg leading-relaxed">Tell it what you run. The screens, the words and the features change to fit — Menu Items for a café, Clients for a salon, Tables for a restaurant.</p>
        </div>
        <div className="mt-14" data-reveal style={{ ['--d' as string]: '220ms' }}><ShapeShifter /></div>
      </section>

      {/* ---------------- a day in the shop ---------------- */}
      <section id="day" className="lp-grain relative scroll-mt-20 px-5 py-24 sm:px-8 sm:py-32">
        <div className="mx-auto max-w-7xl">
          <div className="mb-16 max-w-2xl">
            <div data-reveal className="text-sm font-semibold uppercase tracking-[.2em] text-[#f5a524]">How it works</div>
            <h2 data-reveal style={{ ['--d' as string]: '80ms' }} className="lp-serif mt-4 text-5xl leading-[1.02] text-white sm:text-7xl">From the first chai to the last report.</h2>
          </div>
          <DayTimeline />
        </div>
      </section>

      {/* ---------------- rush ---------------- */}
      <section className="relative border-t border-white/[.06] bg-[#0a0f1e] px-5 py-24 sm:px-8 sm:py-32">
        <div className="mx-auto max-w-7xl"><Rush /></div>
      </section>

      {/* ---------------- tamil ---------------- */}
      <section className="lp-light overflow-hidden px-5 py-24 sm:px-8 sm:py-28">
        <div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-2">
          <div data-reveal className="lp-serif select-none text-[120px] leading-none text-[#17140e] sm:text-[180px] lg:text-[220px]" data-no-i18n lang="ta">
            தமிழ்<span className="lp-gold">.</span>
          </div>
          <div>
            <h2 data-reveal className="lp-serif text-5xl leading-[1.02] sm:text-6xl">Your staff work in the language they think in.</h2>
            <p data-reveal style={{ ['--d' as string]: '80ms' }} className="lp-muted mt-6 max-w-lg text-lg leading-relaxed">Every screen in Tamil or English — chosen by each person on their own device. The cashier in Tamil, the owner in English, the same bill.</p>
            <div data-reveal style={{ ['--d' as string]: '160ms' }} className="mt-8"><LanguageToggle className="!text-sm" /></div>
          </div>
        </div>
      </section>

      {/* ---------------- pricing ---------------- */}
      <section id="pricing" className="lp-grain relative scroll-mt-20 px-5 py-24 sm:px-8 sm:py-32">
        <div className="mx-auto grid max-w-7xl items-center gap-16 lg:grid-cols-2">
          <div>
            <div data-reveal className="text-sm font-semibold uppercase tracking-[.2em] text-[#f5a524]">Pricing</div>
            <h2 data-reveal style={{ ['--d' as string]: '80ms' }} className="lp-serif mt-4 text-5xl leading-[1.02] text-white sm:text-7xl">One simple bill. For us, too.</h2>
            <p data-reveal style={{ ['--d' as string]: '160ms' }} className="mt-6 max-w-lg text-lg leading-relaxed text-white/65">No modules to buy, no per-user fees. Every feature for every branch — you pay only for the branches you open.</p>
            <div data-reveal style={{ ['--d' as string]: '240ms' }} className="mt-10"><GetStarted /></div>
          </div>
          <PriceReceipt />
        </div>
      </section>

      {/* ---------------- faq ---------------- */}
      <section id="faq" className="lp-light scroll-mt-20 px-5 py-24 sm:px-8 sm:py-28">
        <div className="mx-auto max-w-3xl">
          <h2 data-reveal className="lp-serif text-center text-5xl sm:text-6xl">Questions, answered.</h2>
          <div className="mt-12 divide-y divide-black/10 border-y border-black/10">
            {FAQ.map(([q, a], k) => (
              <details key={q} className="lp-faq group py-6" data-reveal style={{ ['--d' as string]: `${k * 60}ms` }}>
                <summary className="flex items-center justify-between gap-6 text-lg font-semibold sm:text-xl">{q}<span className="lp-faq-plus flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-black/15 text-xl font-light">+</span></summary>
                <p className="lp-muted mt-3 max-w-2xl text-[16px] leading-relaxed">{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- final ---------------- */}
      <section className="lp-hero lp-grain relative overflow-hidden px-5 py-28 text-center sm:px-8 sm:py-36">
        <div className="lp-hero-glow" />
        <h2 data-reveal className="lp-serif mx-auto max-w-4xl text-6xl leading-[.95] text-white sm:text-8xl">Your shop, <em className="lp-gold">in order.</em></h2>
        <p data-reveal style={{ ['--d' as string]: '80ms' }} className="mx-auto mt-6 max-w-md text-lg text-white/60">We set up your account, your branches and your first items with you.</p>
        <div data-reveal style={{ ['--d' as string]: '160ms' }} className="mt-10 flex flex-wrap justify-center gap-3"><GetStarted />{signIn}</div>
      </section>

      <footer className="border-t border-white/[.06] bg-[#05080f] px-5 py-10 sm:px-8">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-6 text-sm text-white/45 sm:flex-row">
          <Mark className="text-white/80" />
          <div className="flex flex-wrap items-center justify-center gap-6">
            <span className="flex items-center gap-2"><Clock className="h-4 w-4" />Support in Tamil & English</span>
            <span className="flex items-center gap-2"><Wallet className="h-4 w-4" />UPI · Cash · Card</span>
            <Link to="/login" className="hover:text-white">Sign in</Link>
          </div>
          <span>© {new Date().getFullYear()} BillPoodum</span>
        </div>
      </footer>
    </div>
  )
}
