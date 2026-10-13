import clsx from 'clsx'
import { Bike, Check, ExternalLink, Inbox, Printer, QrCode, ShoppingBag, UtensilsCrossed, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useApp, useData, useNow } from '@/app/AppContext'
import { QrImage } from '@/components/Qr'
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, PageHeader, Segmented, Toggle, useAction } from '@/components/ui'
import { ORDER_TYPE_LABEL, qrSettings } from '@/core/config'
import { itemLabel } from '@/core/orderItem'
import { lineTotal } from '@/core/pricing'
import type { Order, OrderType, QrSettings } from '@/core/types'
import { api } from '@/data'
import { formatPhone } from '@/core/phone'
import { fmtTime, minutesSince, money } from '@/lib/format'

const TYPE_ICON: Record<OrderType, typeof ShoppingBag> = { dine_in: UtensilsCrossed, takeaway: ShoppingBag, delivery: Bike, counter: ShoppingBag }

export default function QrOrders() {
  const { can } = useApp()
  const [tab, setTab] = useState<'inbox' | 'codes' | 'settings'>('inbox')
  const { data: pending = [] } = useData(() => api.qr.pending())
  return (
    <div className="mx-auto max-w-6xl">
      <div className="print:hidden"><PageHeader title="QR Orders" subtitle="Customers scan, order from their phone, and you confirm"
        actions={<Segmented value={tab} onChange={setTab} options={[
          { value: 'inbox', label: 'Orders', count: pending.length },
          { value: 'codes', label: 'QR codes' },
          ...(can('settings.manage') ? [{ value: 'settings' as const, label: 'Settings' }] : []),
        ]} />} /></div>
      {tab === 'inbox' && <InboxView pending={pending} />}
      {tab === 'codes' && <CodesView />}
      {tab === 'settings' && <SettingsView />}
    </div>
  )
}

function InboxView({ pending }: { pending: Order[] }) {
  const { data: recent = [] } = useData(() => api.qr.recent())
  const { data: tables = [] } = useData(() => api.tables.list())
  const done = recent.filter((o) => o.qrStatus !== 'pending')
  const label = (o: Order) => (o.tableId ? `Table ${tables.find((t) => t.id === o.tableId)?.label ?? ''}` : ORDER_TYPE_LABEL[o.type])
  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Waiting for confirmation ({pending.length})</h2>
        {!pending.length ? (
          <Card><EmptyState icon={Inbox} title="No new QR orders" description="New orders appear here with a sound alert. Keep this app open at the counter." /></Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{pending.map((o) => <PendingCard key={o.id} o={o} label={label(o)} />)}</div>
        )}
      </section>
      {done.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Today</h2>
          <Card>
            <ul className="divide-y divide-slate-100">
              {done.map((o) => (
                <li key={o.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                  <span className="font-semibold">{o.number}</span>
                  <Badge tone={o.type === 'dine_in' ? 'violet' : 'blue'}>{label(o)}</Badge>
                  <span className="min-w-0 flex-1 truncate text-slate-500">{o.guest?.name || 'Guest'} · {o.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</span>
                  <span className="text-xs text-slate-400">{fmtTime(o.createdAt)}</span>
                  {o.qrStatus === 'rejected' ? <Badge tone="red">Rejected</Badge> : <Badge tone="green">Accepted</Badge>}
                  <span className="w-16 text-right font-semibold">{money(o.total)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}
    </div>
  )
}

function PendingCard({ o, label }: { o: Order; label: string }) {
  const run = useAction()
  const now = useNow(15000)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const I = TYPE_ICON[o.type]
  return (
    <Card className="flex flex-col border-violet-200 ring-2 ring-violet-100">
      <div className="flex items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div>
          <p className="flex items-center gap-2 font-semibold"><I className="h-4 w-4 text-violet-600" />{label}</p>
          <p className="text-xs text-slate-500">{o.number} · {fmtTime(o.createdAt)} · {minutesSince(o.createdAt, now)}m ago</p>
        </div>
        <span className="text-lg font-bold">{money(o.total)}</span>
      </div>
      {o.guest && (o.guest.name || o.guest.phone) && (
        <div className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs text-slate-600">
          <p className="font-medium text-slate-800">{o.guest.name || 'Guest'} {o.guest.phone && <a href={`tel:${o.guest.phone}`} className="ml-1 text-brand-600">{formatPhone(o.guest.phone)}</a>}</p>
          {o.guest.address && <p className="mt-0.5">📍 {o.guest.address}</p>}
        </div>
      )}
      <ul className="flex-1 space-y-1 px-4 py-3 text-sm">
        {o.items.map((i) => (
          <li key={i.id} className="flex justify-between gap-2">
            <span><b>{i.qty}×</b> {itemLabel(i)}{i.addOns.length > 0 && <span className="text-slate-500"> + {i.addOns.map((a) => a.name).join(', ')}</span>}{i.notes && <span className="block text-xs italic text-amber-700">“{i.notes}”</span>}</span>
            <span className="text-slate-500">{money(lineTotal(i))}</span>
          </li>
        ))}
        {o.notes && <li className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">Note: {o.notes}</li>}
      </ul>
      {rejecting ? (
        <div className="space-y-2 px-4 pb-4">
          <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (e.g. item not available)" />
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>Back</Button>
            <Button size="sm" variant="danger" className="flex-1" onClick={() => run(() => api.qr.reject(o.id, reason || 'Not available right now'), 'Order rejected')}>Reject order</Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 px-4 pb-4">
          <Button variant="secondary" icon={X} onClick={() => setRejecting(true)}>Reject</Button>
          <Button variant="success" icon={Check} className="flex-1" onClick={() => run(() => api.qr.accept(o.id), 'Accepted · sent to kitchen')}>Accept</Button>
        </div>
      )}
    </Card>
  )
}

function CodesView() {
  const { me, t } = useApp()
  const { data: tables = [] } = useData(() => api.tables.list())
  const qr = qrSettings(me!.business)
  const multi = me!.branches.length > 1
  const base = `${qr.baseUrl.replace(/\/$/, '')}/q/${me!.business.id}`
  const outUrl = multi ? `${base}?b=${me!.branch.id}` : base
  const outTypes = qr.orderTypes.filter((x) => x !== 'dine_in')
  const cards = [
    ...(outTypes.length ? [{ key: 'out', title: outTypes.map((x) => ORDER_TYPE_LABEL[x]).join(' & '), sub: multi ? `${me!.branch.name} · counter, poster, social media` : 'Counter, poster, social media', url: outUrl }] : []),
    ...(qr.orderTypes.includes('dine_in') ? tables.filter((x) => !x.mergedInto).map((x) => ({ key: x.id, title: `${t('table')} ${x.label}`, sub: `${multi ? `${me!.branch.name} · ` : ''}${x.floor} · Dine in`, url: `${base}?t=${x.id}` })) : []),
  ]
  const localhost = /localhost|127\.0\.0\.1/.test(qr.baseUrl)
  return (
    <div className="space-y-4">
      {localhost && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 print:hidden">
          The QR codes point to <b>{qr.baseUrl}</b>, which phones can’t open. Set your network address (e.g. <code>http://10.89.33.221:5173</code>) in the <b>Settings</b> tab.
        </div>
      )}
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 print:hidden">
        <b>Demo note:</b> data is saved in this browser only. A real phone scanning the code will see “Menu not available” until the MySQL backend is connected. Use <b>Open</b> on a card to try the customer side in this browser.
      </div>
      <div className="flex justify-end print:hidden"><Button variant="secondary" icon={Printer} onClick={() => window.print()}>Print all</Button></div>
      <div id="qr-sheet" className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.key} className="flex flex-col items-center p-4 text-center break-inside-avoid">
            <p className="text-sm font-semibold text-slate-500">{me!.business.name}</p>
            <QrImage value={c.url} size={150} className="my-3" />
            <p className="text-lg font-bold">{c.title}</p>
            <p className="text-xs text-slate-500">{c.sub}</p>
            <p className="mt-1 text-[11px] font-medium text-brand-600">Scan to see the menu & order</p>
            <a href={c.url} target="_blank" rel="noopener" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-brand-600 print:hidden"><ExternalLink className="h-3.5 w-3.5" />Open</a>
          </Card>
        ))}
        {!cards.length && <Card className="col-span-full"><EmptyState icon={QrCode} title="No QR codes" description="Turn on at least one order type in Settings." /></Card>}
      </div>
    </div>
  )
}

function SettingsView() {
  const { me } = useApp()
  const run = useAction()
  const initial = qrSettings(me!.business)
  const [v, setV] = useState<QrSettings>(initial)
  useEffect(() => setV(qrSettings(me!.business)), [me]) // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(v) !== JSON.stringify(initial)
  const toggle = (x: OrderType, on: boolean) => setV({ ...v, orderTypes: on ? [...v.orderTypes, x] : v.orderTypes.filter((y) => y !== x) })
  return (
    <Card className="max-w-2xl p-5">
      <div className="space-y-6">
        <div>
          <p className="mb-2 text-sm font-medium">Customers can order</p>
          <div className="flex flex-col gap-2">
            {(['dine_in', 'takeaway', 'delivery'] as OrderType[]).map((x) => (
              <Checkbox key={x} checked={v.orderTypes.includes(x)} onChange={(on) => toggle(x, on)}
                label={<span>{ORDER_TYPE_LABEL[x]} <span className="text-xs text-slate-500">{x === 'dine_in' ? '— from the QR on each table' : x === 'takeaway' ? '— name & mobile required' : '— name, mobile & address required'}</span></span>} />
            ))}
          </div>
        </div>
        <div className={clsx('flex items-center justify-between gap-4 rounded-xl border p-4', v.autoAccept ? 'border-amber-200 bg-amber-50' : 'border-slate-200')}>
          <div>
            <p className="text-sm font-medium">Auto-accept orders</p>
            <p className="text-xs text-slate-500">Off (recommended): staff confirm each order first. On: orders go straight to the kitchen.</p>
          </div>
          <Toggle checked={v.autoAccept} onChange={(on) => setV({ ...v, autoAccept: on })} label="Auto-accept" />
        </div>
        <Field label="Public address used in QR codes" hint="The address phones use to reach this app — your network URL now, your domain after going live.">
          <Input value={v.baseUrl} onChange={(e) => setV({ ...v, baseUrl: e.target.value.trim() })} placeholder="http://10.89.33.221:5173" />
        </Field>
        <div className="flex justify-end"><Button disabled={!dirty} onClick={() => run(() => api.business.update({ qr: v }), 'QR settings saved')}>Save</Button></div>
      </div>
    </Card>
  )
}
