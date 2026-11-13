import clsx from 'clsx'
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Clock, Pencil, Phone, Plus, Printer, ReceiptText, RefreshCw, Undo2, Wrench, XCircle } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useApp, useData, useNow } from '@/app/AppContext'
import { Badge, Button, Drawer, EmptyState, Field, Input, Modal, SearchInput, Select, Textarea, useToast } from '@/components/ui'
import { CustomerPicker } from '@/features/CustomerPicker'
import { BillSuccessModal, usePrint } from '@/features/Payment'
import { useSaveOnce } from '@/features/billKey'
import { CLOSED_STAGES, JOB_STAGE_LABEL, type JobCard, type JobInput, type JobStage, type ServiceJob } from '@/core/serviceJobs'
import { formatPhone } from '@/core/phone'
import type { PaymentMethod } from '@/core/types'
import { api } from '@/data'
import { fmtDate, fmtDateTime, fmtTime, money } from '@/lib/format'

// Service jobs: items the shop takes in (a phone to repair, clothes to wash or stitch…), the stages they go through,
// and the bill at delivery. Every read comes fresh from the server when the screen opens, on a tab change or Refresh;
// a save shows at once from its own answer. Nothing here polls.

type Counts = { stages: JobStage[]; counts: Partial<Record<JobStage, number>>; overdue?: Partial<Record<JobStage, number>> }
type AdvanceMethod = 'cash' | 'upi' | 'card' | 'bank'
const ADVANCE_METHODS: AdvanceMethod[] = ['cash', 'upi', 'card', 'bank']
const METHOD_LABEL: Record<AdvanceMethod, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank' }
const overdue = (j: JobCard, now: number) => !!j.promisedAt && !CLOSED_STAGES.includes(j.stage) && j.stage !== 'ready' && new Date(j.promisedAt).getTime() < now
const toLocalInput = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16) }
const conflict = (e: unknown) => /another device/.test((e as Error)?.message ?? '')

/** Run a save: its answer is returned; an error shows as a message (and an "another device" one reloads the screen). */
function useSave(onConflict: () => void) {
  const toast = useToast()
  return useCallback(async <T,>(fn: () => Promise<T>, success?: string): Promise<T | null> => {
    try { const r = await fn(); if (success) toast(success); return r } catch (e) {
      toast((e as Error).message || 'Something went wrong', 'error')
      if (conflict(e)) onConflict()
      return null
    }
  }, [toast, onConflict])
}

export default function ServiceJobs() {
  const { me } = useApp()
  const nav = useNavigate()
  const now = useNow(60000)
  const [counts, setCounts] = useState<Counts | null>(null)
  const [stage, setStage] = useState<JobStage>('received')
  const [rows, setRows] = useState<JobCard[] | null>(null)
  const [next, setNext] = useState<number | string | null>(null)
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')
  const [found, setFound] = useState<JobCard[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const toast = useToast()
  const seq = useRef(0)

  // One stage's first 50 jobs and the counts, read together (also on Refresh / reload / a tile click). No polling.
  const load = useCallback(async (s: JobStage = stage) => {
    const n = ++seq.current
    setLoading(true)
    try {
      const [c, b] = await Promise.all([api.serviceJobs.counts(), api.serviceJobs.board(s)])
      if (n !== seq.current) return
      setCounts(c); setRows(b.rows); setNext(b.next); setLoadedAt(new Date())
    } catch (e) { toast((e as Error).message, 'error') } finally { if (n === seq.current) setLoading(false) }
  }, [stage, toast])
  useEffect(() => { void load(stage) }, [stage]) // eslint-disable-line react-hooks/exhaustive-deps

  const more = async () => {
    if (next == null) return
    try { const b = await api.serviceJobs.board(stage, next); setRows((r) => [...(r ?? []), ...b.rows]); setNext(b.next) } catch (e) { toast((e as Error).message, 'error') }
  }
  const search = async (text: string) => {
    if (!text.trim()) { setFound(null); return }
    try { setFound(await api.serviceJobs.search(text)) } catch (e) { toast((e as Error).message, 'error') }
  }

  /** A save's answer, shown at once: the card moves to its new stage and the counts follow. */
  const applied = useCallback((card: JobCard, from?: JobStage, was?: JobCard) => {
    setRows((r) => {
      if (!r) return r
      const has = r.some((x) => x.id === card.id)
      if (card.stage !== stage) return r.filter((x) => x.id !== card.id)
      return has ? r.map((x) => (x.id === card.id ? card : x)) : [card, ...r]
    })
    setFound((f) => f && f.map((x) => (x.id === card.id ? card : x)))
    if (from && from !== card.stage) setCounts((c) => {
      if (!c) return c
      const counts = { ...c.counts }, late = { ...c.overdue }
      counts[from] = Math.max(0, (counts[from] ?? 0) - 1)
      if (!(['cancelled', 'returned'] as JobStage[]).includes(card.stage)) counts[card.stage] = (counts[card.stage] ?? 0) + 1
      if (was && overdue(was, Date.now())) late[from] = Math.max(0, (late[from] ?? 0) - 1)
      if (overdue(card, Date.now())) late[card.stage] = (late[card.stage] ?? 0) + 1
      return { ...c, counts, overdue: late }
    })
  }, [stage])

  const stages = counts?.stages ?? ['received']
  const working: JobStage[] = stages.filter((s) => s !== 'delivered')
  const shown = found ?? rows ?? []
  const step = (s: JobStage, by: 1 | -1) => { const i = working.indexOf(s); const t = working[i + by]; return i >= 0 && t ? t : null }
  const save = useSave(() => void load())
  const move = async (j: JobCard, to: JobStage) => {
    const card = await save(() => api.serviceJobs.setStage(j.id, to, '', j.version))
    if (card) applied(card, j.stage, j)
  }

  return (
    <div className="flex h-full flex-col bg-slate-100">
      <div className="space-y-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="flex items-center gap-2 text-xl font-semibold"><Wrench className="h-6 w-6 text-brand-600" />Service Jobs</h1>
          <div className="flex-1" />
          <span className="hidden text-sm text-slate-500 sm:inline">{loadedAt ? `Updated ${fmtTime(loadedAt)}` : ''}</span>
          <Button variant="secondary" icon={RefreshCw} onClick={() => void load()} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</Button>
          <Button icon={Plus} onClick={() => setCreating(true)}>New job</Button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); void search(q) }}>
          <SearchInput value={q} onChange={(e) => { setQ(e.target.value); if (!e.target.value) setFound(null) }} placeholder="Search job no., phone or IMEI / serial — press Enter" className="!h-11 text-base" />
        </form>
        {!found && (
          <>
            <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
              {working.map((s) => {
                const n = counts?.counts[s] ?? 0, late = counts?.overdue?.[s] ?? 0, on = s === stage
                return (
                  <button key={s} type="button" onClick={() => setStage(s)} aria-pressed={on}
                    className={clsx('rounded-xl border px-4 py-3 text-left transition', on ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-slate-200 bg-white hover:border-slate-300')}>
                    <span className={clsx('block text-sm font-medium', on ? 'text-brand-700' : 'text-slate-600')}>{JOB_STAGE_LABEL[s]}</span>
                    <span className={clsx('block text-3xl font-semibold tabular', s === 'ready' ? 'text-emerald-600' : on ? 'text-brand-700' : 'text-slate-900')}>{n}</span>
                    <span className={clsx('block text-xs', late ? 'font-semibold text-red-600' : 'text-slate-400')}>
                      {late ? <><AlertTriangle className="mb-0.5 inline h-3 w-3" /> {late} overdue</> : s === 'ready' ? 'To collect' : ' '}
                    </span>
                  </button>
                )
              })}
            </div>
            <p className="text-right text-sm text-slate-500"><CheckCircle2 className="mb-0.5 inline h-4 w-4 text-emerald-600" /> Delivered today: <b className="text-slate-700">{counts?.counts.delivered ?? 0}</b> · bills are in Orders</p>
          </>
        )}
        {found && (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            {found.length} found for “{q}” <Button size="sm" variant="ghost" onClick={() => { setQ(''); setFound(null) }}>Clear</Button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 sm:p-4">
        {rows === null && !found ? <p className="py-10 text-center text-sm text-slate-400">Loading…</p>
          : shown.length ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {shown.map((j) => (
                  <JobTicket key={j.id} j={j} now={now} prev={step(j.stage, -1)} next={step(j.stage, 1)} onOpen={() => setOpenId(j.id)}
                    onMove={(to) => void move(j, to)} onBill={() => nav(`/billing?job=${j.id}`)} />
                ))}
              </div>
              {!found && next != null && <div className="py-3 text-center"><Button variant="secondary" onClick={() => void more()}>Show more</Button></div>}
            </>
          ) : (
            <EmptyState icon={Wrench} title={found ? 'No job found' : stage === 'received' ? 'No jobs waiting' : `Nothing in ${JOB_STAGE_LABEL[stage].toLowerCase()}`}
              description={found ? 'Delivered and closed jobs are found by job no., full phone number or full IMEI / serial.' : stage === 'received' ? 'Take in an item with New job — it gets a job number and a slip for the customer.' : undefined}
              action={stage === 'received' && !found ? <Button icon={Plus} onClick={() => setCreating(true)}>New job</Button> : undefined} />
          )}
      </div>

      {creating && <JobForm onClose={() => setCreating(false)} onSaved={(j) => { setCreating(false); setCounts((c) => c && { ...c, counts: { ...c.counts, received: (c.counts.received ?? 0) + 1 } }); if (stage === 'received') applied(j); setOpenId(j.id) }} />}
      {openId && me && <JobDetails id={openId} stages={stages} onClose={() => setOpenId(null)} onChanged={applied} onReload={() => void load()} />}
    </div>
  )
}

function JobTicket({ j, now, prev, next, onOpen, onMove, onBill }: {
  j: JobCard; now: number; prev: JobStage | null; next: JobStage | null; onOpen: () => void; onMove: (to: JobStage) => void; onBill: () => void
}) {
  const late = overdue(j, now)
  const open = !CLOSED_STAGES.includes(j.stage)
  return (
    <article className={clsx('flex flex-col rounded-xl border bg-white shadow-card', late ? 'border-red-300 ring-2 ring-red-100' : 'border-slate-200')}>
      <button type="button" onClick={onOpen} className="flex-1 px-4 py-3 text-left">
        <div className="flex items-start justify-between gap-2">
          <p className="text-base font-bold">{j.number}</p>
          {late
            ? <span className="flex items-center gap-1 text-xs font-semibold text-red-600"><AlertTriangle className="h-3.5 w-3.5" />Overdue · {fmtDate(j.promisedAt!)}</span>
            : j.promisedAt ? <span className="flex items-center gap-1 text-xs text-slate-500"><Clock className="h-3.5 w-3.5" />By {fmtDateTime(j.promisedAt)}</span>
              : <Badge tone={j.stage === 'ready' ? 'green' : open ? 'blue' : 'slate'}>{JOB_STAGE_LABEL[j.stage]}</Badge>}
        </div>
        <p className="mt-0.5 truncate text-[15px] font-medium text-slate-800">{j.item}{j.brandModel && <span className="font-normal text-slate-500"> · {j.brandModel}</span>}</p>
        <p className="mt-0.5 line-clamp-2 text-sm text-slate-600">{j.problem}</p>
        <div className="mt-1.5 flex items-center justify-between gap-2 text-sm">
          <span className="truncate text-slate-500"><Phone className="mb-0.5 inline h-3.5 w-3.5" /> {j.customerName}{j.customerPhone && <> · {formatPhone(j.customerPhone)}</>}</span>
          {j.advance > 0 && <span className="shrink-0 text-emerald-700">Adv {money(j.advance)}</span>}
        </div>
      </button>
      {open && (
        <footer className="flex gap-2 px-4 pb-3">
          {prev && <Button className="flex-1" variant="secondary" icon={ArrowLeft} onClick={() => onMove(prev)}>{JOB_STAGE_LABEL[prev]}</Button>}
          {j.stage === 'ready'
            ? <Button className="flex-1" variant="success" icon={ReceiptText} onClick={onBill}>Bill and deliver</Button>
            : next && <Button className="flex-1" variant={next === 'ready' ? 'success' : 'primary'} onClick={() => onMove(next)}>{next === 'ready' ? 'Mark ready' : JOB_STAGE_LABEL[next]} <ArrowRight className="ml-1 h-4 w-4" /></Button>}
        </footer>
      )}
    </article>
  )
}

/** New job, or edit one (`job`). "Save and print slip" prints the customer's slip from the save's answer. */
function JobForm({ job, onClose, onSaved }: { job?: ServiceJob; onClose: () => void; onSaved: (j: ServiceJob) => void }) {
  const { me, mod } = useApp()
  const { data: users = [] } = useData(() => api.users.list().catch(() => []))
  const [f, setF] = useState({
    customerId: job?.customerId ?? null as string | null, item: job?.item ?? '', brandModel: job?.brandModel ?? '', serial: job?.serial ?? '', colour: job?.colour ?? '',
    problem: job?.problem ?? '', accessories: job?.accessories ?? '', conditionNote: job?.conditionNote ?? '', estimate: job?.estimate != null ? String(job.estimate) : '',
    promisedAt: toLocalInput(job?.promisedAt ?? null), technicianId: job?.technicianId ?? '', advance: '', method: 'cash' as AdvanceMethod,
  })
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }))
  const methods = ADVANCE_METHODS.filter((m) => (me?.business.billing.paymentMethods ?? ['cash']).includes(m as PaymentMethod))
  const { once, saving } = useSaveOnce() // one job, even if the connection drops and Save is tapped again
  const save = useSave(() => undefined)
  const { print, portal } = usePrint()

  const submit = async (andPrint: boolean) => {
    const input: JobInput = {
      customerId: f.customerId ?? '', item: f.item, brandModel: f.brandModel, serial: f.serial, colour: f.colour, problem: f.problem, accessories: f.accessories,
      conditionNote: f.conditionNote, estimate: f.estimate.trim() === '' ? null : Number(f.estimate), promisedAt: f.promisedAt ? new Date(f.promisedAt).toISOString() : null,
      technicianId: f.technicianId || null,
    }
    const saved = job
      ? await save(() => api.serviceJobs.update(job.id, input, job.version), 'Job saved')
      : await once({ input, a: f.advance, m: f.method }, () => save(() => api.serviceJobs.create({ ...input, advance: Number(f.advance) > 0 ? { amount: Number(f.advance), method: f.method } : null }), 'Job taken in'))
    if (!saved) return
    if (andPrint) print(<JobSlip j={saved} />)
    onSaved(saved)
  }

  return (
    <Modal open onClose={onClose} size="lg" title={job ? `Edit ${job.number}` : 'New job'} subtitle={job ? undefined : 'Take an item in for service'}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button variant="secondary" icon={Printer} disabled={saving} onClick={() => void submit(true)}>Save and print slip</Button>
        <Button disabled={saving} onClick={() => void submit(false)}>{saving ? 'Saving…' : 'Save'}</Button>
      </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {!job && (
          <Field label="Customer" required className="sm:col-span-2">
            {mod('customers') ? <CustomerPicker value={f.customerId} onChange={(id) => set('customerId', id)} /> : <p className="text-sm text-amber-700">Turn on Customers in Settings → Modules to take in jobs.</p>}
          </Field>
        )}
        <Field label="Item" required><Input value={f.item} onChange={(e) => set('item', e.target.value)} placeholder="Mobile, laptop, shirt…" maxLength={80} /></Field>
        <Field label="Brand / model"><Input value={f.brandModel} onChange={(e) => set('brandModel', e.target.value)} placeholder="Redmi Note 12" maxLength={120} /></Field>
        <Field label="IMEI / serial no."><Input value={f.serial} onChange={(e) => set('serial', e.target.value)} maxLength={40} /></Field>
        <Field label="Colour"><Input value={f.colour} onChange={(e) => set('colour', e.target.value)} maxLength={30} /></Field>
        <Field label="Problem / work to do" required className="sm:col-span-2"><Textarea rows={2} value={f.problem} onChange={(e) => set('problem', e.target.value)} maxLength={500} /></Field>
        <Field label="Accessories received"><Input value={f.accessories} onChange={(e) => set('accessories', e.target.value)} placeholder="Charger, back cover, SIM…" maxLength={255} /></Field>
        <Field label="Condition"><Input value={f.conditionNote} onChange={(e) => set('conditionNote', e.target.value)} placeholder="Scratches, cracked back…" maxLength={255} /></Field>
        <Field label="Estimate"><Input type="number" min={0} inputMode="decimal" value={f.estimate} onChange={(e) => set('estimate', e.target.value)} /></Field>
        <Field label="Ready by">
          {/* Not controlled: the browser's date picker reports '' while a date is half picked; writing that back would wipe the choice. */}
          <Input type="datetime-local" defaultValue={f.promisedAt} onChange={(e) => set('promisedAt', e.target.value)} onBlur={(e) => set('promisedAt', e.target.value)} />
        </Field>
        {users.length > 0 && (
          <Field label="Technician">
            <Select value={f.technicianId} onChange={(e) => set('technicianId', e.target.value)}>
              <option value="">—</option>
              {users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </Field>
        )}
        {!job && (
          <Field label="Advance" hint="Taken now; it is taken off the bill at delivery">
            <div className="flex gap-2">
              <Input type="number" min={0} inputMode="decimal" value={f.advance} onChange={(e) => set('advance', e.target.value)} placeholder="0" />
              <Select value={f.method} onChange={(e) => set('method', e.target.value as AdvanceMethod)} className="w-28">
                {methods.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
              </Select>
            </div>
          </Field>
        )}
      </div>
      {portal}
    </Modal>
  )
}

/** The customer's slip (thermal / browser print): job number, item, problem, estimate, advance. */
function JobSlip({ j }: { j: ServiceJob }) {
  const { me } = useApp()
  const b = me?.business
  return (
    <div className="receipt mx-auto w-[72mm] p-2 font-mono text-[12px] leading-snug text-black">
      <p className="text-center text-[14px] font-bold">{b?.name}</p>
      {b?.phone && <p className="text-center">{formatPhone(b.phone)}</p>}
      <p className="my-1 border-y border-dashed border-black py-1 text-center font-bold">SERVICE JOB {j.number}</p>
      <p>Date: {fmtDateTime(j.createdAt)}</p>
      <p>Customer: {j.customerName}{j.customerPhone && ` (${formatPhone(j.customerPhone)})`}</p>
      <p>Item: {j.item}{j.brandModel && ` · ${j.brandModel}`}</p>
      {j.serial && <p>IMEI / serial: {j.serial}</p>}
      <p>Problem: {j.problem}</p>
      {j.accessories && <p>Accessories: {j.accessories}</p>}
      {j.conditionNote && <p>Condition: {j.conditionNote}</p>}
      {j.estimate != null && <p>Estimate: {money(j.estimate)}</p>}
      {j.advance > 0 && <p>Advance paid: {money(j.advance)}</p>}
      {j.promisedAt && <p>Ready by: {fmtDateTime(j.promisedAt)}</p>}
      <p className="mt-2 border-t border-dashed border-black pt-1 text-center">Please bring this slip to collect your item.</p>
    </div>
  )
}

function JobDetails({ id, stages, onClose, onChanged, onReload }: { id: string; stages: JobStage[]; onClose: () => void; onChanged: (c: JobCard, from?: JobStage) => void; onReload: () => void }) {
  const { me } = useApp()
  const [j, setJ] = useState<ServiceJob | null>(null)
  const [note, setNote] = useState('')
  const [editing, setEditing] = useState(false)
  const [closing, setClosing] = useState<'cancelled' | 'returned' | null>(null)
  const nav = useNavigate()
  const [billId, setBillId] = useState<string | null>(null)
  const { data: users = [] } = useData(() => api.users.list().catch(() => []))
  const nameOf = (uid: string | null) => users.find((u) => u.id === uid)?.name ?? ''
  const toast = useToast()
  const { print, portal } = usePrint()
  const fetchJob = useCallback(() => api.serviceJobs.get(id).then(setJ).catch((e) => { toast((e as Error).message, 'error'); onClose() }), [id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void fetchJob() }, [fetchJob])
  const save = useSave(() => { void fetchJob(); onReload() })
  const open = j && !CLOSED_STAGES.includes(j.stage)

  const move = async (to: JobStage) => {
    if (!j) return
    const card = await save(() => api.serviceJobs.setStage(j.id, to, note, j.version))
    if (!card) return
    const at = card.stageAt
    setJ({ ...j, ...card, events: [...j.events, { from: j.stage, to: card.stage, note: note.trim(), at, by: me?.user.id ?? '' }] })
    setNote('')
    onChanged(card, j.stage)
  }
  const done = (next: ServiceJob, from: JobStage) => { setJ(next); onChanged(next, from) }

  return (
    <Drawer open onClose={onClose} width="max-w-lg" title={j ? `${j.number} · ${j.item}` : 'Job'} subtitle={j ? JOB_STAGE_LABEL[j.stage] : undefined}
      footer={j && (open ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="ghost" icon={XCircle} className="!text-red-600" onClick={() => setClosing('cancelled')}>Cancel</Button>
          <Button size="sm" variant="ghost" icon={Undo2} onClick={() => setClosing('returned')}>Return</Button>
          <div className="flex-1" />
          <Button size="sm" variant="secondary" icon={Printer} onClick={() => print(<JobSlip j={j} />)}>Slip</Button>
          <Button size="sm" variant="success" icon={ReceiptText} onClick={() => nav(`/billing?job=${j.id}`)}>Bill and deliver</Button>
        </div>
      ) : j.orderId ? <Button variant="secondary" icon={Printer} onClick={() => setBillId(j.orderId)}>Bill {j.invoiceNumber}</Button> : null)}>
      {!j ? <p className="py-10 text-center text-sm text-slate-400">Loading…</p> : (
        <div className="space-y-4 p-5 text-sm">
          <section className="rounded-lg border border-slate-200 p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{j.customerName}</p>
                {j.customerPhone && <a href={`tel:${j.customerPhone}`} className="text-xs text-brand-600"><Phone className="mb-0.5 inline h-3 w-3" /> {formatPhone(j.customerPhone)}</a>}
              </div>
              {open && <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(true)}>Edit</Button>}
            </div>
            <dl className="mt-2 grid grid-cols-[110px_1fr] gap-x-2 gap-y-1 text-xs">
              {([['Item', `${j.item}${j.brandModel ? ` · ${j.brandModel}` : ''}`], ['IMEI / serial', j.serial], ['Colour', j.colour], ['Problem', j.problem], ['Accessories', j.accessories],
                ['Condition', j.conditionNote], ['Technician', nameOf(j.technicianId)], ['Ready by', j.promisedAt ? fmtDateTime(j.promisedAt) : ''], ['Taken in', fmtDateTime(j.createdAt)],
                ['Reason', j.closeReason]] as const).filter(([, v]) => v).map(([k, v]) => <Fragment key={k}><dt className="text-slate-500">{k}</dt><dd className="whitespace-pre-wrap">{v}</dd></Fragment>)}
            </dl>
          </section>

          <section className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-slate-50 p-2"><p className="text-[11px] text-slate-500">Estimate</p><p className="font-semibold">{j.estimate != null ? money(j.estimate) : '—'}</p></div>
            <div className="rounded-lg bg-emerald-50 p-2"><p className="text-[11px] text-slate-500">Advance</p><p className="font-semibold text-emerald-700">{money(j.advance)}</p></div>
            <div className="rounded-lg bg-slate-50 p-2"><p className="text-[11px] text-slate-500">Bill</p><p className="font-semibold">{j.total != null ? money(j.total) : '—'}</p></div>
          </section>

          {open && (
            <section>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Move to</p>
              <div className="flex flex-wrap gap-1.5">
                {stages.filter((s) => s !== 'delivered').map((s) => (
                  <Button key={s} size="sm" variant={s === j.stage ? 'primary' : 'secondary'} disabled={s === j.stage} onClick={() => void move(s)}>{JOB_STAGE_LABEL[s]}</Button>
                ))}
              </div>
              <Input className="mt-2" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note with the move (optional) — e.g. customer approved ₹2,200" maxLength={255} />
            </section>
          )}

          <section>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">History</p>
            <ol className="space-y-1.5 border-l-2 border-slate-200 pl-3">
              {j.events.slice().reverse().map((e, i) => (
                <li key={i} className="text-xs">
                  <span className="font-medium">{JOB_STAGE_LABEL[e.to]}</span> <span className="text-slate-500">· {fmtDateTime(e.at)}{nameOf(e.by) && ` · ${nameOf(e.by)}`}</span>
                  {e.note && <p className="text-slate-600">{e.note}</p>}
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
      {portal}
      {editing && j && <JobForm job={j} onClose={() => setEditing(false)} onSaved={(n) => { setEditing(false); done(n, n.stage) }} />}
      {closing && j && <CloseModal j={j} how={closing} onClose={() => setClosing(null)} onDone={(n) => { setClosing(null); done(n, j.stage) }} />}
      {billId && <BillSuccessModal orderId={billId} onClose={() => setBillId(null)} onNew={() => setBillId(null)} />}
    </Drawer>
  )
}

function CloseModal({ j, how, onClose, onDone }: { j: ServiceJob; how: 'cancelled' | 'returned'; onClose: () => void; onDone: (j: ServiceJob) => void }) {
  const [reason, setReason] = useState('')
  const [refund, setRefund] = useState<AdvanceMethod | ''>(j.advance > 0 ? 'cash' : '')
  const [busy, setBusy] = useState(false)
  const save = useSave(() => undefined)
  const submit = async () => {
    setBusy(true)
    const r = await save(() => api.serviceJobs.close(j.id, how, reason, refund ? { method: refund } : null), how === 'cancelled' ? 'Job cancelled' : 'Marked returned')
    setBusy(false)
    if (r) onDone(r)
  }
  return (
    <Modal open onClose={onClose} size="sm" title={how === 'cancelled' ? `Cancel ${j.number}?` : `Return ${j.number} without the work?`}
      footer={<><Button variant="secondary" onClick={onClose}>Back</Button><Button variant={how === 'cancelled' ? 'danger' : 'primary'} disabled={busy} onClick={() => void submit()}>{how === 'cancelled' ? 'Cancel job' : 'Mark returned'}</Button></>}>
      <div className="space-y-3">
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={how === 'cancelled' ? 'Customer cancelled' : 'Not repairable'} maxLength={255} /></Field>
        {j.advance > 0 && (
          <Field label={`Advance ${money(j.advance)}`}>
            <Select value={refund} onChange={(e) => setRefund(e.target.value as AdvanceMethod | '')}>
              {ADVANCE_METHODS.map((m) => <option key={m} value={m}>Give back by {METHOD_LABEL[m]}</option>)}
              <option value="">Keep it (not given back)</option>
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  )
}
