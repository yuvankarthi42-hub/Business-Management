// Staff attendance, salary and commission (attendance, staff_advances, salary_payments, expenses).
// Same rules and return shapes as the app's mock API (its payroll() lives in month()).
import { r2 } from '@/core/pricing'
import type { Attendance, AttendanceStatus, PaymentMethod, SalaryPayment, StaffPay } from '@/core/types'
import type { Ctx } from '../core/context'
import { ApiError } from '../core/errors'
import { define, userRead, userWrite } from '../core/registry'
import { DuplicateError, type AggFn, type Row } from '../db/types'
import { selectIn } from '../domain/orders'
import { allowedBranches, loadRoles, loadUsers, payColumns } from '../domain/people'
import { bumpEpoch } from '../domain/session'
import { audit, bizDay, bizDayStart, code, E, fromMinor, nameOf, own, str, strOrNull, toMinor } from '../domain/util'

const perm = { perm: 'users.manage' } as const
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/

/** The business's 'Salary' expense category, created on first use. */
export async function expenseCategoryId(c: Ctx, key: keyof typeof E.ExpenseKey = 'salary'): Promise<string> {
  const find = () => c.db.first('expense_categories', { business_id: c.businessId, system_key: E.ExpenseKey[key] })
  const ex = await find()
  if (ex) return ex.ROWID
  const name = key.charAt(0).toUpperCase() + key.slice(1)
  try {
    return (await c.db.insert('expense_categories', { business_id: c.businessId, name, system_key: E.ExpenseKey[key], is_active: true, uniq_key: `${c.businessId}:${key}` })).ROWID
  } catch (e) {
    // Another request made it at the same moment (or a custom category already uses the name).
    if (!(e instanceof DuplicateError)) throw e
    const again = (await find()) ?? await c.db.first('expense_categories', { uniq_key: `${c.businessId}:${key}` })
    if (!again) throw e
    return again.ROWID
  }
}

export function attendanceFrom(r: Row): Attendance {
  return {
    id: r.ROWID, businessId: str(r.business_id), branchId: str(r.branch_id), userId: str(r.user_id), date: str(r.work_date),
    status: nameOf(E.AttendanceStatus, r.status) as AttendanceStatus, checkIn: strOrNull(r.in_time), checkOut: strOrNull(r.out_time), note: str(r.note),
    markedBy: str(r.marked_by), markedAt: r.MODIFIEDTIME,
  }
}

/** salary_payments has no branch column — the caller passes the branch it belongs to (write branch / the person's branch). */
export function salaryFrom(r: Row, branchId: string): SalaryPayment {
  return {
    id: r.ROWID, businessId: str(r.business_id), branchId, userId: str(r.user_id), month: str(r.month), payType: nameOf(E.PayType, r.pay_type) as StaffPay['type'],
    rate: fromMinor(r.rate_minor), daysInMonth: Number(r.days_in_month), present: Number(r.present_days ?? 0), half: Number(r.half_days ?? 0),
    leave: Number(r.leave_days ?? 0), absent: Number(r.absent_days ?? 0), unmarked: Number(r.unmarked_days ?? 0), basePay: fromMinor(r.base_minor),
    commissionSales: fromMinor(r.commission_sales_minor), commission: fromMinor(r.commission_minor), bonus: fromMinor(r.bonus_minor), deduction: fromMinor(r.deduction_minor),
    advances: fromMinor(r.advances_minor), net: fromMinor(r.net_minor), method: nameOf(E.PayMethod, r.method) as PaymentMethod, note: str(r.note),
    createdAt: r.CREATEDTIME, createdBy: str(r.paid_by), updatedAt: r.MODIFIEDTIME, updatedBy: str(r.paid_by),
  }
}

/** Active people who may work in a branch the current view covers, with their role name. */
async function staffInScope(c: Ctx) {
  const [users, roles] = await Promise.all([loadUsers(c.db, c.businessId), loadRoles(c.db, c.businessId)])
  const all = c.s.allBranches.map((b) => b.id)
  const sc = new Set(c.scope())
  return users
    .filter((u) => u.active && allowedBranches(u, roles.find((r) => r.id === u.roleId), all).some((b) => sc.has(b)))
    .map((u) => ({ user: u, role: roles.find((r) => r.id === u.roleId)?.name ?? '' }))
}

const daysIn = (month: string) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate() }
/** Start of a month in the shop's time zone, as an ISO timestamp ('2026-10' → 2026-09-30T18:30:00Z for India). */
const monthStart = (c: Ctx, month: string) => bizDayStart(c, new Date(`${month}-01T12:00:00Z`))
const nextMonth = (month: string) => { const [y, m] = month.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}` }
/** A 'YYYY-MM-DD' as a timestamp at noon in the shop's time zone (expenses for a past day). */
const noonOf = (c: Ctx, date: string) => new Date(Date.parse(bizDayStart(c, new Date(`${date}T12:00:00Z`))) + 12 * 3600e3).toISOString()

/** One status per day wins: present > half > leave > absent. */
const RANK: Record<AttendanceStatus, number> = { present: 3, half: 2, leave: 1, absent: 0 }

/** Attendance, commission and salary for a month, per staff member — the mock's payroll(). */
async function payroll(c: Ctx, month: string) {
  if (!MONTH_RE.test(String(month ?? ''))) throw new ApiError('Choose a month')
  const today = bizDay(c)
  const dim = daysIn(month)
  // Days that have happened so far in this month (all of them for past months).
  const lastDay = month < today.slice(0, 7) ? dim : month === today.slice(0, 7) ? Number(today.slice(8, 10)) : 0
  const staff = await staffInScope(c)
  const ids = staff.map((s) => s.user.id)
  if (!ids.length) return []
  const monthEnd = `${month}-${String(dim).padStart(2, '0')}` // a real date — 'YYYY-02-31' isn't a valid DATE value
  const billed = { business_id: c.businessId, status: E.OrderStatus.completed, billed_at: { gte: monthStart(c, month), lt: monthStart(c, nextMonth(month)) } }
  const fns: Record<string, [AggFn, string]> = { total: ['SUM', 'total_minor'], returned: ['SUM', 'returned_minor'], n: ['COUNT', 'ROWID'] }
  const [att, bySeller, byMaker, advances, paidRows] = await Promise.all([
    selectIn(c, 'attendance', 'user_id', ids, { business_id: c.businessId, work_date: { gte: `${month}-01`, lte: monthEnd } }),
    // Bills each person sold this month: the salesperson on the bill, else whoever made it.
    // returned_minor already holds every return against the bill.
    c.db.aggregate('orders', { where: { ...billed, salesperson_id: { in: ids } }, groupBy: ['salesperson_id'], fns }),
    c.db.aggregate('orders', { where: { ...billed, salesperson_id: null, created_by: { in: ids } }, groupBy: ['created_by'], fns }),
    selectIn(c, 'staff_advances', 'user_id', ids, { business_id: c.businessId, salary_payment_id: null, given_on: { lte: monthEnd } }),
    c.db.select('salary_payments', { where: { business_id: c.businessId, month } }),
  ])
  return staff.map(({ user: u, role }) => {
    const byDay = new Map<string, AttendanceStatus>()
    for (const a of att.filter((x) => x.user_id === u.id)) {
      const st = nameOf(E.AttendanceStatus, a.status) as AttendanceStatus, day = str(a.work_date), cur = byDay.get(day)
      if (!cur || RANK[st] > RANK[cur]) byDay.set(day, st)
    }
    const count = (st: AttendanceStatus) => [...byDay.values()].filter((x) => x === st).length
    const present = count('present'), half = count('half'), leave = count('leave'), absent = count('absent')
    const unmarked = Math.max(0, lastDay - byDay.size)
    const pay = u.pay ?? null
    // Monthly: full salary less absent days (half day = ½). Unmarked days and leave are paid. Daily: days worked only.
    const basePay = !pay ? 0 : pay.type === 'monthly' ? Math.round(pay.amount - (pay.amount / dim) * (absent + half * 0.5)) : Math.round(pay.amount * (present + half * 0.5))
    const sold = [bySeller.find((x) => x.salesperson_id === u.id), byMaker.find((x) => x.created_by === u.id)]
    const sum = (k: 'total' | 'returned' | 'n') => sold.reduce((a, x) => a + Number(x?.[k] ?? 0), 0)
    const net = r2(fromMinor(sum('total')) - fromMinor(sum('returned')))
    const commission = pay?.commissionPct ? Math.round((net * pay.commissionPct) / 100) : 0 // whole rupees
    const adv = fromMinor(advances.filter((a) => a.user_id === u.id).reduce((a, x) => a + Number(x.amount_minor), 0))
    const paidRow = paidRows.find((x) => x.user_id === u.id)
    return {
      userId: u.id, name: u.name, role, pay, daysInMonth: dim, daysSoFar: lastDay,
      present, half, leave, absent, unmarked, days: Object.fromEntries(byDay), basePay, bills: sum('n'), sales: net, commission, advances: adv,
      net: r2(basePay + commission - adv), paid: paidRow ? salaryFrom(paidRow, u.branchId) : null,
      advanceIds: advances.filter((a) => a.user_id === u.id).map((a) => a.ROWID),
    }
  })
}

const hhmm = (v?: string | null) => {
  if (v == null || v === '') return null
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new ApiError('Time must be like 09:30')
  return v
}
const futureCheck = (c: Ctx, date: string) => {
  if (!DATE_RE.test(String(date ?? ''))) throw new ApiError('Choose a date')
  if (date > bizDay(c)) throw new ApiError('Attendance can’t be marked for a future date')
}
const method = (m: PaymentMethod) => code(E.PayMethod, m) // 'credit' isn't a way to pay someone

define('staff', {
  /** People who work in the current branch. */
  list: userRead(async (c) => (await staffInScope(c)).map(({ user: u, role }) => ({ id: u.id, name: u.name, phone: u.phone, role, pay: u.pay ?? null, canLogin: u.canLogin !== false })), perm),

  day: userRead(async (c, date: string) => {
    if (!DATE_RE.test(String(date ?? ''))) throw new ApiError('Choose a date')
    const rows = await c.db.select('attendance', { where: { business_id: c.businessId, branch_id: { in: c.scope() }, work_date: date } })
    return rows.map(attendanceFrom)
  }, perm),

  mark: userWrite(async (c, userId: string, date: string, patch: { status?: AttendanceStatus; checkIn?: string | null; checkOut?: string | null; note?: string } = {}) => {
    futureCheck(c, date)
    const u = await own(c, 'users', userId, 'Staff member not found')
    const branchId = c.writeBranch({ fallback: true })
    if (patch.status) code(E.AttendanceStatus, patch.status)
    // One row per person per day (uniq_key): marking again updates it.
    const uniq = `${u.ROWID}:${date}`
    for (let attempt = 0; attempt < 2; attempt++) {
      const ex = await c.db.first('attendance', { uniq_key: uniq })
      const cur = ex ? attendanceFrom(ex) : null
      if (!cur && !patch.status) throw new ApiError('Choose present, half day, absent or leave first')
      const status = patch.status ?? cur!.status
      const checkIn = patch.checkIn !== undefined ? hhmm(patch.checkIn) : cur?.checkIn ?? null
      const checkOut = patch.checkOut !== undefined ? hhmm(patch.checkOut) : cur?.checkOut ?? null
      if (checkIn && checkOut && checkOut < checkIn) throw new ApiError('Check-out is before check-in')
      const note = patch.note !== undefined ? String(patch.note).slice(0, 150) : cur?.note ?? ''
      const cols = { branch_id: branchId, status: code(E.AttendanceStatus, status), in_time: checkIn, out_time: checkOut, note: note || null, marked_by: c.actorId }
      if (ex) return attendanceFrom(await c.db.update('attendance', ex.ROWID, cols))
      try {
        return attendanceFrom(await c.db.insert('attendance', { business_id: c.businessId, user_id: u.ROWID, work_date: date, uniq_key: uniq, ...cols }))
      } catch (e) { if (!(e instanceof DuplicateError)) throw e } // marked on another device just now — update that one
    }
    throw new ApiError('Busy — please try again', 409, 'CONFLICT')
  }, perm),

  /** Everyone not marked yet that day → present. */
  markAll: userWrite(async (c, date: string, userIds: string[]) => {
    futureCheck(c, date)
    const branchId = c.writeBranch({ fallback: true })
    const mine = new Set((await c.db.select('users', { where: { business_id: c.businessId } })).map((u) => u.ROWID))
    const ids = [...new Set((userIds ?? []).map(String))].filter((id) => mine.has(id))
    if (!ids.length) return 0
    const marked = new Set((await selectIn(c, 'attendance', 'user_id', ids, { business_id: c.businessId, work_date: date })).map((a) => str(a.user_id)))
    const todo = ids.filter((id) => !marked.has(id))
    let n = 0
    for (const id of todo) {
      try {
        await c.db.insert('attendance', { business_id: c.businessId, branch_id: branchId, user_id: id, work_date: date, status: E.AttendanceStatus.present, marked_by: c.actorId, uniq_key: `${id}:${date}` })
        n++
      } catch (e) { if (!(e instanceof DuplicateError)) throw e }
    }
    return n
  }, perm),

  setPay: userWrite(async (c, userId: string, pay: StaffPay) => {
    const u = await own(c, 'users', userId, 'Staff member not found')
    if (!pay || !['monthly', 'daily'].includes(pay.type)) throw new ApiError('Choose monthly or daily')
    if (!(pay.amount >= 0)) throw new ApiError('Enter a valid salary')
    if (!(pay.commissionPct >= 0 && pay.commissionPct <= 50)) throw new ApiError('Commission must be between 0 and 50%')
    await c.db.update('users', u.ROWID, payColumns({ type: pay.type, amount: r2(pay.amount), commissionPct: r2(pay.commissionPct) }))
    await bumpEpoch(c, c.businessId) // the cached session holds users
    await audit(c, 'user', u.ROWID, 'pay', `${pay.type} ${pay.amount}${pay.commissionPct ? ` + ${pay.commissionPct}%` : ''}`)
  }, perm),

  giveAdvance: userWrite(async (c, userId: string, input: { amount: number; method: PaymentMethod; note?: string; date?: string }) => {
    const u = await own(c, 'users', userId, 'Staff member not found')
    if (!(Number(input?.amount) > 0)) throw new ApiError('Enter the advance amount')
    const m = method(input.method)
    const today = bizDay(c)
    const date = input.date || today
    if (!DATE_RE.test(date)) throw new ApiError('Choose a date')
    const branchId = c.writeBranch({ fallback: true })
    const amount = toMinor(r2(Number(input.amount)))
    const note = String(input.note ?? '').slice(0, 150)
    const adv = await c.db.insert('staff_advances', { business_id: c.businessId, user_id: u.ROWID, amount_minor: amount, method: m, given_on: date, note: note || null, given_by: c.actorId })
    const exp = await c.db.insert('expenses', {
      business_id: c.businessId, branch_id: branchId, category_id: await expenseCategoryId(c, 'salary'), expense_date: date === today ? c.now.toISOString() : noonOf(c, date),
      amount_minor: amount, method: m, notes: `Advance — ${str(u.name)}${note ? ` (${note})` : ''}`.slice(0, 255), ref_type: E.ExpenseRef.advance, ref_id: adv.ROWID, is_voided: false, created_by: c.actorId,
    })
    await c.db.update('staff_advances', adv.ROWID, { expense_id: exp.ROWID })
    await audit(c, 'user', u.ROWID, 'advance', String(input.amount))
  }, perm),

  /** Attendance, commission and salary for a month (YYYY-MM), per staff member. */
  month: userRead(async (c, month: string) => (await payroll(c, month)).map(({ advanceIds: _, ...row }) => row), perm),

  paySalary: userWrite(async (c, userId: string, month: string, input: { bonus?: number; deduction?: number; method: PaymentMethod; note?: string }) => {
    const row = (await payroll(c, month)).find((r) => r.userId === userId)
    if (!row) throw new ApiError('Staff member not found')
    if (!row.pay) throw new ApiError('Set the salary first')
    if (row.paid) throw new ApiError(`Salary for ${month} is already paid`)
    const m = method(input?.method)
    const bonus = r2(Math.max(0, Number(input.bonus) || 0)), deduction = r2(Math.max(0, Number(input.deduction) || 0))
    const net = r2(row.basePay + row.commission + bonus - deduction - row.advances)
    const branchId = c.writeBranch({ fallback: true })
    let sp: Row
    try {
      // uniq_key '<user>:<month>' — two devices paying at once can't both succeed.
      sp = await c.db.insert('salary_payments', {
        business_id: c.businessId, user_id: userId, month, pay_type: code(E.PayType, row.pay.type), rate_minor: toMinor(row.pay.amount), days_in_month: row.daysInMonth,
        present_days: row.present, half_days: row.half, leave_days: row.leave, absent_days: row.absent, unmarked_days: row.unmarked,
        commission_sales_minor: toMinor(row.sales), base_minor: toMinor(row.basePay), commission_minor: toMinor(row.commission), bonus_minor: toMinor(bonus),
        deduction_minor: toMinor(deduction), advances_minor: toMinor(row.advances), net_minor: toMinor(net), method: m, note: String(input.note ?? '').slice(0, 150) || null,
        paid_by: c.actorId, uniq_key: `${userId}:${month}`,
      })
    } catch (e) {
      if (e instanceof DuplicateError) throw new ApiError(`Salary for ${month} is already paid`)
      throw e
    }
    if (row.advanceIds.length) await c.db.updateMany('staff_advances', row.advanceIds.map((id) => ({ ROWID: id, salary_payment_id: sp.ROWID })))
    if (net > 0) {
      const exp = await c.db.insert('expenses', {
        business_id: c.businessId, branch_id: branchId, category_id: await expenseCategoryId(c, 'salary'), expense_date: c.now.toISOString(), amount_minor: toMinor(net), method: m,
        notes: `Salary ${month} — ${row.name}`.slice(0, 255), ref_type: E.ExpenseRef.salary, ref_id: sp.ROWID, is_voided: false, created_by: c.actorId,
      })
      sp = await c.db.update('salary_payments', sp.ROWID, { expense_id: exp.ROWID })
    }
    await audit(c, 'user', userId, 'salary', `${month} · ${net}`)
    return salaryFrom(sp, branchId)
  }, perm),
})
