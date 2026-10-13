import clsx from 'clsx'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Badge, Field, Input, Segmented, useToast } from '@/components/ui'
import { addMonths, dateInputToEnd, periodAmount, VALIDITY_OPTIONS, type SubState } from '@/core/subscription'
import type { Validity } from '@/data'
import type { AdminRole } from '@/core/types'
import type { AdminPermission } from '@/core/adminRoles'
import { formatPhone } from '@/core/phone'
import { appUrl } from '@/lib/appUrl'

export interface AdminMe { id: string; name: string; username: string; role: AdminRole; permissions: AdminPermission[] }
export const useAdmin = () => useOutletContext<{ admin: AdminMe }>().admin
/** Hide what this admin's role can't do (the API refuses it anyway). */
export const useAdminCan = () => { const a = useAdmin(); return (p: AdminPermission) => a.permissions.includes(p) }

export const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')
export const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
export const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

const STATE: Record<SubState, { label: string; tone: 'green' | 'amber' | 'red' | 'slate' }> = {
  active: { label: 'Active', tone: 'green' },
  expiring: { label: 'Expiring soon', tone: 'amber' },
  expired: { label: 'Expired · read-only', tone: 'red' },
  deactivated: { label: 'Deactivated', tone: 'slate' },
}
export const StateBadge = ({ state }: { state: SubState }) => <Badge tone={STATE[state].tone} dot>{STATE[state].label}</Badge>
export const STATE_LABEL = (s: SubState) => STATE[s].label

export function validityText(state: SubState, daysLeft: number, endAt: string | null) {
  if (!endAt) return 'No subscription'
  if (state === 'expired') return `Expired ${fmtDate(endAt)}`
  return `${daysLeft} day${daysLeft === 1 ? '' : 's'} left · till ${fmtDate(endAt)}`
}

export const randomPassword = () => {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const a = new Uint32Array(10); crypto.getRandomValues(a)
  return Array.from(a, (n) => chars[n % chars.length]).join('')
}

/** 1 / 2 / 6 / 12 months or a custom end date, with the resulting end date and price. */
export function ValidityPicker({ value, onChange, from, branches, pricePerBranch }: {
  value: Validity; onChange: (v: Validity) => void; from: Date; branches: number; pricePerBranch: number
}) {
  const key = 'months' in value ? String(value.months) : 'custom'
  const end = 'months' in value ? new Date(addMonths(from, value.months).getTime() - 86_400_000) : value.endDate ? new Date(dateInputToEnd(value.endDate)) : null
  const amount = end ? periodAmount(branches, pricePerBranch, 'months' in value ? value.months : null, from.toISOString(), end.toISOString()) : 0
  const minDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  return (
    <div className="space-y-3">
      <Segmented size="sm" block value={key} onChange={(k) => onChange(k === 'custom' ? { endDate: '' } : { months: Number(k) })}
        options={[...VALIDITY_OPTIONS.map((o) => ({ value: String(o.months), label: o.label })), { value: 'custom', label: 'Custom date' }]} />
      {'endDate' in value && (
        <Field label="Valid until"><Input type="date" min={minDate} value={value.endDate} onChange={(e) => onChange({ endDate: e.target.value })} /></Field>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
        <span className="text-slate-600">{fmtDate(from.toISOString())} → <b className="text-slate-900">{end ? fmtDate(end.toISOString()) : 'pick a date'}</b></span>
        <span className="text-slate-600">{branches} branch{branches === 1 ? '' : 'es'} × {rupees(pricePerBranch)}/month = <b className="text-slate-900">{rupees(amount)}</b></span>
      </div>
    </div>
  )
}

/** Login details to hand over to the customer. */
export function CredentialCard({ phone, username, password, businessName }: { phone?: string; username: string; password?: string; businessName: string }) {
  const toast = useToast()
  const [copied, setCopied] = useState(false)
  const loginUrl = appUrl('/login')
  const text = `BillPoodum login for ${businessName}\nWebsite: ${loginUrl}${phone ? `\nMobile number: ${formatPhone(phone)}` : ''}\nUsername: ${username}${password ? `\nPassword: ${password}` : ''}\nSign in and finish your shop setup.`
  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4" data-no-i18n>
      <dl className="grid grid-cols-[90px_1fr] gap-y-1.5 text-sm">
        <dt className="text-slate-500">Website</dt><dd className="font-medium">{loginUrl}</dd>
        {phone && <><dt className="text-slate-500">Mobile</dt><dd className="font-semibold">{formatPhone(phone)}</dd></>}
        <dt className="text-slate-500">Username</dt><dd className="font-mono font-semibold">{username}</dd>
        {password && <><dt className="text-slate-500">Password</dt><dd className="font-mono font-semibold">{password}</dd></>}
      </dl>
      <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); toast('Login details copied') } catch { toast('Copy failed — select and copy manually', 'error') } }}
        className={clsx('mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium', copied ? 'bg-emerald-600 text-white' : 'bg-white text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-50')}>
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied ? 'Copied' : 'Copy login details'}
      </button>
      {password && <p className="mt-2 text-xs text-slate-500">The password is shown only now. Share it with the customer privately.</p>}
    </div>
  )
}
