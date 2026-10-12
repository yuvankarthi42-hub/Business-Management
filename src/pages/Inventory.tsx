import clsx from 'clsx'
import { Thumb } from '@/components/Thumb'
import { AlertTriangle, Boxes, CalendarClock, Trash2, PackageCheck, PackagePlus, PackageX, SlidersHorizontal, Wallet } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, SearchInput, Segmented, Select, Stat, Table, Td, Th, useAction, type Tone } from '@/components/ui'
import type { Product, StockMovementType } from '@/core/types'
import { api } from '@/data'
import { fmtDateTime, money, num } from '@/lib/format'

const MOVE: Record<StockMovementType, { label: string; tone: Tone }> = {
  opening: { label: 'Opening', tone: 'slate' }, purchase: { label: 'Purchase', tone: 'green' }, sale: { label: 'Sale', tone: 'blue' },
  damage: { label: 'Damage', tone: 'red' }, wastage: { label: 'Wastage', tone: 'orange' }, adjustment: { label: 'Adjustment', tone: 'violet' }, return: { label: 'Return', tone: 'amber' },
}

export default function Inventory() {
  const { t } = useApp()
  const [tab, setTab] = useState<'stock' | 'expiry' | 'history'>('stock')
  const { data: batches = [] } = useData(() => api.inventory.batches())
  const expiringSoon = batches.filter((b) => b.daysLeft !== null && b.daysLeft <= 7)
  const [filter, setFilter] = useState<'all' | 'low' | 'out'>('all')
  const [q, setQ] = useState('')
  const [adjust, setAdjust] = useState<{ p: Product; type: StockMovementType } | null>(null)
  const [trackPick, setTrackPick] = useState(false)
  const { data: products = [] } = useData(() => api.products.list())
  const { data: moves = [] } = useData(() => api.inventory.movements())
  const tracked = products.filter((p) => p.trackStock && p.active)
  const low = tracked.filter((p) => p.stock > 0 && p.stock <= p.lowStockAt)
  const out = tracked.filter((p) => p.stock <= 0)
  const value = tracked.reduce((a, p) => a + p.stock * p.costPrice, 0)
  const list = useMemo(() => tracked.filter((p) => (filter === 'all' || (filter === 'low' ? low.includes(p) : out.includes(p))) && p.name.toLowerCase().includes(q.toLowerCase())), [tracked, filter, q]) // eslint-disable-line react-hooks/exhaustive-deps
  const pname = (id: string) => products.find((p) => p.id === id)

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Inventory" subtitle={`Stock is reduced automatically on every ${t('invoice').toLowerCase()}`}
        actions={<>
          <Button variant="secondary" onClick={() => setTrackPick(true)}>Track another item</Button>
          <Segmented value={tab} onChange={setTab} options={[{ value: 'stock', label: 'Stock' }, { value: 'expiry', label: 'Expiry', count: expiringSoon.length || undefined }, { value: 'history', label: 'History' }]} />
        </>} />
      <div className={clsx('mb-4 grid grid-cols-2 gap-3', batches.length ? 'lg:grid-cols-5' : 'lg:grid-cols-4')}>
        <Stat icon={Boxes} label="Items tracked" value={tracked.length} />
        <Stat icon={AlertTriangle} tone="amber" label="Low stock" value={low.length} />
        <Stat icon={PackageX} tone="red" label="Out of stock" value={out.length} />
        {batches.length > 0 && <Stat icon={CalendarClock} tone="orange" label="Expiring in 7 days" value={expiringSoon.length} sub={batches.some((b) => (b.daysLeft ?? 1) < 0) ? <span className="font-medium text-red-600">{batches.filter((b) => (b.daysLeft ?? 1) < 0).length} expired</span> : undefined} />}
        <Stat icon={Wallet} tone="green" label="Stock value (cost)" value={money(value)} />
      </div>

      {tab === 'stock' ? (
        <Card>
          <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row">
            <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${t('product', true).toLowerCase()}`} className="flex-1" />
            <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'low', label: 'Low', count: low.length }, { value: 'out', label: 'Out', count: out.length }]} />
          </div>
          {!list.length ? <EmptyState icon={PackageCheck} title="Nothing to show" description="Turn on “Track stock” for a product to manage it here." /> : (
            <Table>
              <thead><tr><Th>{t('product')}</Th><Th className="text-right">In stock</Th><Th className="hidden text-right sm:table-cell">Alert at</Th><Th className="hidden text-right md:table-cell">Value</Th><Th>Status</Th><Th /></tr></thead>
              <tbody>
                {list.map((p) => {
                  const pct = Math.min(100, (p.stock / Math.max(1, p.lowStockAt * 4)) * 100)
                  return (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <Td><div className="flex items-center gap-2.5"><Thumb item={p} className="h-9 w-9 rounded-lg text-xl" /><div><p className="font-medium text-slate-900">{p.name}</p><p className="text-xs text-slate-500">{p.sku}</p></div></div></Td>
                      <Td className="text-right">
                        <p className="font-semibold tabular">{num(p.stock)} <span className="text-xs font-normal text-slate-500">{p.unit}</span></p>
                        {p.nextExpiry && <p className={clsx('text-[11px] font-medium', expiryTone(p.nextExpiry))}>Exp {fmtExpiry(p.nextExpiry)}</p>}
                        <div className="ml-auto mt-1 h-1.5 w-20 rounded-full bg-slate-100"><div className={clsx('h-full rounded-full', p.stock <= 0 ? 'bg-red-500' : p.stock <= p.lowStockAt ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${pct}%` }} /></div>
                      </Td>
                      <Td className="hidden text-right tabular text-slate-500 sm:table-cell">{p.lowStockAt}</Td>
                      <Td className="hidden text-right tabular md:table-cell">{money(p.stock * p.costPrice)}</Td>
                      <Td>{p.stock <= 0 ? <Badge tone="red">Out of stock</Badge> : p.stock <= p.lowStockAt ? <Badge tone="amber">Low stock</Badge> : <Badge tone="green">In stock</Badge>}</Td>
                      <Td className="whitespace-nowrap text-right">
                        <Button size="sm" variant="soft" icon={PackagePlus} onClick={() => setAdjust({ p, type: 'purchase' })}>Purchase</Button>
                        <Button size="sm" variant="ghost" icon={SlidersHorizontal} onClick={() => setAdjust({ p, type: 'wastage' })} className="ml-1">Adjust</Button>
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </Table>
          )}
        </Card>
      ) : tab === 'expiry' ? (
        <ExpiryView batches={batches} />
      ) : (
        <Card>
          <Table>
            <thead><tr><Th>Date</Th><Th>{t('product')}</Th><Th>Type</Th><Th className="text-right">Qty</Th><Th className="text-right">Balance</Th><Th className="hidden md:table-cell">Note</Th></tr></thead>
            <tbody>
              {moves.slice(0, 200).map((m) => (
                <tr key={m.id}>
                  <Td className="whitespace-nowrap text-slate-500">{fmtDateTime(m.createdAt)}</Td>
                  <Td className="font-medium"><span className="flex items-center gap-2">{pname(m.productId) && <Thumb item={pname(m.productId)!} className="h-6 w-6 rounded text-base" />}{pname(m.productId)?.name}</span></Td>
                  <Td><Badge tone={MOVE[m.type].tone}>{MOVE[m.type].label}</Badge></Td>
                  <Td className={clsx('text-right font-semibold tabular', m.qty > 0 ? 'text-emerald-600' : 'text-red-600')}>{m.qty > 0 ? '+' : ''}{num(m.qty)}</Td>
                  <Td className="text-right tabular">{num(m.balanceAfter)}</Td>
                  <Td className="hidden text-slate-500 md:table-cell">{m.note}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {adjust && <AdjustModal product={adjust.p} initialType={adjust.type} onClose={() => setAdjust(null)} />}
      {trackPick && (
        <Modal open onClose={() => setTrackPick(false)} size="sm" title="Track stock for…">
          <ul className="-mx-2 max-h-96 overflow-y-auto">
            {products.filter((p) => !p.trackStock && p.kind === 'goods' && p.active).map((p) => (
              <li key={p.id}><button onClick={() => { setTrackPick(false); setAdjust({ p, type: 'opening' }) }} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-slate-50"><Thumb item={p} className="h-7 w-7 rounded-md text-lg" />{p.name}</button></li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  )
}

function AdjustModal({ product, initialType, onClose }: { product: Product; initialType: StockMovementType; onClose: () => void }) {
  const run = useAction()
  const { mod } = useApp()
  const [type, setType] = useState<StockMovementType>(initialType)
  const [qty, setQty] = useState('')
  const [cost, setCost] = useState('')
  const [note, setNote] = useState('')
  const [batchNo, setBatchNo] = useState('')
  const [expiry, setExpiry] = useState('')
  const needsBatch = !!product.trackExpiry && ['purchase', 'opening'].includes(type)
  const n = Number(qty) || 0
  const sign = type === 'adjustment' ? Math.sign(n) : ['purchase', 'opening', 'return'].includes(type) ? 1 : -1
  const after = product.stock + sign * Math.abs(n)
  return (
    <Modal open onClose={onClose} size="sm" title={<span className="flex items-center gap-2"><Thumb item={product} className="h-8 w-8 rounded-lg text-xl" />{product.name}</span>} subtitle={`Current stock: ${product.stock} ${product.unit}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!n || (needsBatch && !expiry)} onClick={async () => { if (await run(() => api.inventory.adjust(product.id, type, n, note || MOVE[type].label, Number(cost) || undefined, needsBatch ? { batchNo, expiry } : undefined), 'Stock updated')) onClose() }}>Save</Button></>}>
      <div className="space-y-4">
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as StockMovementType)}>
            {(['purchase', 'opening', 'wastage', 'damage', 'return', 'adjustment'] as StockMovementType[]).map((k) => <option key={k} value={k}>{MOVE[k].label}{k === 'adjustment' ? ' (+ / −)' : ''}</option>)}
          </Select>
        </Field>
        <Field label={`Quantity (${product.unit})`} hint={type === 'adjustment' ? 'Use a negative number to reduce stock' : undefined}><Input autoFocus type="number" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        {type === 'purchase' && mod('expenses') && <Field label="Total cost paid (₹)" hint="Optional — also recorded as a Purchase expense"><Input type="number" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder={String(Math.abs(n) * product.costPrice || '')} /></Field>}
        {needsBatch && (
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-orange-200 bg-orange-50/50 p-3">
            <Field label="Expiry date"><Input type="date" required value={expiry} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setExpiry(e.target.value)} /></Field>
            <Field label="Batch no." hint="Optional"><Input value={batchNo} onChange={(e) => setBatchNo(e.target.value)} placeholder="B2410A" /></Field>
          </div>
        )}
        {product.trackExpiry && !needsBatch && ['wastage', 'damage', 'adjustment'].includes(type) && <p className="text-xs text-slate-500">Taken from the batch that expires first. To remove one specific batch, use Inventory → Expiry → Write off.</p>}
        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Supplier, reason…" /></Field>
        {n !== 0 && <p className={clsx('rounded-lg px-3 py-2 text-sm font-medium', after < 0 ? 'bg-red-50 text-red-700' : 'bg-slate-50 text-slate-700')}>Stock after: {after} {product.unit}</p>}
      </div>
    </Modal>
  )
}

type BatchRow = Awaited<ReturnType<typeof api.inventory.batches>>[number]

export const fmtExpiry = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })
const daysTo = (iso: string) => Math.round((new Date(`${iso}T00:00:00`).getTime() - new Date(new Date().toDateString()).getTime()) / 86400000)
export const expiryTone = (iso: string) => { const n = daysTo(iso); return n < 0 ? 'text-red-600' : n <= 7 ? 'text-orange-600' : 'text-slate-500' }
const whenText = (n: number | null) => n === null ? 'No expiry date' : n < 0 ? `Expired ${-n} day${n === -1 ? '' : 's'} ago` : n === 0 ? 'Expires today' : `In ${n} day${n === 1 ? '' : 's'}`

/** Inventory → Expiry: batches by expiry date, with write-off for expired stock. */
function ExpiryView({ batches }: { batches: BatchRow[] }) {
  const { t } = useApp()
  const run = useAction()
  const [range, setRange] = useState<'expired' | '7' | '30' | 'all'>('7')
  const list = batches.filter((b) => range === 'all' ? true : range === 'expired' ? (b.daysLeft ?? 1) < 0 : b.daysLeft !== null && b.daysLeft <= Number(range))
  const count = (r: typeof range) => batches.filter((b) => r === 'all' ? true : r === 'expired' ? (b.daysLeft ?? 1) < 0 : b.daysLeft !== null && b.daysLeft <= Number(r)).length
  const lossValue = list.filter((b) => (b.daysLeft ?? 1) < 0).reduce((a, b) => a + b.qty * (b.product?.costPrice ?? 0), 0)
  return (
    <Card>
      <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row sm:items-center">
        <Segmented value={range} onChange={setRange} options={[
          { value: 'expired', label: 'Expired', count: count('expired') },
          { value: '7', label: 'Next 7 days', count: count('7') },
          { value: '30', label: 'Next 30 days', count: count('30') },
          { value: 'all', label: 'All batches', count: count('all') },
        ]} />
        {lossValue > 0 && <span className="text-sm text-red-600 sm:ml-auto">Expired stock value: <b>{money(lossValue)}</b></span>}
      </div>
      {!list.length ? (
        <EmptyState icon={CalendarClock} title={range === 'expired' ? 'Nothing expired' : 'Nothing expiring in this period'}
          description={batches.length ? undefined : `Turn on “Track batch & expiry” for a ${t('product').toLowerCase()} (Products → Edit → Stock), then add stock with an expiry date.`} />
      ) : (
        <Table>
          <thead><tr><Th>{t('product')}</Th><Th>Batch</Th><Th>Expiry</Th><Th className="text-right">Qty left</Th><Th className="hidden text-right md:table-cell">Value</Th><Th /></tr></thead>
          <tbody>
            {list.map((b) => {
              const n = b.daysLeft
              return (
                <tr key={b.id} className={clsx(n !== null && n < 0 && 'bg-red-50/40')}>
                  <Td><div className="flex items-center gap-2.5">{b.product && <Thumb item={b.product} className="h-8 w-8 rounded-md text-lg" />}<span className="font-medium">{b.product?.name ?? '—'}</span></div></Td>
                  <Td className="font-mono text-xs text-slate-500">{b.batchNo || '—'}</Td>
                  <Td>
                    <p className="font-medium">{b.expiry ? fmtExpiry(b.expiry) : '—'}</p>
                    <p className={clsx('text-xs font-semibold', n === null ? 'text-slate-400' : n < 0 ? 'text-red-600' : n <= 7 ? 'text-orange-600' : 'text-slate-500')}>{whenText(n)}</p>
                  </Td>
                  <Td className="text-right tabular">{num(b.qty)} <span className="text-xs text-slate-500">{b.product?.unit}</span></Td>
                  <Td className="hidden text-right tabular md:table-cell">{money(b.qty * (b.product?.costPrice ?? 0))}</Td>
                  <Td className="text-right">
                    <Button size="sm" variant={n !== null && n < 0 ? 'danger' : 'ghost'} icon={Trash2}
                      onClick={() => run(() => api.inventory.writeOffBatch(b.id, n !== null && n < 0 ? 'Expired' : 'Removed'), `${b.product?.name} batch written off`)}>
                      Write off
                    </Button>
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </Table>
      )}
    </Card>
  )
}
