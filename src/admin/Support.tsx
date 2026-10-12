import clsx from 'clsx'
import { ArrowLeft, LifeBuoy, Paperclip, Send } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useData } from '@/app/AppContext'
import { Badge, Button, Card, Chips, EmptyState, Field, SearchInput, Select, Textarea, useAction } from '@/components/ui'
import { formatPhone } from '@/core/phone'
import type { TicketPriority, TicketStatus } from '@/core/types'
import { api } from '@/data'
import { CATEGORY, PRIORITY, ScreenshotPicker, STATUS, StatusBadge, Thread, when } from '@/features/support/TicketParts'
import { StateBadge } from './shared'

type Filter = 'active' | TicketStatus | 'all'

/** All customer problem reports, newest activity first. */
export function AdminSupportList() {
  const nav = useNavigate()
  const { data: tickets = [] } = useData(() => api.admin.tickets())
  const [filter, setFilter] = useState<Filter>('active')
  const [q, setQ] = useState('')
  const active = (s: TicketStatus) => s !== 'resolved' && s !== 'closed'
  const list = useMemo(() => tickets.filter((t) => (filter === 'all' || (filter === 'active' ? active(t.status) : t.status === filter))
    && (!q || `${t.number} ${t.subject} ${t.businessName} ${t.userName}`.toLowerCase().includes(q.toLowerCase()))), [tickets, filter, q])
  const n = (f: Filter) => tickets.filter((t) => (f === 'all' ? true : f === 'active' ? active(t.status) : t.status === f)).length
  return (
    <div>
      <h1 className="text-xl font-semibold">Support</h1>
      <p className="mb-5 text-sm text-slate-500">Problems reported from inside the app, with screenshots and the page they were on.</p>
      <Card>
        <div className="space-y-3 border-b border-slate-100 p-3">
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ticket, customer or subject" className="max-w-md" />
          <Chips value={filter} onChange={setFilter} options={[
            { value: 'active', label: `Needs work (${n('active')})` }, { value: 'open', label: `Open (${n('open')})` }, { value: 'in_progress', label: `In progress (${n('in_progress')})` },
            { value: 'waiting', label: `Waiting for customer (${n('waiting')})` }, { value: 'resolved', label: `Resolved (${n('resolved')})` }, { value: 'all', label: `All (${n('all')})` },
          ]} />
        </div>
        {!list.length ? <EmptyState icon={LifeBuoy} title="Nothing here" /> : (
          <ul className="divide-y divide-slate-100">
            {list.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => nav(`/admin/support/${t.id}`)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50">
                  <span className={clsx('h-2 w-2 shrink-0 rounded-full', t.unreadForAdmin ? 'bg-brand-600' : 'bg-transparent')} />
                  <div className="min-w-0 flex-1">
                    <p className={clsx('truncate text-sm', t.unreadForAdmin ? 'font-semibold' : 'font-medium')}>{t.subject}</p>
                    <p className="truncate text-xs text-slate-500">{t.number} · <b className="font-medium text-slate-600">{t.businessName}</b> · {t.userName} · {CATEGORY[t.category]} · {when(t.updatedAt)}{t.imageCount ? <> · <Paperclip className="mb-0.5 inline h-3 w-3" />{t.imageCount}</> : ''}</p>
                  </div>
                  {t.priority !== 'normal' && <Badge tone={PRIORITY[t.priority].tone}>{PRIORITY[t.priority].label.split(' —')[0]}</Badge>}
                  <StatusBadge s={t.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

export function AdminSupportTicket() {
  const { id = '' } = useParams()
  const run = useAction()
  const { data: t, error } = useData(() => api.admin.ticket(id), [id])
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [after, setAfter] = useState<TicketStatus>('waiting')
  if (error) return <EmptyState icon={LifeBuoy} title="Ticket not found" />
  if (!t) return null
  const set = (patch: { status?: TicketStatus; priority?: TicketPriority; assignedTo?: string | null }) => run(() => api.admin.updateTicket(t.id, patch))
  return (
    <div>
      <Link to="/admin/support" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" />Support</Link>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <Card className="p-4 sm:p-5">
          <h1 className="text-lg font-semibold">{t.subject}</h1>
          <p className="mb-4 text-sm text-slate-500">{t.number} · opened {when(t.createdAt)}</p>
          <Thread messages={t.messages} me="admin" />
          <form className="mt-5 space-y-3 border-t border-slate-100 pt-4" onSubmit={async (e) => {
            e.preventDefault()
            if (await run(() => api.admin.replyTicket(t.id, text, images, after), 'Reply sent')) { setText(''); setImages([]) }
          }}>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder={`Reply to ${t.userName}…`} />
            <div className="flex flex-wrap items-center gap-2">
              <ScreenshotPicker images={images} onChange={setImages} upload={(b) => api.admin.uploadScreenshot(b)} />
              <div className="flex-1" />
              <label className="flex items-center gap-1.5 text-xs text-slate-600">then
                <Select value={after} onChange={(e) => setAfter(e.target.value as TicketStatus)} className="h-9 w-48 text-sm">
                  <option value="waiting">Waiting for customer</option><option value="in_progress">Keep in progress</option><option value="resolved">Mark resolved</option>
                </Select>
              </label>
              <Button type="submit" icon={Send} disabled={!text.trim() && !images.length}>Send reply</Button>
            </div>
          </form>
        </Card>
        <div className="space-y-4">
          <Card className="space-y-3 p-4">
            <Field label="Status"><Select value={t.status} onChange={(e) => set({ status: e.target.value as TicketStatus })}>{(Object.keys(STATUS) as TicketStatus[]).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}</Select></Field>
            <Field label="Priority"><Select value={t.priority} onChange={(e) => set({ priority: e.target.value as TicketPriority })}>{(Object.keys(PRIORITY) as TicketPriority[]).map((p) => <option key={p} value={p}>{PRIORITY[p].label}</option>)}</Select></Field>
            <Field label="Assigned to"><Select value={t.assignedTo ?? ''} onChange={(e) => set({ assignedTo: e.target.value || null })}><option value="">Nobody</option>{t.admins.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
          </Card>
          <Card className="p-4 text-sm">
            <p className="mb-2 font-semibold">Customer</p>
            <p><Link to={`/admin/customers/${t.businessId}`} className="font-medium text-brand-700 hover:underline">{t.businessName}</Link>{t.business && <span className="ml-1.5"><StateBadge state={t.business.state} /></span>}</p>
            <p className="text-slate-600">{t.userName} · {formatPhone(t.userPhone)}</p>
            <p className="mt-3 mb-1 font-semibold">Reported from</p>
            <dl className="space-y-0.5 text-xs text-slate-600">
              <div><dt className="inline text-slate-400">Page </dt><dd className="inline font-mono">{t.context.page || '—'}</dd></div>
              <div><dt className="inline text-slate-400">Browser </dt><dd className="inline">{t.context.browser || '—'}</dd></div>
              <div><dt className="inline text-slate-400">App </dt><dd className="inline">{t.context.version}</dd></div>
              <div><dt className="inline text-slate-400">About </dt><dd className="inline">{CATEGORY[t.category]}</dd></div>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  )
}
