import { ArrowDown, ArrowUp, Copy, Flame, MonitorPlay, Plus, Trash2 } from 'lucide-react'
import { Thumb } from '@/components/Thumb'
import { useEffect, useMemo, useState } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { Badge, Button, Card, CardHeader, EmptyState, Input, PageHeader, SearchInput, Segmented, VegMark, useAction } from '@/components/ui'
import { dateKey } from '@/core/specials'
import type { Special } from '@/core/types'
import { api } from '@/data'
import { addDays, fmtDate, money } from '@/lib/format'
import { priceLabel, tintFor } from '@/features/Catalog'

type Row = Omit<Special, 'id' | 'businessId' | 'date'>
const TAGS = ['Chef’s pick', 'Today only', 'Offer', 'New', 'Limited', 'Bestseller']

export default function Specials() {
  const { me, t } = useApp()
  const run = useAction()
  const [day, setDay] = useState<'today' | 'tomorrow' | 'custom'>('today')
  const [custom, setCustom] = useState(dateKey(addDays(new Date(), 2)))
  const date = day === 'today' ? dateKey() : day === 'tomorrow' ? dateKey(addDays(new Date(), 1)) : custom
  const { data: saved } = useData(() => api.specials.list(date), [date])
  const { data: products = [] } = useData(() => api.products.list())
  const [rows, setRows] = useState<Row[]>([])
  const [q, setQ] = useState('')

  useEffect(() => { if (saved) setRows(saved.map(({ productId, specialPrice, tag, sort }) => ({ productId, specialPrice, tag, sort }))) }, [saved])
  const dirty = JSON.stringify(rows) !== JSON.stringify(saved?.map(({ productId, specialPrice, tag, sort }) => ({ productId, specialPrice, tag, sort })) ?? [])
  const product = (id: string) => products.find((p) => p.id === id)
  const available = useMemo(() => products.filter((p) => p.active && !rows.some((r) => r.productId === p.id) && p.name.toLowerCase().includes(q.toLowerCase())), [products, rows, q])

  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const move = (i: number, dir: -1 | 1) => {
    const next = [...rows]; const [x] = next.splice(i, 1); next.splice(i + dir, 0, x)
    setRows(next.map((r, j) => ({ ...r, sort: j })))
  }
  const copyPrevious = async () => {
    const prev = await api.specials.list(dateKey(addDays(new Date(date + 'T00:00'), -1)))
    if (!prev.length) return run(async () => { throw new Error('No specials on the previous day') })
    setRows(prev.map(({ productId, specialPrice, tag }, i) => ({ productId, specialPrice, tag, sort: i })))
  }
  const displayUrl = `/display/${me!.business.id}`

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Daily Specials" subtitle={`${fmtDate(date + 'T00:00')} · shown first in billing, the waiter app and the QR menu`}
        actions={<>
          <Button variant="secondary" icon={MonitorPlay} onClick={() => window.open(displayUrl, '_blank', 'noopener')}>Open TV display</Button>
          <Button disabled={!dirty} onClick={() => run(() => api.specials.save(date, rows), 'Specials saved')}>Save</Button>
        </>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented value={day} onChange={setDay} options={[{ value: 'today', label: 'Today' }, { value: 'tomorrow', label: 'Tomorrow' }, { value: 'custom', label: 'Pick date' }]} />
        {day === 'custom' && <Input type="date" value={custom} min={dateKey()} onChange={(e) => setCustom(e.target.value)} className="h-9 w-40" />}
        <Button variant="ghost" size="sm" icon={Copy} onClick={copyPrevious}>Copy previous day</Button>
        {dirty && <Badge tone="amber">Unsaved changes</Badge>}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader title={`Specials (${rows.length})`} subtitle="Special price works for items without sizes. Items with sizes keep their size prices." />
          {!rows.length ? (
            <EmptyState icon={Flame} title="No specials for this day" description={`Pick ${t('product', true).toLowerCase()} from the list to feature them.`} />
          ) : (
            <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100">
              {rows.map((r, i) => {
                const p = product(r.productId)
                if (!p) return null
                return (
                  <li key={r.productId} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <Thumb item={p} className={`h-11 w-11 rounded-lg text-2xl ${tintFor(p.id)}`} />
                    <div className="min-w-[140px] flex-1">
                      <p className="flex items-center gap-1.5 text-sm font-medium"><VegMark veg={p.isVeg} />{p.name}</p>
                      <p className="text-xs text-slate-500">Regular {priceLabel(p)}</p>
                    </div>
                    <div className="w-28">
                      <Input type="number" inputMode="decimal" placeholder={p.variants.length ? 'Sizes' : 'Offer ₹'} disabled={p.variants.length > 0}
                        value={r.specialPrice ?? ''} onChange={(e) => set(i, { specialPrice: e.target.value === '' ? null : Number(e.target.value) })} className="h-9" title="Special price (optional)" />
                    </div>
                    <div className="w-36">
                      <Input list="special-tags" value={r.tag} onChange={(e) => set(i, { tag: e.target.value })} placeholder="Tag" className="h-9" />
                    </div>
                    <div className="flex items-center">
                      <button disabled={i === 0} onClick={() => move(i, -1)} className="p-1.5 text-slate-400 hover:text-slate-700 disabled:opacity-30" aria-label="Move up"><ArrowUp className="h-4 w-4" /></button>
                      <button disabled={i === rows.length - 1} onClick={() => move(i, 1)} className="p-1.5 text-slate-400 hover:text-slate-700 disabled:opacity-30" aria-label="Move down"><ArrowDown className="h-4 w-4" /></button>
                      <button onClick={() => setRows(rows.filter((_, j) => j !== i))} className="p-1.5 text-slate-400 hover:text-red-600" aria-label="Remove"><Trash2 className="h-4 w-4" /></button>
                    </div>
                    {r.specialPrice != null && r.specialPrice < p.price && !p.variants.length && (
                      <p className="w-full pl-14 text-xs font-medium text-emerald-700">Customer saves {money(p.price - r.specialPrice)} ({Math.round(((p.price - r.specialPrice) / p.price) * 100)}% off)</p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <datalist id="special-tags">{TAGS.map((x) => <option key={x} value={x} />)}</datalist>
        </Card>

        <Card className="flex max-h-[70vh] flex-col">
          <CardHeader title={`Add ${t('product', true).toLowerCase()}`} />
          <div className="px-5 pt-3"><SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" /></div>
          <ul className="mt-2 flex-1 overflow-y-auto px-2 pb-3">
            {available.map((p) => (
              <li key={p.id}>
                <button onClick={() => setRows([...rows, { productId: p.id, specialPrice: null, tag: TAGS[0], sort: rows.length }])} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50">
                  <Thumb item={p} className="h-8 w-8 rounded-md text-xl" /><span className="flex-1 truncate">{p.name}</span><span className="text-xs text-slate-500">{priceLabel(p)}</span><Plus className="h-4 w-4 text-brand-600" />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
