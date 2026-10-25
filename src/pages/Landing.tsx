// Public landing page (/ when signed out, and /welcome). Positions Kadai Kalanjiyam as complete business management —
// billing is one part. Its own look (deep charcoal + mint), separate from the app screens. Everything shown here
// is something the product really does.
import clsx from 'clsx'
import {
  ArrowRight, BarChart3, Bell, Boxes, Check, ChefHat, CreditCard, FileSpreadsheet, Languages, LayoutDashboard, Lock,
  MessageCircle, MonitorSmartphone, NotebookPen, PackageOpen, QrCode, ReceiptText, Scissors, ShieldCheck, ShoppingCart,
  Store, Tag, TrendingUp, UserCheck, Users, UtensilsCrossed, Wallet, type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '@/app/AppContext'
import { LanguageToggle } from '@/i18n/LanguagePicker'
import './landing.css'
import { BRAND, BRAND_LOGO } from '@/core/brand'
import { SupportContacts } from '@/components/SupportLinks'

/** "Get started" opens WhatsApp when this is set (digits with country code, e.g. 919876543210); else sign-in. */
const CONTACT_WHATSAPP = (import.meta.env.VITE_CONTACT_WHATSAPP || BRAND.supportWhatsApp).replace(/\D/g, '')
const waLink = CONTACT_WHATSAPP ? `https://wa.me/${CONTACT_WHATSAPP}?text=${encodeURIComponent('Hi, I would like to know more about Kadai Kalanjiyam for my business.')}` : null

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
/** Scroll to a section (no #anchors: the app may use # for its own links). */
const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth' })
const D = (ms: number) => ({ ['--d' as string]: `${ms}ms` })

function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll('.lp [data-reveal]')
    if (!('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('is-in')); return }
    const io = new IntersectionObserver((list) => list.forEach((x) => { if (x.isIntersecting) { x.target.classList.add('is-in'); io.unobserve(x.target) } }), { rootMargin: '0px 0px -8% 0px' })
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
    const io = new IntersectionObserver(([x]) => { if (x.isIntersecting) { setSeen(true); io.disconnect() } }, { rootMargin: margin, threshold: 0.2 })
    io.observe(el)
    return () => io.disconnect()
  }, [seen, margin])
  return [ref, seen] as const
}

function GetStarted({ className, label = 'Get started' }: { className?: string; label?: string }) {
  const cls = clsx('lp-btn lp-btn-mint px-6 py-3 text-[15px]', className)
  return waLink
    ? <a href={waLink} target="_blank" rel="noreferrer" className={cls}><MessageCircle className="h-4 w-4" />{label}</a>
    : <Link to="/login" className={cls}>{label}<ArrowRight className="h-4 w-4" /></Link>
}

function Mark({ className }: { className?: string }) {
  return (
    <div className={clsx('flex items-center gap-2.5', className)}>
      <img src={BRAND_LOGO} alt="" className="h-9 w-9 rounded-xl shadow-[0_8px_24px_-8px_rgba(31,85,235,.9)]" draggable={false} />
      <span className="lp-display text-[17px] text-white" data-no-i18n>Kadai Kalanjiyam</span>
    </div>
  )
}

// ======================================================================= hero: the owner's dashboard

const WEEK: [string, number][] = [['Mon', 58], ['Tue', 64], ['Wed', 52], ['Thu', 71], ['Fri', 84], ['Sat', 96], ['Sun', 78]]

function HeroDashboard() {
  return (
    <div className="relative mx-auto max-w-5xl">
      <div className="lp-window overflow-hidden">
        <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" /><span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" /><span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
          <div className="mx-auto hidden rounded-md bg-white/5 px-10 py-1 text-[11px] text-white/40 sm:block">Dashboard · All branches</div>
        </div>
        <div className="grid grid-cols-12">
          <aside className="col-span-3 hidden border-r border-white/5 p-3 text-[13px] md:block lg:col-span-2">
            {([[LayoutDashboard, 'Dashboard'], [ReceiptText, 'Billing'], [Boxes, 'Inventory'], [Users, 'Customers'], [UserCheck, 'Staff'], [Wallet, 'Expenses'], [BarChart3, 'Reports']] as [LucideIcon, string][]).map(([I, l], k) => (
              <div key={l} className={clsx('mb-1 flex items-center gap-2.5 rounded-lg px-2.5 py-2', k === 0 ? 'bg-[#7ffaab]/10 text-[#7ffaab]' : 'text-white/45')}><I className="h-4 w-4" />{l}</div>
            ))}
          </aside>
          <main className="col-span-12 p-4 sm:p-6 md:col-span-9 lg:col-span-10">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[['Today’s sales', '₹48,250', '+12%'], ['Bills', '312', '+8%'], ['Expenses', '₹6,400', ''], ['Customer dues', '₹12,800', '']].map(([l, v, d]) => (
                <div key={l} className="rounded-2xl border border-white/5 bg-white/[.03] p-3.5 sm:p-4">
                  <div className="text-[11px] text-white/45 sm:text-xs">{l}</div>
                  <div className="lp-display mt-1.5 text-lg text-white sm:text-2xl">{v}</div>
                  {d && <div className="mt-1 flex items-center gap-1 text-[11px] text-[#7ffaab]"><TrendingUp className="h-3 w-3" />{d}</div>}
                </div>
              ))}
            </div>
            <div className="mt-4 grid gap-3 lg:grid-cols-3">
              <div className="rounded-2xl border border-white/5 bg-white/[.03] p-4 lg:col-span-2">
                <div className="flex items-center justify-between text-xs text-white/45"><span>Sales this week</span><span>₹5.0L</span></div>
                <div className="mt-4 flex h-32 items-end gap-2 sm:h-40 sm:gap-3">
                  {WEEK.map(([d, v], k) => (
                    <div key={d} className="flex h-full flex-1 flex-col items-center gap-2">
                      <div className="flex w-full flex-1 items-end"><div className="lp-bar w-full rounded-t-lg bg-gradient-to-t from-[#61ce70]/40 to-[#94f8af]" style={{ height: `${v}%`, ...D(300 + k * 70) }} /></div>
                      <span className="text-[10px] text-white/35">{d}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-2xl border border-white/5 bg-white/[.03] p-4">
                <div className="text-xs text-white/45">Branches today</div>
                {[['Anna Nagar', 62], ['T. Nagar', 48], ['Velachery', 31]].map(([n, p]) => (
                  <div key={n} className="mt-3.5">
                    <div className="flex justify-between text-[12px]"><span className="text-white/75">{n}</span><span className="text-white/45">{p}%</span></div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/5"><div className="h-full rounded-full bg-[#7ffaab]" style={{ width: `${p}%` }} /></div>
                  </div>
                ))}
              </div>
            </div>
          </main>
        </div>
      </div>
      {/* what's happening across the business, right now */}
      <div className="lp-chip lp-float absolute -left-3 top-[22%] hidden items-center gap-3 rounded-2xl px-4 py-3 xl:flex xl:-left-24">
        <span className="lp-icon lp-ping h-9 w-9 rounded-xl"><QrCode className="h-4 w-4" /></span>
        <div><div className="text-[13px] font-semibold text-white">New QR order</div><div className="text-[11px] text-white/50">Table 5 · ₹640</div></div>
      </div>
      <div className="lp-chip lp-float-2 absolute -right-3 top-[14%] hidden items-center gap-3 rounded-2xl px-4 py-3 xl:flex xl:-right-20">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-400/15 text-amber-300"><Bell className="h-4 w-4" /></span>
        <div><div className="text-[13px] font-semibold text-white">Low stock</div><div className="text-[11px] text-white/50">Milk 500 ml · 6 left</div></div>
      </div>
      <div className="lp-chip lp-float-2 absolute -left-3 bottom-[10%] hidden items-center gap-3 rounded-2xl px-4 py-3 xl:flex xl:-left-20">
        <span className="lp-icon h-9 w-9 rounded-xl"><UserCheck className="h-4 w-4" /></span>
        <div><div className="text-[13px] font-semibold text-white">Attendance</div><div className="text-[11px] text-white/50">12 of 14 present</div></div>
      </div>
      <div className="lp-chip lp-float absolute -right-3 bottom-[16%] hidden items-center gap-3 rounded-2xl px-4 py-3 xl:flex xl:-right-24">
        <span className="lp-icon h-9 w-9 rounded-xl"><Check className="h-4 w-4" /></span>
        <div><div className="text-[13px] font-semibold text-white">Payment received</div><div className="text-[11px] text-white/50">₹1,240 · UPI</div></div>
      </div>
    </div>
  )
}

// ======================================================================= the feature explorer

interface Module { key: string; icon: LucideIcon; tag: string; title: string; blurb: string; points: string[] }
const MODULES: Module[] = [
  { key: 'pos', icon: ReceiptText, tag: 'Sell', title: 'Billing & POS', blurb: 'Fast counter billing with barcode scan, sizes, add-ons, discounts and split payments — UPI, cash, card or credit.', points: ['Bill in a few taps — search, scan or tap the item', 'GST worked out per item, printed on 58 / 80 mm receipts', 'Returns, exchanges and credit notes', 'Edit running orders and settle them later'] },
  { key: 'serve', icon: UtensilsCrossed, tag: 'Serve', title: 'Tables, kitchen & QR orders', blurb: 'Run dine-in smoothly: table status, waiters taking orders on their phones, kitchen tickets on a screen and guests ordering by QR.', points: ['Every table at a glance — transfer and merge', 'Kitchen tickets (KOT) reach the kitchen screen instantly', 'QR menu for dine-in, takeaway and delivery', 'Today’s specials on a TV display'] },
  { key: 'stock', icon: Boxes, tag: 'Stock', title: 'Inventory & stock', blurb: 'Know exactly what you have in every branch. Stock goes down with every bill and up with every purchase.', points: ['Low-stock alerts before you run out', 'Batch & expiry — the earliest expiry is sold first', 'Barcode labels and bulk import from Excel / CSV', 'Wastage and adjustments, with full history'] },
  { key: 'people', icon: UserCheck, tag: 'People', title: 'Staff & payroll', blurb: 'Attendance, salary, advances and commission — and logins that show each person only what their role allows.', points: ['Daily attendance in one tap', 'Monthly salary with advances deducted', 'Commission for each staff member', 'Roles & permissions for every login'] },
  { key: 'money', icon: Wallet, tag: 'Money', title: 'Payments, credit & expenses', blurb: 'Every rupee in and out: payments, customer credit, collections and shop expenses — all in one place.', points: ['Customer credit and outstanding dues', 'Collect dues against old bills', 'Expenses by category — rent, purchase, salary…', 'Cash, UPI and card totals for the day'] },
  { key: 'grow', icon: MessageCircle, tag: 'Grow', title: 'Customers & WhatsApp', blurb: 'Turn walk-ins into regulars with customer history, special prices, and bills and offers on WhatsApp.', points: ['Customer profiles with purchase history', 'Send bills on WhatsApp', 'Offer campaigns with a poster from your menu', 'Wholesale price list for bulk buyers'] },
  { key: 'control', icon: BarChart3, tag: 'Control', title: 'Reports & multi-branch', blurb: 'See the whole business — one branch or all of them together — from your phone, wherever you are.', points: ['Sales, expense and product reports', 'Branch-by-branch comparison', 'Audit log of every change', 'Export all your data any time'] },
]
const MODULE_MS = 6500

function ModuleMock({ k }: { k: string }) {
  const row = 'flex items-center justify-between rounded-xl border border-white/5 bg-white/[.03] px-3.5 py-2.5 text-[13px]'
  switch (k) {
    case 'pos': return (
      <div className="grid gap-3 sm:grid-cols-5">
        <div className="grid grid-cols-2 gap-2.5 sm:col-span-3">
          {[['Filter Coffee', 25], ['Veg Puff', 22], ['Masala Dosa', 70], ['Rose Milk', 35]].map(([n, p], i) => (
            <div key={n} className="lp-swap rounded-xl border border-white/5 bg-white/[.04] p-3" style={D(i * 60)}>
              <div className="mb-5 h-7 w-7 rounded-lg bg-gradient-to-br from-[#7ffaab]/30 to-[#605be5]/30" />
              <div className="text-[12px] text-white/80" data-no-i18n>{n}</div><div className="text-[12px] font-semibold text-[#7ffaab]">₹{p}</div>
            </div>
          ))}
        </div>
        <div className="lp-swap rounded-xl border border-white/5 bg-white/[.04] p-3.5 sm:col-span-2" style={D(200)}>
          <div className="text-[11px] uppercase tracking-wider text-white/40">Bill · INV-10482</div>
          {[['Filter Coffee ×2', 50], ['Masala Dosa', 70], ['GST 5%', 6]].map(([n, p]) => <div key={n} className="mt-2 flex justify-between text-[12px] text-white/70"><span data-no-i18n>{n}</span><span>₹{p}</span></div>)}
          <div className="mt-3 flex justify-between border-t border-white/10 pt-2 text-sm font-semibold text-white"><span>Total</span><span>₹126</span></div>
          <div className="mt-3 grid grid-cols-3 gap-1.5 text-center text-[11px]">{['UPI', 'Cash', 'Card'].map((m, i) => <span key={m} className={clsx('rounded-lg py-1.5', i === 0 ? 'bg-[#7ffaab] text-[#07130b]' : 'bg-white/5 text-white/60')}>{m}</span>)}</div>
        </div>
      </div>
    )
    case 'serve': return (
      <div className="grid gap-3 sm:grid-cols-5">
        <div className="grid grid-cols-4 gap-2 sm:col-span-3">
          {(['busy', 'free', 'bill', 'busy', 'free', 'busy', 'free', 'bill'] as const).map((st, i) => (
            <div key={i} className={clsx('lp-swap flex aspect-square flex-col items-center justify-center rounded-xl border text-[12px] font-semibold', st === 'free' ? 'border-white/10 text-white/50' : st === 'busy' ? 'border-[#7ffaab]/40 bg-[#7ffaab]/10 text-[#7ffaab]' : 'border-amber-300/40 bg-amber-300/10 text-amber-200')} style={D(i * 45)}>
              T{i + 1}<span className="mt-0.5 text-[9px] font-normal opacity-70">{st === 'free' ? 'Free' : st === 'busy' ? 'Running' : 'Bill'}</span>
            </div>
          ))}
        </div>
        <div className="lp-swap rounded-xl border border-white/5 bg-white/[.04] p-3.5 sm:col-span-2" style={D(250)}>
          <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-white/40"><span>KOT-0042</span><span className="text-[#7ffaab]">New</span></div>
          <div className="mt-1 text-[12px] text-white/50">Table 4 · Dine in</div>
          {['2 × Veg Meals', '1 × Paneer Butter Masala', '3 × Butter Naan'].map((x) => <div key={x} className="mt-2 text-[13px] text-white/85" data-no-i18n>{x}</div>)}
          <div className="mt-3 rounded-lg bg-[#7ffaab]/10 py-1.5 text-center text-[11px] text-[#7ffaab]">Start preparing</div>
        </div>
      </div>
    )
    case 'stock': return (
      <div className="space-y-2">
        {[['Aavin Milk 500 ml', 6, 'low', 'Exp 14 Oct'], ['Ponni Rice 5 kg', 84, 'ok', ''], ['Sunflower Oil 1 L', 23, 'ok', 'Exp 02 Mar'], ['Brown Bread', 4, 'low', 'Exp 13 Oct'], ['Toor Dal 1 kg', 41, 'ok', '']].map(([n, q, st, ex], i) => (
          <div key={n as string} className={clsx(row, 'lp-swap')} style={D(i * 55)}>
            <span className="text-white/80" data-no-i18n>{n}</span>
            <span className="flex items-center gap-2">
              {ex && <span className="hidden rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-white/50 sm:inline" data-no-i18n>{ex}</span>}
              <span className={clsx('rounded-full px-2.5 py-0.5 text-[11px] font-semibold', st === 'low' ? 'bg-amber-300/15 text-amber-200' : 'bg-[#7ffaab]/10 text-[#7ffaab]')}>{q as number} left</span>
            </span>
          </div>
        ))}
      </div>
    )
    case 'people': return (
      <div className="space-y-2">
        {[['Priya', 'Stylist', true, '₹18,000'], ['Kumar', 'Cashier', true, '₹15,500'], ['Anitha', 'Kitchen', false, '₹14,000'], ['Ravi', 'Waiter', true, '₹12,000']].map(([n, r, p, s], i) => (
          <div key={n as string} className={clsx(row, 'lp-swap')} style={D(i * 55)}>
            <span className="flex items-center gap-3"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/5 text-[12px] font-semibold text-white/80" data-no-i18n>{(n as string)[0]}</span><span><span className="block text-white/85" data-no-i18n>{n}</span><span className="text-[11px] text-white/40">{r}</span></span></span>
            <span className="flex items-center gap-3"><span className="hidden text-[12px] text-white/50 sm:inline">{s as string}</span><span className={clsx('rounded-full px-2.5 py-0.5 text-[11px] font-semibold', p ? 'bg-[#7ffaab]/10 text-[#7ffaab]' : 'bg-white/5 text-white/40')}>{p ? 'Present' : 'Leave'}</span></span>
          </div>
        ))}
      </div>
    )
    case 'money': return (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="lp-swap rounded-xl border border-white/5 bg-white/[.04] p-4">
          <div className="text-[11px] uppercase tracking-wider text-white/40">Collected today</div>
          {[['UPI', 62, '₹29,900'], ['Cash', 28, '₹13,500'], ['Card', 10, '₹4,850']].map(([m, p, v]) => (
            <div key={m as string} className="mt-3">
              <div className="flex justify-between text-[12px]"><span className="text-white/75">{m}</span><span className="text-white/50">{v}</span></div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/5"><div className="h-full rounded-full bg-[#7ffaab]" style={{ width: `${p}%` }} /></div>
            </div>
          ))}
        </div>
        <div className="lp-swap rounded-xl border border-white/5 bg-white/[.04] p-4" style={D(150)}>
          <div className="text-[11px] uppercase tracking-wider text-white/40">Dues to collect</div>
          {[['Raja Stores', '₹4,200'], ['Meena', '₹1,150'], ['Hotel Saravana', '₹7,450']].map(([n, v]) => <div key={n} className="mt-2.5 flex justify-between text-[13px]"><span className="text-white/80" data-no-i18n>{n}</span><span className="font-semibold text-amber-200">{v}</span></div>)}
          <div className="mt-3 rounded-lg bg-white/5 py-1.5 text-center text-[11px] text-white/60">Collect due</div>
        </div>
      </div>
    )
    case 'grow': return (
      <div className="mx-auto max-w-sm rounded-2xl border border-white/5 bg-[#0b141a] p-3">
        <div className="flex items-center gap-2 border-b border-white/5 pb-2.5"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#25d366] text-white"><MessageCircle className="h-4 w-4" /></span><span className="text-[13px] font-semibold text-white" data-no-i18n>Murugan Tea Stall</span></div>
        <div className="lp-swap mt-3 rounded-xl rounded-tl-sm bg-[#1f2c34] p-2.5">
          <div className="flex h-24 items-center justify-center rounded-lg bg-gradient-to-br from-[#61ce70]/50 to-[#605be5]/40 text-center">
            <span className="lp-display text-lg text-white">Evening offer<br /><span className="text-sm font-normal text-white/80">Samosa + Tea ₹30</span></span>
          </div>
          <div className="mt-2 text-[12px] text-white/80">Hi Meena! Today’s evening offer — see you at the shop 🙂</div>
          <div className="mt-1 text-right text-[10px] text-white/40">5:30 PM ✓✓</div>
        </div>
        <div className="lp-swap mt-2 ml-auto w-fit rounded-xl rounded-tr-sm bg-[#005c4b] px-3 py-2 text-[12px] text-white/90" style={D(250)}>Bill INV-10482 · ₹126 · Thank you!</div>
      </div>
    )
    default: return (
      <div className="grid gap-3 sm:grid-cols-3">
        {[['Sales', '₹14.2L'], ['Expenses', '₹2.1L'], ['Bills', '9,840']].map(([l, v], i) => (
          <div key={l} className="lp-swap rounded-xl border border-white/5 bg-white/[.04] p-3.5" style={D(i * 70)}><div className="text-[11px] text-white/40">{l} · this month</div><div className="lp-display mt-1 text-xl text-white">{v}</div></div>
        ))}
        <div className="lp-swap rounded-xl border border-white/5 bg-white/[.04] p-4 sm:col-span-3" style={D(220)}>
          <div className="text-[11px] text-white/40">Branch-wise sales</div>
          <div className="mt-3 flex h-24 items-end gap-3">
            {[70, 52, 88, 40, 64, 76].map((v, i) => <div key={i} className="lp-bar flex-1 rounded-t-md bg-gradient-to-t from-[#605be5]/50 to-[#7ffaab]" style={{ height: `${v}%`, ...D(300 + i * 60) }} />)}
          </div>
        </div>
      </div>
    )
  }
}

function FeatureExplorer() {
  const [i, setI] = useState(0)
  const [auto, setAuto] = useState(true)
  const [ref, seen] = useInView<HTMLDivElement>('0px 0px -25% 0px')
  useEffect(() => {
    if (!auto || !seen || reduced()) return
    const id = setTimeout(() => setI((x) => (x + 1) % MODULES.length), MODULE_MS)
    return () => clearTimeout(id)
  }, [i, auto, seen])
  const m = MODULES[i]
  return (
    <div ref={ref} className="grid gap-6 lg:grid-cols-[minmax(0,.9fr)_minmax(0,1.4fr)]">
      <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar lg:flex-col lg:overflow-visible">
        {MODULES.map((x, k) => (
          <button key={x.key} type="button" onClick={() => { setI(k); setAuto(false) }}
            className={clsx('lp-tab relative flex shrink-0 items-center gap-3.5 overflow-hidden rounded-2xl border border-transparent px-4 py-3 text-left lg:py-3.5', k === i && 'is-on')}>
            <span className={clsx('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border', k === i ? 'border-[#7ffaab]/40 bg-[#7ffaab]/15 text-[#7ffaab]' : 'border-white/10 bg-white/[.03] text-white/50')}><x.icon className="h-[18px] w-[18px]" /></span>
            <span>
              <span className="block text-[11px] font-semibold uppercase tracking-[.16em] text-white/35">{x.tag}</span>
              <span className="lp-tab-title block whitespace-nowrap text-[15px] font-semibold text-white/65">{x.title}</span>
            </span>
            {k === i && auto && seen && <span key={`p${i}`} className="lp-progress absolute bottom-0 left-0 h-0.5 w-full bg-[#7ffaab]/70" style={{ animationDuration: `${MODULE_MS}ms` }} />}
          </button>
        ))}
      </div>
      <div className="lp-card p-6 sm:p-8" key={m.key}>
        <div className="lp-swap flex items-center gap-3"><span className="lp-icon h-11 w-11"><m.icon className="h-5 w-5" /></span><h3 className="lp-display text-2xl text-white sm:text-3xl">{m.title}</h3></div>
        <p className="lp-swap lp-muted mt-4 max-w-2xl text-[16px] leading-relaxed" style={D(60)}>{m.blurb}</p>
        <ul className="mt-5 grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
          {m.points.map((p, k) => (
            <li key={p} className="lp-swap flex items-start gap-2.5 text-[14px] text-white/80" style={D(100 + k * 50)}>
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#7ffaab]/15 text-[#7ffaab]"><Check className="h-3 w-3" /></span>{p}
            </li>
          ))}
        </ul>
        <div className="mt-7 rounded-2xl border border-white/5 bg-black/20 p-4 sm:p-5"><ModuleMock k={m.key} /></div>
      </div>
    </div>
  )
}

// ======================================================================= one app, four shapes

interface Shape { key: string; label: string; sub: string; icon: LucideIcon; nav: [LucideIcon, string][]; terms: [string, string][] }
const SHAPES: Shape[] = [
  { key: 'retail', label: 'Retail', sub: 'Supermarket · Silk & textiles · Hardware · Electronics', icon: ShoppingCart,
    nav: [[ReceiptText, 'Billing'], [PackageOpen, 'Customer Orders'], [Tag, 'Products'], [Boxes, 'Inventory'], [Users, 'Customers'], [BarChart3, 'Reports']],
    terms: [['Items called', 'Products'], ['Buyers called', 'Customers'], ['Extras', 'QR price stickers, batches & expiry, wholesale prices']] },
  { key: 'food', label: 'Food', sub: 'Tea shop · Bakery · Fast food · Juice', icon: ChefHat,
    nav: [[ReceiptText, 'Billing'], [ChefHat, 'Kitchen (KOT)'], [Tag, 'Menu Items'], [QrCode, 'QR Orders'], [Users, 'Customers'], [BarChart3, 'Reports']],
    terms: [['Items called', 'Menu Items'], ['Buyers called', 'Customers'], ['Extras', 'Kitchen tickets, today’s specials, QR menu']] },
  { key: 'restaurant', label: 'Restaurant', sub: 'Hotel · Cafe · Dine-in · Cloud kitchen', icon: UtensilsCrossed,
    nav: [[UtensilsCrossed, 'Tables'], [NotebookPen, 'Take Order'], [ChefHat, 'Kitchen (KOT)'], [Tag, 'Menu Items'], [Users, 'Guests'], [BarChart3, 'Reports']],
    terms: [['Items called', 'Menu Items'], ['Buyers called', 'Guests'], ['Extras', 'Tables, waiter phones, QR at the table']] },
  { key: 'service', label: 'Service', sub: 'Salon · Spa · Laundry · Repair', icon: Scissors,
    nav: [[ReceiptText, 'Billing'], [Tag, 'Services'], [Users, 'Clients'], [UserCheck, 'Staff'], [CreditCard, 'Payments'], [BarChart3, 'Reports']],
    terms: [['Items called', 'Services'], ['Buyers called', 'Clients'], ['Extras', 'Staff commission, client history, dues']] },
]
const SHAPE_MS = 5000

function ShapeShifter() {
  const [i, setI] = useState(0)
  const [auto, setAuto] = useState(true)
  const [ref, seen] = useInView<HTMLDivElement>('0px 0px -20% 0px')
  useEffect(() => {
    if (!auto || !seen || reduced()) return
    const id = setTimeout(() => setI((x) => (x + 1) % SHAPES.length), SHAPE_MS)
    return () => clearTimeout(id)
  }, [i, auto, seen])
  const s = SHAPES[i]
  return (
    <div ref={ref} className="grid items-center gap-10 lg:grid-cols-2">
      <div>
        <div className="relative grid w-full max-w-lg grid-cols-4 rounded-2xl border border-white/10 bg-white/[.03] p-1.5">
          <span className="lp-seg-ind absolute bottom-1.5 left-1.5 top-1.5 w-[calc((100%-12px)/4)] rounded-xl bg-[#7ffaab]" style={{ transform: `translateX(${i * 100}%)` }} />
          {SHAPES.map((x, k) => (
            <button key={x.key} type="button" onClick={() => { setI(k); setAuto(false) }}
              className={clsx('relative z-10 flex items-center justify-center gap-1.5 rounded-xl px-1 py-2.5 text-xs font-semibold transition-colors sm:text-sm', k === i ? 'text-[#07130b]' : 'text-white/60 hover:text-white')}>
              <x.icon className="hidden h-4 w-4 min-[400px]:block" />{x.label}
            </button>
          ))}
        </div>
        <p className="lp-muted mt-4 text-sm" key={`s${s.key}`}><span className="lp-swap inline-block">{s.sub}</span></p>
        <dl className="mt-6 space-y-3" key={`t${s.key}`}>
          {s.terms.map(([a, b], k) => (
            <div key={a} className="lp-swap flex gap-4 border-b border-white/5 pb-3" style={D(k * 70)}>
              <dt className="w-32 shrink-0 text-sm text-white/40">{a}</dt><dd className="text-[15px] font-medium text-white/90">{b}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="lp-window mx-auto w-full max-w-md overflow-hidden" key={`w${s.key}`}>
        <div className="flex items-center gap-2 border-b border-white/5 bg-white/[.02] px-4 py-3 text-sm font-semibold text-white"><Store className="h-4 w-4 text-[#7ffaab]" />Main branch</div>
        <div className="p-3">
          {s.nav.map(([I, l], k) => (
            <div key={l} className={clsx('lp-swap mb-1 flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px]', k === 0 ? 'bg-[#7ffaab]/10 text-[#7ffaab]' : 'text-white/60')} style={D(k * 50)}>
              <I className="h-[18px] w-[18px]" />{l}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ======================================================================= a day in the business

const DAY: { time: string; title: string; body: string; icon: LucideIcon }[] = [
  { time: '06:30', title: 'Open the shop.', body: 'Open Kadai Kalanjiyam on the counter PC, a tablet or your phone. Pick your branch — yesterday’s numbers and today’s attendance are ready.', icon: Store },
  { time: '09:15', title: 'The morning rush.', body: 'Every counter bills at the same time. Each bill gets its own number, stock goes down item by item, and UPI, cash and card are counted correctly.', icon: ReceiptText },
  { time: '13:00', title: 'Kitchen and tables in sync.', body: 'Orders reach the kitchen screen as tickets. Guests order from the QR code on their table; waiters take orders on their phones.', icon: ChefHat },
  { time: '16:00', title: 'Restock and pay.', body: 'Low-stock items show up before they run out. Record purchases and expenses, collect customer dues, give a staff advance.', icon: Boxes },
  { time: '17:30', title: 'Bring customers back.', body: 'Send today’s offer to your regular customers on WhatsApp — with a poster made from your own menu.', icon: MessageCircle },
  { time: '22:00', title: 'Close with clarity.', body: 'Sales, expenses, salary and dues in one report — for every branch, from home.', icon: BarChart3 },
]

function DayTimeline() {
  const [active, setActive] = useState(0)
  const refs = useRef<(HTMLDivElement | null)[]>([])
  // The card nearest the middle of the screen is the current moment (also when the middle is between cards).
  useEffect(() => {
    const pick = () => {
      const mid = window.innerHeight / 2
      let best = 0, dist = Infinity
      refs.current.forEach((r, k) => {
        if (!r) return
        const b = r.getBoundingClientRect()
        const d = Math.abs(b.top + b.height / 2 - mid)
        if (d < dist) { dist = d; best = k }
      })
      setActive(best)
    }
    pick()
    window.addEventListener('scroll', pick, { passive: true })
    window.addEventListener('resize', pick)
    return () => { window.removeEventListener('scroll', pick); window.removeEventListener('resize', pick) }
  }, [])
  const [h, m] = DAY[active].time.split(':').map(Number)
  const hourDeg = (h % 12) * 30 + m * 0.5, minDeg = m * 6
  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="lg:sticky lg:top-32 lg:h-[64vh]">
        <div className="flex items-center gap-8 lg:flex-col lg:items-start">
          <svg viewBox="0 0 200 200" className="h-28 w-28 shrink-0 sm:h-40 sm:w-40 lg:h-56 lg:w-56" aria-hidden>
            <circle cx="100" cy="100" r="92" fill="rgba(127,250,171,.03)" stroke="rgba(255,255,255,.12)" strokeWidth="2" />
            {Array.from({ length: 12 }, (_, k) => <line key={k} x1="100" y1="14" x2="100" y2={k % 3 ? 22 : 28} stroke="rgba(255,255,255,.4)" strokeWidth={k % 3 ? 1.5 : 3} strokeLinecap="round" transform={`rotate(${k * 30} 100 100)`} />)}
            <line className="lp-hand" x1="100" y1="100" x2="100" y2="52" stroke="#fff" strokeWidth="5" strokeLinecap="round" style={{ transform: `rotate(${hourDeg}deg)` }} />
            <line className="lp-hand" x1="100" y1="100" x2="100" y2="30" stroke="#7ffaab" strokeWidth="3" strokeLinecap="round" style={{ transform: `rotate(${minDeg}deg)` }} />
            <circle cx="100" cy="100" r="6" fill="#7ffaab" />
          </svg>
          <div>
            <div className="lp-display text-6xl leading-none text-white sm:text-7xl" data-no-i18n key={DAY[active].time}><span className="lp-swap inline-block">{DAY[active].time}</span></div>
            <div className="mt-3 text-sm uppercase tracking-[.25em] text-white/45">A day in your business</div>
          </div>
        </div>
      </div>
      <div className="space-y-5 lg:space-y-[18vh] lg:py-[14vh]">
        {DAY.map((d, k) => (
          <div key={d.time} ref={(el) => { refs.current[k] = el }} data-i={k} className={clsx('lp-step lp-card p-7 sm:p-8', k === active && 'is-active')}>
            <div className="flex items-center gap-3 text-[#7ffaab]"><d.icon className="h-5 w-5" /><span className="lp-mono text-sm" data-no-i18n>{d.time}</span></div>
            <h3 className="lp-display mt-4 text-2xl text-white sm:text-3xl">{d.title}</h3>
            <p className="lp-muted mt-3 max-w-lg text-[16px] leading-relaxed">{d.body}</p>
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
        <div className="text-sm font-semibold uppercase tracking-[.2em] text-[#7ffaab]">Built for the rush</div>
        <h2 className="lp-display mt-4 text-4xl leading-[1.1] text-white sm:text-5xl">Twenty counters. One second. Zero mix-ups.</h2>
        <p className="lp-muted mt-6 max-w-lg text-lg leading-relaxed">When every counter presses Pay at once, each bill is saved completely or not at all — its own number, the exact stock, the right payment. Nothing is half-saved, nothing is counted twice.</p>
      </div>
      <div>
        <div className="grid grid-cols-4 gap-2 sm:gap-2.5 xl:grid-cols-5">
          {done.map((d, i) => (
            <div key={i} className={clsx('lp-counter rounded-xl border border-white/10 bg-white/[.03] p-2.5 sm:p-3', d && 'is-done')}>
              <div className="whitespace-nowrap text-[9px] uppercase tracking-wider text-white/40 sm:text-[10px]">Counter {String(i + 1).padStart(2, '0')}</div>
              <div className="lp-mono mt-2 h-4 text-[11px] text-[#7ffaab] sm:text-xs" data-no-i18n>{d ? <span className="lp-counter-num inline-block">INV-{plan.num[i]}</span> : <span className="text-white/25">· · ·</span>}</div>
            </div>
          ))}
        </div>
        <div className={clsx('mt-5 flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm transition-all duration-500', all ? 'border-[#7ffaab]/40 bg-[#7ffaab]/10 text-[#bae8b7]' : 'border-white/10 text-white/40')}>
          <ShieldCheck className="h-5 w-5 shrink-0" />{all ? '20 bills saved · 20 different numbers · stock exact' : 'Saving…'}
        </div>
      </div>
    </div>
  )
}

// ======================================================================= page

const KINDS = ['Tea shops', 'Supermarkets', 'Silk & saree shops', 'Bakeries', 'Restaurants', 'Textiles & garments', 'Salons', 'Hardware stores', 'Juice shops', 'Cafes', 'Sweet stalls', 'Laundries', 'Grocery stores', 'Cloud kitchens', 'Stationery', 'Spas', 'Dhabas', 'Electronics']

const UNLIMITED: [LucideIcon, string, string][] = [
  [ReceiptText, 'Unlimited bills', 'Every bill, every day, on every counter — no monthly bill count.'],
  [Users, 'Unlimited users', 'A login for every owner, manager, cashier, waiter and kitchen staff.'],
  [UserCheck, 'Unlimited customers', 'Save every customer with their history, credit and dues.'],
  [Tag, 'Unlimited products', 'Your full catalogue or menu — with sizes, add-ons and prices.'],
  [MonitorSmartphone, 'Unlimited devices', 'Counter PCs, tablets and phones — sign in on as many as you need.'],
]

const TRUST: [LucideIcon, string, string][] = [
  [Lock, 'Your data, kept private', 'Every business gets its own private database. Only you and the staff you add can sign in.'],
  [Store, 'One branch or many', 'Each branch has its own bill numbers, stock and printer — and you see all of them together.'],
  [Users, 'The right access for each person', 'Owner, manager, cashier, waiter, kitchen — every login shows only what that role needs.'],
  [MonitorSmartphone, 'Any device', 'Counter PC, tablet or phone — in the browser, nothing to install. Add it to the home screen like an app.'],
  [Languages, 'Tamil & English', 'Every screen in Tamil or English, chosen by each person on their own device.'],
  [FileSpreadsheet, 'Your data is yours', 'Import products from Excel / CSV, and export everything any time.'],
]

const FAQ: [string, string][] = [
  ['Is it only for billing?', 'No. Billing is one part. Kadai Kalanjiyam also runs your stock, kitchen and tables, staff and salary, customer credit, expenses and reports — for every branch.'],
  ['Is there a limit on bills, users or customers?', 'No. Bills, users, customers, products and devices are all unlimited. Only the number of branches is set for your account, and you can add more when you open a new one.'],
  ['Which businesses can use it?', 'Retail shops and supermarkets, tea shops and bakeries, restaurants and hotels, salons and other services. The screens and words change to fit the type of business you choose.'],
  ['Do I need the internet?', 'Yes. Everything is saved online the moment you press Save, so all your counters and your own phone always see the same numbers — and nothing is lost if a device breaks.'],
  ['Is my business data kept separate?', 'Yes. Every business gets its own private database. Only you and the staff you add can sign in, each with the permissions you choose.'],
  ['Which printers work?', 'Common 58 mm and 80 mm thermal receipt printers — through the browser, USB, serial or Bluetooth — set separately for each branch.'],
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
  useEffect(() => { document.title = 'Kadai Kalanjiyam — Complete business management for every shop' }, [])
  const onMove = (e: React.PointerEvent) => {
    const el = hero.current
    if (!el || e.pointerType !== 'mouse') return
    const r = el.getBoundingClientRect()
    el.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`)
    el.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`)
  }
  const signIn = me
    ? <Link to="/dashboard" className="lp-btn lp-btn-line whitespace-nowrap px-5 py-2.5 text-sm">Open the app<ArrowRight className="h-4 w-4" /></Link>
    : <Link to="/login" className="lp-btn lp-btn-line whitespace-nowrap px-5 py-2.5 text-sm">Sign in</Link>

  return (
    <div className="lp min-h-[100dvh]">
      {/* ---------------- nav ---------------- */}
      <header className="fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-6 sm:pt-4">
        <div className={clsx('lp-nav-pill mx-auto flex max-w-7xl items-center justify-between gap-4 rounded-2xl px-4 py-3 sm:px-6', stuck && 'is-stuck')}>
          <Mark />
          <nav className="hidden items-center gap-7 whitespace-nowrap text-sm text-white/70 lg:flex [html[lang=ta]_&]:hidden [html[lang=ta]_&]:xl:flex">
            <button type="button" onClick={() => jump('features')} className="hover:text-white">Features</button>
            <button type="button" onClick={() => jump('business')} className="hover:text-white">Business types</button>
            <button type="button" onClick={() => jump('day')} className="hover:text-white">How it works</button>
            <button type="button" onClick={() => jump('faq')} className="hover:text-white">FAQ</button>
          </nav>
          <div className="flex items-center gap-3">
            <LanguageToggle className="hidden !border-white/10 !bg-white/5 sm:inline-flex [&_button.bg-brand-600]:!bg-[#7ffaab] [&_button.bg-brand-600]:!text-[#07130b] [&_button:not(.bg-brand-600)]:!text-white/70 [&_button:not(.bg-brand-600)]:hover:!bg-white/10" />
            {signIn}
          </div>
        </div>
      </header>

      {/* ---------------- hero ---------------- */}
      <section ref={hero} onPointerMove={onMove} className="lp-hero lp-grain relative overflow-hidden px-5 pb-20 pt-36 text-center sm:px-8 sm:pt-44">
        <div className="lp-aurora" aria-hidden><span /><span /><span /></div>
        <div className="lp-gridlines" aria-hidden /><div className="lp-spot" aria-hidden />
        <div className="lp-rise mx-auto inline-flex items-center gap-2 rounded-full border border-[#7ffaab]/25 bg-[#7ffaab]/[.06] px-4 py-1.5 text-xs font-semibold uppercase tracking-[.18em] text-[#bae8b7]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#7ffaab] shadow-[0_0_10px_#7ffaab]" />Complete business management
        </div>
        <h1 className="lp-display lp-rise mx-auto mt-7 max-w-5xl text-[42px] leading-[1.08] text-white sm:text-6xl lg:text-7xl" style={D(80)}>
          Run your whole business<br /><span className="lp-mint-text">from one app.</span>
        </h1>
        <p className="lp-rise lp-muted mx-auto mt-7 max-w-2xl text-lg leading-relaxed sm:text-xl" style={D(160)}>
          Billing, stock, kitchen, tables, staff, customers, expenses and reports — for every branch, in Tamil or English. Made for Indian shops, restaurants and services.
        </p>
        <div className="lp-rise mt-10 flex flex-wrap justify-center gap-3" style={D(240)}>
          <GetStarted />
          <button type="button" onClick={() => jump('features')} className="lp-btn lp-btn-line px-6 py-3 text-[15px]">Explore features</button>
        </div>
        <div className="lp-rise mt-8 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-white/60" style={D(300)}>
          {['Unlimited bills', 'Unlimited users', 'Unlimited customers'].map((x) => <span key={x} className="flex items-center gap-2"><Check className="h-4 w-4 text-[#7ffaab]" />{x}</span>)}
        </div>
        <div className="lp-rise mt-14 sm:mt-16" style={D(340)}><HeroDashboard /></div>
      </section>

      {/* ---------------- business types marquee ---------------- */}
      <section className="border-y border-white/[.06] bg-[#0f0e12] py-6" data-no-i18n>
        <div className="lp-marquee overflow-hidden">
          <div className="lp-marquee-track flex gap-10 whitespace-nowrap">
            {[...KINDS, ...KINDS].map((k, i) => (
              <span key={i} className="lp-display flex items-center gap-10 text-2xl font-medium text-white/30">{k}<span className="text-base text-[#7ffaab]/50">✦</span></span>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- features ---------------- */}
      <section id="features" className="scroll-mt-24 px-5 py-24 sm:px-8 sm:py-32">
        <div className="mx-auto max-w-7xl">
          <div className="mx-auto mb-14 max-w-3xl text-center">
            <div data-reveal className="text-sm font-semibold uppercase tracking-[.2em] text-[#7ffaab]">Features</div>
            <h2 data-reveal style={D(80)} className="lp-display mt-4 text-4xl leading-[1.1] text-white sm:text-5xl">Everything your business runs on.</h2>
            <p data-reveal style={D(160)} className="lp-muted mx-auto mt-5 max-w-2xl text-lg leading-relaxed">Not just the bill. Seven parts that work together — what you sell, what you stock, who works for you and where the money goes.</p>
          </div>
          <div data-reveal style={D(200)}><FeatureExplorer /></div>
        </div>
      </section>

      {/* ---------------- no limits ---------------- */}
      <section className="lp-grain relative overflow-hidden border-t border-white/[.06] px-5 py-24 sm:px-8 sm:py-28">
        <div className="lp-aurora opacity-50" aria-hidden><span /><span /><span /></div>
        <div className="mx-auto max-w-7xl">
          <div className="mx-auto mb-14 max-w-3xl text-center">
            <div data-reveal className="text-sm font-semibold uppercase tracking-[.2em] text-[#7ffaab]">No limits</div>
            <h2 data-reveal style={D(80)} className="lp-display mt-4 text-4xl leading-[1.1] text-white sm:text-5xl">Grow as much as you want. <span className="lp-mint-text">We don’t count.</span></h2>
            <p data-reveal style={D(160)} className="lp-muted mx-auto mt-5 max-w-2xl text-lg leading-relaxed">No caps on the work you do every day. Bill all day, add every staff member, save every customer — the app never asks you to stop or upgrade.</p>
          </div>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            {UNLIMITED.map(([I, t, b], k) => (
              <div key={t} data-reveal style={D(k * 70)} className={clsx('lp-card lp-card-hover relative overflow-hidden p-6 text-center', k === UNLIMITED.length - 1 && 'col-span-2 lg:col-span-1')}>
                <div className="lp-display lp-mint-text text-6xl leading-none" aria-hidden>∞</div>
                <span className="lp-icon mx-auto mt-5 h-10 w-10"><I className="h-[18px] w-[18px]" /></span>
                <h3 className="lp-display mt-4 text-lg text-white">{t}</h3>
                <p className="lp-muted mt-2 text-[14px] leading-relaxed">{b}</p>
              </div>
            ))}
          </div>
          <p data-reveal className="mt-8 text-center text-sm text-white/40">Branches are set up for your account — add more whenever you open a new one.</p>
        </div>
      </section>

      {/* ---------------- business types ---------------- */}
      <section id="business" className="lp-grain relative scroll-mt-24 border-t border-white/[.06] bg-[#0f0e12] px-5 py-24 sm:px-8 sm:py-32">
        <div className="mx-auto max-w-7xl">
          <div className="mb-14 max-w-2xl">
            <div data-reveal className="text-sm font-semibold uppercase tracking-[.2em] text-[#7ffaab]">One app · four shapes</div>
            <h2 data-reveal style={D(80)} className="lp-display mt-4 text-4xl leading-[1.1] text-white sm:text-5xl">It speaks your business’s language.</h2>
            <p data-reveal style={D(160)} className="lp-muted mt-5 text-lg leading-relaxed">Choose what you run. The menus, the words and the features change to fit — Menu Items for a café, Clients for a salon, Tables for a restaurant.</p>
          </div>
          <div data-reveal style={D(200)}><ShapeShifter /></div>
        </div>
      </section>

      {/* ---------------- a day ---------------- */}
      <section id="day" className="scroll-mt-24 px-5 py-24 sm:px-8 sm:py-32">
        <div className="mx-auto max-w-7xl">
          <div className="mb-16 max-w-2xl">
            <div data-reveal className="text-sm font-semibold uppercase tracking-[.2em] text-[#7ffaab]">How it works</div>
            <h2 data-reveal style={D(80)} className="lp-display mt-4 text-4xl leading-[1.1] text-white sm:text-5xl">From opening the shutter to closing the day.</h2>
          </div>
          <DayTimeline />
        </div>
      </section>

      {/* ---------------- rush ---------------- */}
      <section className="border-t border-white/[.06] bg-[#0f0e12] px-5 py-24 sm:px-8 sm:py-28">
        <div className="mx-auto max-w-7xl"><Rush /></div>
      </section>

      {/* ---------------- trust ---------------- */}
      <section className="px-5 py-24 sm:px-8 sm:py-32">
        <div className="mx-auto max-w-7xl">
          <div className="mx-auto mb-14 max-w-2xl text-center">
            <div data-reveal className="text-sm font-semibold uppercase tracking-[.2em] text-[#7ffaab]">Made for how you work</div>
            <h2 data-reveal style={D(80)} className="lp-display mt-4 text-4xl leading-[1.1] text-white sm:text-5xl">Simple for the counter. Complete for the owner.</h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {TRUST.map(([I, t, b], k) => (
              <div key={t} data-reveal style={D(k * 60)} className="lp-card lp-card-hover p-7">
                <span className="lp-icon h-12 w-12"><I className="h-5 w-5" /></span>
                <h3 className="lp-display mt-5 text-xl text-white">{t}</h3>
                <p className="lp-muted mt-2.5 text-[15px] leading-relaxed">{b}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- faq ---------------- */}
      <section id="faq" className="scroll-mt-24 border-t border-white/[.06] bg-[#0f0e12] px-5 py-24 sm:px-8 sm:py-28">
        <div className="mx-auto max-w-3xl">
          <h2 data-reveal className="lp-display text-center text-4xl text-white sm:text-5xl">Questions, answered.</h2>
          <div className="mt-12 space-y-3">
            {FAQ.map(([q, a], k) => (
              <details key={q} className="lp-faq lp-card px-6 py-5" data-reveal style={D(k * 50)}>
                <summary className="flex items-center justify-between gap-6 text-[17px] font-semibold text-white">{q}<span className="lp-faq-plus flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/15 text-xl font-light text-white/80">+</span></summary>
                <p className="lp-muted mt-3 max-w-2xl text-[15px] leading-relaxed">{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- final ---------------- */}
      <section className="lp-grain relative overflow-hidden px-5 py-28 text-center sm:px-8 sm:py-36">
        <div className="lp-aurora" aria-hidden><span /><span /><span /></div>
        <h2 data-reveal className="lp-display mx-auto max-w-4xl text-4xl leading-[1.1] text-white sm:text-6xl">Your whole business, <span className="lp-mint-text">in one place.</span></h2>
        <p data-reveal style={D(80)} className="lp-muted mx-auto mt-6 max-w-lg text-lg">We set up your account, your branches and your first items with you.</p>
        <div data-reveal style={D(160)} className="mt-10 flex flex-wrap justify-center gap-3"><GetStarted />{signIn}</div>
      </section>

      <footer className="border-t border-white/[.06] bg-[#08070a] px-5 py-10 sm:px-8">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-6 text-sm text-white/45 sm:flex-row">
          <Mark />
          <div className="flex flex-wrap items-center justify-center gap-6">
            <button type="button" onClick={() => jump('features')} className="hover:text-white">Features</button>
            <button type="button" onClick={() => jump('faq')} className="hover:text-white">FAQ</button>
            <Link to="/login" className="hover:text-white">Sign in</Link>
            <Link to="/terms" className="hover:text-white">Terms</Link>
            <Link to="/privacy" className="hover:text-white">Privacy</Link>
          </div>
          <span>© {new Date().getFullYear()} {BRAND.name}</span>
        </div>
        <div className="mx-auto mt-6 flex max-w-7xl justify-center sm:justify-start"><SupportContacts dark compact /></div>
      </footer>

      {waLink && (
        <a href={waLink} target="_blank" rel="noreferrer" aria-label="Chat on WhatsApp" className="lp-wa fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-[#25d366] text-white transition-transform hover:scale-105">
          <MessageCircle className="h-6 w-6" />
        </a>
      )}
    </div>
  )
}
