import clsx from 'clsx'
import { ArrowLeft, CalendarPlus, Eye, KeyRound, Minus, Pencil, Plus, Power, Store, Trash2, Wand2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useApp, useData } from '@/app/AppContext'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Table, Td, Th, Toggle, useAction } from '@/components/ui'
import { PhoneInput } from '@/components/PhoneInput'
import { formatPhone } from '@/core/phone'
import { api, type Validity } from '@/data'
import { BranchUsage } from './Customers'
import { ExportButtons } from '@/features/ExportData'
import { CredentialCard, fmtDate, fmtDateTime, randomPassword, rupees, StateBadge, useAdminCan, ValidityPicker, validityText } from './shared'

type Detail = Awaited<ReturnType<typeof api.admin.customer>>

const KIND: Record<string, string> = { new: 'New account', renew: 'Renewal', extend: 'Extension', change: 'Plan change' }
const ACTION: Record<string, string> = { support_start: 'Support view', support_end: 'Support ended', create: 'Created', update: 'Updated', password: 'Password reset', renew: 'Validity', branch_limit: 'Branch limit', activate: 'Activated', deactivate: 'Deactivated', delete: 'Deleted', settings: 'Settings', login: 'Login' }

export default function AdminCustomerDetail() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const { data: c, error } = useData(() => api.admin.customer(id), [id])
  const { data: platform } = useData(() => api.admin.settings())
  const [modal, setModal] = useState<null | 'edit' | 'password' | 'renew' | 'status' | 'delete' | 'support'>(null)
  const can = useAdminCan()

  if (error) return <EmptyState icon={Store} title="Customer not found" action={<Button onClick={() => nav('/admin')}>Back to customers</Button>} />
  if (!c || !platform) return null
  const close = () => setModal(null)
  const deactivated = c.state === 'deactivated'

  return (
    <div>
      <Link to="/admin" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" />Customers</Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold">{c.name}</h1><StateBadge state={c.state} /></div>
          <p className="text-sm text-slate-500">{c.onboarded ? c.subType : 'Shop setup not finished yet'} · registered {fmtDate(c.createdAt)}{c.lastActivity ? ` · last bill ${fmtDate(c.lastActivity)}` : ''}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can('customers.support') && <Button variant="secondary" icon={Eye} onClick={() => setModal('support')}>View as customer</Button>}
          {can('customers.edit') && <Button variant="secondary" icon={Pencil} onClick={() => setModal('edit')}>Edit</Button>}
          {can('customers.password') && <Button variant="secondary" icon={KeyRound} onClick={() => setModal('password')}>Reset password</Button>}
          {can('customers.status') && <Button variant="secondary" icon={Power} onClick={() => setModal('status')} className={deactivated ? '!text-emerald-700' : '!text-amber-700'}>{deactivated ? 'Activate' : 'Deactivate'}</Button>}
          {can('customers.delete') && <Button variant="secondary" icon={Trash2} onClick={() => setModal('delete')} className="!text-red-600">Delete</Button>}
        </div>
      </div>

      {c.state === 'expired' && <Notice tone="red">Subscription expired on {fmtDate(c.endAt)}. The customer can sign in and view data, but can’t create, change or delete anything until you renew.</Notice>}
      {deactivated && <Notice tone="slate">This account is deactivated — the customer and their staff can’t sign in. Data is kept.</Notice>}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5">
          <h2 className="mb-3 font-semibold">Account</h2>
          <dl className="space-y-2 text-sm">
            <Row k="Owner">{c.ownerName || '—'}</Row>
            <Row k="Username"><span className="font-mono font-semibold">{c.username || '—'}</span></Row>
            <Row k="Mobile (login)">{formatPhone(c.phone) || '—'}</Row>
            <Row k="Email">{c.email || '—'}</Row>
            <Row k="Business type">{c.onboarded ? `${c.category} · ${c.subType}` : '—'}</Row>
            <Row k="Last login">{c.lastLoginAt ? fmtDateTime(c.lastLoginAt) : 'Never'}</Row>
            <Row k="Usage">{c.usage.bills} bills · {c.usage.products} items · {c.usage.staff} staff · {c.usage.customers} customers</Row>
            {c.adminNote && <Row k="Note">{c.adminNote}</Row>}
          </dl>
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Subscription</h2>{can('customers.renew') && <Button size="sm" icon={CalendarPlus} onClick={() => setModal('renew')}>{c.state === 'expired' ? 'Renew' : 'Extend'}</Button>}</div>
          <dl className="space-y-2 text-sm">
            <Row k="Status"><StateBadge state={c.state} /></Row>
            <Row k="Started">{fmtDate(c.startAt)}</Row>
            <Row k="Valid until"><b>{fmtDate(c.endAt)}</b></Row>
            <Row k="Remaining"><span className={clsx(c.state === 'expired' ? 'text-red-700' : c.state === 'expiring' ? 'text-amber-700' : '')}>{validityText(c.state, c.daysLeft, c.endAt)}</span></Row>
            <Row k="Price">{rupees(c.monthlyPrice)} / month <span className="text-slate-400">({c.maxBranches} × {rupees(platform.pricePerBranchMonth)})</span></Row>
          </dl>
        </Card>

        <BranchCard c={c} price={platform.pricePerBranchMonth} editable={can('customers.branches')} />
      </div>

      <FeaturesCard c={c} editable={can('features.manage')} />
      {can('customers.edit') && (
        <Card className="mt-4 flex flex-wrap items-center gap-4 px-5 py-3">
          <div className="min-w-0 flex-1"><p className="text-sm font-medium">Export customer data</p><p className="text-xs text-slate-500">Everything this customer has — bills, items, customers, stock, staff, payments. Passwords are never included. Logged in the audit log.</p></div>
          <ExportButtons size="sm" load={() => api.admin.exportCustomer(c.id)} />
        </Card>
      )}

      <Card className="mt-4">
        <div className="border-b border-slate-100 px-5 py-3"><h2 className="font-semibold">Subscription history</h2></div>
        <Table>
          <thead><tr><Th>Type</Th><Th>Period</Th><Th>Branches</Th><Th className="text-right">Amount</Th><Th>Note</Th><Th>Added</Th></tr></thead>
          <tbody>
            {c.periods.map((p) => (
              <tr key={p.id}>
                <Td><Badge tone={p.kind === 'new' ? 'blue' : 'green'}>{KIND[p.kind]}</Badge></Td>
                <Td className="text-sm">{fmtDate(p.startAt)} → {fmtDate(p.endAt)}{p.months ? <span className="text-slate-400"> · {p.months} mo</span> : <span className="text-slate-400"> · custom</span>}</Td>
                <Td className="tabular">{p.branches}</Td>
                <Td className="text-right font-medium tabular">{rupees(p.amount)}</Td>
                <Td className="max-w-[220px] truncate text-sm text-slate-600">{p.note || '—'}</Td>
                <Td className="text-sm text-slate-500">{fmtDate(p.createdAt)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card className="mt-4">
        <div className="border-b border-slate-100 px-5 py-3"><h2 className="font-semibold">Admin activity</h2></div>
        {c.history.length ? (
          <ul className="divide-y divide-slate-100">
            {c.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-5 py-2.5 text-sm">
                <Badge>{ACTION[h.action] ?? h.action}</Badge><span className="flex-1 text-slate-700">{h.detail}</span>
                <span className="text-xs text-slate-500">{h.adminName} · {fmtDateTime(h.at)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="px-5 py-6 text-sm text-slate-500">No admin changes yet.</p>}
      </Card>

      {modal === 'edit' && <EditModal c={c} onClose={close} />}
      {modal === 'password' && <PasswordModal c={c} onClose={close} />}
      {modal === 'renew' && <RenewModal c={c} price={platform.pricePerBranchMonth} onClose={close} />}
      {modal === 'status' && <StatusModal c={c} onClose={close} />}
      {modal === 'support' && <SupportModal c={c} onClose={close} />}
      {modal === 'delete' && <DeleteModal c={c} onClose={close} onDeleted={() => nav('/admin', { replace: true })} />}
    </div>
  )
}

const Row = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className="grid grid-cols-[110px_1fr] gap-2"><dt className="text-slate-500">{k}</dt><dd className="min-w-0 break-words text-slate-800">{children}</dd></div>
)
const Notice = ({ tone, children }: { tone: 'red' | 'slate'; children: ReactNode }) => (
  <div className={clsx('mb-4 rounded-xl px-4 py-3 text-sm', tone === 'red' ? 'bg-red-50 text-red-800' : 'bg-slate-100 text-slate-700')}>{children}</div>
)

function BranchCard({ c, price, editable }: { c: Detail; price: number; editable: boolean }) {
  const run = useAction()
  const [max, setMax] = useState(c.maxBranches)
  const dirty = max !== c.maxBranches
  return (
    <Card className="p-5">
      <h2 className="mb-3 font-semibold">Branches</h2>
      <div className="flex items-center justify-between gap-3">
        <BranchUsage used={c.branchesUsed} max={c.maxBranches} />
        {editable && <div className="flex items-center gap-1.5">
          <button type="button" aria-label="Fewer branches" disabled={max <= Math.max(1, c.branchesUsed)} onClick={() => setMax(max - 1)} className="rounded-lg border border-slate-200 p-1.5 disabled:opacity-40"><Minus className="h-4 w-4" /></button>
          <span className="w-8 text-center text-lg font-semibold tabular">{max}</span>
          <button type="button" aria-label="More branches" disabled={max >= 100} onClick={() => setMax(max + 1)} className="rounded-lg border border-slate-200 p-1.5 disabled:opacity-40"><Plus className="h-4 w-4" /></button>
        </div>}
      </div>
      <p className="mt-2 text-xs text-slate-500">Allowed branches. Can’t go below the {c.branchesUsed} already created. Price {rupees(max * price)}/month.</p>
      {dirty && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={() => run(() => api.admin.setBranchLimit(c.id, max), `Branch limit set to ${max}`)}>Save limit</Button>
          <Button size="sm" variant="ghost" onClick={() => setMax(c.maxBranches)}>Undo</Button>
        </div>
      )}
      <ul className="mt-4 divide-y divide-slate-100 border-t border-slate-100 text-sm">
        {c.branches.map((b) => (
          <li key={b.id} className="flex items-center justify-between py-2">
            <span className="flex items-center gap-2">{b.name}{b.isDefault && <Badge>Main</Badge>}{!b.active && <Badge tone="amber">Closed</Badge>}</span>
            <span className="text-xs text-slate-500">{b.bills} bills</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function EditModal({ c, onClose }: { c: Detail; onClose: () => void }) {
  const run = useAction()
  const [f, setF] = useState({ businessName: c.name === '(setup not finished)' ? '' : c.name, ownerName: c.ownerName, username: c.username, phone: c.phone, email: c.email, adminNote: c.adminNote })
  return (
    <Modal open onClose={onClose} title="Edit customer">
      <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.admin.updateCustomer(c.id, f), 'Customer updated')) onClose() }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Business name"><Input required value={f.businessName} onChange={(e) => setF({ ...f, businessName: e.target.value })} /></Field>
          <Field label="Owner name"><Input required value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} /></Field>
          <Field label="Username" hint="Changing it changes how the customer signs in"><Input required value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase().replace(/\s/g, '') })} className="font-mono" /></Field>
          <Field label="Mobile number (login ID)"><PhoneInput required value={f.phone} onChange={(v) => setF({ ...f, phone: v })} /></Field>
          <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Note (admins only)"><Input value={f.adminNote} onChange={(e) => setF({ ...f, adminNote: e.target.value })} /></Field>
        </div>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit">Save</Button></div>
      </form>
    </Modal>
  )
}

function PasswordModal({ c, onClose }: { c: Detail; onClose: () => void }) {
  const run = useAction()
  const [pw, setPw] = useState(randomPassword)
  const [done, setDone] = useState(false)
  return (
    <Modal open onClose={onClose} size="sm" title="Reset password" subtitle={`New password for ${c.username || c.ownerName}. The old one stops working.`}>
      {done ? (
        <><CredentialCard phone={c.phone} username={c.username} password={pw} businessName={c.name} /><div className="mt-4 flex justify-end"><Button onClick={onClose}>Done</Button></div></>
      ) : (
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.admin.resetPassword(c.id, pw), 'Password reset')) setDone(true) }}>
          <Field label="New password" hint="At least 6 characters">
            <div className="flex gap-1.5">
              <Input required minLength={6} value={pw} onChange={(e) => setPw(e.target.value)} className="font-mono" autoComplete="new-password" />
              <Button type="button" variant="secondary" icon={Wand2} onClick={() => setPw(randomPassword())} aria-label="New password" title="Generate" />
            </div>
          </Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" icon={KeyRound}>Reset password</Button></div>
        </form>
      )}
    </Modal>
  )
}

function RenewModal({ c, price, onClose }: { c: Detail; price: number; onClose: () => void }) {
  const run = useAction()
  const [v, setV] = useState<Validity>({ months: 1 })
  const [note, setNote] = useState('')
  const expired = c.state === 'expired' || !c.endAt
  const from = expired ? new Date() : new Date(new Date(c.endAt!).getTime() + 1)
  return (
    <Modal open onClose={onClose} title={expired ? 'Renew subscription' : 'Extend subscription'}
      subtitle={expired ? 'Starts today. The account becomes fully usable again right away.' : `Added after the current end date (${fmtDate(c.endAt)}).`}>
      <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.admin.renew(c.id, v, note), expired ? 'Subscription renewed' : 'Subscription extended')) onClose() }}>
        <ValidityPicker value={v} onChange={setV} from={from} branches={c.maxBranches} pricePerBranch={price} />
        <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Paid ₹2,994 by UPI" /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" icon={CalendarPlus} disabled={'endDate' in v && !v.endDate}>{expired ? 'Renew' : 'Extend'}</Button></div>
      </form>
    </Modal>
  )
}

function StatusModal({ c, onClose }: { c: Detail; onClose: () => void }) {
  const run = useAction()
  const activate = c.state === 'deactivated'
  const [reason, setReason] = useState('')
  return (
    <Modal open onClose={onClose} size="sm" title={activate ? `Activate ${c.name}?` : `Deactivate ${c.name}?`}
      subtitle={activate ? 'The owner and staff can sign in again.' : 'The owner and all staff are signed out and can’t sign in. No data is deleted.'}>
      <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.admin.setStatus(c.id, activate ? 'active' : 'deactivated', reason), activate ? 'Account activated' : 'Account deactivated')) onClose() }}>
        <Field label="Reason (saved in the audit log)"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={activate ? 'e.g. Payment received' : 'e.g. Payment pending'} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" variant={activate ? 'success' : 'danger'} icon={Power}>{activate ? 'Activate' : 'Deactivate'}</Button></div>
      </form>
    </Modal>
  )
}

function DeleteModal({ c, onClose, onDeleted }: { c: Detail; onClose: () => void; onDeleted: () => void }) {
  const run = useAction()
  const [typed, setTyped] = useState('')
  return (
    <Modal open onClose={onClose} size="sm" title="Delete customer permanently?">
      <div className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-800">
        Tip: export the data first (Excel / ZIP on the customer page) if the customer may want it.<br />This deletes <b>{c.name}</b> and all its data — {c.usage.bills} bills, {c.usage.products} items, {c.usage.customers} customers, {c.branches.length} branch{c.branches.length === 1 ? '' : 'es'}, staff logins and payments. <b>This can’t be undone.</b>
      </div>
      <form className="mt-4 space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.admin.deleteCustomer(c.id, typed), 'Customer deleted')) onDeleted() }}>
        <Field label={`Type the business name to confirm: ${c.name}`}><Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" variant="danger" icon={Trash2} disabled={typed.trim() !== c.name}>Delete permanently</Button></div>
      </form>
    </Modal>
  )
}

/** Opens the customer's app here, read-only, as the owner. The reason goes into the audit log. */
function SupportModal({ c, onClose }: { c: Detail; onClose: () => void }) {
  const run = useAction()
  const { refresh } = useApp()
  const nav = useNavigate()
  const [reason, setReason] = useState('')
  return (
    <Modal open onClose={onClose} size="sm" title={`View ${c.name} as the customer`}
      subtitle="Opens their app in this tab exactly as the owner sees it. Read-only: nothing can be changed. Start and end are recorded in the audit log.">
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault()
        if (await run(() => api.admin.startSupport(c.id, reason))) { await refresh(); nav('/', { replace: true }) }
      }}>
        <Field label="Why are you opening this account?"><Input autoFocus required minLength={4} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer says GST is wrong on bills" /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" icon={Eye} disabled={reason.trim().length < 4}>Open support view</Button></div>
      </form>
    </Modal>
  )
}

const WA_STATE: Record<string, string> = { off: 'Not released', not_set_up: 'Not set up yet', incomplete: 'Setup in progress', connected: 'Connected' }

/** Features released to this customer (flags live on the Features page). */
function FeaturesCard({ c, editable }: { c: Detail; editable: boolean }) {
  const run = useAction()
  return (
    <Card className="mt-4">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3"><h2 className="font-semibold">Features</h2><Link to="/admin/features" className="text-sm text-brand-700 hover:underline">All releases</Link></div>
      <div className="flex flex-wrap items-center gap-4 px-5 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">WhatsApp integration</p>
          <p className="text-xs text-slate-500">{c.features.whatsapp ? `On · customer: ${WA_STATE[c.whatsappState] ?? c.whatsappState}` : 'Off — Settings → Integrations is hidden for this customer'}</p>
        </div>
        <Toggle checked={c.features.whatsapp} disabled={!editable} label="WhatsApp integration"
          onChange={(v) => run(() => api.admin.setCustomerFeature(c.id, 'whatsapp', v), v ? 'WhatsApp turned on for this customer' : 'WhatsApp turned off for this customer')} />
      </div>
    </Card>
  )
}
