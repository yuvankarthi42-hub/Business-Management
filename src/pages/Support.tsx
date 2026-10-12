import clsx from 'clsx'
import { ArrowLeft, CheckCircle2, LifeBuoy, Plus, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useApp, useData } from '@/app/AppContext'
import { Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Textarea, useAction } from '@/components/ui'
import type { Ticket, TicketCategory, TicketPriority } from '@/core/types'
import { api } from '@/data'
import { CATEGORY, PRIORITY, ScreenshotPicker, StatusBadge, Thread, when } from '@/features/support/TicketParts'

/** Help & support: report a problem to the BillPoodum team (with screenshots) and follow the replies. */
export default function Support() {
  const { data: tickets = [] } = useData(() => api.support.mine())
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const open = tickets.find((t) => t.id === openId) ?? null
  if (open) return <TicketView t={open} onBack={() => setOpenId(null)} />
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Help & support" subtitle="Tell us about a problem — the BillPoodum team replies here" actions={<Button icon={Plus} write={false} onClick={() => setCreating(true)}>Report a problem</Button>} />
      <Card>
        {!tickets.length ? <EmptyState icon={LifeBuoy} title="No requests yet" description="Something not working? Report it with a screenshot and we’ll help." action={<Button icon={Plus} write={false} onClick={() => setCreating(true)}>Report a problem</Button>} /> : (
          <ul className="divide-y divide-slate-100">
            {tickets.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => setOpenId(t.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50">
                  <span className={clsx('h-2 w-2 shrink-0 rounded-full', t.unreadForCustomer ? 'bg-brand-600' : 'bg-transparent')} aria-label={t.unreadForCustomer ? 'New reply' : undefined} />
                  <div className="min-w-0 flex-1">
                    <p className={clsx('truncate text-sm', t.unreadForCustomer ? 'font-semibold' : 'font-medium')}>{t.subject}</p>
                    <p className="truncate text-xs text-slate-500">{t.number} · {CATEGORY[t.category]} · updated {when(t.updatedAt)} · {t.messages.length} message{t.messages.length === 1 ? '' : 's'}</p>
                  </div>
                  <StatusBadge s={t.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {creating && <NewTicket onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpenId(id) }} />}
    </div>
  )
}

function NewTicket({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const run = useAction()
  const loc = useLocation()
  const [f, setF] = useState({ subject: '', category: 'billing' as TicketCategory, priority: 'normal' as TicketPriority, message: '' })
  const [images, setImages] = useState<string[]>([])
  const from = (loc.state as { from?: string } | null)?.from ?? ''
  return (
    <>
      <Modal open onClose={onClose} title="Report a problem" subtitle="Add a screenshot if you can — it helps us fix it faster.">
        <form className="space-y-4" onSubmit={async (e) => {
          e.preventDefault()
          let id = ''
          if (await run(async () => { id = (await api.support.create({ ...f, images, page: from || loc.pathname })).id }, 'Sent to the BillPoodum team')) onCreated(id)
        }}>
          <Field label="What’s the problem?"><Input autoFocus required value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} placeholder="e.g. Bill doesn’t print after payment" maxLength={120} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="About"><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as TicketCategory })}>{(Object.keys(CATEGORY) as TicketCategory[]).map((c) => <option key={c} value={c}>{CATEGORY[c]}</option>)}</Select></Field>
            <Field label="How urgent?"><Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as TicketPriority })}>{(Object.keys(PRIORITY) as TicketPriority[]).map((p) => <option key={p} value={p}>{PRIORITY[p].label}</option>)}</Select></Field>
          </div>
          <Field label="Details"><Textarea required value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} rows={4} placeholder="What were you doing, what happened, and what did you expect?" /></Field>
          <ScreenshotPicker images={images} onChange={setImages} upload={(b) => api.support.uploadScreenshot(b)} onHide={() => {}} />
          <p className="text-xs text-slate-500">We also get the page you were on, your browser and the app version.</p>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" write={false} onClick={onClose}>Cancel</Button><Button type="submit" icon={Send} write={false}>Send</Button></div>
        </form>
      </Modal>
    </>
  )
}

function TicketView({ t, onBack }: { t: Ticket; onBack: () => void }) {
  const run = useAction()
  const { me } = useApp()
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  useEffect(() => { if (t.unreadForCustomer) void api.support.markRead(t.id) }, [t.id, t.unreadForCustomer])
  const done = t.status === 'resolved' || t.status === 'closed'
  return (
    <div className="mx-auto max-w-3xl">
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" />All requests</button>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-xl font-semibold">{t.subject}</h1><p className="text-sm text-slate-500">{t.number} · {CATEGORY[t.category]} · {PRIORITY[t.priority].label} · opened {when(t.createdAt)}</p></div>
        <div className="flex items-center gap-2"><StatusBadge s={t.status} />{!done && <Button size="sm" variant="secondary" icon={CheckCircle2} write={false} onClick={() => run(() => api.support.resolve(t.id), 'Marked as solved')}>It’s solved</Button>}</div>
      </div>
      <Card className="p-4 sm:p-5">
        <Thread messages={t.messages} me="customer" />
        <form className="mt-5 space-y-3 border-t border-slate-100 pt-4" onSubmit={async (e) => {
          e.preventDefault()
          if (await run(() => api.support.reply(t.id, text, images))) { setText(''); setImages([]) }
        }}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={done ? 'Still a problem? Write here to open it again' : `Reply as ${me?.user.name ?? 'you'}`} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ScreenshotPicker images={images} onChange={setImages} upload={(b) => api.support.uploadScreenshot(b)} />
            <Button type="submit" icon={Send} write={false} disabled={!text.trim() && !images.length}>Send</Button>
          </div>
        </form>
      </Card>
    </div>
  )
}
