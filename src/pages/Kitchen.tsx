import clsx from 'clsx'
import { ChefHat, Clock, Maximize2, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { useApp, useData, useNow } from '@/app/AppContext'
import { Badge, Button, EmptyState, Segmented, useAction } from '@/components/ui'
import { ORDER_TYPE_LABEL } from '@/core/config'
import type { KitchenTicket, KotStatus } from '@/core/types'
import { VegMark } from '@/components/ui'
import { api } from '@/data'
import { fmtTime, minutesSince } from '@/lib/format'

const NEXT: Partial<Record<KotStatus, { to: KotStatus; label: string; variant: 'primary' | 'success' | 'secondary' }>> = {
  new: { to: 'preparing', label: 'Start preparing', variant: 'primary' },
  preparing: { to: 'ready', label: 'Mark ready', variant: 'success' },
  ready: { to: 'completed', label: 'Served / picked up', variant: 'secondary' },
}
const PREV: Partial<Record<KotStatus, KotStatus>> = { preparing: 'new', ready: 'preparing', completed: 'ready' }
const TONE: Record<KotStatus, 'blue' | 'orange' | 'green' | 'slate' | 'red'> = { new: 'blue', preparing: 'orange', ready: 'green', completed: 'slate', cancelled: 'red' }
const LABEL: Record<KotStatus, string> = { new: 'New', preparing: 'Preparing', ready: 'Ready', completed: 'Completed', cancelled: 'Cancelled' }

export default function Kitchen() {
  const { t } = useApp()
  const now = useNow(15000)
  const { data: kots = [] } = useData(() => api.kitchen.list())
  const [tab, setTab] = useState<'board' | KotStatus>('board')
  const count = (s: KotStatus) => kots.filter((k) => k.status === s).length

  return (
    <div className="flex h-full flex-col bg-slate-100">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <h1 className="flex items-center gap-2 text-lg font-semibold"><ChefHat className="h-5 w-5 text-orange-500" />Kitchen Display</h1>
        <Segmented size="sm" value={tab} onChange={setTab} options={[
          { value: 'board', label: 'Live board' },
          { value: 'new', label: 'New', count: count('new') },
          { value: 'preparing', label: 'Preparing', count: count('preparing') },
          { value: 'ready', label: 'Ready', count: count('ready') },
          { value: 'completed', label: 'Completed', count: count('completed') },
          { value: 'cancelled', label: 'Cancelled', count: count('cancelled') },
        ]} />
        <div className="flex-1" />
        <Button size="sm" variant="secondary" icon={Maximize2} onClick={() => document.documentElement.requestFullscreen?.()} className="hidden md:inline-flex">Full screen</Button>
      </div>

      {tab === 'board' ? (
        <div className="grid flex-1 gap-3 overflow-y-auto p-3 md:grid-cols-3 md:overflow-hidden">
          {(['new', 'preparing', 'ready'] as KotStatus[]).map((s) => (
            <section key={s} className="flex min-h-0 flex-col rounded-xl bg-slate-200/50">
              <header className="flex items-center justify-between px-3 py-2.5">
                <span className="flex items-center gap-2 text-sm font-semibold text-slate-700"><span className={clsx('h-2 w-2 rounded-full', s === 'new' ? 'bg-brand-500' : s === 'preparing' ? 'bg-orange-500' : 'bg-emerald-500')} />{LABEL[s]}</span>
                <Badge tone={TONE[s]}>{count(s)}</Badge>
              </header>
              <div className="flex-1 space-y-2.5 overflow-y-auto px-2.5 pb-2.5">
                {kots.filter((k) => k.status === s).map((k) => <Ticket key={k.id} k={k} now={now} />)}
                {!count(s) && <p className="py-10 text-center text-xs text-slate-400">Nothing here</p>}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3">
          {count(tab) ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {kots.filter((k) => k.status === tab).reverse().map((k) => <Ticket key={k.id} k={k} now={now} />)}
            </div>
          ) : <EmptyState icon={ChefHat} title={`No ${LABEL[tab].toLowerCase()} ${t('kot', true)}`} />}
        </div>
      )}
    </div>
  )
}

function Ticket({ k, now }: { k: KitchenTicket; now: number }) {
  const run = useAction()
  const mins = minutesSince(k.createdAt, now)
  const active = k.status === 'new' || k.status === 'preparing'
  const late = active && mins >= 20
  const warn = active && mins >= 12
  const next = NEXT[k.status]
  const prev = PREV[k.status]
  return (
    <article className={clsx('rounded-xl border bg-white shadow-card', late ? 'border-red-300 ring-2 ring-red-200' : 'border-slate-200')}>
      <header className="flex items-start justify-between gap-2 border-b border-dashed border-slate-200 px-3.5 py-2.5">
        <div>
          <p className="text-[15px] font-bold">{k.number}</p>
          <p className="text-xs text-slate-500">{k.orderNumber} · {fmtTime(k.createdAt)}</p>
        </div>
        <div className="text-right">
          <span className="inline-block rounded-md bg-slate-900 px-2 py-0.5 text-sm font-bold text-white">{k.tableLabel ?? ORDER_TYPE_LABEL[k.orderType]}</span>
          <p className={clsx('mt-1 flex items-center justify-end gap-1 text-xs font-semibold', late ? 'text-red-600' : warn ? 'text-amber-600' : 'text-slate-500')}><Clock className="h-3 w-3" />{mins}m</p>
        </div>
      </header>
      <ul className="space-y-1.5 px-3.5 py-2.5">
        {k.items.map((i, idx) => (
          <li key={idx} className="text-sm">
            <div className="flex items-start gap-2">
              <span className="min-w-[26px] rounded bg-slate-100 text-center text-sm font-bold">{i.qty}</span>
              <span className="mt-[3px]"><VegMark veg={i.isVeg} /></span>
              <span className={clsx('flex-1 font-medium leading-snug', k.status === 'completed' && 'text-slate-500 line-through decoration-slate-300')}>{i.name}</span>
            </div>
            {i.notes && <p className="ml-[54px] mt-0.5 rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800">⚠ {i.notes}</p>}
          </li>
        ))}
      </ul>
      {(next || prev) && (
        <footer className="flex gap-2 px-3.5 pb-3">
          {prev && <Button size="sm" variant="ghost" icon={Undo2} onClick={() => run(() => api.kitchen.setStatus(k.id, prev))} aria-label="Move back" />}
          {next && <Button size="sm" block variant={next.variant} onClick={() => run(() => api.kitchen.setStatus(k.id, next.to))}>{next.label}</Button>}
        </footer>
      )}
    </article>
  )
}
