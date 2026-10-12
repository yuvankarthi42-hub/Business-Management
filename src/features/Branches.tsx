import clsx from 'clsx'
import { Building2, Check, ChevronDown, LayoutGrid, Settings2 } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '@/app/AppContext'
import { useAction } from '@/components/ui'
import { api } from '@/data'

/** Header dropdown to switch branch (or "All branches"). Hidden when the user has only one branch. */
export function BranchSwitcher({ onDark }: { onDark?: boolean }) {
  const { me, can } = useApp()
  const run = useAction()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  if (!me || me.branches.length < 2) return null
  const pickBranch = async (id: string) => { setOpen(false); await run(() => api.auth.switchBranch(id)) }
  const Row = ({ id, icon, label, sub }: { id: string; icon: ReactNode; label: string; sub?: string }) => (
    <button onClick={() => pickBranch(id)} className={clsx('flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm', me.branch.id === id ? 'bg-brand-50 text-brand-700' : 'hover:bg-slate-50')}>
      {icon}
      <span className="min-w-0 flex-1"><span className="block truncate font-medium">{label}</span>{sub && <span className="block truncate text-[11px] text-slate-500">{sub}</span>}</span>
      {me.branch.id === id && <Check className="h-4 w-4" />}
    </button>
  )
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)}
        className={clsx('flex max-w-[220px] items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition',
          onDark ? 'border-white/20 text-white hover:bg-white/10' : me.isAll ? 'border-brand-200 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-700 hover:bg-slate-50')}>
        {me.isAll ? <LayoutGrid className="h-4 w-4 shrink-0" /> : <Building2 className="h-4 w-4 shrink-0" />}
        <span className="truncate">{me.branch.name}</span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
      </button>
      {open && (
        <div className="absolute left-0 top-11 z-40 w-64 rounded-xl border border-slate-200 bg-white p-1.5 text-slate-800 shadow-pop animate-pop">
          <Row id="all" icon={<LayoutGrid className="h-4 w-4 text-slate-400" />} label="All branches" sub={`Combined view · ${me.branches.length} branches`} />
          <div className="my-1 border-t border-slate-100" />
          {me.branches.map((b) => (
            <Row key={b.id} id={b.id} icon={<Building2 className="h-4 w-4 text-slate-400" />} label={b.name} sub={b.active === false ? 'Closed' : b.isDefault ? 'Main branch' : b.address || undefined} />
          ))}
          {can('settings.manage') && (
            <Link to="/settings?tab=branches" onClick={() => setOpen(false)} className="mt-1 flex items-center gap-2 border-t border-slate-100 px-3 pb-1 pt-2.5 text-sm font-medium text-brand-600">
              <Settings2 className="h-4 w-4" />Manage branches
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

/** Shown on billing-type pages while "All branches" is selected — they need one branch. */
export function ChooseBranch({ what = 'this page' }: { what?: string }) {
  const { me } = useApp()
  const run = useAction()
  if (!me) return null
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center p-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 text-brand-600"><Building2 className="h-7 w-7" /></div>
      <h2 className="mt-4 text-lg font-semibold">Choose a branch</h2>
      <p className="mt-1 max-w-sm text-sm text-slate-500">You’re viewing all branches together. Pick the branch you want to work in for {what}.</p>
      <div className="mt-5 grid w-full max-w-md gap-2 sm:grid-cols-2">
        {me.branches.filter((b) => b.active !== false).map((b) => (
          <button key={b.id} onClick={() => run(() => api.auth.switchBranch(b.id))} className="rounded-xl border-2 border-slate-200 p-4 text-left transition hover:border-brand-400 hover:bg-brand-50/40">
            <p className="font-semibold">{b.name}</p>
            <p className="mt-0.5 truncate text-xs text-slate-500">{b.address || (b.isDefault ? 'Main branch' : '')}</p>
          </button>
        ))}
      </div>
    </div>
  )
}
