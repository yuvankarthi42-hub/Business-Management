import clsx from 'clsx'
import { Building2, Check, Plug, Printer, Star, Store, Database, Languages, LayoutGrid, Plus, Receipt, RotateCcw, ShieldCheck, Tag, Trash2, UserPlus, UtensilsCrossed } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApp, useData } from '@/app/AppContext'
import { Badge, Button, Card, Checkbox, Field, FieldLabel, Input, Modal, PageHeader, Select, Table, Td, Th, Toggle, useAction, useReadOnly } from '@/components/ui'
import { DEFAULT_TERMS, isHardware, modulesShownFor, productFormFor, usesRetailPos, ORDER_TYPE_LABEL, PAYMENT_LABEL, PERMISSIONS, TEMPLATES, TERM_LABELS, templateFor } from '@/core/config'
import type { BillingSettings, Branch, Business, OrderType, PaymentMethod, Permission, Role, TermKey, User } from '@/core/types'
import { api, BACKEND } from '@/data'
import { fmtDateTime, uid } from '@/lib/format'
import { PhoneInput } from '@/components/PhoneInput'
import { PrinterSettingsPanel } from '@/features/printing/PrinterSettings'
import { StickerSettingsPanel } from '@/features/Labels'
import { LoyaltySettingsPanel } from '@/features/loyalty/Points'
import { BRAND } from '@/core/brand'
import { GstinInput, StateSelect } from '@/features/gst/GstFields'
import { gstinState } from '@/core/gst'
import { IntegrationsSettings } from '@/features/whatsapp/Integrations'
import { ExportButtons } from '@/features/ExportData'
import { ShopLogoUpload } from '@/features/ShopLogoUpload'
import { COUNTRIES, formatPhone } from '@/core/phone'

type Section = 'profile' | 'billing' | 'loyalty' | 'stickers' | 'printer' | 'integrations' | 'terms' | 'modules' | 'branches' | 'staff' | 'tables' | 'data'

export default function Settings() {
  const { can, mod, me } = useApp()
  const sections: { key: Section; label: string; icon: typeof Building2; show: boolean }[] = [
    { key: 'profile', label: 'Business Profile', icon: Building2, show: can('settings.manage') },
    { key: 'billing', label: 'Billing & Tax', icon: Receipt, show: can('settings.manage') },
    { key: 'loyalty', label: 'Loyalty points', icon: Star, show: can('settings.manage') && mod('customers') },
    { key: 'stickers', label: 'Price stickers', icon: Tag, show: can('settings.manage') && !!me && (usesRetailPos(me.business) || /bakery|sweet/i.test(me.business.subType)) },
    { key: 'printer', label: 'Printer', icon: Printer, show: can('billing.create') || can('settings.manage') },
    { key: 'integrations', label: 'Integrations', icon: Plug, show: can('settings.manage') && !!me?.features.whatsapp },
    { key: 'terms', label: 'Terminology', icon: Languages, show: can('settings.manage') },
    { key: 'modules', label: 'Modules', icon: LayoutGrid, show: can('settings.manage') },
    { key: 'branches', label: 'Branches', icon: Store, show: can('settings.manage') },
    { key: 'staff', label: 'Staff & Roles', icon: ShieldCheck, show: can('users.manage') },
    { key: 'tables', label: 'Tables', icon: UtensilsCrossed, show: can('settings.manage') && mod('tables') },
    { key: 'data', label: 'Audit & Data', icon: Database, show: can('settings.manage') },
  ]
  const visible = sections.filter((s) => s.show)
  const [params] = useSearchParams()
  const fromUrl = params.get('tab') as Section | null
  const [sec, setSec] = useState<Section>(visible.some((v) => v.key === fromUrl) ? fromUrl! : visible[0]?.key ?? 'profile')
  useEffect(() => { if (fromUrl && visible.some((v) => v.key === fromUrl)) setSec(fromUrl) }, [fromUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Settings" subtitle="Configure how the app adapts to your business" />
      <div className="flex flex-col gap-5 md:flex-row">
        <nav className="flex gap-1 overflow-x-auto no-scrollbar md:w-56 md:shrink-0 md:flex-col">
          {visible.map((s) => (
            <button key={s.key} onClick={() => setSec(s.key)} className={clsx('flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition',
              sec === s.key ? 'bg-white text-brand-700 shadow-card ring-1 ring-slate-200' : 'text-slate-600 hover:bg-white/60')}>
              <s.icon className="h-4 w-4" />{s.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {sec === 'profile' && <ProfileSettings />}
          {sec === 'billing' && <BillingSettingsForm />}
          {sec === 'stickers' && <StickerSettingsPanel Section={Section} />}
          {sec === 'loyalty' && <LoyaltySettingsPanel Section={Section} />}
          {sec === 'printer' && <PrinterSettingsPanel />}
          {sec === 'integrations' && <IntegrationsSettings />}
          {sec === 'terms' && <TermsSettings />}
          {sec === 'modules' && <ModuleSettings />}
          {sec === 'staff' && <StaffSettings />}
          {sec === 'branches' && <BranchSettings />}
          {sec === 'tables' && <TableSettings />}
          {sec === 'data' && <DataSettings />}
        </div>
      </div>
    </div>
  )
}

function Section({ title, subtitle, children, onSave, dirty }: { title: string; subtitle?: string; children: ReactNode; onSave?: () => void; dirty?: boolean }) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div><h2 className="text-base font-semibold">{title}</h2>{subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}</div>
        {onSave && <Button onClick={onSave} disabled={dirty === false}>Save</Button>}
      </div>
      <div className="p-5">{children}</div>
    </Card>
  )
}

/** Local editable copy of the business with a save action. */
function useBusinessForm<T>(pick: (b: Business) => T) {
  const { me } = useApp()
  const run = useAction()
  const [v, setV] = useState<T>(() => structuredClone(pick(me!.business)))
  const original = JSON.stringify(pick(me!.business))
  useEffect(() => { setV(structuredClone(pick(me!.business))) }, [original]) // eslint-disable-line react-hooks/exhaustive-deps
  return { v, setV, dirty: JSON.stringify(v) !== original, save: (patch: (v: T) => Partial<Business>) => run(() => api.business.update(patch(v)), 'Settings saved') }
}

function ProfileSettings() {
  const f = useBusinessForm((b) => ({ name: b.name, address: b.address, phone: b.phone, defaultCountry: b.defaultCountry ?? 'IN', email: b.email, gstin: b.gstin, stateCode: b.stateCode ?? '', currencySymbol: b.currencySymbol, timezone: b.timezone, category: b.category, subType: b.subType }))
  const set = (k: keyof typeof f.v, val: string) => f.setV({ ...f.v, [k]: val })
  return (
    <Section title="Business Profile" subtitle="Shown on bills and receipts" onSave={() => f.save((v) => v)} dirty={f.dirty}>
      <div className="mb-4"><ShopLogoUpload /></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field required label="Business name"><Input value={f.v.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field required label="Business type">
          <Select value={`${f.v.category}|${f.v.subType}`} onChange={(e) => { const [c, s] = e.target.value.split('|'); f.setV({ ...f.v, category: c as Business['category'], subType: s }) }}>
            {!TEMPLATES.some((tp) => tp.subTypes.includes(f.v.subType)) && <option value={`${f.v.category}|${f.v.subType}`}>{f.v.subType}</option>}
            {TEMPLATES.map((tp) => <optgroup key={tp.key} label={tp.name}>{tp.subTypes.map((s) => <option key={s} value={`${tp.category}|${s}`}>{s}</option>)}</optgroup>)}
          </Select>
        </Field>
        <Field label="Address" className="sm:col-span-2"><Input value={f.v.address} onChange={(e) => set('address', e.target.value)} /></Field>
        <div className="grid gap-4 sm:col-span-2 sm:grid-cols-3">
          <Field label="Country" hint="Default code for mobile numbers">
            <Select value={f.v.defaultCountry} onChange={(e) => set('defaultCountry', e.target.value)}>
              {COUNTRIES.map((c) => <option key={c.iso} value={c.iso}>{c.flag} {c.name} (+{c.dial})</option>)}
            </Select>
          </Field>
          <div><span className="mb-1.5 block text-xs font-medium text-slate-600">Phone</span><PhoneInput value={f.v.phone} onChange={(v) => set('phone', v)} defaultCountry={f.v.defaultCountry} /></div>
          <Field label="Email"><Input value={f.v.email} onChange={(e) => set('email', e.target.value)} /></Field>
          <GstinInput label="GSTIN / Tax ID" value={f.v.gstin} onChange={(v) => set('gstin', v)} hint="Printed on bills. Its first two digits are your GST state." />
          {!gstinState(f.v.gstin) && <StateSelect label="GST state" value={f.v.stateCode} onChange={(v) => set('stateCode', v ?? '')} emptyLabel="Not set" hint="Used for IGST when you sell to another state" />}
          <Field label="Currency symbol"><Input value={f.v.currencySymbol} onChange={(e) => set('currencySymbol', e.target.value)} maxLength={3} /></Field>
          <Field label="Timezone"><Select value={f.v.timezone} onChange={(e) => set('timezone', e.target.value)}>{['Asia/Kolkata', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Singapore', 'Asia/Kuala_Lumpur', 'Asia/Colombo', 'Europe/London', 'America/New_York', 'Australia/Sydney'].map((z) => <option key={z}>{z}</option>)}</Select></Field>
        </div>
      </div>
      <p className="mt-4 text-xs text-slate-500">Changing the business type does not remove anything — enable the matching features under <b>Modules</b>.</p>
    </Section>
  )
}

function BillingSettingsForm() {
  const { me } = useApp()
  const f = useBusinessForm((b) => b.billing)
  const b = f.v
  const set = <K extends keyof BillingSettings>(k: K, val: BillingSettings[K]) => f.setV({ ...b, [k]: val })
  const toggleIn = <T,>(arr: T[], x: T, on: boolean) => (on ? [...arr, x] : arr.filter((y) => y !== x))
  return (
    <Section title="Billing & Tax" subtitle="Numbering, tax, payment methods and receipts" onSave={() => f.save((v) => ({ billing: v }))} dirty={f.dirty}>
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Invoice prefix"><Input value={b.invoicePrefix} onChange={(e) => set('invoicePrefix', e.target.value)} /></Field>
          <Field label="Next invoice no."><Input type="number" value={b.nextInvoiceNumber} onChange={(e) => set('nextInvoiceNumber', Number(e.target.value))} /></Field>
          <Field label="Order prefix"><Input value={b.orderPrefix} onChange={(e) => set('orderPrefix', e.target.value)} /></Field>
          <Field label="Preview" hint="Next bill"><div className="flex h-10 items-center rounded-lg bg-slate-50 px-3 text-sm font-semibold">{b.invoicePrefix}{b.nextInvoiceNumber}</div></Field>
        </div>

        <div className="rounded-xl border border-slate-200">
          <Row label="Enable tax" hint="GST / VAT on bills"><Toggle checked={b.taxEnabled} onChange={(v) => set('taxEnabled', v)} /></Row>
          {b.taxEnabled && <>
            <Row label="Prices are" hint="Inclusive: menu price already includes tax">
              <Select value={b.taxMode} onChange={(e) => set('taxMode', e.target.value as BillingSettings['taxMode'])} className="w-40"><option value="exclusive">Tax exclusive</option><option value="inclusive">Tax inclusive</option></Select>
            </Row>
            <Row label="Default tax rate">
              <Select value={b.defaultTaxRateId ?? ''} onChange={(e) => set('defaultTaxRateId', e.target.value || null)} className="w-40">{b.taxRates.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>
            </Row>
            <div className="border-t border-slate-100 px-4 py-3">
              <p className="mb-2 text-sm font-medium">Tax rates</p>
              <div className="space-y-2">
                {b.taxRates.map((r, i) => (
                  <div key={r.id} className="flex gap-2">
                    <Input value={r.name} onChange={(e) => set('taxRates', b.taxRates.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                    <Input type="number" value={r.rate} className="w-24" onChange={(e) => set('taxRates', b.taxRates.map((x, j) => (j === i ? { ...x, rate: Number(e.target.value) } : x)))} />
                    <span className="flex items-center text-sm text-slate-500">%</span>
                  </div>
                ))}
                <Button size="sm" variant="soft" icon={Plus} onClick={() => set('taxRates', [...b.taxRates, { id: uid('tax_'), name: 'New rate', rate: 0 }])}>Add rate</Button>
              </div>
            </div>
          </>}
          <Row label="Allow discounts"><Toggle checked={b.discountEnabled} onChange={(v) => set('discountEnabled', v)} /></Row>
          {!!me && productFormFor(me.business).showMrp && (
            <Row label="Customer discount below MRP" hint={b.mrpDiscounts !== false
              ? 'On: items sell at their selling price; stickers and bills show the MRP, the discount and “You saved”'
              : 'Off: every item sells at its MRP and stickers show MRP only. Selling prices are kept for when you turn this on again'}>
              <Toggle checked={b.mrpDiscounts !== false} onChange={(v) => set('mrpDiscounts', v)} label="Customer discount below MRP" />
            </Row>
          )}
          <Row label="Round off total" hint="Round to nearest rupee"><Toggle checked={b.roundOff} onChange={(v) => set('roundOff', v)} /></Row>
          {me?.business.category === 'retail' && <>
            <Row label="Second price list" hint="A lower rate for contractors, electricians or wholesale buyers"><Toggle checked={!!b.wholesale?.enabled} onChange={(v) => set('wholesale', { label: b.wholesale?.label || (isHardware(me.business) ? 'Contractor rate' : 'Wholesale rate'), enabled: v })} /></Row>
            {b.wholesale?.enabled && <Field required label="Name of the price list" hint="Shown on billing and in the product form"><Input value={b.wholesale.label} onChange={(e) => set('wholesale', { ...b.wholesale!, label: e.target.value })} placeholder="Contractor rate" className="max-w-xs" /></Field>}
          </>}
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <p className="mb-2 text-sm font-medium">Payment methods</p>
            <div className="flex flex-col gap-2">{(['cash', 'upi', 'card', 'bank', 'credit'] as PaymentMethod[]).map((m) => <Checkbox key={m} label={PAYMENT_LABEL[m]} checked={b.paymentMethods.includes(m)} onChange={(v) => set('paymentMethods', toggleIn(b.paymentMethods, m, v))} />)}</div>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">Order types</p>
            <div className="flex flex-col gap-2">{(['counter', 'dine_in', 'takeaway', 'delivery'] as OrderType[]).map((m) => <Checkbox key={m} label={ORDER_TYPE_LABEL[m]} checked={b.orderTypes.includes(m)} onChange={(v) => set('orderTypes', toggleIn(b.orderTypes, m, v))} />)}</div>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
          <Field label="Printer paper">
            <Select value={b.paperWidth ?? '80mm'} onChange={(e) => set('paperWidth', e.target.value as BillingSettings['paperWidth'])}>
              <option value="80mm">80 mm (3 inch)</option><option value="58mm">58 mm (2 inch)</option>
            </Select>
          </Field>
          <Field label="Receipt footer" hint="Leave empty to print nothing at the bottom"><Input value={b.receiptFooter} onChange={(e) => set('receiptFooter', e.target.value)} placeholder="Thank you! Visit again." /></Field>
        </div>
      </div>
    </Section>
  )
}

const Row = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <div className="flex items-center justify-between gap-4 border-b border-slate-100 px-4 py-3 last:border-0"><div><p className="text-sm font-medium">{label}</p>{hint && <p className="text-xs text-slate-500">{hint}</p>}</div>{children}</div>
)

function TermsSettings() {
  const { me } = useApp()
  const f = useBusinessForm((b) => b.terminology)
  const keys = Object.keys(DEFAULT_TERMS) as TermKey[]
  const tplTerms = { ...DEFAULT_TERMS, ...templateFor(me!.business.category).terms }
  return (
    <Section title="Terminology" subtitle="Rename things to match how your team talks — used everywhere in the app" onSave={() => f.save((v) => ({ terminology: v }))} dirty={f.dirty}>
      <div className="mb-3 flex justify-end"><Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => f.setV(tplTerms)}>Reset to {me!.business.subType} defaults</Button></div>
      <Table>
        <thead><tr><Th>System name</Th><Th>Singular</Th><Th>Plural</Th></tr></thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k}>
              <Td className="font-medium text-slate-600">{TERM_LABELS[k]}</Td>
              <Td><Input value={f.v[k].singular} onChange={(e) => f.setV({ ...f.v, [k]: { ...f.v[k], singular: e.target.value } })} /></Td>
              <Td><Input value={f.v[k].plural} onChange={(e) => f.setV({ ...f.v, [k]: { ...f.v[k], plural: e.target.value } })} /></Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Section>
  )
}

function ModuleSettings() {
  const { me } = useApp()
  const f = useBusinessForm((b) => b.modules)
  return (
    <Section title="Modules" subtitle="Turn features on as your business grows. Hidden modules keep their data." onSave={() => f.save((v) => ({ modules: v }))} dirty={f.dirty}>
      <div className="grid gap-3 sm:grid-cols-2">
        {modulesShownFor(me!.business).map((m) => (
          <div key={m.key} className={clsx('flex items-start gap-3 rounded-xl border p-4', f.v[m.key] ? 'border-brand-200 bg-brand-50/30' : 'border-slate-200')}>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{m.name} {m.core && <Badge className="ml-1">Core</Badge>}{m.comingSoon && <Badge tone="amber" className="ml-1">Coming soon</Badge>}</p>
              <p className="mt-0.5 text-xs text-slate-500">{m.description}</p>
            </div>
            <Toggle checked={f.v[m.key]} disabled={m.core || m.comingSoon} onChange={(v) => f.setV({ ...f.v, [m.key]: v })} label={m.name} />
          </div>
        ))}
      </div>
    </Section>
  )
}

function StaffSettings() {
  const { t, me } = useApp()
  const { data: users = [] } = useData(() => api.users.list())
  const { data: roles = [] } = useData(() => api.roles.list())
  const [edit, setEdit] = useState<Partial<User> | null>(null)
  const [role, setRole] = useState<Partial<Role> | null>(null)
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? '—'
  const isFull = (id: string) => (roles.find((r) => r.id === id)?.permissions as string[] | undefined)?.includes('*') ?? false
  const { data: branches = [] } = useData(() => api.branches.list())
  return (
    <div className="space-y-4">
      <Section title={t('employee', true)} subtitle={`${users.filter((u) => u.active).length} active`}>
        <div className="mb-3 flex justify-end"><Button size="sm" icon={UserPlus} onClick={() => setEdit({ roleId: roles.find((r) => r.name === 'Cashier')?.id })}>Add {t('employee').toLowerCase()}</Button></div>
        <Table>
          <thead><tr><Th>Name</Th><Th>Mobile</Th><Th>Role</Th><Th>Branches</Th><Th>Status</Th><Th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <Td className="font-medium">{u.name}{u.id === me?.user.id && <span className="ml-1 text-xs text-slate-400">(you)</span>}</Td>
                <Td className="whitespace-nowrap text-slate-500 tabular">{formatPhone(u.phone)}</Td>
                <Td>{u.canLogin === false ? <Badge>No app login</Badge> : <Badge tone="blue">{roleName(u.roleId)}</Badge>}</Td>
                <Td>
                  {u.canLogin !== false && isFull(u.roleId) ? <Badge tone="violet">All branches</Badge> : (
                    <div className="flex flex-wrap gap-1">{(u.branchIds?.length ? u.branchIds : [u.branchId]).map((id) => <Badge key={id}>{branches.find((b) => b.id === id)?.name ?? '—'}</Badge>)}</div>
                  )}
                </Td>
                <Td>{u.active ? <Badge tone="green">Active</Badge> : <Badge>Disabled</Badge>}</Td>
                <Td className="text-right"><Button size="sm" variant="ghost" onClick={() => setEdit(u)}>Edit</Button></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Section>
      <Section title="Roles & permissions" subtitle="Control what each role can see and do">
        <div className="mb-3 flex justify-end"><Button size="sm" variant="secondary" icon={Plus} onClick={() => setRole({ name: '', permissions: [] })}>Custom role</Button></div>
        <div className="grid gap-3 sm:grid-cols-2">
          {roles.map((r) => {
            const all = (r.permissions as string[]).includes('*')
            return (
              <button key={r.id} onClick={() => setRole(r)} className="rounded-xl border border-slate-200 p-4 text-left hover:border-slate-300">
                <div className="flex items-center justify-between"><p className="font-semibold">{r.name}</p>{r.system ? <Badge>Built-in</Badge> : <Badge tone="violet">Custom</Badge>}</div>
                <p className="mt-1 text-xs text-slate-500">{all ? 'Full access' : `${r.permissions.length} permissions`} · {users.filter((u) => u.roleId === r.id).length} staff</p>
              </button>
            )
          })}
        </div>
      </Section>
      {edit && <UserForm initial={edit} roles={roles} branches={branches} onClose={() => setEdit(null)} />}
      {role && <RoleForm initial={role} onClose={() => setRole(null)} />}
    </div>
  )
}

function UserForm({ initial, roles, branches, onClose }: { initial: Partial<User>; roles: Role[]; branches: Branch[]; onClose: () => void }) {
  const run = useAction()
  const { me } = useApp()
  const startBranches = initial.branchIds?.length ? initial.branchIds : initial.branchId ? [initial.branchId] : [me?.isAll ? branches.find((b) => b.isDefault)?.id ?? branches[0]?.id : me?.branch.id].filter(Boolean) as string[]
  const [u, setU] = useState({ name: '', phone: '', email: '', roleId: roles[0]?.id ?? '', active: true, password: '', canLogin: true, ...initial, ...(initial.id ? { password: '' } : {}), branchIds: startBranches })
  const self = u.id === me?.user.id
  const app = u.canLogin !== false
  // Turning app access on for someone who had none needs a password.
  const needsPassword = app && (!initial.id || initial.canLogin === false)
  const fullAccess = app && (roles.find((r) => r.id === u.roleId)?.permissions as string[] | undefined)?.includes('*')
  const toggle = (id: string) => setU({ ...u, branchIds: u.branchIds.includes(id) ? u.branchIds.filter((x) => x !== id) : [...u.branchIds, id] })
  const noBranch = !fullAccess && !u.branchIds.length
  return (
    <Modal open onClose={onClose} size="md" title={initial.id ? `Edit ${initial.name}` : 'Add staff'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={noBranch} onClick={async () => { if (await run(() => api.users.save(u), 'Saved')) onClose() }}>Save</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field required label="Name"><Input autoFocus value={u.name} onChange={(e) => setU({ ...u, name: e.target.value })} /></Field>
          <div><FieldLabel required>{app ? 'Mobile (login ID)' : 'Mobile'}</FieldLabel><PhoneInput value={u.phone} onChange={(v) => setU({ ...u, phone: v })} defaultCountry={me?.business.defaultCountry} required /></div>
          {app && <Field required label="Role"><Select value={u.roleId} disabled={self} onChange={(e) => setU({ ...u, roleId: e.target.value })}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>}
          {app && <Field required={needsPassword} label={needsPassword ? 'Password' : 'New password (leave blank to keep)'}><Input type="password" value={u.password} onChange={(e) => setU({ ...u, password: e.target.value })} /></Field>}
        </div>
        {!self && !initial.username && (
          <div className="rounded-xl border border-slate-200 p-3">
            <Checkbox label="Uses the app (can sign in)" checked={app} onChange={(v) => setU({ ...u, canLogin: v, ...(v && !u.roleId ? { roleId: roles.find((r) => r.name === 'Cashier')?.id ?? roles[0]?.id ?? '' } : {}) })} />
            <p className="mt-1 pl-7 text-xs text-slate-500">{app ? 'Signs in with this mobile number and password, and sees what the role allows.' : 'Never signs in — for cleaners, helpers or drivers. Attendance and salary still work.'}</p>
          </div>
        )}
        <div>
          <p className="mb-1.5 text-xs font-medium text-slate-600">Works at</p>
          {fullAccess ? (
            <p className="rounded-lg bg-violet-50 px-3 py-2 text-sm text-violet-800">The {roles.find((r) => r.id === u.roleId)?.name} role has access to <b>all branches</b>.</p>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                {branches.map((b) => {
                  const on = u.branchIds.includes(b.id)
                  return (
                    <button key={b.id} type="button" onClick={() => toggle(b.id)}
                      className={clsx('flex items-center gap-3 rounded-xl border-2 px-3 py-2.5 text-left transition', on ? 'border-brand-500 bg-brand-50/50' : 'border-slate-200 hover:border-slate-300')}>
                      <span className={clsx('flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2', on ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300')}>{on && <Check className="h-3.5 w-3.5" />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{b.name}{b.isDefault && <span className="ml-1.5 text-[11px] font-normal text-slate-400">Main</span>}</span>
                        <span className="block truncate text-[11px] text-slate-500">{b.address || '—'}</span>
                      </span>
                      {on && u.branchIds[0] === b.id && u.branchIds.length > 1 && <Badge tone="blue">Default</Badge>}
                    </button>
                  )
                })}
              </div>
              {noBranch ? <p className="mt-1.5 text-xs text-red-600">Select at least one branch</p>
                : <p className="mt-1.5 text-[11px] text-slate-400">{u.branchIds.length > 1 ? 'They can switch between these branches. The first one opens by default.' : 'They will only see this branch.'}</p>}
            </>
          )}
        </div>
        {initial.id && !self && <Checkbox label={app ? 'Active (can sign in)' : 'Active (still works here)'} checked={u.active} onChange={(v) => setU({ ...u, active: v })} />}
      </div>
    </Modal>
  )
}

function RoleForm({ initial, onClose }: { initial: Partial<Role>; onClose: () => void }) {
  const run = useAction()
  const all = (initial.permissions as string[] | undefined)?.includes('*')
  const [name, setName] = useState(initial.name ?? '')
  const [perms, setPerms] = useState<Permission[]>(all ? PERMISSIONS.map((p) => p.key) : ((initial.permissions ?? []) as Permission[]))
  const groups = [...new Set(PERMISSIONS.map((p) => p.group))]
  return (
    <Modal open onClose={onClose} size="lg" title={initial.id ? `${initial.name} permissions` : 'New role'}
      footer={<>
        {initial.id && !initial.system && <Button variant="ghost" icon={Trash2} className="mr-auto !text-red-600" onClick={async () => { if (await run(() => api.roles.remove(initial.id!), 'Role deleted')) onClose() }}>Delete</Button>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={all} onClick={async () => { if (await run(() => api.roles.save({ id: initial.id, name, system: !!initial.system, permissions: perms }), 'Role saved')) onClose() }}>Save</Button>
      </>}>
      {all && <p className="mb-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">The Owner role always has full access.</p>}
      <Field required label="Role name" className="mb-5"><Input value={name} disabled={initial.system} onChange={(e) => setName(e.target.value)} placeholder="e.g. Delivery Staff" /></Field>
      <div className="grid gap-5 sm:grid-cols-2">
        {groups.map((g) => (
          <div key={g}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{g}</p>
            <div className="flex flex-col gap-2">
              {PERMISSIONS.filter((p) => p.group === g).map((p) => (
                <Checkbox key={p.key} label={p.label} checked={perms.includes(p.key)} onChange={(v) => !all && setPerms(v ? [...perms, p.key] : perms.filter((x) => x !== p.key))} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}

function TableSettings() {
  const { t, me } = useApp()
  if (me?.isAll) return <Section title={t('table', true)}><p className="text-sm text-slate-500">Tables belong to a branch. Choose a branch from the top bar to add or edit its {t('table', true).toLowerCase()}.</p></Section>
  return <TableSettingsInner />
}

function TableSettingsInner() {
  const { t, me } = useApp()
  const readOnly = useReadOnly()
  const run = useAction()
  const { data: tables = [] } = useData(() => api.tables.list())
  const [form, setForm] = useState({ label: '', floor: tables[0]?.floor ?? 'Main', seats: 4 })
  return (
    <Section title={t('table', true)} subtitle={`${tables.length} ${t('table', true).toLowerCase()}${me && me.branches.length > 1 ? ` · ${me.branch.name}` : ''}`}>
      <form className="mb-4 grid gap-2 sm:grid-cols-[1fr_1fr_100px_auto]" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.tables.save(form), `${t('table')} added`)) setForm({ ...form, label: '' }) }}>
        <Input required placeholder="Label e.g. T13" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        <Input placeholder="Floor / area" value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value })} />
        <Input type="number" placeholder="Seats" value={form.seats} onChange={(e) => setForm({ ...form, seats: Number(e.target.value) })} />
        <Button type="submit" icon={Plus}>Add</Button>
      </form>
      <Table>
        <thead><tr><Th>{t('table')}</Th><Th>Floor</Th><Th>Seats</Th><Th /></tr></thead>
        <tbody>{tables.map((x) => <tr key={x.id}><Td className="font-medium">{x.label}</Td><Td>{x.floor}</Td><Td>{x.seats}</Td><Td className="text-right"><button disabled={!!readOnly} aria-label="Remove" onClick={() => run(() => api.tables.remove(x.id), 'Removed')} className="text-slate-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button></Td></tr>)}</tbody>
      </Table>
    </Section>
  )
}

function DataSettings() {
  const run = useAction()
  const { data: logs = [] } = useData(() => api.audit.list(100))
  const [confirm, setConfirm] = useState(false)
  const { can } = useApp()
  return (
    <div className="space-y-4">
      {can('settings.manage') && (
        <Section title="Download your data" subtitle="A full copy of your business — bills, items, customers, stock, staff and payments. Yours to keep.">
          <ExportButtons load={() => api.dataExport.mine()} />
          <p className="mt-2 text-xs text-slate-500">Excel has one sheet per table. ZIP has CSV files (open in Excel / Google Sheets) and your product photos. Passwords are never included.</p>
        </Section>
      )}
      <Section title="Audit log" subtitle="Every financial change is recorded — nothing is hard-deleted">
        {!logs.length ? <p className="text-sm text-slate-500">No changes recorded in this session yet. Create a bill, cancel an order or edit settings to see entries.</p> : (
          <Table>
            <thead><tr><Th>When</Th><Th>User</Th><Th>Action</Th><Th>Detail</Th></tr></thead>
            <tbody>{logs.map((l) => <tr key={l.id}><Td className="whitespace-nowrap text-slate-500">{fmtDateTime(l.at)}</Td><Td>{l.userName}</Td><Td><Badge>{l.entity}.{l.action}</Badge></Td><Td className="max-w-xs truncate text-slate-600">{l.detail}</Td></tr>)}</tbody>
          </Table>
        )}
      </Section>
      {BACKEND === 'mock' && (
        <Section title="Demo data" subtitle="Data is stored in this browser (demo app).">
          <Button variant="danger" icon={RotateCcw} onClick={() => setConfirm(true)}>Reset demo data</Button>
        </Section>
      )}
      <Modal open={confirm} onClose={() => setConfirm(false)} size="sm" title="Reset all demo data?" subtitle="All bills, changes and new businesses in this browser are replaced with fresh demo data."
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button><Button variant="danger" onClick={async () => { await run(() => api.dev.reset(), 'Demo data reset'); await api.auth.logout(); setConfirm(false); window.location.href = '/login' }}>Reset</Button></>}>
        <p className="text-sm text-slate-600">You’ll be signed out.</p>
      </Modal>
    </div>
  )
}

function BranchSettings() {
  const run = useAction()
  const { me } = useApp()
  const { data: branches = [] } = useData(() => api.branches.list())
  const [edit, setEdit] = useState<Partial<Branch> | null>(null)
  const max = me?.branchLimit.max ?? 1
  const full = branches.length >= max
  return (
    <div className="space-y-4">
      <Section title="Branches" subtitle={`${branches.length} branch${branches.length === 1 ? '' : 'es'} · one menu, separate bills, tables, kitchen and stock`}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-600">Your plan: <b>{branches.length} of {max}</b> branch{max === 1 ? '' : 'es'} used</p>
          <Button size="sm" icon={Plus} disabled={full || me?.subscription.readOnly} onClick={() => setEdit({ name: '' })}>Add branch</Button>
        </div>
        {full && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">You’ve used all {max} branch{max === 1 ? '' : 'es'} in your plan. Call or WhatsApp {BRAND.supportPhoneDisplay} to add more branches.</p>}
        <Table>
          <thead><tr><Th>Branch</Th><Th className="hidden md:table-cell">Address</Th><Th className="hidden sm:table-cell">Phone</Th><Th className="text-right">Staff</Th><Th className="text-right">Tables</Th><Th>Bill series</Th><Th>Status</Th><Th /></tr></thead>
          <tbody>
            {branches.map((b) => (
              <tr key={b.id}>
                <Td className="font-medium">{b.name}{b.isDefault && <Badge tone="blue" className="ml-1.5">Main</Badge>}</Td>
                <Td className="hidden max-w-[220px] truncate text-slate-500 md:table-cell">{b.address || '—'}</Td>
                <Td className="hidden whitespace-nowrap text-slate-500 sm:table-cell">{formatPhone(b.phone) || '—'}</Td>
                <Td className="text-right tabular">{b.staff}</Td>
                <Td className="text-right tabular">{b.tables}</Td>
                <Td className="font-mono text-xs">{b.invoicePrefix ? `${b.invoicePrefix}${b.nextInvoiceNumber ?? 10001}` : 'Business series'}</Td>
                <Td>{b.active === false ? <Badge>Closed</Badge> : <Badge tone="green">Open</Badge>}</Td>
                <Td className="text-right"><Button size="sm" variant="ghost" onClick={() => setEdit(b)}>Edit</Button></Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Note title="Menu">Same menu and prices in every branch.</Note>
          <Note title="Stock">Each branch has its own stock.</Note>
          <Note title="Guests">Shared — dues follow the guest to any branch.</Note>
        </div>
      </Section>
      {branches.length === 1 && max >= 3 && (
        <Section title="Try it with sample data" subtitle="Adds Adyar and Velachery with staff, tables, stock and 10 days of sales so you can see the combined dashboard.">
          <Button variant="secondary" icon={Store} onClick={() => run(() => api.branches.addDemo(), 'Demo branches added')}>Add 2 demo branches</Button>
        </Section>
      )}
      {edit && <BranchForm initial={edit} onClose={() => setEdit(null)} />}
    </div>
  )
}

const Note = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="rounded-lg bg-slate-50 px-3 py-2.5"><p className="text-xs font-semibold text-slate-700">{title}</p><p className="mt-0.5 text-xs text-slate-500">{children}</p></div>
)

function BranchForm({ initial, onClose }: { initial: Partial<Branch>; onClose: () => void }) {
  const run = useAction()
  const { me } = useApp()
  const [b, setB] = useState<Partial<Branch> & { name: string }>({ address: '', phone: '', invoicePrefix: '', active: true, ...initial, name: initial.name ?? '' })
  const isNew = !initial.id
  return (
    <Modal open onClose={onClose} title={isNew ? 'Add branch' : `Edit ${initial.name}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={async () => { if (await run(() => api.branches.save(b), isNew ? 'Branch added' : 'Saved')) onClose() }}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field required label="Branch name" className="sm:col-span-2"><Input autoFocus value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} placeholder="Anna Nagar" /></Field>
        <Field label="Address" className="sm:col-span-2"><Input value={b.address} onChange={(e) => setB({ ...b, address: e.target.value })} placeholder="Printed on this branch’s bills" /></Field>
        <div><span className="mb-1.5 block text-xs font-medium text-slate-600">Phone</span><PhoneInput value={b.phone ?? ''} onChange={(v) => setB({ ...b, phone: v })} defaultCountry={me?.business.defaultCountry} /></div>
        <Field label="Bill prefix" hint={b.isDefault && !b.invoicePrefix ? 'Empty = business series (Settings → Billing)' : isNew ? 'Leave empty to auto-create, e.g. AN-' : undefined}>
          <Input value={b.invoicePrefix} onChange={(e) => setB({ ...b, invoicePrefix: e.target.value.toUpperCase() })} placeholder="AN-" maxLength={8} />
        </Field>
        {!b.isDefault && (
          <div className="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3 sm:col-span-2">
            <div><p className="text-sm font-medium">Open for business</p><p className="text-xs text-slate-500">Closed branches stay in reports but can’t take bills or QR orders.</p></div>
            <Toggle checked={b.active !== false} onChange={(v) => setB({ ...b, active: v })} label="Open" />
          </div>
        )}
      </div>
    </Modal>
  )
}
