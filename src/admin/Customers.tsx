import clsx from 'clsx'
import { ChevronRight, Plus, Users, Wand2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useData } from '@/app/AppContext'
import { Button, Card, Chips, EmptyState, Field, Input, Modal, SearchInput, Table, Td, Th, useAction } from '@/components/ui'
import { PhoneInput } from '@/components/PhoneInput'
import { formatPhone, isValidPhone, phoneMatches } from '@/core/phone'
import type { SubState } from '@/core/subscription'
import { api, type Validity } from '@/data'
import { CredentialCard, fmtDate, randomPassword, rupees, StateBadge, useAdminCan, ValidityPicker, validityText } from './shared'

type Filter = 'all' | SubState

export default function AdminCustomers() {
  const nav = useNavigate()
  const can = useAdminCan()
  const { data: rows = [] } = useData(() => api.admin.customers())
  const { data: platform } = useData(() => api.admin.settings())
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<{ id: string; username: string; password: string; businessName: string; phone: string } | null>(null)

  const count = (s: SubState) => rows.filter((r) => r.state === s).length
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return rows.filter((r) => (filter === 'all' || r.state === filter)
      && (!s || r.name.toLowerCase().includes(s) || r.username.includes(s) || r.ownerName.toLowerCase().includes(s) || phoneMatches(r.phone, s) || r.email.includes(s)))
  }, [rows, q, filter])
  const monthly = rows.filter((r) => r.state !== 'deactivated' && r.state !== 'expired').reduce((a, r) => a + r.monthlyPrice, 0)

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Customers</h1>
          <p className="text-sm text-slate-500">Every business using Kadai Kalanjiyam — accounts, validity and branch limits.</p>
        </div>
        {can('customers.create') && <Button icon={Plus} onClick={() => setCreating(true)}>New customer</Button>}
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Customers" value={rows.length} />
        <Stat label="Active" value={count('active')} tone="text-emerald-700" />
        <Stat label="Expiring in 7 days" value={count('expiring')} tone="text-amber-700" />
        <Stat label="Expired (read-only)" value={count('expired')} tone="text-red-700" />
        <Stat label="Deactivated" value={count('deactivated')} tone="text-slate-500" />
        <Stat label="Monthly value" value={rupees(monthly)} hint={platform ? `${rupees(platform.pricePerBranchMonth)} per branch` : undefined} />
      </div>

      <Card>
        <div className="space-y-3 border-b border-slate-100 p-3">
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search business, owner, username, mobile or email" className="max-w-lg" />
          <Chips value={filter} onChange={setFilter} options={[
            { value: 'all', label: `All (${rows.length})` },
            { value: 'active', label: `Active (${count('active')})` },
            { value: 'expiring', label: `Expiring soon (${count('expiring')})` },
            { value: 'expired', label: `Expired (${count('expired')})` },
            { value: 'deactivated', label: `Deactivated (${count('deactivated')})` },
          ]} />
        </div>
        {!list.length ? <EmptyState icon={Users} title={rows.length ? 'No customer matches' : 'No customers yet'} action={!rows.length && can('customers.create') ? <Button icon={Plus} onClick={() => setCreating(true)}>New customer</Button> : undefined} /> : (
          <Table>
            <thead><tr><Th>Customer</Th><Th>Owner / username</Th><Th>Status</Th><Th>Validity</Th><Th>Branches</Th><Th>Registered</Th><Th /></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => nav(`/admin/customers/${r.id}`)}>
                  <Td>
                    <p className="font-medium text-slate-900">{r.name}</p>
                    <p className="text-xs text-slate-500">{r.onboarded ? r.subType : 'Setup not finished'}</p>
                  </Td>
                  <Td>
                    <p className="text-slate-800">{r.ownerName}</p>
                    <p className="font-mono text-xs text-slate-500">{r.username || '—'}{r.phone && <span className="font-sans"> · {formatPhone(r.phone)}</span>}</p>
                  </Td>
                  <Td><StateBadge state={r.state} /></Td>
                  <Td className={clsx('text-sm', r.state === 'expired' ? 'text-red-700' : r.state === 'expiring' ? 'text-amber-700' : 'text-slate-600')}>{validityText(r.state, r.daysLeft, r.endAt)}</Td>
                  <Td><BranchUsage used={r.branchesUsed} max={r.maxBranches} /></Td>
                  <Td className="text-sm text-slate-600">{fmtDate(r.createdAt)}</Td>
                  <Td className="text-right"><ChevronRight className="inline h-4 w-4 text-slate-400" /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {creating && platform && <CreateCustomerModal pricePerBranch={platform.pricePerBranchMonth} onClose={() => setCreating(false)} onCreated={(c) => { setCreating(false); setCreated(c) }} />}
      {created && (
        <Modal open onClose={() => setCreated(null)} size="sm" title="Customer created" subtitle="Send these login details to the customer. They sign in and finish the shop setup.">
          <CredentialCard phone={created.phone} username={created.username} password={created.password} businessName={created.businessName} />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreated(null)}>Close</Button>
            <Button onClick={() => nav(`/admin/customers/${created.id}`)}>Open customer</Button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function Stat({ label, value, tone, hint }: { label: string; value: number | string; tone?: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-card">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={clsx('mt-1 text-2xl font-semibold tabular', tone ?? 'text-slate-900')}>{value}</p>
      {hint && <p className="text-[11px] text-slate-400">{hint}</p>}
    </div>
  )
}

export function BranchUsage({ used, max }: { used: number; max: number }) {
  const pct = Math.min(100, (used / Math.max(1, max)) * 100)
  return (
    <div className="w-28">
      <p className="text-sm tabular"><b>{used}</b><span className="text-slate-500"> of {max}</span></p>
      <div className="mt-1 h-1.5 rounded-full bg-slate-100"><div className={clsx('h-1.5 rounded-full', used >= max ? 'bg-amber-500' : 'bg-brand-500')} style={{ width: `${pct}%` }} /></div>
    </div>
  )
}

function CreateCustomerModal({ pricePerBranch, onClose, onCreated }: { pricePerBranch: number; onClose: () => void; onCreated: (c: { id: string; username: string; password: string; businessName: string; phone: string }) => void }) {
  const run = useAction()
  const [f, setF] = useState({ businessName: '', ownerName: '', username: '', password: randomPassword(), phone: '', email: '', maxBranches: 1, note: '' })
  const [validity, setValidity] = useState<Validity>({ months: 1 })
  const [touchedUser, setTouchedUser] = useState(false)
  const suggest = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20)
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }))
  const ready = f.businessName.trim() && f.ownerName.trim() && isValidPhone(f.phone) && f.username.trim().length >= 4 && f.password.length >= 6 && ('months' in validity || validity.endDate)

  return (
    <Modal open onClose={onClose} size="lg" title="New customer" subtitle="Creates the business and its owner login. The customer can’t sign up on their own.">
      <form className="space-y-5" onSubmit={async (e) => {
        e.preventDefault()
        let res: { id: string; username: string } | null = null
        const ok = await run(async () => { res = await api.admin.createCustomer({ ...f, validity }) })
        if (ok && res) onCreated({ ...(res as { id: string; username: string }), password: f.password, businessName: f.businessName.trim(), phone: f.phone })
      }}>
        <section className="grid gap-4 sm:grid-cols-2">
          <Field required label="Business name"><Input autoFocus required value={f.businessName} onChange={(e) => set({ businessName: e.target.value, ...(touchedUser ? {} : { username: suggest(e.target.value) }) })} placeholder="e.g. Sri Murugan Stores" /></Field>
          <Field required label="Owner name"><Input required value={f.ownerName} onChange={(e) => set({ ownerName: e.target.value })} placeholder="e.g. Murugan" /></Field>
          <Field required label="Mobile number (login ID)" hint="The owner signs in with this number"><PhoneInput required value={f.phone} onChange={(v) => set({ phone: v })} /></Field>
          <Field label="Email (optional)"><Input type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} placeholder="owner@shop.com" /></Field>
        </section>

        <section className="rounded-xl border border-slate-200 p-4">
          <p className="mb-3 text-sm font-semibold">Login</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field required label="Username" hint="4–30 letters or numbers, no spaces">
              <Input required value={f.username} onChange={(e) => { setTouchedUser(true); set({ username: e.target.value.toLowerCase().replace(/\s/g, '') }) }} className="font-mono" autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field required label="Password" hint="At least 6 characters">
              <div className="flex gap-1.5">
                <Input required minLength={6} value={f.password} onChange={(e) => set({ password: e.target.value })} className="font-mono" autoComplete="new-password" />
                <Button type="button" variant="secondary" icon={Wand2} onClick={() => set({ password: randomPassword() })} aria-label="New password" title="Generate a new password" />
              </div>
            </Field>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold">Subscription</p>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-slate-600">Branches allowed</span>
              <Input type="number" min={1} max={100} value={f.maxBranches} onChange={(e) => set({ maxBranches: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} className="w-20 text-center" aria-label="Branches allowed" />
            </label>
          </div>
          <ValidityPicker value={validity} onChange={setValidity} from={new Date()} branches={f.maxBranches} pricePerBranch={pricePerBranch} />
        </section>

        <Field label="Note (only admins see this)"><Input value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="e.g. Paid by UPI, ref 4521" /></Field>

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" icon={Plus} disabled={!ready}>Create customer</Button>
        </div>
      </form>
    </Modal>
  )
}
