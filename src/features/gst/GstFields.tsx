// GSTIN and state inputs (customer, supplier and shop forms) with the same checks the server runs.
import { CheckCircle2 } from 'lucide-react'
import { Field, Input, Select } from '@/components/ui'
import { cleanGstin, GST_STATES, gstinError, gstinState, hsnError, stateLabel } from '@/core/gst'

export function GstinInput({ value, onChange, label = 'GSTIN', hint }: { value: string; onChange: (v: string) => void; label?: string; hint?: string }) {
  const v = cleanGstin(value)
  const err = v.length === 15 ? gstinError(v) : '' // checked once all 15 characters are typed
  const state = !err && v.length === 15 ? gstinState(v) : null
  return (
    <Field label={label} error={err || undefined} hint={state ? undefined : hint ?? 'Optional — 15 characters, e.g. 33AABCS1234D1Z5'}>
      <Input value={value} maxLength={15} onChange={(e) => onChange(e.target.value.toUpperCase().replace(/\s+/g, ''))} placeholder="33AABCS1234D1Z5" className="font-mono uppercase" />
      {state && <span className="mt-1 flex items-center gap-1 text-xs text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" />Valid · {stateLabel(state)}</span>}
    </Field>
  )
}

export function StateSelect({ value, onChange, label = 'State', hint, emptyLabel = 'Same as the shop' }: { value: string | null | undefined; onChange: (v: string | null) => void; label?: string; hint?: string; emptyLabel?: string }) {
  return (
    <Field label={label} hint={hint}>
      <Select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{emptyLabel}</option>
        {Object.entries(GST_STATES).map(([code, name]) => <option key={code} value={code}>{code} · {name}</option>)}
      </Select>
    </Field>
  )
}

export function HsnInput({ value, onChange, label = 'HSN / SAC code', hint = 'Optional — 4, 6 or 8 digits', placeholder = '5007' }: { value: string | null | undefined; onChange: (v: string) => void; label?: string; hint?: string; placeholder?: string }) {
  const err = hsnError(value)
  return (
    <Field label={label} error={value && value.length >= 4 && err ? err : undefined} hint={hint}>
      <Input value={value ?? ''} inputMode="numeric" maxLength={8} onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))} placeholder={placeholder} className="font-mono" />
    </Field>
  )
}
