import clsx from 'clsx'
import { Thumb } from '@/components/Thumb'
import { AlertTriangle, Boxes, CalendarClock, ChevronLeft, ChevronRight, Trash2, PackageCheck, PackagePlus, PackageX, Printer, SlidersHorizontal, Wallet } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, SearchInput, Segmented, Select, Stat, Table, Td, Th, useAction, type Tone } from '@/components/ui'
import type { Product, StockMovement, StockMovementType } from '@/core/types'
import { api } from '@/data'
import { fmtDateTime, money, num } from '@/lib/format'
import { isTextileShop } from '@/core/stickers'
import { LabelPrintModal } from '@/features/Labels'
import { PurchasesView, SuppliersView } from '@/features/purchases/Purchases'
import { LoadOlder, Pager, useOlder, usePage } from '@/components/Pager'

const MOVE: Record<StockMovementType, { label: string; tone: Tone }> = {
  opening: { label: 'Opening', tone: 'slate' }, purchase: { label: 'Purchase', tone: 'green' }, sale: { label: 'Sale', tone: 'blue' },
  damage: { label: 'Damage', tone: 'red' }, wastage: { label: 'Wastage', tone: 'orange' }, adjustment: { label: 'Adjustment', tone: 'violet' }, return: { label: 'Return', tone: 'amber' },
}

const HISTORY_PAGE = 50

export default function Inventory() {
  const { t } = useApp()
  const [tab, setTab] = useState<'stock' | 'expiry' | 'history' | 'purchases' | 'suppliers'>('stock')
  const { data: batches = [] } = useData(() => api.inventory.batches())
  const expiringSoon = batches.filter((b) => b.daysLeft !== null && b.daysLeft <= 7)
  const [filter, setFilter] = useState<'all' | 'low' | 'out'>('all')
  const [q, setQ] = useState('')
  const [adjust, setAdjust] = useState<{ p: Product; type: StockMovementType } | null>(null)
  const [trackPick, setTrackPick] = useState(false)
  // The counts come added up and the list a page at a time from the server — the product list is never loaded here.
  // The Data Store setup (or if the summary can't be read): the screen works on the product list.
  // (`big` = the summary came from the server.)
  const { data: summary, error: summaryError } = useData(() => api.inventory.summary())
  const big = summary?.large === true ? summary : null
  const listed = summary?.large === false || !!summaryError
  const { data: products = [] } = useData(() => (listed ? api.products.list() : Promise.resolve([] as Product[])), [listed])
  // History screen: 50 a time (a small, fast read); the Reports tab keeps its own 3,000. From the server they come
  // with each item's name and picture.
  const known = !!summary || !!summaryError
  const movesAfter = (before: Parameters<typeof api.inventory.movements>[1]) => (big ? api.inventory.movements(null, before, HISTORY_PAGE, true) : api.inventory.movements(null, before, HISTORY_PAGE))
  const { data: newest } = useData(() => (known ? movesAfter(null) : Promise.resolve(undefined)), [known, !!big])
  // "Load older" brings the next 50.
  const history = useOlder(newest, HISTORY_PAGE, (m) => m.createdAt, movesAfter)
  const moves = history.rows
  const tracked = products.filter((p) => p.trackStock && p.active)
  const low = tracked.filter((p) => p.stock > 0 && p.stock <= p.lowStockAt)
  const out = tracked.filter((p) => p.stock <= 0)
  const value = tracked.reduce((a, p) => a + p.stock * p.costPrice, 0)
  const list = useMemo(() => tracked.filter((p) => (filter === 'all' || (filter === 'low' ? low.includes(p) : out.includes(p))) && p.name.toLowerCase().includes(q.toLowerCase())), [tracked, filter, q]) // eslint-disable-line react-hooks/exhaustive-deps
  const pname = (m: { productId: string; product?: StockMovement['product'] }) => m.product ?? products.find((p) => p.id === m.productId)
  const counts = big ?? { tracked: tracked.length, low: low.length, out: out.length, value }
  const remote = useStockPages(!!big, filter, q)
  const rowsShown = big ? remote.rows : list

  const pg = usePage(big ? [] : list, [filter, q])
  const pgMoves = usePage(moves, [tab])
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Inventory" subtitle={`Stock is reduced automatically on every ${t('invoice').toLowerCase()}`}
        actions={<>
          <Button variant="secondary" onClick={() => setTrackPick(true)}>Track another item</Button>
          <Segmented value={tab} onChange={setTab} options={[{ value: 'stock', label: 'Stock' }, { value: 'purchases', label: 'Purchases' }, { value: 'suppliers', label: 'Suppliers' }, { value: 'expiry', label: 'Expiry', count: expiringSoon.length || undefined }, { value: 'history', label: 'History' }]} />
        </>} />
      {tab === 'purchases' ? <PurchasesView /> : tab === 'suppliers' ? <SuppliersView /> : <>
      <div className={clsx('mb-4 grid grid-cols-2 gap-3', batches.length ? 'lg:grid-cols-5' : 'lg:grid-cols-4')}>
        <Stat icon={Boxes} label="Items tracked" value={counts.tracked} />
        <Stat icon={AlertTriangle} tone="amber" label="Low stock" value={counts.low} />
        <Stat icon={PackageX} tone="red" label="Out of stock" value={counts.out} />
        {batches.length > 0 && <Stat icon={CalendarClock} tone="orange" label="Expiring in 7 days" value={expiringSoon.length} sub={batches.some((b) => (b.daysLeft ?? 1) < 0) ? <span className="font-medium text-red-600">{batches.filter((b) => (b.daysLeft ?? 1) < 0).length} expired</span> : undefined} />}
        <Stat icon={Wallet} tone="green" label="Stock value (cost)" value={money(counts.value)} />
      </div>

      {tab === 'stock' ? (
        <Card>
          <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row">
            <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${t('product', true).toLowerCase()}`} className="flex-1" />
            <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'low', label: 'Low', count: counts.low }, { value: 'out', label: 'Out', count: counts.out }]} />
          </div>
          {!rowsShown.length ? (big && remote.loading ? <p className="p-6 text-center text-sm text-slate-500">Loading…</p> : <EmptyState icon={PackageCheck} title="Nothing to show" description="Turn on “Track stock” for a product to manage it here." />) : (
            <Table footer={big ? <ServerPager s={remote} /> : <Pager p={pg} />}>
              <thead><tr><Th>{t('product')}</Th><Th className="text-right">In stock</Th><Th className="hidden text-right sm:table-cell">Alert at</Th><Th className="hidden text-right md:table-cell">Value</Th><Th>Status</Th><Th /></tr></thead>
              <tbody>
                {(big ? remote.rows : pg.rows).map((p) => {
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
          <Table footer={<Pager p={pgMoves} more={history.canMore ? <LoadOlder o={history} /> : undefined} />}>
            <thead><tr><Th>Date</Th><Th>{t('product')}</Th><Th>Type</Th><Th className="text-right">Qty</Th><Th className="text-right">Balance</Th><Th className="hidden md:table-cell">Note</Th></tr></thead>
            <tbody>
              {pgMoves.rows.map((m) => (
                <tr key={m.id}>
                  <Td className="whitespace-nowrap text-slate-500">{fmtDateTime(m.createdAt)}</Td>
                  <Td className="font-medium"><span className="flex items-center gap-2">{pname(m) && <Thumb item={pname(m)!} className="h-6 w-6 rounded text-base" />}{pname(m)?.name}</span></Td>
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

      </>}
      {adjust && <AdjustModal product={adjust.p} initialType={adjust.type} onClose={() => setAdjust(null)} />}
      {trackPick && big && <TrackPicker onClose={() => setTrackPick(false)} onPick={(p) => { setTrackPick(false); setAdjust({ p, type: 'opening' }) }} />}
      {trackPick && !big && (
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

/** Typed text, once the typing stops (each search is a server read). */
function useSettled(v: string, ms = 300) {
  const [s, setS] = useState(v)
  useEffect(() => { const t = setTimeout(() => setS(v), ms); return () => clearTimeout(t) }, [v, ms])
  return s
}

/** The stock list: one page from the server at a time (Next / Previous), for the filter and search. */
function useStockPages(on: boolean, filter: 'all' | 'low' | 'out', q: string) {
  const text = useSettled(q.trim())
  // The key of each page shown so far (the first has none); back = the previous key.
  const [keys, setKeys] = useState<(string | null)[]>([null])
  useEffect(() => { setKeys([null]) }, [filter, text])
  const after = keys[keys.length - 1]
  const { data } = useData(() => (on ? api.inventory.stock({ filter, q: text, after }) : Promise.resolve(null)), [on, filter, text, after])
  return {
    rows: data?.rows ?? [], loading: on && data === undefined, page: keys.length,
    next: data?.next ? () => setKeys((k) => [...k, data.next]) : null,
    back: keys.length > 1 ? () => setKeys((k) => k.slice(0, -1)) : null,
  }
}
type StockPages = ReturnType<typeof useStockPages>

/** "Page 2  ‹ ›" under the stock list (from the server). */
function ServerPager({ s }: { s: StockPages }) {
  if (!s.next && !s.back) return null
  const btn = 'inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent'
  return (
    <div className="flex items-center justify-end gap-1 border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">
      <button type="button" aria-label="Previous page" disabled={!s.back} onClick={() => s.back?.()} className={btn}><ChevronLeft className="h-4 w-4" /></button>
      <span className="tabular px-1">Page {s.page}</span>
      <button type="button" aria-label="Next page" disabled={!s.next} onClick={() => s.next?.()} className={btn}><ChevronRight className="h-4 w-4" /></button>
    </div>
  )
}

/** "Track stock for…" (from the server): a search over the goods not tracked yet, 50 at a time. */
function TrackPicker({ onClose, onPick }: { onClose: () => void; onPick: (p: Product) => void }) {
  const [q, setQ] = useState('')
  const text = useSettled(q.trim())
  const [more, setMore] = useState<{ rows: Product[]; next: string | null } | null>(null)
  useEffect(() => { setMore(null) }, [text])
  const { data } = useData(() => api.inventory.untracked({ q: text }), [text])
  const rows = [...(data?.rows ?? []), ...(more?.rows ?? [])]
  const next = more ? more.next : data?.next ?? null
  const [busy, setBusy] = useState(false)
  const loadMore = async () => {
    if (!next || busy) return
    setBusy(true)
    try { const page = await api.inventory.untracked({ q: text, after: next }); setMore((m) => ({ rows: [...(m?.rows ?? []), ...page.rows], next: page.next })) } finally { setBusy(false) }
  }
  return (
    <Modal open onClose={onClose} size="sm" title="Track stock for…">
      <SearchInput autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items" className="mb-2" />
      <ul className="-mx-2 max-h-96 overflow-y-auto">
        {data === undefined && <li className="px-2 py-3 text-sm text-slate-500">Loading…</li>}
        {data !== undefined && !rows.length && <li className="px-2 py-3 text-sm text-slate-500">Nothing to show</li>}
        {rows.map((p) => (
          <li key={p.id}><button onClick={() => onPick(p)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-slate-50"><Thumb item={p} className="h-7 w-7 rounded-md text-lg" />{p.name}</button></li>
        ))}
        {next && <li className="px-2 pt-1"><Button size="sm" variant="ghost" disabled={busy} onClick={loadMore}>Show more</Button></li>}
      </ul>
    </Modal>
  )
}

function AdjustModal({ product, initialType, onClose }: { product: Product; initialType: StockMovementType; onClose: () => void }) {
  const run = useAction()
  const { mod, me } = useApp()
  // Textile: new pieces need price stickers — offer one per piece after a purchase.
  const [stickers, setStickers] = useState<{ count: number; print: boolean } | null>(null)
  const [type, setType] = useState<StockMovementType>(initialType)
  const [qty, setQty] = useState('')
  const [cost, setCost] = useState('')
  const [note, setNote] = useState('')
  const [batchNo, setBatchNo] = useState('')
  const [expiry, setExpiry] = useState('')
  const needsBatch = !!product.trackExpiry && ['purchase', 'opening'].includes(type)
  const n = Number(qty) || 0
  // Only an adjustment goes either way (the server refuses a negative purchase, wastage…).
  const negative = n < 0 && type !== 'adjustment'
  const sign = type === 'adjustment' ? Math.sign(n) : ['purchase', 'opening', 'return'].includes(type) ? 1 : -1
  const after = product.stock + sign * Math.abs(n)
  const offerStickers = !!me && isTextileShop(me.business) && sign > 0 && ['purchase', 'opening', 'return'].includes(type) && Number.isInteger(n) && n > 0 && n <= 500
  if (stickers?.print) return <LabelPrintModal title="Print stickers for the new stock" initial={[{ id: product.id, count: stickers.count }]} onClose={onClose} />
  if (stickers) {
    return (
      <Modal open onClose={onClose} size="sm" title="Stock updated" subtitle={`${product.name}: ${after} ${product.unit} in stock`}>
        <p className="text-sm text-slate-600">Print a price sticker for each of the {stickers.count} new piece{stickers.count === 1 ? '' : 's'}?</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Later</Button>
          <Button icon={Printer} onClick={() => setStickers({ ...stickers, print: true })}>Print {stickers.count} sticker{stickers.count === 1 ? '' : 's'}</Button>
        </div>
      </Modal>
    )
  }
  return (
    <Modal open onClose={onClose} size="sm" title={<span className="flex items-center gap-2"><Thumb item={product} className="h-8 w-8 rounded-lg text-xl" />{product.name}</span>} subtitle={`Current stock: ${product.stock} ${product.unit}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!n || negative || (needsBatch && !expiry)} onClick={async () => { if (await run(() => api.inventory.adjust(product.id, type, n, note || MOVE[type].label, Number(cost) || undefined, needsBatch ? { batchNo, expiry } : undefined), 'Stock updated')) { if (offerStickers) setStickers({ count: n, print: false }); else onClose() } }}>Save</Button></>}>
      <div className="space-y-4">
        <Field required label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as StockMovementType)}>
            {(['purchase', 'opening', 'wastage', 'damage', 'return', 'adjustment'] as StockMovementType[]).map((k) => <option key={k} value={k}>{MOVE[k].label}{k === 'adjustment' ? ' (+ / −)' : ''}</option>)}
          </Select>
        </Field>
        <Field required label={`Quantity (${product.unit})`} hint={type === 'adjustment' ? 'Use a negative number to reduce stock' : undefined} error={negative ? 'Enter a quantity more than 0. To reduce stock, use Wastage, Damage or Adjustment.' : undefined}><Input autoFocus type="number" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        {type === 'purchase' && mod('expenses') && <Field label="Total cost paid (₹)" hint="Optional — also recorded as a Purchase expense"><Input type="number" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder={String(Math.abs(n) * product.costPrice || '')} /></Field>}
        {needsBatch && (
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-orange-200 bg-orange-50/50 p-3">
            <Field required label="Expiry date"><Input type="date" required value={expiry} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setExpiry(e.target.value)} /></Field>
            <Field label="Batch no." hint="Optional"><Input value={batchNo} onChange={(e) => setBatchNo(e.target.value)} placeholder="B2410A" /></Field>
          </div>
        )}
        {product.trackExpiry && !needsBatch && ['wastage', 'damage', 'adjustment'].includes(type) && <p className="text-xs text-slate-500">Taken from the batch that expires first. To remove one specific batch, use Inventory → Expiry → Write off.</p>}
        <Field label="Notes (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Supplier, reason…" /></Field>
        {n !== 0 && !negative && <p className={clsx('rounded-lg px-3 py-2 text-sm font-medium', after < 0 ? 'bg-red-50 text-red-700' : 'bg-slate-50 text-slate-700')}>Stock after: {after} {product.unit}</p>}
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
