import clsx from 'clsx'
import { Rocket, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useData } from '@/app/AppContext'
import { Badge, Button, Card, Checkbox, Input, Segmented, useAction } from '@/components/ui'
import type { FeatureFlag, FeatureKey } from '@/core/features'
import { api } from '@/data'
import { StateBadge, useAdminCan } from './shared'

type Row = Awaited<ReturnType<typeof api.admin.features>>[number]

/** Release new features gradually: off → a few customers → everyone. */
export default function AdminFeatures() {
  const { data: features = [] } = useData(() => api.admin.features())
  const { data: customers = [] } = useData(() => api.admin.customers())
  return (
    <div>
      <h1 className="text-xl font-semibold">Feature releases</h1>
      <p className="mb-5 text-sm text-slate-500">Turn new features on for no one, a few customers to try first, or everyone. Customers only see a feature once it’s on for them.</p>
      <div className="space-y-4">
        {features.map((f) => <FeatureCard key={f.key} f={f} customers={customers} />)}
      </div>
    </div>
  )
}

function FeatureCard({ f, customers }: { f: Row; customers: Awaited<ReturnType<typeof api.admin.customers>> }) {
  const run = useAction()
  const can = useAdminCan()
  const [flag, setFlag] = useState<FeatureFlag>(f.flag)
  const [q, setQ] = useState('')
  useEffect(() => setFlag(f.flag), [f.flag])
  const dirty = flag.mode !== f.flag.mode || [...flag.businessIds].sort().join() !== [...f.flag.businessIds].sort().join()
  const list = useMemo(() => customers.filter((c) => !q || `${c.name} ${c.username}`.toLowerCase().includes(q.toLowerCase())), [customers, q])
  const count = flag.mode === 'all' ? customers.length : flag.mode === 'selected' ? flag.businessIds.length : 0
  const toggle = (id: string, on: boolean) => setFlag((x) => ({ ...x, businessIds: on ? [...x.businessIds, id] : x.businessIds.filter((y) => y !== id) }))
  const editable = can('features.manage')
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><Rocket className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{f.name}</p>
          <p className="text-sm text-slate-500">{f.description}</p>
        </div>
        <Badge tone={f.flag.mode === 'all' ? 'green' : f.flag.mode === 'selected' ? 'blue' : 'slate'} dot>
          {f.flag.mode === 'all' ? 'On for everyone' : f.flag.mode === 'selected' ? `On for ${f.flag.businessIds.length} customer${f.flag.businessIds.length === 1 ? '' : 's'}` : 'Off'}
        </Badge>
      </div>
      {editable ? (
        <div className="mt-4 space-y-3">
          <Segmented value={flag.mode} onChange={(mode) => setFlag({ ...flag, mode })} options={[{ value: 'off', label: 'Off' }, { value: 'selected', label: 'Selected customers' }, { value: 'all', label: 'All customers' }]} />
          {flag.mode === 'selected' && (
            <div className="rounded-xl border border-slate-200">
              <div className="relative border-b border-slate-100 p-2">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customer" className="h-9 border-0 pl-8 shadow-none focus:ring-0" />
              </div>
              <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto">
                {list.map((c) => (
                  <li key={c.id} className={clsx('flex items-center gap-3 px-3 py-2', flag.businessIds.includes(c.id) && 'bg-brand-50/40')}>
                    <Checkbox checked={flag.businessIds.includes(c.id)} onChange={(v) => toggle(c.id, v)} label={<span className="text-sm font-medium">{c.name}</span>} />
                    <span className="font-mono text-xs text-slate-500">{c.username}</span>
                    <span className="ml-auto"><StateBadge state={c.state} /></span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-slate-500">{count} of {customers.length} customers will see it</span>
            {dirty && (
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setFlag(f.flag)}>Undo</Button>
                <Button onClick={() => run(() => api.admin.setFeature(f.key as FeatureKey, flag), 'Release updated')}>Save</Button>
              </div>
            )}
          </div>
        </div>
      ) : <p className="mt-3 text-sm text-slate-500">Your role can view releases but not change them.</p>}
    </Card>
  )
}
