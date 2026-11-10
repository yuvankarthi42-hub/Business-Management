// Settings → Printer, scale and bill. One branch at a time (picker in the header), up to three tabs:
//   Printer      — how this branch prints (cashiers too);
//   Weighing scale — the branch's scale, for shops that sell by weight (cashiers too);
//   Bill design  — what its bills show, in the bill's own order: shop details, bill details, item columns, totals and
//                  footer (owner / manager, or a role with "Change bill format", own branches only).
// One live sample bill (drawn by the same code that prints) and one Save bar for both tabs. Connect / Forget /
// Print test bill act at once. A branch without a bill design keeps its standard bill until the owner switches.
import clsx from 'clsx'
import { ChevronDown, Eye, Lock, Pencil, Printer as PrinterIcon, Receipt as ReceiptIcon, RotateCcw, Scale as ScaleIcon, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '@/app/AppContext'
import { Button, Card, Field, Input, Modal, Select, Textarea, Toggle, useAction, useToast } from '@/components/ui'
import {
  BOTTOM_INFO, COL_DEFAULT, COL_HINT, LAYOUT_COLS, LAYOUT_LABEL, TOP_INFO,
  canEditBillFormat, cleanBillFormat, defaultBillFormat, shopTypeLabel, type BillFormat, type BillLayout, type BillLine, type BottomKey, type TopKey,
} from '@/core/billFormat'
import { GST_STATES } from '@/core/gst'
import { computeTotals } from '@/core/pricing'
import { isVegetableShop } from '@/core/config'
import { isTextileShop } from '@/core/stickers'
import { cleanScale, type BranchScale } from '@/core/scale'
import { ScaleSetup, sellsByWeight } from '../scale/ScaleSettings'
import type { Branch, Business, Order, OrderItem } from '@/core/types'
import { api } from '@/data'
import { Receipt, usePrint, type ReceiptProps } from '../Payment'
import { BillLines } from './BillLines'
import { receiptDoc, needsImage, type BillSection, type Paper } from './doc'
import { encodeImage, encodeText } from './escpos'
import { savePrinter, sendToPrinter, usePrinterSettings } from './printer'
import { PrinterSetup, printerChanges, printerDraftOf, type PrinterDraft } from './PrinterSettings'

/** When a line prints only on some bills, say so (otherwise its switch seems to do nothing). */
const HINTS: Partial<Record<TopKey, string>> = {
  orderNo: 'The running order number, next to the time',
  waiter: 'Prints when the bill has a waiter (dine in) or a salesperson',
}

/** Lines printed with a fixed name (no Rename). */
const NO_RENAME: TopKey[] = ['state']

const food = (b: Business) => b.category === 'food' || b.category === 'restaurant'
const gstBillOf = (b: Business) => b.billing.taxEnabled && b.billing.taxRates.some((r) => /gst/i.test(r.name))

/** A made-up bill for the preview and the test print: one item with a discount (Rate 60 × 2 − 10 = 110) and MRPs. */
function sampleOrder(b: Business, br: Branch): Order {
  const gst = b.billing.taxEnabled ? b.billing.taxRates.find((r) => r.id === b.billing.defaultTaxRateId) ?? b.billing.taxRates[0] : undefined
  const rate = gst?.rate ?? 0
  const item = (id: string, name: string, qty: number, unit: string, price: number, extra: Partial<OrderItem> = {}): OrderItem =>
    ({ id, productId: id, name, variantId: null, variantName: null, addOns: [], qty, unit, unitPrice: price, taxRate: rate, notes: '', kotQty: qty, ...extra })
  const items = food(b)
    ? [item('s1', 'Masala Dosa', 2, 'pc', 70, { listPrice: 80, priceOverride: 70 }), item('s2', 'Filter Coffee', 3, 'pc', 25), item('s3', 'Parotta', 4, 'pc', 20)]
    : isVegetableShop(b)
    ? [item('s1', 'Tomato', 0.5, 'kg', 50), item('s2', 'Onion (Big)', 1.25, 'kg', 38, { listPrice: 40, priceOverride: 38 }), item('s3', 'Banana', 6, 'pc', 6)]
    : [item('s1', 'Ponni Rice', 2, 'kg', 55, { mrp: 70, listPrice: 60, priceOverride: 55 }), item('s2', 'Sugar 1kg', 1, 'pc', 45, { mrp: 50 }), item('s3', 'Toor Dal', 0.5, 'kg', 140, { mrp: 150 })]
  const t = computeTotals(items, 0, b.billing)
  const now = new Date().toISOString()
  const inv = br.invoicePrefix ? `${br.invoicePrefix}${br.nextInvoiceNumber ?? 10001}` : `${b.billing.invoicePrefix}${b.billing.nextInvoiceNumber}`
  return {
    id: 'sample', number: `${b.billing.orderPrefix}${b.billing.nextOrderNumber}`, type: food(b) ? 'dine_in' : 'counter', tableId: null, customerId: null,
    status: 'completed', items, notes: '', ...t, paid: t.total, balance: 0, paymentStatus: 'paid',
    invoiceNumber: inv, billedAt: now, cancelledAt: null, cancelReason: null, source: 'pos', ...(isTextileShop(b) ? { salespersonId: 'sp' } : {}),
    businessId: b.id, branchId: br.id, createdAt: now, createdBy: 'me', updatedAt: now, updatedBy: 'me',
  }
}

type Tab = 'printer' | 'scale' | 'bill'

/** The page: branch picker, tabs, the tab's settings, the live bill, and the Save bar. */
export function PrinterAndBill() {
  const { me, can } = useApp()
  const branches = (me?.branches ?? []).filter((b) => b.active !== false)
  const [picked, setPicked] = useState(me?.isAll ? branches[0]?.id ?? '' : me?.branch.id ?? '')
  const branchId = branches.some((b) => b.id === picked) ? picked : (me?.isAll ? branches[0]?.id : me?.branch.id) ?? ''
  const branch = branches.find((b) => b.id === branchId)
  const [ask, setAsk] = useState<string | null>(null) // branch to switch to, waiting for Save / Discard
  const [dirty, setDirty] = useState(false)
  if (!me || !branch) return null
  const pick = (id: string) => { if (id === branchId) return; if (dirty) setAsk(id); else setPicked(id) }
  return (
    <>
      <BranchSetup key={branch.id} branch={branch} others={branches.filter((b) => b.id !== branch.id && b.billFormat)} onDirty={setDirty}
        canPrinter={can('settings.manage') || can('billing.create')} canBill={canEditBillFormat(can)}
        header={branches.length > 1 && (
          <Field label="Branch" className="w-full sm:w-56">
            <Select value={branchId} onChange={(e) => pick(e.target.value)}>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}{b.id === me.branch.id ? ' (current)' : ''}</option>)}
            </Select>
          </Field>
        )}
        switchTo={ask} onSwitched={() => { if (ask) setPicked(ask); setAsk(null) }} onStay={() => setAsk(null)} />
    </>
  )
}

function BranchSetup({ branch, others, canPrinter, canBill, header, onDirty, switchTo, onSwitched, onStay }: {
  branch: Branch; others: Branch[]; canPrinter: boolean; canBill: boolean; header: ReactNode
  onDirty: (d: boolean) => void; switchTo: string | null; onSwitched: () => void; onStay: () => void
}) {
  const { me, can } = useApp()
  const run = useAction()
  const toast = useToast()
  const { print, portal } = usePrint()
  const b = me!.business
  const shopPaper: Paper = b.billing.paperWidth ?? '80mm'

  // ---- printer draft: only the user's changes, on top of what is saved (Connect / Forget save at once) ----
  const saved = usePrinterSettings(branch.id)
  const base = printerDraftOf(saved, shopPaper)
  const [pEdits, setPEdits] = useState<Partial<PrinterDraft>>({})
  const pDraft: PrinterDraft = { ...base, ...pEdits }
  const pChanges = printerChanges(base, pDraft)

  // ---- weighing scale draft (shops that sell by weight) ----
  const withScale = canPrinter && sellsByWeight(b)
  const scaleBase = cleanScale(branch.scale ?? {})
  const [sEdits, setSEdits] = useState<Partial<BranchScale>>({})
  const sDraft: BranchScale = { ...scaleBase, ...sEdits }
  const sChanges = (Object.keys(sEdits) as (keyof BranchScale)[]).filter((k) => sDraft[k] !== scaleBase[k])

  // ---- bill design draft ----
  const shopDefault = useMemo(() => defaultBillFormat(b, b.billing.receiptFooter), [b])
  const savedFormat = branch.billFormat ? JSON.stringify(branch.billFormat) : ''
  const [f, setF] = useState<BillFormat>(() => branch.billFormat ?? shopDefault)
  useEffect(() => { setF(branch.billFormat ?? shopDefault) }, [savedFormat]) // eslint-disable-line react-hooks/exhaustive-deps
  const using = !!branch.billFormat
  const fDirty = using && JSON.stringify(cleanBillFormat(f, b)) !== savedFormat
  // Standard bill: its footer is the shop's receipt footer (every branch on the standard bill).
  const [footer, setFooter] = useState(b.billing.receiptFooter)
  useEffect(() => setFooter(b.billing.receiptFooter), [b.billing.receiptFooter])
  const footerDirty = !using && footer !== b.billing.receiptFooter

  const dirty = Object.keys(pChanges).length > 0 || sChanges.length > 0 || fDirty || footerDirty
  useEffect(() => { onDirty(dirty) }, [dirty]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onDirty(false), []) // eslint-disable-line react-hooks/exhaustive-deps

  // Opens on Printer until this branch's printer has been set up once (or when bill design isn't allowed).
  const [tab, setTab] = useState<Tab>(() => (!canBill ? 'printer' : !canPrinter ? 'bill' : branch.printer ? 'bill' : 'printer'))
  const [open, setOpen] = useState<BillSection | null>('shop')
  const [busy, setBusy] = useState(false)
  const [showBill, setShowBill] = useState(false)

  const save = async () => {
    const ok = await run(async () => {
      if (Object.keys(pChanges).length) await savePrinter(branch.id, pChanges)
      if (sChanges.length) await api.branches.saveScale(branch.id, Object.fromEntries(sChanges.map((k) => [k, sDraft[k]])))
      if (fDirty) await api.branches.saveBillFormat(branch.id, f)
      if (footerDirty) await api.business.update({ billing: { ...b.billing, receiptFooter: footer } })
      setPEdits({}); setSEdits({})
    }, 'Saved')
    return ok
  }
  const discard = () => { setPEdits({}); setSEdits({}); setF(branch.billFormat ?? shopDefault); setFooter(b.billing.receiptFooter) }
  const act = (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    fn().then(() => { if (ok) toast(ok) }).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/No device selected|cancelled|User cancelled|No port selected/i.test(msg)) toast(msg, 'error')
    }).finally(() => setBusy(false))
  }

  // ---- the sample bill, as this branch would print it with the changes so far ----
  const paper = pDraft.paper
  const props: ReceiptProps = useMemo(() => ({
    order: sampleOrder(b, branch),
    business: { ...b, billing: { ...b.billing, paperWidth: paper, receiptFooter: footer } },
    branch: { ...branch, printer: { ...saved, paper }, billFormat: using ? cleanBillFormat(f, b) : undefined },
    users: [{ id: 'me', name: me!.user.name }, { id: 'sp', name: 'Lavanya' }], tableLabel: food(b) ? 'T4' : null,
  }), [b, branch, paper, footer, using, f, me, saved])
  const lit = tab === 'bill' && using ? open : null
  const bill = props.branch?.billFormat ? <BillLines doc={receiptDoc(props, paper)} paper={paper} active={lit} /> : <Receipt {...props} />

  const test = () => act(async () => {
    if (pDraft.transport === 'browser') { print(<Receipt {...props} />); return }
    const doc = receiptDoc(props, paper)
    const s = { ...saved, ...pDraft }
    const image = s.mode === 'image' || (s.mode === 'auto' && needsImage(doc))
    await sendToPrinter(branch.id, s, image ? encodeImage(doc, paper, { cut: s.cut }) : encodeText(doc, paper, { cut: s.cut }))
  }, pDraft.transport === 'browser' ? undefined : 'Test bill sent')

  const printerReady = !!branch.printer
  return (
    <Card className="overflow-visible">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{withScale ? 'Printer, scale and bill' : 'Printer and bill'}{header ? '' : ` · ${branch.name}`}</h2>
          <p className="mt-0.5 text-sm text-slate-500">{header ? `Each branch has its own printer${withScale ? ', scale' : ''} and bill. Changes apply only to the branch you choose.` : `How this branch prints${withScale ? ', weighs' : ''} and what its bills show.`}</p>
        </div>
        {header}
      </div>
      {((canPrinter && canBill) || withScale) && (
        <div className="flex gap-1 overflow-x-auto border-b border-slate-100 px-3 no-scrollbar" role="tablist">
          {canPrinter && (
            <TabBtn on={tab === 'printer'} onClick={() => setTab('printer')} icon={<PrinterIcon className="h-4 w-4" />}>
              1. Printer <span className={clsx('ml-1 text-xs font-medium', printerReady ? 'text-emerald-600' : 'text-amber-600')}>● {printerReady ? 'Ready' : 'Not set up'}</span>
            </TabBtn>
          )}
          {withScale && (
            <TabBtn on={tab === 'scale'} onClick={() => setTab('scale')} icon={<ScaleIcon className="h-4 w-4" />}>
              2. Weighing scale <span className={clsx('ml-1 text-xs font-medium', scaleBase.enabled ? 'text-emerald-600' : 'text-slate-400')}>● {scaleBase.enabled ? 'On' : 'Off'}</span>
            </TabBtn>
          )}
          {canBill && <TabBtn on={tab === 'bill'} onClick={() => setTab('bill')} icon={<ReceiptIcon className="h-4 w-4" />}>{withScale ? 3 : 2}. Bill design</TabBtn>}
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 p-5 xl:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          {tab === 'scale'
            ? <ScaleSetup branch={branch} draft={sDraft} set={(p) => setSEdits({ ...sEdits, ...p })} act={act} busy={busy} />
            : tab === 'printer'
            ? <PrinterSetup branchId={branch.id} saved={saved} draft={pDraft} set={(p) => setPEdits({ ...pEdits, ...p })} onTest={test} act={act} busy={busy} />
            : using
              ? <BillDesign f={f} setF={setF} b={b} branch={branch} others={others} open={open} setOpen={setOpen} shopDefault={shopDefault} />
              : <StandardBill b={b} others={others} footer={footer} setFooter={setFooter} canFooter={can('settings.manage')}
                  onSwitch={(next, ok) => run(() => api.branches.saveBillFormat(branch.id, next), ok)} shopDefault={shopDefault} />}
        </div>
        <aside className="hidden min-w-0 xl:block xl:w-[380px]">
          <div className="sticky top-4">
            <PreviewHead paper={paper} onChange={tab === 'bill' && canPrinter ? () => { setTab('printer'); setTimeout(() => document.getElementById('paper-size')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50) } : undefined} />
            <div className="flex justify-center overflow-x-auto rounded-xl bg-slate-100 p-3"><div className="rounded bg-white p-3 shadow-card">{bill}</div></div>
          </div>
        </aside>
      </div>

      <div className={clsx('sticky bottom-16 z-10 flex flex-wrap items-center gap-2 rounded-b-xl border-t border-slate-100 bg-white/95 px-5 py-3 backdrop-blur md:bottom-0')}>
        <Button variant="secondary" icon={Eye} className="xl:hidden" onClick={() => setShowBill(true)}>See bill</Button>
        <p className="min-w-0 flex-1 text-sm text-slate-500">{dirty ? <span className="text-amber-700">● Unsaved changes for {branch.name}</span> : <span className="hidden sm:inline">All changes saved</span>}</p>
        {dirty && <Button variant="ghost" onClick={discard}>Discard</Button>}
        <Button onClick={() => void save()} disabled={!dirty}>Save</Button>
      </div>

      <Modal open={showBill} onClose={() => setShowBill(false)} title="Sample bill" subtitle={`${branch.name} · ${paper === '58mm' ? '58 mm' : '80 mm'} paper`}>
        <div className="flex justify-center overflow-x-auto rounded-xl bg-slate-100 p-3"><div className="rounded bg-white p-3 shadow-card">{bill}</div></div>
      </Modal>
      <Modal open={!!switchTo} onClose={onStay} title="Save your changes?" subtitle={`You changed ${branch.name}'s printer or bill and didn't save.`}
        footer={<><Button variant="ghost" onClick={onStay}>Cancel</Button><Button variant="secondary" onClick={() => { discard(); onSwitched() }}>Discard</Button><Button onClick={async () => { if (await save()) onSwitched() }}>Save</Button></>}>
        <p className="text-sm text-slate-600">Save them before you switch to the other branch, or discard them.</p>
      </Modal>
      {portal}
    </Card>
  )
}

const TabBtn = ({ on, onClick, icon, children }: { on: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) => (
  <button type="button" role="tab" aria-selected={on} onClick={onClick} className={clsx('-mb-px flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition',
    on ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}>{icon}{children}</button>
)

function PreviewHead({ paper, onChange }: { paper: Paper; onChange?: () => void }) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
      <span className="font-medium uppercase tracking-wide text-slate-500">Sample bill</span>
      <span className="text-slate-500">Paper: <b className="text-slate-700">{paper === '58mm' ? '58 mm' : '80 mm'}</b>{onChange && <> · <button type="button" className="font-medium text-brand-700 hover:underline" onClick={onChange}>Change</button></>}</span>
    </div>
  )
}

/** A branch still on the standard bill: what it prints, its footer, and the way to the new bill design. */
function StandardBill({ b, others, footer, setFooter, canFooter, onSwitch, shopDefault }: {
  b: Business; others: Branch[]; footer: string; setFooter: (v: string) => void; canFooter: boolean
  onSwitch: (f: BillFormat, ok: string) => void; shopDefault: BillFormat
}) {
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-brand-200 bg-brand-50 p-4">
        <div className="flex items-start gap-3">
          <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-slate-800">This branch uses the standard bill</p>
            <p className="mt-0.5 text-sm text-slate-600">A bill design for <b>{shopTypeLabel(b)}</b> is ready: choose the columns (MRP, discount…), the lines at the top and bottom, and their names. Bills print as they do today until you switch.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => onSwitch(shopDefault, 'This branch now uses the new bill design')}>Switch to the new bill design</Button>
              {others.length > 0 && (
                <Select className="h-10 w-56" value="" onChange={(e) => { const o = others.find((x) => x.id === e.target.value)?.billFormat; if (o) onSwitch(o, 'Bill design copied') }}>
                  <option value="">Copy from a branch…</option>
                  {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </Select>
              )}
            </div>
          </div>
        </div>
      </div>
      {canFooter && (
        <Field label="Footer on the standard bill" hint="Printed at the bottom. The same for every branch that uses the standard bill. Leave empty to print nothing.">
          <Input value={footer} onChange={(e) => setFooter(e.target.value)} placeholder="Thank you! Visit again." />
        </Field>
      )}
    </div>
  )
}

/** The four parts of the bill, top to bottom; one open at a time (its lines light up in the preview). */
function BillDesign({ f, setF, b, branch, others, open, setOpen, shopDefault }: {
  f: BillFormat; setF: (f: BillFormat) => void; b: Business; branch: Branch; others: Branch[]
  open: BillSection | null; setOpen: (s: BillSection | null) => void; shopDefault: BillFormat
}) {
  const gstBill = gstBillOf(b)
  // The shop's state for the State line: Business Profile, else the first two digits of the GSTIN.
  const shopState = [b.stateCode, b.gstin?.slice(0, 2)].find((x) => !!x && !!GST_STATES[x]) ?? ''
  // The extra title's box stays open while it is being typed in, even when emptied for a moment.
  const [titleEdit, setTitleEdit] = useState(false)
  const top = (k: TopKey, p: Partial<BillLine>) => setF({ ...f, top: { ...f.top, [k]: { ...f.top[k], ...p } } })
  const bottom = (k: BottomKey, p: Partial<BillLine>) => setF({ ...f, bottom: { ...f.bottom, [k]: { ...f.bottom[k], ...p } } })
  const T = (k: TopKey, extra?: ReactNode, hint?: string) => <LineRow key={k} name={TOP_INFO[k].name} line={f.top[k]} def={TOP_INFO[k].label} set={(p) => top(k, p)} extra={extra} hint={hint} noRename={NO_RENAME.includes(k)} />
  const B = (k: BottomKey, extra?: ReactNode) => <LineRow key={k} name={BOTTOM_INFO[k].name} line={f.bottom[k]} def={BOTTOM_INFO[k].label} set={(p) => bottom(k, p)} extra={extra} />
  const cols = LAYOUT_COLS[f.layout]
  const onCount = (keys: (TopKey | BottomKey)[], src: Record<string, BillLine>) => keys.filter((k) => src[k]?.on).length
  const shopKeys: TopKey[] = ['name2', 'address', 'phone', 'gstin', 'email']
  const billKeys: TopKey[] = ['title', 'billNo', 'orderNo', 'date', 'time', 'cashier', 'waiter', 'customer', 'state']
  const totalKeys: BottomKey[] = ['totalQty', 'total', 'words', 'savings', 'received', 'orderType', 'signature']

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-500">
        <p>Set up for <b className="text-slate-700">{shopTypeLabel(b)}</b>. Each part below is the same part of the bill, top to bottom.</p>
        <div className="flex flex-wrap items-center gap-3">
          {others.length > 0 && (
            <Select className="h-9 w-52" value="" onChange={(e) => { const o = others.find((x) => x.id === e.target.value)?.billFormat; if (o) setF(structuredClone(o)) }} aria-label="Copy from another branch">
              <option value="">Copy from another branch…</option>
              {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          )}
          <button type="button" className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline" onClick={() => setF(shopDefault)}><RotateCcw className="h-3.5 w-3.5" />Reset to shop type's layout</button>
        </div>
      </div>

      <Part n={1} sec="shop" open={open} setOpen={setOpen} title="Shop details" summary={`${f.name1.trim() || b.name} · ${onCount(shopKeys, f.top) + 1} lines`}>
        <div className="mb-3 grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <Field label="Shop name on the bill" hint={`Empty = ${b.name}`}><Input value={f.name1} maxLength={60} placeholder={b.name} onChange={(e) => setF({ ...f, name1: e.target.value })} /></Field>
        </div>
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {T('name2', f.top.name2.on && <Input className="h-9" value={f.name2} maxLength={60} placeholder="Wholesale and retail" onChange={(e) => setF({ ...f, name2: e.target.value })} />)}
          {T('address', f.top.address.on && <Textarea rows={2} value={f.address} maxLength={200} placeholder={branch.address || b.address || 'Empty = the branch address'} onChange={(e) => setF({ ...f, address: e.target.value })} />)}
          {T('phone', f.top.phone.on && <Input className="h-9" value={f.phone2} maxLength={20} inputMode="tel" placeholder="Second phone (optional)" onChange={(e) => setF({ ...f, phone2: e.target.value })} />)}
          {!gstBill && T('gstin')}
          {T('email')}
        </div>
        {gstBill && <Always>GSTIN, on every GST bill.</Always>}
      </Part>

      <Part n={2} sec="bill" open={open} setOpen={setOpen} title="Bill details" summary={`${onCount(billKeys, f.top)} lines`}>
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {gstBill
            // GST bills always say TAX INVOICE; this line adds the shop's own title under it (on = it has one).
            ? <LineRow name="Extra title under TAX INVOICE" line={{ ...f.top.title, on: f.top.title.on && !!f.title.trim() }} def="" hint="e.g. CASH BILL, RETAIL INVOICE"
                set={(p) => { setTitleEdit(!!p.on); setF({ ...f, top: { ...f.top, title: { ...f.top.title, on: !!p.on } }, title: p.on ? f.title.trim() || 'CASH BILL' : '' }) }}
                extra={<Input className="h-9" value={f.title} maxLength={30} placeholder="CASH BILL" onChange={(e) => setF({ ...f, title: e.target.value })} />} keepExtra={titleEdit} />
            : T('title', f.top.title.on && <Input className="h-9" value={f.title} maxLength={30} placeholder="BILL" onChange={(e) => setF({ ...f, title: e.target.value })} />)}
          {billKeys.filter((k) => k !== 'title' && k !== 'customer' && k !== 'state').map((k) => T(k, undefined, HINTS[k]))}
          {T('state', f.top.state.on && !shopState && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">Your shop's state isn't set, so this line can't print yet. <Link to="/settings?tab=profile" className="font-medium underline">Set it in Business Profile</Link></p>
          ), shopState ? `${GST_STATES[shopState]} (${shopState})` : 'Set your state in Business Profile')}
          {T('customer', f.top.customer.on && <Input className="h-9" value={f.cashSales} maxLength={30} placeholder="When there is no customer, e.g. Cash Sales" onChange={(e) => setF({ ...f, cashSales: e.target.value })} />)}
        </div>
        {gstBill && <Always>the TAX INVOICE heading, on every GST bill.</Always>}
      </Part>

      <Part n={3} sec="items" open={open} setOpen={setOpen} title="Item columns and their names" summary={LAYOUT_LABEL[f.layout]}>
        <div className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(LAYOUT_COLS) as BillLayout[]).map((l) => (
            <button key={l} type="button" onClick={() => setF({ ...f, layout: l })} className={clsx('rounded-xl border px-3 py-2.5 text-left transition',
              f.layout === l ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-slate-200 bg-white hover:border-slate-300')}>
              <span className="block text-sm font-semibold">{LAYOUT_LABEL[l]}{l === shopDefault.layout && <span className="ml-1.5 text-xs font-normal text-slate-500">(your shop type)</span>}</span>
              <span className="mt-0.5 block text-xs text-slate-500">{LAYOUT_COLS[l].map((c) => f.cols[c] || COL_DEFAULT[c]).join(' · ')}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">Every line: Rate × Qty − Discount = Amount. MRP is only shown for information.</p>
        <h4 className="mb-2 mt-4 text-sm font-medium">Names on the bill <span className="font-normal text-slate-500">— change them or write them in Tamil</span></h4>
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          {cols.map((c) => (
            <Field key={c} label={COL_DEFAULT[c]} hint={COL_HINT[c]}>
              <Input value={f.cols[c]} maxLength={16} placeholder={COL_DEFAULT[c]} onChange={(e) => setF({ ...f, cols: { ...f.cols, [c]: e.target.value } })} />
            </Field>
          ))}
          <Field label="Quantity decimals" hint="Automatic: 2 for pieces, 0.500 for loose items">
            <Select value={String(f.qtyDecimals)} onChange={(e) => setF({ ...f, qtyDecimals: e.target.value === 'auto' ? 'auto' : (Number(e.target.value) as 0 | 2 | 3) })}>
              <option value="auto">Automatic</option><option value="0">None (2)</option><option value="2">2 places (2.00)</option><option value="3">3 places (2.000)</option>
            </Select>
          </Field>
        </div>
      </Part>

      <Part n={4} sec="totals" open={open} setOpen={setOpen} title="Totals and footer" summary={`${onCount(totalKeys, f.bottom)} lines${f.footer1 || f.footer2 ? ' · footer' : ''}`}>
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {totalKeys.map((k) => B(k))}
        </div>
        <div className="mt-3 grid gap-3">
          <Field label="Footer line 1"><Input value={f.footer1} maxLength={60} placeholder="Thank you! Visit again." onChange={(e) => setF({ ...f, footer1: e.target.value })} /></Field>
          <Field label="Footer line 2"><Input value={f.footer2} maxLength={60} placeholder="Goods once sold can't be taken back" onChange={(e) => setF({ ...f, footer2: e.target.value })} /></Field>
        </div>
        <Always>{gstBill ? 'CGST / SGST, round off and balance due, when the bill has them.' : 'round off and balance due, when the bill has them.'}</Always>
      </Part>
    </div>
  )
}

function Part({ n, sec, open, setOpen, title, summary, children }: {
  n: number; sec: BillSection; open: BillSection | null; setOpen: (s: BillSection | null) => void; title: string; summary: string; children: ReactNode
}) {
  const on = open === sec
  return (
    <section className={clsx('rounded-xl border transition', on ? 'border-brand-300 ring-1 ring-brand-200' : 'border-slate-200')}>
      <button type="button" aria-expanded={on} onClick={() => setOpen(on ? null : sec)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className={clsx('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold', on ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600')}>{n}</span>
        <span className="min-w-0 flex-1 text-sm font-semibold">{title}</span>
        <span className="hidden truncate text-xs text-slate-500 sm:block">{summary}</span>
        <ChevronDown className={clsx('h-4 w-4 shrink-0 text-slate-400 transition', on && 'rotate-180')} />
      </button>
      {on && <div className="border-t border-slate-100 px-4 py-4">{children}</div>}
    </section>
  )
}

/** One line of the bill: printed or not, its name, and (when it has one) the label printed before it. */
function LineRow({ name, line, def, set, extra, hint, keepExtra, noRename }: {
  name: string; line: BillLine; def: string; set: (p: Partial<BillLine>) => void; extra?: ReactNode; hint?: string; noRename?: boolean
  /** Keep the text box open while it is being typed in (even when empty). */
  keepExtra?: boolean
}) {
  const [edit, setEdit] = useState(false)
  const hasLabel = !noRename && (def !== '' || name.startsWith('Grand total'))
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-3">
        <Toggle checked={line.on} onChange={(on) => set({ on })} label={name} />
        <span className="min-w-0 flex-1">
          <span className={clsx('block text-sm', line.on ? 'text-slate-800' : 'text-slate-400')}>{name}</span>
          {hint && <span className="block text-xs text-slate-400">{hint}</span>}
        </span>
        {hasLabel && line.on && !edit && (
          <button type="button" onClick={() => setEdit(true)} className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
            <Pencil className="h-3 w-3" />{line.label && line.label !== def ? <span className="max-w-[9rem] truncate text-slate-600">“{line.label}”</span> : 'Rename'}
          </button>
        )}
      </div>
      {hasLabel && line.on && edit && (
        <div className="mt-2 flex items-center gap-2 pl-12">
          <Input className="h-9" autoFocus value={line.label} maxLength={24} placeholder={def} onChange={(e) => set({ label: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') setEdit(false) }} />
          <Button size="sm" variant="secondary" onClick={() => setEdit(false)}>Done</Button>
        </div>
      )}
      {extra && (line.on || keepExtra) && <div className="mt-2 pl-12">{extra}</div>}
    </div>
  )
}

const Always = ({ children }: { children: ReactNode }) => (
  <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500"><Lock className="h-3 w-3 shrink-0" />Always printed: {children}</p>
)

