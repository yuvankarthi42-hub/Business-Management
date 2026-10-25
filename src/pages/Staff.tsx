import clsx from 'clsx'
import { ChevronLeft, ChevronRight, HandCoins, Pencil, Printer, UserCheck, UserPlus, Users, Wallet } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { Badge, Button, Card, EmptyState, Field, FieldLabel, Input, Modal, PageHeader, Segmented, Select, Table, Td, Th, useAction } from '@/components/ui'
import { PAYMENT_LABEL } from '@/core/config'
import type { AttendanceStatus, PaymentMethod, StaffPay } from '@/core/types'
import { api } from '@/data'
import { money } from '@/lib/format'
import { usePrint } from '@/features/Payment'
import { PhoneInput } from '@/components/PhoneInput'

type Tab = 'attendance' | 'month' | 'payroll'
type PayrollRow = Awaited<ReturnType<typeof api.staff.month>>[number]

const ST: Record<AttendanceStatus, { label: string; short: string; on: string; dot: string }> = {
  present: { label: 'Present', short: 'P', on: 'border-emerald-600 bg-emerald-600 text-white', dot: 'bg-emerald-500' },
  half: { label: 'Half day', short: '½', on: 'border-amber-500 bg-amber-500 text-white', dot: 'bg-amber-400' },
  absent: { label: 'Absent', short: 'A', on: 'border-red-600 bg-red-600 text-white', dot: 'bg-red-500' },
  leave: { label: 'Leave', short: 'L', on: 'border-sky-600 bg-sky-600 text-white', dot: 'bg-sky-500' },
}
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const shiftDay = (k: string, n: number) => { const d = new Date(`${k}T12:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const shiftMonth = (m: string, n: number) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }
const monthLabel = (m: string) => new Date(`${m}-01T12:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
const dayLabel = (k: string) => new Date(`${k}T12:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })

/** Staff: daily attendance, monthly summary and payroll with commission and advances. */
export default function Staff() {
  const { me } = useApp()
  const [tab, setTab] = useState<Tab>('attendance')
  if (me?.isAll) return <EmptyState icon={Users} title="Choose a branch" description="Attendance and salary are kept per branch. Pick a branch from the top bar." />
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Staff" subtitle="Attendance, salary and commission" />
      <Segmented value={tab} onChange={setTab} className="mb-4" options={[{ value: 'attendance', label: 'Attendance' }, { value: 'month', label: 'Monthly summary' }, { value: 'payroll', label: 'Salary' }]} />
      {tab === 'attendance' && <AttendanceTab />}
      {tab === 'month' && <MonthTab />}
      {tab === 'payroll' && <PayrollTab />}
    </div>
  )
}

function AttendanceTab() {
  const run = useAction()
  const [adding, setAdding] = useState(false)
  const [date, setDate] = useState(todayKey())
  const { data: staff = [] } = useData(() => api.staff.list())
  const { data: day = [] } = useData(() => api.staff.day(date), [date])
  const rec = (id: string) => day.find((a) => a.userId === id)
  const count = (st: AttendanceStatus) => day.filter((a) => a.status === st).length
  const unmarked = staff.filter((s) => !rec(s.id))
  const future = date > todayKey()
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-3">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" icon={ChevronLeft} write={false} onClick={() => setDate(shiftDay(date, -1))} aria-label="Previous day" />
          <Input type="date" value={date} max={todayKey()} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-9 w-40" aria-label="Date" />
          <Button size="sm" variant="ghost" icon={ChevronRight} write={false} disabled={date >= todayKey()} onClick={() => setDate(shiftDay(date, 1))} aria-label="Next day" />
        </div>
        <span className="text-sm font-medium text-slate-700">{dayLabel(date)}</span>
        <div className="flex flex-wrap gap-1.5 text-xs">
          {(Object.keys(ST) as AttendanceStatus[]).map((k) => <span key={k} className="inline-flex items-center gap-1 rounded-md bg-slate-50 px-2 py-1"><span className={clsx('h-2 w-2 rounded-full', ST[k].dot)} />{ST[k].label} {count(k)}</span>)}
          <span className="inline-flex items-center gap-1 rounded-md bg-slate-50 px-2 py-1 text-slate-500">Not marked {unmarked.length}</span>
        </div>
        <div className="flex-1" />
        <Button size="sm" variant="secondary" icon={UserPlus} onClick={() => setAdding(true)} title="For staff who don’t use the app — cleaners, helpers, drivers">Add staff member</Button>
        <Button size="sm" icon={UserCheck} disabled={!unmarked.length || future} onClick={() => run(() => api.staff.markAll(date, unmarked.map((s) => s.id)), `${unmarked.length} marked present`)}>Mark all present</Button>
      </div>
      {adding && <AddWorker onClose={() => setAdding(false)} />}
      {!staff.length ? <EmptyState icon={Users} title="No staff in this branch" description="Add staff here (for people who don’t use the app), or in Settings → Staff & Roles (with an app login)." /> : (
        <ul className="divide-y divide-slate-100">
          {staff.map((s) => {
            const a = rec(s.id)
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-sm font-semibold text-brand-700">{s.name[0]}</span>
                <div className="min-w-[140px] flex-1"><p className="text-sm font-medium">{s.name}</p><p className="text-xs text-slate-500">{s.canLogin === false ? 'No app login' : s.role}</p></div>
                <div className="flex gap-1" role="group" aria-label={`Attendance for ${s.name}`}>
                  {(Object.keys(ST) as AttendanceStatus[]).map((k) => (
                    <button key={k} type="button" disabled={future} aria-pressed={a?.status === k} onClick={() => run(() => api.staff.mark(s.id, date, { status: k }))}
                      className={clsx('h-9 min-w-[44px] rounded-lg border px-2.5 text-xs font-semibold transition disabled:opacity-40', a?.status === k ? ST[k].on : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300')}>
                      <span className="sm:hidden">{ST[k].short}</span><span className="hidden sm:inline">{ST[k].label}</span>
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-slate-500">
                  <label className="flex items-center gap-1">In<input type="time" aria-label="Check in" disabled={!a} defaultValue={a?.checkIn ?? ''} key={`${s.id}-${date}-in-${a?.checkIn}`}
                    onBlur={(e) => a && e.target.value !== (a.checkIn ?? '') && run(() => api.staff.mark(s.id, date, { checkIn: e.target.value }))} className="h-8 w-[92px] rounded-md border-slate-200 px-1.5 text-xs disabled:opacity-40" /></label>
                  <label className="flex items-center gap-1">Out<input type="time" aria-label="Check out" disabled={!a} defaultValue={a?.checkOut ?? ''} key={`${s.id}-${date}-out-${a?.checkOut}`}
                    onBlur={(e) => a && e.target.value !== (a.checkOut ?? '') && run(() => api.staff.mark(s.id, date, { checkOut: e.target.value }))} className="h-8 w-[92px] rounded-md border-slate-200 px-1.5 text-xs disabled:opacity-40" /></label>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

/**
 * A staff member who doesn't use the app (cleaner, helper, driver): name, mobile and salary — attendance, salary
 * and advances work like for everyone else, but they never sign in. App logins are added in Settings → Staff & Roles.
 */
function AddWorker({ onClose }: { onClose: () => void }) {
  const run = useAction()
  const { me } = useApp()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [payType, setPayType] = useState<'none' | StaffPay['type']>('monthly')
  const [amount, setAmount] = useState('')
  const save = async () => {
    const pay = payType === 'none' ? undefined : { type: payType, amount: Number(amount) || 0, commissionPct: 0 }
    const ok = await run(() => api.users.save({ name: name.trim(), phone, roleId: '', canLogin: false, branchIds: [me!.branch.id], ...(pay ? { pay } : {}) }), `${name.trim()} added`)
    if (ok) onClose()
  }
  return (
    <Modal open onClose={onClose} size="sm" title="Add staff member" subtitle="For people who don’t use the app — cleaners, helpers, drivers"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!name.trim() || !phone} onClick={save}>Add</Button></>}>
      <div className="space-y-4">
        <Field required label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div><FieldLabel required>Mobile</FieldLabel><PhoneInput value={phone} onChange={setPhone} defaultCountry={me?.business.defaultCountry} required /></div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Salary"><Select value={payType} onChange={(e) => setPayType(e.target.value as typeof payType)}>
            <option value="monthly">Monthly</option><option value="daily">Per day</option><option value="none">Not on payroll</option>
          </Select></Field>
          {payType !== 'none' && <Field required label={payType === 'daily' ? 'Amount per day' : 'Amount per month'}><Input type="number" inputMode="decimal" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>}
        </div>
        <p className="text-xs text-slate-500">Works at {me?.branch.name}. They can’t sign in to the app — attendance, salary and advances are marked by you.</p>
      </div>
    </Modal>
  )
}

function MonthTab() {
  const [month, setMonth] = useState(todayKey().slice(0, 7))
  const { data: rows = [] } = useData(() => api.staff.month(month), [month])
  const dim = rows[0]?.daysInMonth ?? 30
  const soFar = rows[0]?.daysSoFar ?? 0
  return (
    <Card>
      <MonthBar month={month} setMonth={setMonth} />
      <div className="overflow-x-auto">
        <Table>
          <thead><tr><Th>Staff</Th><Th className="text-right">Present</Th><Th className="text-right">Half</Th><Th className="text-right">Absent</Th><Th className="text-right">Leave</Th><Th className="text-right">Not marked</Th><Th>Days</Th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId}>
                <Td><p className="font-medium">{r.name}</p><p className="text-xs text-slate-500">{r.role}</p></Td>
                <Td className="text-right tabular">{r.present}</Td><Td className="text-right tabular">{r.half}</Td>
                <Td className={clsx('text-right tabular', r.absent && 'font-semibold text-red-600')}>{r.absent}</Td><Td className="text-right tabular">{r.leave}</Td>
                <Td className={clsx('text-right tabular', r.unmarked && 'text-amber-700')}>{r.unmarked}</Td>
                <Td>
                  <div className="flex gap-[3px]" aria-label="Day by day">
                    {Array.from({ length: dim }, (_, i) => {
                      const k = `${month}-${String(i + 1).padStart(2, '0')}`
                      const st = (r.days as Record<string, AttendanceStatus>)[k]
                      return <span key={k} title={`${i + 1}: ${st ? ST[st].label : i < soFar ? 'Not marked' : ''}`} className={clsx('h-4 w-2.5 rounded-sm', st ? ST[st].dot : i < soFar ? 'bg-slate-200' : 'bg-slate-50')} />
                    })}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      <p className="flex flex-wrap gap-3 border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">
        {(Object.keys(ST) as AttendanceStatus[]).map((k) => <span key={k} className="inline-flex items-center gap-1"><span className={clsx('h-2.5 w-2.5 rounded-sm', ST[k].dot)} />{ST[k].label}</span>)}
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-slate-200" />Not marked</span>
      </p>
    </Card>
  )
}

const MonthBar = ({ month, setMonth }: { month: string; setMonth: (m: string) => void }) => (
  <div className="flex items-center gap-1 border-b border-slate-100 p-3">
    <Button size="sm" variant="ghost" icon={ChevronLeft} write={false} onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month" />
    <span className="min-w-[150px] text-center text-sm font-semibold">{monthLabel(month)}</span>
    <Button size="sm" variant="ghost" icon={ChevronRight} write={false} disabled={month >= todayKey().slice(0, 7)} onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month" />
  </div>
)

function PayrollTab() {
  const [month, setMonth] = useState(todayKey().slice(0, 7))
  const { data: rows = [] } = useData(() => api.staff.month(month), [month])
  const [editPay, setEditPay] = useState<PayrollRow | null>(null)
  const [advance, setAdvance] = useState<PayrollRow | null>(null)
  const [paying, setPaying] = useState<PayrollRow | null>(null)
  const { print, portal } = usePrint()
  const totals = useMemo(() => ({ net: rows.reduce((a, r) => a + (r.paid ? r.paid.net : r.net), 0), paid: rows.filter((r) => r.paid).length }), [rows])
  return (
    <Card>
      {portal}
      <div className="flex flex-wrap items-center justify-between gap-2 pr-3"><MonthBar month={month} setMonth={setMonth} /><span className="text-sm text-slate-500">{totals.paid} of {rows.length} paid · total {money(totals.net)}</span></div>
      <div className="overflow-x-auto">
        <Table>
          <thead><tr><Th>Staff</Th><Th>Salary</Th><Th className="text-right">Days</Th><Th className="text-right">Base pay</Th><Th className="text-right">Commission</Th><Th className="text-right">Advance</Th><Th className="text-right">Net pay</Th><Th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId}>
                <Td><p className="font-medium">{r.name}</p><p className="text-xs text-slate-500">{r.role}</p></Td>
                <Td className="text-sm">
                  {r.pay ? <>{money(r.pay.amount)}<span className="text-slate-500">/{r.pay.type === 'monthly' ? 'month' : 'day'}</span>{r.pay.commissionPct > 0 && <span className="block text-xs text-slate-500">+ {r.pay.commissionPct}% of bills</span>}</> : <span className="text-amber-700">Not set</span>}
                  <button type="button" onClick={() => setEditPay(r)} className="ml-1 inline-flex align-middle text-slate-400 hover:text-brand-600" aria-label={`Edit salary for ${r.name}`}><Pencil className="h-3.5 w-3.5" /></button>
                </Td>
                <Td className="text-right text-xs tabular">{r.present}P{r.half ? ` · ${r.half}½` : ''}{r.absent ? <span className="text-red-600"> · {r.absent}A</span> : ''}{r.leave ? ` · ${r.leave}L` : ''}</Td>
                <Td className="text-right tabular">{money(r.paid?.basePay ?? r.basePay)}</Td>
                <Td className="text-right tabular">{(r.paid?.commission ?? r.commission) > 0 ? <>{money(r.paid?.commission ?? r.commission)}<span className="block text-[11px] text-slate-400">{r.bills} bills · {money(r.sales)}</span></> : '—'}</Td>
                <Td className="text-right tabular">{(r.paid?.advances ?? r.advances) > 0 ? <span className="text-amber-700">− {money(r.paid?.advances ?? r.advances)}</span> : '—'}</Td>
                <Td className="text-right font-semibold tabular">{money(r.paid?.net ?? r.net)}</Td>
                <Td className="whitespace-nowrap text-right">
                  {r.paid ? (
                    <span className="inline-flex items-center gap-1"><Badge tone="green">Paid · {PAYMENT_LABEL[r.paid.method]}</Badge><Button size="sm" variant="ghost" icon={Printer} write={false} aria-label="Print slip" title="Print salary slip" onClick={() => print(<SalarySlip r={r} />)} /></span>
                  ) : <>
                    <Button size="sm" variant="ghost" icon={HandCoins} onClick={() => setAdvance(r)} title="Give advance" aria-label={`Give advance to ${r.name}`} />
                    <Button size="sm" icon={Wallet} disabled={!r.pay} onClick={() => setPaying(r)}>Pay salary</Button>
                  </>}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      <p className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">Monthly salary: absent days are cut (half day = ½); leave and days not marked are paid. Daily wage: paid for days present. Commission: % of bills the person made, after returns. Salary and advances are added to Expenses (Salary).</p>
      {editPay && <PayModal r={editPay} onClose={() => setEditPay(null)} />}
      {advance && <AdvanceModal r={advance} onClose={() => setAdvance(null)} />}
      {paying && <PaySalaryModal r={paying} month={month} onClose={() => setPaying(null)} />}
    </Card>
  )
}

function PayModal({ r, onClose }: { r: PayrollRow; onClose: () => void }) {
  const run = useAction()
  const [p, setP] = useState<StaffPay>(r.pay ?? { type: 'monthly', amount: 0, commissionPct: 0 })
  return (
    <Modal open onClose={onClose} size="sm" title={`Salary · ${r.name}`}>
      <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.staff.setPay(r.userId, p), 'Salary saved')) onClose() }}>
        <Segmented value={p.type} onChange={(type) => setP({ ...p, type })} options={[{ value: 'monthly', label: 'Monthly salary' }, { value: 'daily', label: 'Daily wage' }]} />
        <Field required label={p.type === 'monthly' ? 'Salary per month (₹)' : 'Wage per day (₹)'}><Input autoFocus type="number" min={0} inputMode="decimal" value={p.amount || ''} onChange={(e) => setP({ ...p, amount: Number(e.target.value) })} /></Field>
        <Field label="Commission (% of bills they make)" hint="0 = no commission"><Input type="number" min={0} max={50} step="0.5" inputMode="decimal" value={p.commissionPct || ''} onChange={(e) => setP({ ...p, commissionPct: Number(e.target.value) })} placeholder="0" /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit">Save</Button></div>
      </form>
    </Modal>
  )
}

const Methods = ({ value, onChange }: { value: PaymentMethod; onChange: (m: PaymentMethod) => void }) => (
  <Select value={value} onChange={(e) => onChange(e.target.value as PaymentMethod)}>{(['cash', 'upi', 'bank'] as PaymentMethod[]).map((m) => <option key={m} value={m}>{PAYMENT_LABEL[m]}</option>)}</Select>
)

function AdvanceModal({ r, onClose }: { r: PayrollRow; onClose: () => void }) {
  const run = useAction()
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [note, setNote] = useState('')
  return (
    <Modal open onClose={onClose} size="sm" title={`Advance · ${r.name}`} subtitle="Taken off the next salary.">
      <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.staff.giveAdvance(r.userId, { amount: Number(amount), method, note }), 'Advance recorded')) onClose() }}>
        <div className="grid grid-cols-2 gap-3"><Field required label="Amount (₹)"><Input autoFocus type="number" min={1} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field><Field required label="Paid by"><Methods value={method} onChange={setMethod} /></Field></div>
        <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Festival" /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" icon={HandCoins} disabled={!(Number(amount) > 0)}>Give advance</Button></div>
      </form>
    </Modal>
  )
}

function PaySalaryModal({ r, month, onClose }: { r: PayrollRow; month: string; onClose: () => void }) {
  const run = useAction()
  const [bonus, setBonus] = useState('')
  const [deduction, setDeduction] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [note, setNote] = useState('')
  const net = Math.round((r.basePay + r.commission + (Number(bonus) || 0) - (Number(deduction) || 0) - r.advances) * 100) / 100
  const Line = ({ k, v, minus }: { k: string; v: number; minus?: boolean }) => <div className="flex justify-between"><span className="text-slate-600">{k}</span><span className="tabular">{minus && v ? '− ' : ''}{money(v, { decimals: true })}</span></div>
  return (
    <Modal open onClose={onClose} title={`Pay salary · ${r.name}`} subtitle={`${monthLabel(month)} · ${r.present} present${r.half ? `, ${r.half} half` : ''}${r.absent ? `, ${r.absent} absent` : ''}${r.leave ? `, ${r.leave} leave` : ''}${r.unmarked ? `, ${r.unmarked} not marked` : ''}`}>
      <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.staff.paySalary(r.userId, month, { bonus: Number(bonus) || 0, deduction: Number(deduction) || 0, method, note }), 'Salary paid')) onClose() }}>
        <div className="space-y-1 rounded-xl bg-slate-50 p-4 text-sm">
          <Line k={r.pay?.type === 'daily' ? `Wage (${r.present + r.half * 0.5} days × ${money(r.pay.amount)})` : 'Salary after absent days'} v={r.basePay} />
          {r.commission > 0 && <Line k={`Commission (${r.pay?.commissionPct}% of ${money(r.sales)})`} v={r.commission} />}
          {Number(bonus) > 0 && <Line k="Bonus" v={Number(bonus)} />}
          {Number(deduction) > 0 && <Line k="Other deduction" v={Number(deduction)} minus />}
          {r.advances > 0 && <Line k="Advance taken" v={r.advances} minus />}
          <div className="flex justify-between border-t border-slate-200 pt-1.5 text-base font-semibold"><span>Net pay</span><span className="tabular">{money(net, { decimals: true })}</span></div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Bonus (₹)"><Input type="number" min={0} inputMode="decimal" value={bonus} onChange={(e) => setBonus(e.target.value)} placeholder="0" /></Field>
          <Field label="Other deduction (₹)"><Input type="number" min={0} inputMode="decimal" value={deduction} onChange={(e) => setDeduction(e.target.value)} placeholder="0" /></Field>
          <Field required label="Paid by"><Methods value={method} onChange={setMethod} /></Field>
        </div>
        <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {net < 0 && <p className="text-sm text-amber-700">The advance is more than this month’s pay — {money(-net)} stays to recover.</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" icon={Wallet}>Pay {money(Math.max(0, net))}</Button></div>
      </form>
    </Modal>
  )
}

function SalarySlip({ r }: { r: PayrollRow }) {
  const { me } = useApp()
  const p = r.paid!
  const row = (k: string, v: number, minus = false) => <div className="flex justify-between"><span>{k}</span><span>{minus && v ? '-' : ''}{v.toFixed(2)}</span></div>
  return (
    <div data-no-i18n className="font-mono text-[11.5px] leading-snug text-black" style={{ maxWidth: '80mm' }}>
      <p className="text-center text-[15px] font-bold uppercase">{me?.business.name}</p>
      <p className="text-center font-bold">SALARY SLIP · {monthLabel(p.month)}</p>
      <div className="my-1.5 border-t border-dashed border-black" />
      <p>{r.name} · {r.role}</p>
      <p>Days: {p.present} present, {p.half} half, {p.absent} absent, {p.leave} leave</p>
      <div className="my-1.5 border-t border-dashed border-black" />
      {row(p.payType === 'monthly' ? `Salary (${p.rate}/month)` : `Wage (${p.rate}/day)`, p.basePay)}
      {p.commission > 0 && row(`Commission on ${p.commissionSales.toFixed(0)}`, p.commission)}
      {p.bonus > 0 && row('Bonus', p.bonus)}
      {p.deduction > 0 && row('Deduction', p.deduction, true)}
      {p.advances > 0 && row('Advance', p.advances, true)}
      <div className="my-1.5 border-t-2 border-black" />
      <div className="flex justify-between font-bold"><span>NET PAID</span><span>{me?.business.currencySymbol}{p.net.toFixed(2)}</span></div>
      <p>Paid by {PAYMENT_LABEL[p.method]} on {new Date(p.createdAt).toLocaleDateString('en-IN')}</p>
      <p className="mt-6">Signature: ______________________</p>
    </div>
  )
}
