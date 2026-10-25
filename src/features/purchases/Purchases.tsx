// Inventory → Purchases (supplier bills: stock in + input GST) and Inventory → Suppliers (balance, statement, payments).
import clsx from 'clsx'
import { Ban, FileText, IndianRupee, Pencil, Plus, Printer, ScanLine, Trash2, Truck, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { Badge, Button, Card, Drawer, EmptyState, Field, Input, Modal, SearchInput, Select, Table, Td, Textarea, Th, useAction } from '@/components/ui'
import { PhoneInput } from '@/components/PhoneInput'
import { PAYMENT_LABEL } from '@/core/config'
import { gstinState, isInterState, shopStateOf, stateLabel } from '@/core/gst'
import { r2 } from '@/core/pricing'
import { SUPPLIER_PAY_METHODS, type SupplierPayMethod } from '@/core/purchases'
import { isTextileShop } from '@/core/stickers'
import type { Product, Purchase, Supplier } from '@/core/types'
import { api } from '@/data'
import { fmtDate, money } from '@/lib/format'
import { GstinInput, StateSelect } from '../gst/GstFields'
import { LabelPrintModal } from '../Labels'

const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)

// ======================================================================= Purchases

export function PurchasesView() {
  const { me } = useApp()
  const { data: purchases } = useData(() => api.purchases.list())
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<Purchase | null>(null)
  const list = useMemo(() => (purchases ?? []).filter((p) => { const s = q.trim().toLowerCase(); return !s || p.number.toLowerCase().includes(s) || p.supplierName.toLowerCase().includes(s) || p.supplierBillNo.toLowerCase().includes(s) }), [purchases, q])
  const month = today().slice(0, 7)
  const thisMonth = (purchases ?? []).filter((p) => p.status === 'final' && p.date.startsWith(month))
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Mini k="Purchases this month" v={money(thisMonth.reduce((a, p) => a + p.total, 0))} />
        <Mini k="Input GST this month" v={money(thisMonth.reduce((a, p) => a + p.tax, 0))} />
        <Mini k="Bills this month" v={String(thisMonth.length)} />
        <Mini k="Unpaid on these bills" v={money(thisMonth.reduce((a, p) => a + p.balance, 0))} tone="amber" />
      </div>
      <Card>
        <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row">
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search purchase no., supplier or their bill no." className="flex-1" />
          <Button icon={Plus} write onClick={() => setCreating(true)}>New purchase bill</Button>
        </div>
        {purchases && !list.length ? (
          <EmptyState icon={Truck} title="No purchase bills yet" description="Enter a supplier’s bill: stock goes up, cost prices update and the GST is kept for your GST return." action={<Button icon={Plus} onClick={() => setCreating(true)}>New purchase bill</Button>} />
        ) : (
          <Table>
            <thead><tr><Th>Purchase</Th><Th>Supplier</Th><Th className="hidden sm:table-cell">Date</Th><Th className="text-right">Total</Th><Th className="hidden text-right md:table-cell">GST</Th><Th className="text-right">Unpaid</Th></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} onClick={() => setOpen(p)} className="cursor-pointer hover:bg-slate-50">
                  <Td><p className="font-medium">{p.number}{p.status === 'void' && <Badge tone="red" className="ml-2">Voided</Badge>}</p><p className="text-xs text-slate-500">{p.supplierBillNo ? `Bill ${p.supplierBillNo} · ` : ''}{p.lines.length} item{p.lines.length === 1 ? '' : 's'}</p></Td>
                  <Td>{p.supplierName}{p.igst && <Badge tone="violet" className="ml-1.5">IGST</Badge>}</Td>
                  <Td className="hidden text-slate-500 sm:table-cell">{fmtDate(p.date)}</Td>
                  <Td className={clsx('text-right font-semibold tabular', p.status === 'void' && 'text-slate-400 line-through')}>{money(p.total)}</Td>
                  <Td className="hidden text-right tabular text-slate-500 md:table-cell">{money(p.tax)}</Td>
                  <Td className="text-right tabular">{p.status === 'final' && p.balance > 0 ? <span className="font-medium text-amber-700">{money(p.balance)}</span> : <span className="text-slate-400">—</span>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {creating && <NewPurchaseModal onClose={() => setCreating(false)} />}
      {open && <PurchaseDetail purchase={open} onClose={() => setOpen(null)} textile={!!me && isTextileShop(me.business)} />}
    </>
  )
}

const Mini = ({ k, v, tone }: { k: string; v: string; tone?: 'amber' }) => (
  <div className="rounded-xl border border-slate-200 bg-white p-3"><p className="text-xs text-slate-500">{k}</p><p className={clsx('mt-0.5 text-lg font-semibold tabular', tone === 'amber' && 'text-amber-700')}>{v}</p></div>
)

interface Row { key: string; productId: string; qty: string; cost: string; taxRate: number; hsn: string; batchNo: string; expiry: string }

export function NewPurchaseModal({ onClose, supplierId: preset }: { onClose: () => void; supplierId?: string }) {
  const { me } = useApp()
  const run = useAction()
  const b = me!.business
  const { data: suppliers = [] } = useData(() => api.suppliers.list())
  const { data: products = [] } = useData(() => api.products.list())
  const [supplierId, setSupplierId] = useState(preset ?? '')
  const [newSupplier, setNewSupplier] = useState(false)
  const [billNo, setBillNo] = useState('')
  const [date, setDate] = useState(today())
  const [rows, setRows] = useState<Row[]>([])
  const [q, setQ] = useState('')
  const [paid, setPaid] = useState('')
  const [method, setMethod] = useState<SupplierPayMethod>('cash')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [saved, setSaved] = useState<Purchase | null>(null)
  const [printing, setPrinting] = useState(false)
  const rateOf = (p: Product) => b.billing.taxRates.find((r) => r.id === (p.taxRateId ?? b.billing.defaultTaxRateId))?.rate ?? 0
  const byId = (id: string) => products.find((p) => p.id === id)
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return []
    return products.filter((p) => p.active && p.kind === 'goods' && (p.name.toLowerCase().includes(s) || p.barcode === s || p.sku.toLowerCase() === s)).slice(0, 8)
  }, [q, products])
  const add = (p: Product) => {
    setRows((r) => r.some((x) => x.productId === p.id && !p.trackExpiry) ? r.map((x) => (x.productId === p.id ? { ...x, qty: String((Number(x.qty) || 0) + 1) } : x))
      : [...r, { key: `${p.id}-${Date.now()}`, productId: p.id, qty: '1', cost: p.costPrice ? String(p.costPrice) : '', taxRate: rateOf(p), hsn: p.hsn ?? '', batchNo: '', expiry: '' }])
    setQ('')
  }
  const set = (key: string, patch: Partial<Row>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)))
  const lines = rows.map((r) => { const qty = Number(r.qty) || 0, cost = Number(r.cost) || 0, taxable = r2(qty * cost); return { r, p: byId(r.productId), qty, cost, taxable, tax: r2((taxable * r.taxRate) / 100) } })
  const taxable = r2(lines.reduce((a, l) => a + l.taxable, 0)), tax = r2(lines.reduce((a, l) => a + l.tax, 0))
  const total = Math.round(taxable + tax)
  const supplier = suppliers.find((s) => s.id === supplierId)
  const igst = isInterState(shopStateOf(b), supplier?.stateCode ?? null)
  const paidNum = paid === '' ? 0 : Number(paid)
  const problem = !supplierId ? 'Choose the supplier' : !rows.length ? 'Add the items on the bill' : lines.some((l) => !(l.qty > 0)) ? 'Enter every quantity' : lines.some((l) => l.p?.trackExpiry && !l.r.expiry) ? 'Enter the expiry date for batch items' : paidNum > total ? 'Paid is more than the bill total' : ''
  const save = () => run(async () => {
    setSaved(await api.purchases.create({
      supplierId, supplierBillNo: billNo, date, paid: paidNum, method, reference, note,
      lines: rows.map((r) => ({ productId: r.productId, qty: Number(r.qty), cost: Number(r.cost) || 0, taxRate: r.taxRate, hsn: r.hsn, batchNo: r.batchNo || undefined, expiry: r.expiry || undefined })),
    }))
  }, 'Purchase saved — stock updated')

  if (saved && printing) return <LabelPrintModal title="Stickers for the new stock" initial={saved.lines.map((l) => ({ id: l.productId, count: Math.max(1, Math.round(l.qty)) }))} onClose={onClose} />
  if (saved) {
    return (
      <Modal open onClose={onClose} size="sm" title={`Purchase ${saved.number} saved`} subtitle={`${saved.supplierName} · ${money(saved.total)}`}>
        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between"><span className="text-slate-500">Stock added</span><span>{saved.lines.length} item{saved.lines.length === 1 ? '' : 's'}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">Input GST</span><span>{money(saved.tax, { decimals: true })}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">Paid now</span><span>{money(saved.paid)}</span></div>
          <div className="flex justify-between font-medium"><span>Still to pay the supplier</span><span className={saved.balance > 0 ? 'text-amber-700' : ''}>{money(saved.balance)}</span></div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Done</Button>
          {isTextileShop(b) && <Button icon={Printer} onClick={() => setPrinting(true)}>Print stickers</Button>}
        </div>
      </Modal>
    )
  }
  return (
    <Modal open onClose={onClose} size="xl" title="New purchase bill" subtitle="Copy the supplier’s bill: items, quantity, cost before GST and the GST rate"
      footer={<>
        <span className="mr-auto self-center text-sm text-slate-500">{problem || <>Bill total <b className="text-slate-800">{money(total)}</b>{igst ? ' · IGST (other state)' : ''}</>}</span>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button icon={Truck} disabled={!!problem} onClick={async () => { await save() }}>Save purchase</Button>
      </>}>
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <Field required label="Supplier">
              <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">Choose…</option>
                {suppliers.filter((s) => s.active || s.id === supplierId).map((s) => <option key={s.id} value={s.id}>{s.name}{s.balance ? ` · owes ${money(s.balance)}` : ''}</option>)}
              </Select>
            </Field>
            <button type="button" onClick={() => setNewSupplier(true)} className="mt-1.5 text-xs font-medium text-brand-600 hover:underline">+ New supplier</button>
          </div>
          <Field label="Supplier’s bill no."><Input value={billNo} onChange={(e) => setBillNo(e.target.value)} placeholder="AWS/2026/481" /></Field>
          <Field required label="Bill date"><Input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>

        <div>
          <div className="relative">
            <SearchInput autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add item — name, barcode or code (scan works)"
              onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) { e.preventDefault(); add(matches[0]) } }} />
            <ScanLine className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" />
            {!!matches.length && (
              <div className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
                {matches.map((p) => (
                  <button key={p.id} type="button" onClick={() => add(p)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50">
                    <span className="min-w-0 truncate font-medium">{p.name}</span><span className="shrink-0 text-xs text-slate-500">cost {money(p.costPrice)} · stock {p.stock}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr><th className="px-3 py-2 text-left font-medium">Item</th><th className="w-20 px-2 py-2 text-right font-medium">Qty</th><th className="w-28 px-2 py-2 text-right font-medium">Cost (before GST)</th><th className="w-24 px-2 py-2 text-right font-medium">GST %</th><th className="w-24 px-2 py-2 text-left font-medium">HSN</th><th className="w-28 px-2 py-2 text-right font-medium">Amount</th><th className="w-8" /></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lines.map(({ r, p, taxable, tax }) => (
                  <tr key={r.key} className="align-top">
                    <td className="px-3 py-2">
                      <p className="font-medium">{p?.name ?? 'Item'}</p>
                      {p?.trackExpiry ? (
                        <div className="mt-1 flex gap-1.5">
                          <Input value={r.batchNo} onChange={(e) => set(r.key, { batchNo: e.target.value })} placeholder="Batch no." className="h-8 w-28 text-xs" aria-label="Batch no." />
                          <Input type="date" value={r.expiry} onChange={(e) => set(r.key, { expiry: e.target.value })} className={clsx('h-8 w-36 text-xs', !r.expiry && 'border-amber-300')} aria-label="Expiry date" />
                        </div>
                      ) : <p className="text-[11px] text-slate-400">{p?.unit} · now {p?.stock ?? 0} in stock</p>}
                    </td>
                    <td className="px-2 py-2"><Input type="number" inputMode="decimal" min={0} value={r.qty} onChange={(e) => set(r.key, { qty: e.target.value })} className="h-9 text-right" aria-label="Quantity" /></td>
                    <td className="px-2 py-2"><Input type="number" inputMode="decimal" min={0} step="0.01" value={r.cost} onChange={(e) => set(r.key, { cost: e.target.value })} className="h-9 text-right" placeholder="0" aria-label="Cost" /></td>
                    <td className="px-2 py-2">
                      <Select value={r.taxRate} onChange={(e) => set(r.key, { taxRate: Number(e.target.value) })} className="h-9" aria-label="GST rate">
                        {[...new Set([...b.billing.taxRates.map((t) => t.rate), r.taxRate])].sort((x, y) => x - y).map((v) => <option key={v} value={v}>{v}%</option>)}
                      </Select>
                    </td>
                    <td className="px-2 py-2"><Input value={r.hsn} onChange={(e) => set(r.key, { hsn: e.target.value.replace(/\D/g, '').slice(0, 8) })} className="h-9 font-mono text-xs" placeholder="—" aria-label="HSN" /></td>
                    <td className="px-2 py-2 text-right tabular"><p className="font-medium">{money(r2(taxable + tax), { decimals: true })}</p><p className="text-[11px] text-slate-400">GST {money(tax, { decimals: true })}</p></td>
                    <td className="py-2 pr-2"><button type="button" aria-label="Remove" onClick={() => setRows((x) => x.filter((y) => y.key !== r.key))} className="p-1 text-slate-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button></td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={7} className="px-3 py-10 text-center text-sm text-slate-400">Search or scan above to add the items on the supplier’s bill</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="grid gap-5 sm:grid-cols-[1fr_280px]">
          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_130px] gap-3">
              <Field label="Paid now" hint="Leave empty if it’s on credit"><div className="relative"><span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">₹</span><Input type="number" inputMode="decimal" min={0} value={paid} onChange={(e) => setPaid(e.target.value)} placeholder="0" className="pl-7" /></div></Field>
              <Field required label="Paid by"><Select value={method} onChange={(e) => setMethod(e.target.value as SupplierPayMethod)}>{SUPPLIER_PAY_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_LABEL[m]}</option>)}</Select></Field>
            </div>
            {paidNum > 0 && method !== 'cash' && <Field label="Reference" hint="UTR / cheque no."><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>}
            <div className="flex flex-wrap gap-1.5">
              {total > 0 && <button type="button" className="rounded-full border border-slate-200 px-2.5 py-0.5 text-xs text-slate-600 hover:border-brand-300" onClick={() => setPaid(String(total))}>Paid in full</button>}
              {total > 0 && <button type="button" className="rounded-full border border-slate-200 px-2.5 py-0.5 text-xs text-slate-600 hover:border-brand-300" onClick={() => setPaid('')}>On credit</button>}
            </div>
            <Field label="Note" hint="Optional"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          </div>
          <div className="space-y-1.5 rounded-xl bg-slate-50 p-4 text-sm">
            <div className="flex justify-between"><span className="text-slate-500">Value before GST</span><span className="tabular">{money(taxable, { decimals: true })}</span></div>
            {igst ? <div className="flex justify-between"><span className="text-slate-500">IGST</span><span className="tabular">{money(tax, { decimals: true })}</span></div> : <>
              <div className="flex justify-between"><span className="text-slate-500">CGST</span><span className="tabular">{money(r2(tax / 2), { decimals: true })}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">SGST</span><span className="tabular">{money(r2(tax - r2(tax / 2)), { decimals: true })}</span></div>
            </>}
            <div className="flex justify-between"><span className="text-slate-500">Round off</span><span className="tabular">{money(r2(total - taxable - tax), { decimals: true })}</span></div>
            <div className="flex justify-between border-t border-dashed border-slate-200 pt-2 text-base font-semibold"><span>Bill total</span><span className="tabular">{money(total)}</span></div>
            <div className="flex justify-between text-amber-700"><span>To pay the supplier later</span><span className="tabular">{money(Math.max(0, r2(total - paidNum)))}</span></div>
          </div>
        </div>
      </div>
      {newSupplier && <SupplierForm initial={{}} onClose={(s) => { setNewSupplier(false); if (s) setSupplierId(s.id) }} />}
    </Modal>
  )
}

function PurchaseDetail({ purchase: p0, onClose, textile }: { purchase: Purchase; onClose: () => void; textile: boolean }) {
  const run = useAction()
  const { data: list = [] } = useData(() => api.purchases.list())
  const p = list.find((x) => x.id === p0.id) ?? p0
  const [voiding, setVoiding] = useState(false)
  const [reason, setReason] = useState('')
  const [printing, setPrinting] = useState(false)
  if (printing) return <LabelPrintModal title={`Stickers for ${p.number}`} initial={p.lines.map((l) => ({ id: l.productId, count: Math.max(1, Math.round(l.qty)) }))} onClose={() => setPrinting(false)} />
  return (
    <Drawer open onClose={onClose} width="max-w-xl" title={<span className="flex items-center gap-2">{p.number}{p.status === 'void' && <Badge tone="red">Voided</Badge>}</span>} subtitle={`${p.supplierName} · ${fmtDate(p.date)}${p.supplierBillNo ? ` · bill ${p.supplierBillNo}` : ''}`}
      footer={p.status === 'final' ? <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" icon={Ban} className="!text-red-600" onClick={() => setVoiding(true)}>Void purchase</Button>
        {textile && <Button variant="secondary" icon={Printer} onClick={() => setPrinting(true)}>Print stickers</Button>}
      </div> : undefined}>
      <div className="space-y-4 p-5">
        {p.status === 'void' && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">Voided — {p.voidReason}. Its stock was taken back out.</p>}
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 text-sm">
          {p.lines.map((l) => (
            <li key={l.id ?? l.productId} className="flex items-start gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1"><p className="font-medium">{l.name}</p><p className="text-xs text-slate-500">{l.qty} {l.unit} × {money(l.cost, { decimals: true })} · GST {l.taxRate}%{l.hsn ? ` · HSN ${l.hsn}` : ''}{l.batchNo ? ` · batch ${l.batchNo}` : ''}{l.expiry ? ` · exp ${fmtDate(l.expiry)}` : ''}</p></div>
              <span className="font-medium tabular">{money(r2(l.taxable + l.tax), { decimals: true })}</span>
            </li>
          ))}
        </ul>
        <div className="space-y-1 text-sm">
          <div className="flex justify-between"><span className="text-slate-500">Value before GST</span><span className="tabular">{money(p.taxable, { decimals: true })}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">{p.igst ? 'IGST' : 'CGST + SGST'}</span><span className="tabular">{money(p.tax, { decimals: true })}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">Round off</span><span className="tabular">{money(p.roundOff, { decimals: true })}</span></div>
          <div className="flex justify-between font-semibold"><span>Total</span><span className="tabular">{money(p.total)}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">Paid with the bill</span><span className="tabular">{money(p.paid)}</span></div>
        </div>
        {p.note && <p className="text-sm text-slate-600">📝 {p.note}</p>}
      </div>
      {voiding && (
        <Modal open onClose={() => setVoiding(false)} size="sm" title={`Void ${p.number}?`} subtitle="The stock from this bill is taken back out. Money already paid stays on the supplier’s statement as an advance."
          footer={<><Button variant="ghost" onClick={() => setVoiding(false)}>Cancel</Button><Button variant="danger" disabled={!reason.trim()} onClick={async () => { if (await run(() => api.purchases.void(p.id, reason), 'Purchase voided')) setVoiding(false) }}>Void purchase</Button></>}>
          <Field required label="Reason"><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Entered twice" /></Field>
        </Modal>
      )}
    </Drawer>
  )
}

// ======================================================================= Suppliers

export function SuppliersView() {
  const { data: suppliers } = useData(() => api.suppliers.list())
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<Partial<Supplier> | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const list = useMemo(() => (suppliers ?? []).filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()) || s.phone.includes(q) || s.gstin.includes(q.toUpperCase())), [suppliers, q])
  const owed = (suppliers ?? []).reduce((a, s) => a + Math.max(0, s.balance ?? 0), 0)
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Mini k="Suppliers" v={String(suppliers?.length ?? '—')} />
        <Mini k="You owe suppliers" v={money(owed)} tone="amber" />
      </div>
      <Card>
        <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row">
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, phone or GSTIN" className="flex-1" />
          <Button icon={Plus} write onClick={() => setEdit({})}>Add supplier</Button>
        </div>
        {suppliers && !list.length ? <EmptyState icon={Users} title="No suppliers yet" description="Add the people and companies you buy stock from." action={<Button icon={Plus} onClick={() => setEdit({})}>Add supplier</Button>} /> : (
          <Table>
            <thead><tr><Th>Supplier</Th><Th className="hidden sm:table-cell">GSTIN</Th><Th className="hidden text-right md:table-cell">Bills</Th><Th className="hidden md:table-cell">Last purchase</Th><Th className="text-right">You owe</Th></tr></thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} onClick={() => setOpen(s.id)} className="cursor-pointer hover:bg-slate-50">
                  <Td><p className="font-medium">{s.name}{!s.active && <Badge className="ml-2">Inactive</Badge>}</p><p className="text-xs text-slate-500">{s.phone || '—'}{s.stateCode ? ` · ${stateLabel(s.stateCode)}` : ''}</p></Td>
                  <Td className="hidden font-mono text-xs text-slate-500 sm:table-cell">{s.gstin || '—'}</Td>
                  <Td className="hidden text-right tabular md:table-cell">{s.purchases ?? 0}</Td>
                  <Td className="hidden text-slate-500 md:table-cell">{s.lastPurchaseOn ? fmtDate(s.lastPurchaseOn) : '—'}</Td>
                  <Td className="text-right tabular">{(s.balance ?? 0) > 0 ? <span className="font-semibold text-amber-700">{money(s.balance!)}</span> : (s.balance ?? 0) < 0 ? <span className="text-emerald-700">Advance {money(-s.balance!)}</span> : <span className="text-slate-400">—</span>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {edit && <SupplierForm initial={edit} onClose={() => setEdit(null)} />}
      {open && <SupplierDrawer id={open} onClose={() => setOpen(null)} onEdit={(s) => setEdit(s)} />}
    </>
  )
}

export function SupplierForm({ initial, onClose }: { initial: Partial<Supplier>; onClose: (s?: Supplier) => void }) {
  const { me } = useApp()
  const run = useAction()
  const [s, setS] = useState<Partial<Supplier>>({ name: '', phone: '', gstin: '', address: '', notes: '', openingBalance: 0, active: true, ...initial })
  return (
    <Modal open onClose={() => onClose()} title={initial.id ? `Edit ${initial.name}` : 'Add supplier'}
      footer={<><Button variant="ghost" onClick={() => onClose()}>Cancel</Button><Button onClick={async () => { let saved: Supplier | undefined; if (await run(async () => { saved = await api.suppliers.save({ ...s, name: s.name ?? '' }) }, 'Supplier saved')) onClose(saved) }}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field required label="Name" className="sm:col-span-2"><Input autoFocus value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} placeholder="Arani Weavers Society" /></Field>
        <div><span className="mb-1.5 block text-xs font-medium text-slate-600">Phone</span><PhoneInput value={s.phone ?? ''} onChange={(v) => setS({ ...s, phone: v })} defaultCountry={me?.business.defaultCountry} /></div>
        <GstinInput value={s.gstin ?? ''} onChange={(v) => setS({ ...s, gstin: v })} hint="Needed to claim input tax credit" />
        {!gstinState(s.gstin) && <StateSelect value={s.stateCode} onChange={(v) => setS({ ...s, stateCode: v })} label="State" hint="Another state → their bills have IGST" />}
        <Field label="Opening balance" hint={initial.id ? 'What you owed them before using the app' : 'What you owe them today (before entering bills). Advance paid = minus'} className={gstinState(s.gstin) ? '' : ''}>
          <div className="relative"><span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">₹</span><Input type="number" inputMode="decimal" value={s.openingBalance || ''} onChange={(e) => setS({ ...s, openingBalance: Number(e.target.value) })} className="pl-7" placeholder="0" /></div>
        </Field>
        <Field label="Address" className="sm:col-span-2"><Input value={s.address} onChange={(e) => setS({ ...s, address: e.target.value })} /></Field>
        <Field label="Notes" className="sm:col-span-2"><Input value={s.notes} onChange={(e) => setS({ ...s, notes: e.target.value })} placeholder="Pays on the 10th · bank details…" /></Field>
      </div>
    </Modal>
  )
}

function SupplierDrawer({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (s: Supplier) => void }) {
  const run = useAction()
  const { data } = useData(() => api.suppliers.ledger(id), [id])
  const [paying, setPaying] = useState(false)
  const [buying, setBuying] = useState(false)
  if (!data) return null
  const s = data.supplier
  return (
    <Drawer open onClose={onClose} width="max-w-xl" title={s.name} subtitle={[s.phone, s.gstin ? `GSTIN ${s.gstin}` : '', s.stateCode ? stateLabel(s.stateCode) : ''].filter(Boolean).join(' · ') || 'Supplier'}
      footer={<div className="grid grid-cols-[auto_1fr_1fr] gap-2">
        <Button variant="secondary" icon={Pencil} onClick={() => onEdit(s)} aria-label="Edit supplier">Edit</Button>
        <Button variant="secondary" icon={FileText} block onClick={() => setBuying(true)}>New purchase</Button>
        <Button icon={IndianRupee} block onClick={() => setPaying(true)}>Record payment</Button>
      </div>}>
      <div className="space-y-4 p-5">
        <div className={clsx('flex items-center justify-between rounded-xl border p-4', data.balance > 0 ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50')}>
          <div><p className={clsx('text-xs font-medium', data.balance > 0 ? 'text-amber-800' : 'text-emerald-800')}>{data.balance >= 0 ? 'You owe' : 'Advance with supplier'}</p><p className={clsx('text-2xl font-bold', data.balance > 0 ? 'text-amber-900' : 'text-emerald-900')}>{money(Math.abs(data.balance))}</p></div>
          <p className="text-right text-xs text-slate-500">{s.purchases ?? 0} bill{s.purchases === 1 ? '' : 's'}{s.lastPurchaseOn ? <><br />last {fmtDate(s.lastPurchaseOn)}</> : ''}</p>
        </div>
        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Statement</h4>
          <div className="overflow-hidden rounded-xl border border-slate-200">
            <table className="w-full table-fixed text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="w-24 px-3 py-2 text-left font-medium">Date</th><th className="px-2 py-2 text-left font-medium">Details</th><th className="w-24 px-2 py-2 text-right font-medium">Bill</th><th className="w-24 px-2 py-2 text-right font-medium">Paid</th><th className="w-24 px-3 py-2 text-right font-medium">Balance</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {data.rows.map((r, k) => (
                  <tr key={k} className={clsx(r.kind === 'void' && 'text-slate-400')}>
                    <td className="px-3 py-2 text-xs text-slate-500">{r.date ? fmtDate(r.date) : '—'}</td>
                    <td className="truncate px-2 py-2" title={r.ref}>
                      {r.ref}
                      {r.kind === 'payment' && r.id && !data.payments.find((p) => p.id === r.id)?.purchaseId && (
                        <button type="button" className="ml-2 text-[11px] text-red-600 hover:underline" onClick={() => { const why = window.prompt('Why is this payment being voided?'); if (why) void run(() => api.suppliers.voidPayment(r.id!, why), 'Payment voided') }}>Void</button>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right tabular">{r.debit ? money(r.debit) : ''}</td>
                    <td className="px-2 py-2 text-right tabular text-emerald-700">{r.credit ? money(r.credit) : ''}</td>
                    <td className="px-3 py-2 text-right font-medium tabular">{money(r.balance)}</td>
                  </tr>
                ))}
                {!data.rows.length && <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-400">Nothing yet</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
        {(s.address || s.notes) && <div className="space-y-1 text-sm text-slate-600">{s.address && <p>📍 {s.address}</p>}{s.notes && <p>📝 {s.notes}</p>}</div>}
      </div>
      {paying && <PaySupplierModal supplier={s} owed={data.balance} onClose={() => setPaying(false)} />}
      {buying && <NewPurchaseModal supplierId={s.id} onClose={() => setBuying(false)} />}
    </Drawer>
  )
}

function PaySupplierModal({ supplier, owed, onClose }: { supplier: Supplier; owed: number; onClose: () => void }) {
  const run = useAction()
  const [amount, setAmount] = useState(owed > 0 ? String(owed) : '')
  const [method, setMethod] = useState<SupplierPayMethod>('bank')
  const [date, setDate] = useState(today())
  const [reference, setReference] = useState('')
  const n = Number(amount) || 0
  return (
    <Modal open onClose={onClose} size="sm" title={`Pay ${supplier.name}`} subtitle={owed > 0 ? `You owe ${money(owed)}` : 'No balance due — this will be an advance'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="success" disabled={!(n > 0)} onClick={async () => { if (await run(() => api.suppliers.pay(supplier.id, { amount: n, method, date, reference }), 'Payment recorded')) onClose() }}>Save {money(n)}</Button></>}>
      <div className="space-y-4">
        <Field required label="Amount"><div className="relative"><span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">₹</span><Input autoFocus type="number" inputMode="decimal" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} className="pl-7" /></div></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field required label="Paid by"><Select value={method} onChange={(e) => setMethod(e.target.value as SupplierPayMethod)}>{SUPPLIER_PAY_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_LABEL[m]}</option>)}</Select></Field>
          <Field required label="Date"><Input type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        {method !== 'cash' && <Field label="Reference" hint="UTR / cheque no."><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>}
        {n > owed && owed > 0 && <p className="text-xs text-amber-700">{money(r2(n - owed))} more than you owe — it stays as an advance.</p>}
      </div>
    </Modal>
  )
}
