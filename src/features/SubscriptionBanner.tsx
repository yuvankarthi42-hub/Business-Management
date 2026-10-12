import clsx from 'clsx'
import { AlertTriangle, Eye, Lock, LogOut } from 'lucide-react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '@/app/AppContext'
import { ReadOnlyContext } from '@/components/ui'
import { api } from '@/data'

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '')

/** Turns write buttons off for an expired account or a support view (the API refuses writes either way). */
export function ReadOnlyGate({ children }: { children: ReactNode }) {
  const { me } = useApp()
  const reason = me?.support ? 'Support view — read-only' : me?.subscription.readOnly ? 'Read-only — subscription expired. Contact the product admin to renew.' : null
  return <ReadOnlyContext.Provider value={reason}>{children}</ReadOnlyContext.Provider>
}

/** Support view bar, read-only notice after the subscription ends, and a reminder in the last 7 days. */
export function SubscriptionBanner({ className }: { className?: string }) {
  const { me, refresh } = useApp()
  const nav = useNavigate()
  if (me?.support) {
    return (
      <div role="status" className={clsx('flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-slate-900 px-4 py-2 text-sm text-white print:hidden lg:px-6', className)} data-no-i18n>
        <Eye className="h-4 w-4 shrink-0 text-amber-300" />
        <p className="min-w-0 flex-1"><b>Support view</b> of {me.business.name} by {me.support.adminName} · read-only · <span className="text-slate-300">“{me.support.reason}”</span></p>
        <button onClick={async () => { const id = await api.admin.endSupport(); await refresh(); nav(id ? `/admin/customers/${id}` : '/admin', { replace: true }) }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-1 text-xs font-semibold hover:bg-white/25"><LogOut className="h-3.5 w-3.5" />Exit support view</button>
      </div>
    )
  }
  const s = me?.subscription
  if (!s || (s.state !== 'expired' && s.state !== 'expiring')) return null
  const expired = s.state === 'expired'
  return (
    <div role="status" className={clsx('flex items-start gap-2.5 border-b px-4 py-2.5 text-sm print:hidden lg:px-6', expired ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800', className)}>
      {expired ? <Lock className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
      <p className="min-w-0">
        {expired
          ? <><b>Subscription expired on {fmt(s.endAt)}.</b> <span>Your account is read-only — you can view everything, but can’t make bills or change data. Contact the BillPoodum team to renew.</span></>
          : <><b>Subscription ends in {s.daysLeft} day{s.daysLeft === 1 ? '' : 's'} ({fmt(s.endAt)}).</b> <span>Contact the BillPoodum team to renew and keep billing without a break.</span></>}
      </p>
    </div>
  )
}
