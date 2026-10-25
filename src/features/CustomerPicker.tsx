import { Check, UserPlus, UserRound, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { Button, Input, Modal, SearchInput, useAction } from '@/components/ui'
import { api } from '@/data'
import { money } from '@/lib/format'
import { PhoneInput } from '@/components/PhoneInput'
import { formatPhone, normalizePhone, phoneMatches } from '@/core/phone'

/** Compact customer selector: shows current customer, opens a searchable picker with quick-add. */
export function CustomerPicker({ value, onChange, compact }: { value: string | null; onChange: (id: string | null) => void; compact?: boolean }) {
  const { t, mod } = useApp()
  const [open, setOpen] = useState(false)
  const { data: customers = [] } = useData(() => api.customers.list())
  const current = customers.find((c) => c.id === value)
  if (!mod('customers')) return null
  return (
    <>
      <button
        type="button" onClick={() => setOpen(true)}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-sm hover:border-slate-300"
      >
        <UserRound className="h-4 w-4 shrink-0 text-slate-400" />
        <span className="min-w-0 flex-1 truncate">
          {current ? <><span className="font-medium">{current.name}</span>{!compact && <span className="text-slate-400"> · {formatPhone(current.phone)}</span>}{current.gstin && <span className="ml-1.5 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700" title={`B2B tax invoice · GSTIN ${current.gstin}`}>B2B</span>}</> : <span className="text-slate-500">Walk-in {t('customer').toLowerCase()}</span>}
        </span>
        {current && current.stats.outstanding > 0 && <span className="shrink-0 rounded bg-amber-50 px-1.5 text-[11px] font-semibold text-amber-700">Due {money(current.stats.outstanding)}</span>}
        {current && <X className="h-4 w-4 shrink-0 text-slate-400 hover:text-slate-700" onClick={(e) => { e.stopPropagation(); onChange(null) }} />}
      </button>
      {open && <CustomerSearchModal customers={customers} value={value} onClose={() => setOpen(false)} onPick={(id) => { onChange(id); setOpen(false) }} />}
    </>
  )
}

type Row = Awaited<ReturnType<typeof api.customers.list>>[number]

function CustomerSearchModal({ customers, value, onClose, onPick }: { customers: Row[]; value: string | null; onClose: () => void; onPick: (id: string) => void }) {
  const { t, me } = useApp()
  const toE164 = (typed: string) => { try { return normalizePhone(typed, me?.business.defaultCountry) ?? '' } catch { return '' } }
  const run = useAction()
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', phone: '' })
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return customers.filter((c) => !s || c.name.toLowerCase().includes(s) || phoneMatches(c.phone, s)).slice(0, 50)
  }, [q, customers])

  return (
    <Modal open onClose={onClose} title={`Select ${t('customer').toLowerCase()}`} size="sm">
      {!adding ? (
        <>
          <div className="flex gap-2">
            <SearchInput autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or phone" className="flex-1" />
            <Button variant="soft" icon={UserPlus} onClick={() => { setAdding(true); setForm({ name: /\d/.test(q) ? '' : q, phone: /\d/.test(q) ? toE164(q) : '' }) }}>New</Button>
          </div>
          <div className="-mx-2 mt-3 max-h-80 overflow-y-auto">
            {list.map((c) => (
              <button key={c.id} onClick={() => onPick(c.id)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-slate-50">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600">{c.name[0]}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{c.name}</span>
                  <span className="block text-xs text-slate-500 tabular">{formatPhone(c.phone) || 'No phone'}</span>
                </span>
                {c.stats.outstanding > 0 && <span className="text-xs font-semibold text-amber-700">Due {money(c.stats.outstanding)}</span>}
                {c.id === value && <Check className="h-4 w-4 text-brand-600" />}
              </button>
            ))}
            {!list.length && <p className="py-6 text-center text-sm text-slate-500">No match. Add as new {t('customer').toLowerCase()}.</p>}
          </div>
        </>
      ) : (
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault()
            let id = ''
            const ok = await run(async () => { id = (await api.customers.save({ name: form.name, phone: form.phone })).id }, `${t('customer')} added`)
            if (ok) onPick(id)
          }}
        >
          <Input autoFocus required placeholder="Name *" aria-label="Name (required)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <PhoneInput value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} defaultCountry={me?.business.defaultCountry} />
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>Back</Button>
            <Button type="submit">Save & select</Button>
          </div>
        </form>
      )}
    </Modal>
  )
}
