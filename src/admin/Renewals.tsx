import clsx from 'clsx'
import { AlertTriangle, BellRing, CalendarClock, MessageCircle, Pause, Play, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '@/app/AppContext'
import { Badge, Button, Card, EmptyState, Field, Input, Table, Td, Th, Toggle, useAction } from '@/components/ui'
import type { ReminderSettings } from '@/core/types'
import { formatPhone } from '@/core/phone'
import { api } from '@/data'
import { fmtDate, fmtDateTime, rupees, StateBadge, useAdminCan } from './shared'

type Data = Awaited<ReturnType<typeof api.admin.renewals>>

/** Renewal reminders: sent every day from N days before a plan ends, plus the expiring / expired lists. */
export default function AdminRenewals() {
  const run = useAction()
  const can = useAdminCan()
  const { data } = useData(() => api.admin.renewals())
  if (!data) return null
  const dueToday = data.expiring.filter((r) => r.dueToday).length
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Renewals</h1>
          <p className="text-sm text-slate-500">Customers are reminded on WhatsApp every day from {data.settings.daysBefore} days before their plan ends.</p>
        </div>
        {can('customers.renew') && <Button icon={BellRing} variant="secondary" disabled={!dueToday || !data.whatsapp.ready} onClick={() => run(() => api.admin.runReminders(), `Reminders sent`)}>Send today’s reminders now ({dueToday})</Button>}
      </div>

      {!data.whatsapp.ready && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
          <p className="min-w-0 flex-1">{!data.whatsapp.connected ? 'Reminders aren’t going out — connect Kadai Kalanjiyam’s WhatsApp number first.' : data.whatsapp.templateStatus === 'pending' ? 'Reminders start once Meta approves the reminder template.' : 'Reminders aren’t going out — submit the reminder template to Meta.'}</p>
          <Link to="/admin/whatsapp" className="font-semibold text-amber-900 underline">Set up WhatsApp</Link>
        </div>
      )}

      <Card className="mb-5">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3"><h2 className="font-semibold">Expiring soon</h2><span className="text-sm text-slate-500">{data.expiring.length} customer{data.expiring.length === 1 ? '' : 's'}</span></div>
        {!data.expiring.length ? <EmptyState icon={CalendarClock} title="No plans ending in the next two weeks" /> : <RenewTable rows={data.expiring} ready={data.whatsapp.ready} />}
      </Card>

      <Card className="mb-5">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3"><h2 className="font-semibold">Expired (last 30 days)</h2><span className="text-sm text-slate-500">read-only until renewed</span></div>
        {!data.expired.length ? <p className="px-5 py-6 text-sm text-slate-500">None.</p> : <RenewTable rows={data.expired} expired ready={data.whatsapp.ready} />}
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <SettingsCard s={data.settings} preview={data.whatsapp.preview} editable={can('pricing.manage')} />
        <Card>
          <div className="border-b border-slate-100 px-5 py-3"><h2 className="font-semibold">Reminder log</h2></div>
          {!data.log.length ? <p className="px-5 py-6 text-sm text-slate-500">No reminders sent yet.</p> : (
            <ul className="max-h-[440px] divide-y divide-slate-100 overflow-y-auto">
              {data.log.map((l) => (
                <li key={l.id} className="px-5 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <MessageCircle className="h-4 w-4 text-emerald-600" />
                    <b className="font-medium">{l.businessName}</b>
                    <span className="text-xs text-slate-500">{l.daysLeft} day{l.daysLeft === 1 ? '' : 's'} left · {l.trigger === 'auto' ? 'automatic' : `sent by ${l.adminName}`}</span>
                    <span className="ml-auto text-xs text-slate-500">{fmtDateTime(l.createdAt)}</span>
                    <Badge tone={l.status === 'sent' ? 'green' : 'red'}>{l.status === 'sent' ? 'Sent' : 'Failed'}</Badge>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{l.error ?? l.message}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}

function RenewTable({ rows, expired, ready }: { rows: Data['expiring']; expired?: boolean; ready: boolean }) {
  const run = useAction()
  const can = useAdminCan()
  return (
    <Table>
      <thead><tr><Th>Customer</Th><Th>Status</Th><Th>{expired ? 'Ended' : 'Ends'}</Th><Th className="text-right">Monthly</Th><Th>Reminders</Th><Th /></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <Td><Link to={`/admin/customers/${r.id}`} className="font-medium text-slate-900 hover:text-brand-700 hover:underline">{r.name}</Link><p className="text-xs text-slate-500">{r.ownerName} · {r.phone ? formatPhone(r.phone) : <span className="text-red-600">no mobile</span>}</p></Td>
            <Td><StateBadge state={r.state} /></Td>
            <Td className="text-sm">{fmtDate(r.endAt)}<span className={clsx('block text-xs', expired ? 'text-red-600' : (r.daysLeft ?? 0) <= 3 ? 'font-semibold text-red-600' : 'text-amber-700')}>{expired ? `${Math.abs(r.daysLeft ?? 0)} day(s) ago` : `${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'} left`}</span></Td>
            <Td className="text-right tabular">{rupees(r.monthly)}</Td>
            <Td className="text-sm">{r.paused ? <Badge tone="slate">Paused</Badge> : <>{r.sentThisCycle} sent{r.lastSent && <span className="block text-xs text-slate-500">last {fmtDateTime(r.lastSent)}</span>}</>}{r.dueToday && !r.paused && <Badge tone="amber" className="ml-1">due today</Badge>}</Td>
            <Td className="whitespace-nowrap text-right">
              {can('customers.renew') && <>
                <Button size="sm" variant="ghost" icon={r.paused ? Play : Pause} write={false} onClick={() => run(() => api.admin.pauseReminders(r.id, !r.paused), r.paused ? 'Reminders resumed' : 'Reminders paused')}>{r.paused ? 'Resume' : 'Pause'}</Button>
                <Button size="sm" variant="secondary" icon={Send} write={false} disabled={!ready} title={ready ? undefined : 'Set up WhatsApp first'} onClick={() => run(() => api.admin.sendReminder(r.id), 'Reminder sent')}>Send now</Button>
              </>}
              <Link to={`/admin/customers/${r.id}`} className="ml-2 text-sm font-medium text-brand-700 hover:underline">Renew</Link>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}

function SettingsCard({ s, preview, editable }: { s: ReminderSettings; preview: string; editable: boolean }) {
  const run = useAction()
  const [f, setF] = useState(s)
  useEffect(() => setF(s), [s])
  const dirty = JSON.stringify(f) !== JSON.stringify(s)
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Reminder settings</h2><Toggle checked={f.enabled} disabled={!editable} onChange={(v) => setF({ ...f, enabled: v })} label="Reminders on" /></div>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start (days before end)"><Input type="number" min={1} max={30} value={f.daysBefore} disabled={!editable} onChange={(e) => setF({ ...f, daysBefore: Number(e.target.value) })} /></Field>
          <Field label="Your support number"><Input value={f.supportContact} disabled={!editable} onChange={(e) => setF({ ...f, supportContact: e.target.value })} /></Field>
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between"><p className="text-sm font-medium text-slate-700">WhatsApp message</p><Link to="/admin/whatsapp" className="text-xs font-medium text-brand-700 hover:underline">Edit template</Link></div>
          <div className="rounded-xl bg-[#e5ddd5] p-3" data-no-i18n><p className="ml-auto max-w-[320px] rounded-lg rounded-tr-none bg-[#dcf8c6] px-3 py-2 text-[12.5px] leading-snug text-slate-800 shadow-sm">{preview}</p></div>
        </div>
        <p className="text-xs text-slate-500">Sent from Kadai Kalanjiyam’s WhatsApp number every morning at 9 (demo mode: logged here, not really sent).</p>
        {editable && dirty && <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setF(s)}>Undo</Button><Button onClick={() => run(() => api.admin.updateReminderSettings(f), 'Reminder settings saved')}>Save</Button></div>}
      </div>
    </Card>
  )
}
