import clsx from 'clsx'
import { BarChart3, BellRing, History, LifeBuoy, LogOut, MessageCircle, Rocket, Settings, ShieldCheck, UserCog, Users } from 'lucide-react'
import { Suspense, useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { Logo } from '@/app/Layout'
import { Spinner } from '@/components/ui'
import { useData } from '@/app/AppContext'
import { api } from '@/data'
import type { AdminMe } from './shared'
import { ADMIN_ROLES, type AdminPermission } from '@/core/adminRoles'

const NAV: { to: string; label: string; icon: typeof Users; end?: boolean; perm: AdminPermission }[] = [
  { to: '/admin', label: 'Customers', icon: Users, end: true, perm: 'customers.view' },
  { to: '/admin/support', label: 'Support', icon: LifeBuoy, perm: 'customers.view' },
  { to: '/admin/renewals', label: 'Renewals', icon: BellRing, perm: 'customers.view' },
  { to: '/admin/whatsapp', label: 'WhatsApp', icon: MessageCircle, perm: 'customers.view' },
  { to: '/admin/reports', label: 'Usage', icon: BarChart3, perm: 'reports.view' },
  { to: '/admin/features', label: 'Features', icon: Rocket, perm: 'customers.view' },
  { to: '/admin/audit', label: 'Audit log', icon: History, perm: 'customers.view' },
  { to: '/admin/team', label: 'Team', icon: UserCog, perm: 'team.manage' },
  { to: '/admin/settings', label: 'Pricing', icon: Settings, perm: 'pricing.manage' },
]

/** Shell for the product admin. Only a signed-in product admin gets past this. */
export default function AdminLayout() {
  const nav = useNavigate()
  const [admin, setAdmin] = useState<AdminMe | null | undefined>(undefined)
  const { data: tickets = [] } = useData(() => (admin ? api.admin.tickets() : Promise.resolve([])), [admin?.id])
  useEffect(() => { api.admin.me().then((a) => { setAdmin(a); if (!a) nav('/admin/login', { replace: true }) }) }, [nav])
  if (admin === undefined) return <Spinner />
  const unread = tickets.filter((t) => t.unreadForAdmin).length
  if (!admin) return null
  return (
    <div className="min-h-[100dvh] bg-slate-50" data-no-i18n>
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-900 text-white">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
          <Logo />
          <span className="hidden items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[11px] font-semibold sm:inline-flex"><ShieldCheck className="h-3.5 w-3.5" />Product admin</span>
          <nav className="ml-2 flex flex-1 gap-1 overflow-x-auto no-scrollbar">
            {NAV.filter((n) => admin.permissions.includes(n.perm)).map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => clsx('flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium', isActive ? 'bg-white/15 text-white' : 'text-slate-300 hover:bg-white/10 hover:text-white')}>
                <n.icon className="h-4 w-4" /><span className="hidden lg:inline">{n.label}</span>{n.to === '/admin/support' && unread > 0 && <span className="rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">{unread}</span>}
              </NavLink>
            ))}
          </nav>
          <span className="hidden shrink-0 text-right text-sm leading-tight text-slate-300 xl:block">{admin.name}<span className="block text-[11px] text-slate-400">{ADMIN_ROLES[admin.role].name}</span></span>
          <button onClick={async () => { await api.admin.logout(); nav('/admin/login', { replace: true }) }} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-slate-300 hover:bg-white/10 hover:text-white" aria-label="Sign out">
            <LogOut className="h-4 w-4" /><span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6"><Suspense fallback={<Spinner />}><Outlet context={{ admin }} /></Suspense></main>
    </div>
  )
}
