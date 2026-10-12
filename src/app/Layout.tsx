import clsx from 'clsx'
import { CalendarDays, ChevronDown, LifeBuoy, LogOut, Menu, MoreHorizontal, PanelLeftClose, PanelLeftOpen, ShoppingCart, X } from 'lucide-react'
import { Suspense, useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { api } from '@/data'
import { useApp, useData } from './AppContext'
import { Spinner, useToast } from '@/components/ui'
import { allowed, NAV, type NavItem } from './nav'
import { BranchSwitcher } from '@/features/Branches'
import { usesRetailPos } from '@/core/config'
import { formatPhone } from '@/core/phone'
import { LanguageMenu } from '@/i18n/LanguagePicker'
import { SubscriptionBanner } from '@/features/SubscriptionBanner'
import { migrateLegacyPrinter } from '@/features/printing/printer'

export function Logo({ light = true, compact = false }: { light?: boolean; compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white shadow-sm"><ShoppingCart className="h-[18px] w-[18px]" /></div>
      {!compact && <span className={clsx('text-[17px] font-bold tracking-tight', light ? 'text-white' : 'text-slate-900')}>BillPoodum</span>}
    </div>
  )
}

/** Short two-tone chime for new customer orders (no audio file needed). */
function chime() {
  try {
    const ctx = new AudioContext()
    ;[880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator(); const g = ctx.createGain()
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination)
      g.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.18)
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.25)
      o.start(ctx.currentTime + i * 0.18); o.stop(ctx.currentTime + i * 0.18 + 0.26)
    })
  } catch { /* audio blocked until the user interacts with the page */ }
}

/** Watches for new QR orders: returns the pending count and alerts when it goes up. */
export function useQrAlerts() {
  const { mod, can } = useApp()
  const toast = useToast()
  const on = mod('qrOrdering') && can('tables.manage')
  const { data: pending } = useData(() => (on ? api.qr.pending() : Promise.resolve([])), [on])
  const seen = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!pending) return
    const ids = new Set(pending.map((o) => o.id))
    if (seen.current) {
      const fresh = pending.filter((o) => !seen.current!.has(o.id))
      if (fresh.length) { chime(); toast(`New QR order · ${fresh[0].number}${fresh[0].guest?.name ? ` from ${fresh[0].guest.name}` : ''}`, 'info') }
    }
    seen.current = ids
  }, [pending, toast])
  return pending?.length ?? 0
}

export function useNavItems() {
  const { can, mod, t, me } = useApp()
  const retailPos = !!me && usesRetailPos(me.business)
  return NAV.filter((n) => allowed(n, can, mod) && (n.only !== 'retailPos' || retailPos)).map((n) => ({
    ...n, text: typeof n.label === 'string' ? n.label : t(n.label.term, true),
  }))
}

function SideNav({ items, onNavigate, collapsed, badges = {} }: { items: (NavItem & { text: string })[]; onNavigate?: () => void; collapsed?: boolean; badges?: Record<string, number> }) {
  return (
    <nav className={clsx('flex flex-col gap-0.5', collapsed ? 'px-2' : 'px-3')}>
      {items.map((n) => (
        <NavLink
          key={n.to} to={n.to} onClick={onNavigate} title={collapsed ? n.text : undefined} aria-label={n.text}
          className={({ isActive }) => clsx('group relative flex items-center rounded-lg py-2 text-[13.5px] font-medium transition-colors',
            collapsed ? 'justify-center px-0' : 'gap-3 px-3',
            isActive ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-300 hover:bg-white/5 hover:text-white')}
        >
          <n.icon className="h-[18px] w-[18px] shrink-0 opacity-90" />
          {!collapsed && n.text}
          {!!badges[n.to] && (collapsed
            ? <span className="absolute right-1.5 top-1 h-2.5 w-2.5 rounded-full bg-orange-500 ring-2 ring-navy-800" />
            : <span className="ml-auto rounded-full bg-orange-500 px-1.5 text-[11px] font-bold text-white">{badges[n.to]}</span>)}
        </NavLink>
      ))}
    </nav>
  )
}

/** Profile button + sign-out menu. `onDark`: light text for dark headers (phone / tablet). */
export function UserMenu({ onDark }: { onDark?: boolean }) {
  const { me } = useApp()
  const nav = useNavigate()
  const loc = useLocation()
  // Replies from the BillPoodum team that this shop hasn't read yet.
  const { data: tickets = [] } = useData(() => (me && !me.support ? api.support.mine() : Promise.resolve([])), [me?.business.id])
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  if (!me) return null
  const unread = tickets.filter((t) => t.unreadForCustomer).length
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)} className={clsx('flex items-center gap-2.5 rounded-lg py-1 pl-1 pr-2', onDark ? 'hover:bg-white/10' : 'hover:bg-slate-100')}>
        <div className="relative flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-sm font-semibold text-white">
          {me.user.name[0]}
          {unread > 0 && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white" aria-label="New reply from support" />}
        </div>
        <div className="hidden text-left leading-tight sm:block">
          <p className={clsx('text-sm font-semibold', onDark ? 'text-white' : 'text-slate-800')}>{me.user.name}</p>
          <p className={clsx('text-[11px]', onDark ? 'text-slate-300' : 'text-slate-500')}>{me.role.name}</p>
        </div>
        <ChevronDown className={clsx('hidden h-4 w-4 sm:block', onDark ? 'text-slate-300' : 'text-slate-400')} />
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-40 w-56 rounded-xl border border-slate-200 bg-white p-1.5 shadow-pop animate-pop">
          <div className="border-b border-slate-100 px-3 py-2">
            <p className="text-sm font-semibold">{me.user.name}</p>
            <p className="text-xs text-slate-500">{formatPhone(me.user.phone)} · {me.role.name}</p>
          </div>
          <LanguageMenu />
          <Link to="/support" state={{ from: loc.pathname }} onClick={() => setOpen(false)} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
            <LifeBuoy className="h-4 w-4" />Help & support{unread > 0 && <span className="ml-auto rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold text-white">{unread}</span>}
          </Link>
          <button
            onClick={async () => { await api.auth.logout(); nav('/login') }}
            className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-600 hover:bg-red-50"
          ><LogOut className="h-4 w-4" />Sign out</button>
        </div>
      )}
    </div>
  )
}

/** Web sidebar (≥1024px). Shared by the main app layout and full-screen pages like Take Order. */
export function DesktopSidebar({ badges, from = 'lg' }: { badges?: Record<string, number>; from?: 'lg' | 'xl' }) {
  const { me } = useApp()
  const items = useNavItems()
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('billpoodum.sidebar') === 'collapsed' } catch { return false } })
  const toggleSidebar = () => setCollapsed((c) => {
    try { localStorage.setItem('billpoodum.sidebar', c ? 'open' : 'collapsed') } catch { /* storage unavailable */ }
    return !c
  })
  if (!me) return null
  return (
    <aside className={clsx('hidden shrink-0 flex-col bg-navy-800 transition-[width] duration-200 print:!hidden', from === 'xl' ? 'xl:flex' : 'lg:flex', collapsed ? 'w-[68px]' : 'w-60')}>
      <div className={clsx('flex h-16 items-center', collapsed ? 'justify-center' : 'justify-between pl-5 pr-3')}>
        {!collapsed && <Logo />}
        <button
          onClick={toggleSidebar} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
        >
          {collapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto pb-4 pt-2 no-scrollbar"><SideNav items={items} collapsed={collapsed} badges={badges} /></div>
      {!collapsed && (
        <div className="m-3 rounded-xl bg-white/5 p-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Branch</p>
          <p className="mt-0.5 truncate text-sm font-medium text-white">{me.branch.name}</p>
        </div>
      )}
    </aside>
  )
}

export function AppLayout() {
  const { me } = useApp()
  // Old device-wide printer setup → this branch (once). Other branches set up their own.
  useEffect(() => { if (me && !me.isAll && !me.support && !me.subscription.readOnly) void migrateLegacyPrinter(me.branch) }, [me])
  const items = useNavItems()
  const qrPending = useQrAlerts()
  const badges = { '/qr-orders': qrPending }
  const [drawer, setDrawer] = useState(false)
  const loc = useLocation()
  const fullBleed = loc.pathname.startsWith('/billing') || loc.pathname.startsWith('/kitchen') || loc.pathname.startsWith('/customer-orders')
  const tabs = items.filter((i) => i.mobileTab).slice(0, 4)
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })

  if (!me) return null
  return (
    <div className="flex h-[100dvh] overflow-hidden print:block print:h-auto print:overflow-visible">
      <DesktopSidebar badges={badges} />

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50 animate-fade" onClick={() => setDrawer(false)} />
          <aside className="absolute left-0 top-0 flex h-full w-72 flex-col bg-navy-800 animate-slide">
            <div className="flex h-16 items-center justify-between px-5"><Logo /><button onClick={() => setDrawer(false)} className="text-slate-300"><X className="h-5 w-5" /></button></div>
            {me.branches.length > 1 && <div className="px-4 pb-3 sm:hidden"><BranchSwitcher onDark /></div>}
            <div className="flex-1 overflow-y-auto pb-6"><SideNav items={items} badges={badges} onNavigate={() => setDrawer(false)} /></div>
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 print:hidden lg:px-6">
          <button className="-ml-1 rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden" onClick={() => setDrawer(true)} aria-label="Menu"><Menu className="h-5 w-5" /></button>
          <Link to="/settings" className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-orange-50 text-lg">{me.business.logoEmoji}</span>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-semibold text-slate-900">{me.business.name || 'My Business'}</p>
              <p className="truncate text-[11px] text-slate-500">{me.business.subType}</p>
            </div>
          </Link>
          <div className="hidden sm:block"><BranchSwitcher /></div>
          <div className="flex-1" />
          <div className="hidden items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 md:flex">
            <CalendarDays className="h-4 w-4 text-slate-400" />{today}
          </div>
          <UserMenu />
        </header>

        <SubscriptionBanner />
        <main className={clsx('flex-1 overflow-y-auto print:overflow-visible', !fullBleed && 'p-4 pb-24 lg:p-6 lg:pb-6')}>
          {/* Page-level boundary: the sidebar and header stay while a page's code loads. */}
          <Suspense fallback={<Spinner />}><Outlet /></Suspense>
        </main>

        {/* Mobile bottom navigation */}
        {!fullBleed && tabs.length > 1 && (
          <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 grid print:hidden border-t border-slate-200 bg-white/95 backdrop-blur lg:hidden" style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, 1fr)` }}>
            {tabs.map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => clsx('flex flex-col items-center gap-0.5 py-2 text-[10.5px] font-medium', isActive ? 'text-brand-600' : 'text-slate-500')}>
                <n.icon className="h-5 w-5" />{n.text}
              </NavLink>
            ))}
            <button onClick={() => setDrawer(true)} className="flex flex-col items-center gap-0.5 py-2 text-[10.5px] font-medium text-slate-500"><MoreHorizontal className="h-5 w-5" />More</button>
          </nav>
        )}
      </div>
    </div>
  )
}
