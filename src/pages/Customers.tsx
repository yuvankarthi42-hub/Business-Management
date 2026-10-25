import { BellOff, Clock, IndianRupee, MessageCircle, Pencil, Phone, Plus, ShieldCheck, UserPlus, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { Badge, Button, Card, Checkbox, Drawer, EmptyState, Field, Input, Modal, PageHeader, SearchInput, Segmented, Select, Stat, Table, Td, Textarea, Th, useAction } from '@/components/ui'
import { PAYMENT_LABEL } from '@/core/config'
import type { Customer, PaymentMethod } from '@/core/types'
import { api } from '@/data'
import { wholesaleLabel, wholesaleOn } from '@/core/orderItem'
import { fmtDate, fmtDateTime, money } from '@/lib/format'
import { statusBadge } from './Orders'
import { PhoneInput } from '@/components/PhoneInput'
import { formatPhone, phoneMatches } from '@/core/phone'
import { OfferShareDrawer } from '@/features/OfferShare'
import { GstinInput, StateSelect } from '@/features/gst/GstFields'
import { gstinState, isInterState, shopStateOf, stateLabel } from '@/core/gst'
import { loyaltyOf } from '@/core/loyalty'
import { CustomerPoints } from '@/features/loyalty/Points'
import { useWhatsApp } from '@/features/whatsapp/useWhatsApp'

export default function Customers() {
  const { t, me } = useApp()
  const { data: customers } = useData(() => api.customers.list())
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'due'>('all')
  const [open, setOpen] = useState<string | null>(null)
  const [edit, setEdit] = useState<Partial<Customer> | null>(null)
  const [share, setShare] = useState(false)
  // WhatsApp offers appear only after the integration is set up and the offer template is approved.
  const wa = useWhatsApp()
  const list = useMemo(() => (customers ?? [])
    .filter((c) => (filter === 'all' || c.stats.outstanding > 0) && (!q || c.name.toLowerCase().includes(q.toLowerCase()) || phoneMatches(c.phone, q)))
    .sort((a, b) => (filter === 'due' ? b.stats.outstanding - a.stats.outstanding : b.stats.totalPurchases - a.stats.totalPurchases)), [customers, q, filter])
  const dueCount = customers?.filter((c) => c.stats.outstanding > 0).length ?? 0
  const receivable = customers?.reduce((a, c) => a + c.stats.outstanding, 0) ?? 0
  const pointsOn = !!me && (loyaltyOf(me.business).enabled || !!customers?.some((c) => c.pointsBalance))

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title={t('customer', true)} actions={<>
        <Button variant="secondary" icon={UserPlus} onClick={() => setEdit({})}>Add {t('customer')}</Button>
        {wa?.ready.offer && <Button variant="success" icon={MessageCircle} onClick={() => setShare(true)}>Send offer</Button>}
      </>} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat icon={Users} label={`Total ${t('customer', true).toLowerCase()}`} value={customers?.length ?? '—'} />
        <Stat icon={Clock} tone="amber" label="With outstanding" value={dueCount} />
        <Stat icon={IndianRupee} tone="red" label="Total receivable" value={money(receivable)} />
      </div>
      <Card>
        <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row">
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or phone" className="flex-1" />
          <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'due', label: 'Outstanding', count: dueCount }]} />
        </div>
        {customers && !list.length ? <EmptyState icon={Users} title={`No ${t('customer', true).toLowerCase()} found`} /> : (
          <Table>
            <thead><tr><Th>{t('customer')}</Th><Th className="hidden sm:table-cell">Phone</Th><Th className="text-right">Purchases</Th><Th className="hidden text-right md:table-cell">{t('order', true)}</Th><Th className="hidden lg:table-cell">Last visit</Th>{pointsOn && <Th className="text-right">Points</Th>}<Th className="text-right">Outstanding</Th></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} onClick={() => setOpen(c.id)} className="cursor-pointer hover:bg-slate-50">
                  <Td><div className="flex items-center gap-2.5"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-sm font-semibold text-brand-700">{c.name[0]}</span><span className="font-medium text-slate-900">{c.name}</span>{c.priceTier === 'wholesale' && me && wholesaleOn(me.business.billing) && <Badge tone="violet">{wholesaleLabel(me.business.billing)}</Badge>}{c.gstin && <Badge tone="blue">B2B</Badge>}{c.marketingOptIn === false && <span title="Doesn’t want offers"><BellOff className="h-3.5 w-3.5 text-slate-400" /></span>}</div></Td>
                  <Td className="hidden whitespace-nowrap text-slate-500 tabular sm:table-cell">{formatPhone(c.phone) || '—'}</Td>
                  <Td className="text-right tabular">{money(c.stats.totalPurchases)}</Td>
                  <Td className="hidden text-right tabular md:table-cell">{c.stats.orderCount}</Td>
                  <Td className="hidden text-slate-500 lg:table-cell">{c.stats.lastPurchase ? fmtDate(c.stats.lastPurchase) : '—'}</Td>
                  {pointsOn && <Td className="text-right tabular">{c.pointsBalance ? <span className="font-medium text-violet-700">{c.pointsBalance}</span> : <span className="text-slate-400">—</span>}</Td>}
                  <Td className="text-right">{c.stats.outstanding > 0 ? <span className="font-semibold text-amber-700">{money(c.stats.outstanding)}</span> : <span className="text-slate-400">—</span>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {open && <CustomerProfile id={open} onClose={() => setOpen(null)} onEdit={(c) => setEdit(c)} />}
      {edit && <CustomerForm initial={edit} onClose={() => setEdit(null)} />}
      {share && wa?.ready.offer && <OfferShareDrawer onClose={() => setShare(false)} />}
    </div>
  )
}

function CustomerProfile({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (c: Customer) => void }) {
  const { t, can } = useApp()
  const { data: customers = [] } = useData(() => api.customers.list())
  const { data: hist } = useData(() => api.customers.history(id), [id])
  const [collect, setCollect] = useState(false)
  const c = customers.find((x) => x.id === id)
  if (!c) return null
  return (
    <Drawer open onClose={onClose} width="max-w-lg" title={c.name} subtitle={<span className="flex items-center gap-1"><Phone className="h-3.5 w-3.5" />{c.phone ? <a href={`tel:${c.phone}`} className="hover:underline">{formatPhone(c.phone)}</a> : 'No phone'}{c.email && ` · ${c.email}`}</span>}>
      <div className="space-y-5 p-5">
        <div className="grid grid-cols-3 gap-2">
          <Mini k="Total purchases" v={money(c.stats.totalPurchases)} />
          <Mini k={t('order', true)} v={String(c.stats.orderCount)} />
          <Mini k="Last visit" v={c.stats.lastPurchase ? fmtDate(c.stats.lastPurchase) : '—'} />
        </div>
        <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div><p className="text-xs font-medium text-amber-800">Outstanding</p><p className="text-2xl font-bold text-amber-900">{money(c.stats.outstanding)}</p></div>
          {c.stats.outstanding > 0 && can('payments.collect') && <Button variant="primary" icon={IndianRupee} onClick={() => setCollect(true)}>Record Payment</Button>}
        </div>
        <p className="flex items-center gap-1.5 text-sm text-slate-600">{c.marketingOptIn === false ? <><BellOff className="h-4 w-4 text-slate-400" />Doesn’t want offers on WhatsApp</> : <><ShieldCheck className="h-4 w-4 text-emerald-600" />OK to send offers on WhatsApp</>}</p>
        {(c.address || c.notes) && <div className="space-y-1 text-sm text-slate-600">{c.address && <p>📍 {c.address}</p>}{c.notes && <p>📝 {c.notes}</p>}</div>}
        {(c.gstin || c.stateCode) && <p className="text-sm text-slate-600">{c.gstin ? <>GSTIN <span className="font-mono">{c.gstin}</span> · </> : ''}{stateLabel(gstinState(c.gstin) ?? c.stateCode)}</p>}
        <Button size="sm" variant="secondary" icon={Pencil} onClick={() => onEdit(c)}>Edit details</Button>
        <CustomerPoints customer={c} />

        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Purchase history</h4>
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {hist?.orders.slice(0, 30).map((o) => {
              const b = statusBadge(o)
              return (
                <li key={o.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                  <div className="min-w-0 flex-1"><p className="font-medium">{o.invoiceNumber ?? o.number}</p><p className="truncate text-xs text-slate-500">{fmtDateTime(o.createdAt)} · {o.items.length} items</p></div>
                  <Badge tone={b.tone}>{b.label}</Badge>
                  <span className="w-20 text-right font-semibold tabular">{money(o.total)}</span>
                </li>
              )
            })}
            {hist && !hist.orders.length && <li className="px-3 py-6 text-center text-sm text-slate-400">No purchases yet</li>}
          </ul>
        </section>
        {hist && hist.payments.some((p) => p.kind === 'due_collection') && (
          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Due payments received</h4>
            <ul className="space-y-1.5">
              {hist.payments.filter((p) => p.kind === 'due_collection').map((p) => (
                <li key={p.id} className="flex justify-between text-sm"><span className="text-slate-600">{fmtDateTime(p.createdAt)} · {PAYMENT_LABEL[p.method]}</span><span className="font-medium text-emerald-700">{money(p.amount)}</span></li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {collect && <CollectDueModal customer={c} outstanding={c.stats.outstanding} onClose={() => setCollect(false)} />}
    </Drawer>
  )
}

const Mini = ({ k, v }: { k: string; v: string }) => <div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] text-slate-500">{k}</p><p className="mt-0.5 text-sm font-semibold">{v}</p></div>

export function CollectDueModal({ customer, outstanding, onClose }: { customer: Customer; outstanding: number; onClose: () => void }) {
  const { me } = useApp()
  const run = useAction()
  const [amount, setAmount] = useState(String(outstanding))
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [ref, setRef] = useState('')
  return (
    <Modal open onClose={onClose} size="sm" title={`Record payment — ${customer.name}`} subtitle={`Outstanding ${money(outstanding)}. Applied to the oldest bills first.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="success" onClick={async () => { if (await run(() => api.customers.collectDue(customer.id, Number(amount), method, ref), 'Payment recorded')) onClose() }}>Save {money(Number(amount) || 0)}</Button></>}>
      <div className="space-y-4">
        <Field required label="Amount (₹)"><Input autoFocus type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-12 text-lg font-semibold" /></Field>
        <Field required label="Method">
          <Select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
            {me!.business.billing.paymentMethods.filter((m) => m !== 'credit').map((m) => <option key={m} value={m}>{PAYMENT_LABEL[m]}</option>)}
          </Select>
        </Field>
        <Field label="Reference (optional)"><Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="UPI ref / cheque no." /></Field>
      </div>
    </Modal>
  )
}

function CustomerForm({ initial, onClose }: { initial: Partial<Customer>; onClose: () => void }) {
  const { t, me } = useApp()
  const run = useAction()
  const [c, setC] = useState<Partial<Customer>>({ name: '', phone: '', email: '', address: '', notes: '', ...initial })
  return (
    <Modal open onClose={onClose} title={initial.id ? `Edit ${t('customer').toLowerCase()}` : `Add ${t('customer').toLowerCase()}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button icon={Plus} onClick={async () => { if (await run(() => api.customers.save({ ...c, name: c.name ?? '' }), 'Saved')) onClose() }}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field required label="Name"><Input autoFocus value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></Field>
        <div><span className="mb-1.5 block text-xs font-medium text-slate-600">Mobile</span><PhoneInput value={c.phone ?? ''} onChange={(v) => setC({ ...c, phone: v })} defaultCountry={me?.business.defaultCountry} /></div>
        <Field label="Email" className="sm:col-span-2"><Input type="email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} /></Field>
        <Field label="Address" className="sm:col-span-2"><Textarea value={c.address} onChange={(e) => setC({ ...c, address: e.target.value })} /></Field>
        <Field label="Notes" className="sm:col-span-2"><Input value={c.notes} onChange={(e) => setC({ ...c, notes: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Checkbox checked={c.marketingOptIn !== false} onChange={(v) => setC({ ...c, marketingOptIn: v })} label="OK to send offers and specials on WhatsApp" /></div>
        {me?.business.billing.taxEnabled && (
          <div className="grid gap-4 rounded-xl border border-slate-200 p-3 sm:col-span-2 sm:grid-cols-2">
            <p className="text-xs font-medium text-slate-600 sm:col-span-2">GST — for business customers (B2B tax invoice)</p>
            <GstinInput value={c.gstin ?? ''} onChange={(v) => setC({ ...c, gstin: v })} hint="Their bills show this GSTIN" />
            {!gstinState(c.gstin) ? (
              <StateSelect value={c.stateCode} onChange={(v) => setC({ ...c, stateCode: v })} label="State (place of supply)" hint="Only for customers from another state — the bill then has IGST" />
            ) : (
              <div className="text-xs text-slate-500 sm:pt-6">State from the GSTIN: <b className="text-slate-700">{stateLabel(gstinState(c.gstin))}</b>{isInterState(shopStateOf(me.business), gstinState(c.gstin)) ? ' — another state, so bills have IGST.' : '.'}</div>
            )}
          </div>
        )}
        {me && wholesaleOn(me.business.billing) && (
          <div className="sm:col-span-2 rounded-xl border border-slate-200 p-3">
            <p className="mb-2 text-xs font-medium text-slate-600">Price list for this {t('customer').toLowerCase()}</p>
            <Segmented size="sm" value={c.priceTier ?? 'retail'} onChange={(v) => setC({ ...c, priceTier: v })} options={[{ value: 'retail', label: 'Retail price' }, { value: 'wholesale', label: wholesaleLabel(me.business.billing) }]} />
            <p className="mt-1.5 text-xs text-slate-500">{c.priceTier === 'wholesale' ? `Bills for this ${t('customer').toLowerCase()} use the ${wholesaleLabel(me.business.billing).toLowerCase()} automatically.` : 'Normal shop prices.'}</p>
          </div>
        )}
      </div>
    </Modal>
  )
}
