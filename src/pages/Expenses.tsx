import { Plus, Trash2, Wallet } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { Badge, Button, Card, CardHeader, EmptyState, Field, FieldLabel, Input, Modal, PageHeader, Segmented, Select, Table, Td, Th, useAction, useReadOnly } from '@/components/ui'
import { EXPENSE_LABEL, PAYMENT_LABEL } from '@/core/config'
import type { Expense, ExpenseCategory, PaymentMethod } from '@/core/types'
import { api } from '@/data'
import { fmtDate, money, rangeFor, toDateInput, type RangeKey } from '@/lib/format'

const ICON: Record<ExpenseCategory, string> = { purchase: '🛒', salary: '👥', rent: '🏠', electricity: '⚡', transport: '🛺', maintenance: '🔧', other: '📦' }

export default function Expenses() {
  const { t, me } = useApp()
  const readOnly = useReadOnly()
  const run = useAction()
  const [range, setRange] = useState<RangeKey>('month')
  const [cat, setCat] = useState<'all' | ExpenseCategory>('all')
  const [edit, setEdit] = useState<Partial<Expense> | null>(null)
  const r = rangeFor(range)
  const { data: expenses } = useData(() => api.expenses.list(r.from, r.to), [range])
  const { data: users = [] } = useData(() => api.users.list().catch(() => []))
  const active = (expenses ?? []).filter((e) => !e.voided)
  const total = active.reduce((a, e) => a + e.amount, 0)
  const byCat = useMemo(() => {
    const m: Partial<Record<ExpenseCategory, number>> = {}
    active.forEach((e) => { m[e.category] = (m[e.category] ?? 0) + e.amount })
    return (Object.entries(m) as [ExpenseCategory, number][]).sort((a, b) => b[1] - a[1])
  }, [expenses]) // eslint-disable-line react-hooks/exhaustive-deps
  const list = (expenses ?? []).filter((e) => cat === 'all' || e.category === cat)

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title={t('expense', true)} subtitle={`${money(total)} spent`}
        actions={<>
          <Segmented value={range} onChange={setRange} options={[{ value: 'today', label: 'Today' }, { value: 'week', label: 'This Week' }, { value: 'month', label: 'This Month' }]} />
          <Button icon={Plus} onClick={() => setEdit({})}>Add {t('expense')}</Button>
        </>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:order-2">
          <CardHeader title="By category" />
          <ul className="space-y-3 px-5 pb-5 pt-4">
            {byCat.map(([c, v]) => (
              <li key={c}>
                <button className="w-full text-left" onClick={() => setCat(cat === c ? 'all' : c)}>
                  <div className="flex items-center justify-between text-sm"><span className={cat === c ? 'font-semibold text-brand-700' : ''}>{ICON[c]} {EXPENSE_LABEL[c]}</span><span className="font-medium tabular">{money(v)} <span className="text-xs text-slate-400">{total ? Math.round((v / total) * 100) : 0}%</span></span></div>
                  <div className="mt-1.5 h-1.5 rounded-full bg-slate-100"><div className="h-full rounded-full bg-orange-500" style={{ width: `${(v / (byCat[0]?.[1] || 1)) * 100}%` }} /></div>
                </button>
              </li>
            ))}
            {!byCat.length && <li className="py-6 text-center text-sm text-slate-400">No expenses</li>}
          </ul>
        </Card>
        <Card className="lg:col-span-2">
          {cat !== 'all' && <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2 text-sm">Showing {EXPENSE_LABEL[cat]} <button className="text-brand-600" onClick={() => setCat('all')}>Show all</button></div>}
          {expenses && !list.length ? <EmptyState icon={Wallet} title={`No ${t('expense', true).toLowerCase()} recorded`} action={<Button icon={Plus} onClick={() => setEdit({})}>Add {t('expense')}</Button>} /> : (
            <Table>
              <thead><tr><Th>Date</Th>{me?.isAll && <Th>Branch</Th>}<Th>Category</Th><Th className="hidden sm:table-cell">Notes</Th><Th className="hidden md:table-cell">Paid via</Th><Th className="hidden lg:table-cell">By</Th><Th className="text-right">Amount</Th><Th /></tr></thead>
              <tbody>
                {list.map((e) => (
                  <tr key={e.id} className={e.voided ? 'opacity-50' : 'hover:bg-slate-50'}>
                    <Td className="whitespace-nowrap text-slate-500">{fmtDate(e.date)}</Td>
                    {me?.isAll && <Td><Badge>{me.branches.find((b) => b.id === e.branchId)?.name ?? '—'}</Badge></Td>}
                    <Td className="whitespace-nowrap">{ICON[e.category]} {EXPENSE_LABEL[e.category]}</Td>
                    <Td className="hidden max-w-[260px] truncate text-slate-600 sm:table-cell">{e.notes}</Td>
                    <Td className="hidden md:table-cell"><Badge>{PAYMENT_LABEL[e.method]}</Badge></Td>
                    <Td className="hidden text-slate-500 lg:table-cell">{users.find((u) => u.id === e.createdBy)?.name ?? '—'}</Td>
                    <Td className={`text-right font-semibold tabular ${e.voided ? 'line-through' : ''}`}>{money(e.amount)}</Td>
                    <Td className="text-right">{!e.voided ? <button disabled={!!readOnly} aria-label="Void" title={readOnly ?? 'Void (kept for audit)'} onClick={() => run(() => api.expenses.void(e.id), 'Expense voided')} className="text-slate-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button> : <Badge tone="red">Void</Badge>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
      {edit && <ExpenseForm onClose={() => setEdit(null)} />}
    </div>
  )
}

function ExpenseForm({ onClose }: { onClose: () => void }) {
  const { t, me } = useApp()
  const run = useAction()
  const [e, setE] = useState({ amount: '', category: 'purchase' as ExpenseCategory, method: 'cash' as PaymentMethod, notes: '', date: toDateInput(new Date()), branchId: me?.isAll ? (me.branches.find((b) => b.id === me.user.branchId) ?? me.branches[0])?.id ?? '' : '' })
  return (
    <Modal open onClose={onClose} size="sm" title={`Add ${t('expense').toLowerCase()}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={async () => {
        const d = new Date(e.date); const now = new Date(); d.setHours(now.getHours(), now.getMinutes())
        if (await run(() => api.expenses.save({ amount: Number(e.amount), category: e.category, method: e.method, notes: e.notes, date: d.toISOString(), ...(e.branchId ? { branchId: e.branchId } : {}) }), `${t('expense')} added`)) onClose()
      }}>Save</Button></>}>
      <div className="space-y-4">
        <Field required label="Amount (₹)"><Input autoFocus type="number" inputMode="decimal" value={e.amount} onChange={(x) => setE({ ...e, amount: x.target.value })} className="h-12 text-lg font-semibold" /></Field>
        <FieldLabel required>Category</FieldLabel>
        <div className="-mt-3 grid grid-cols-4 gap-2">
          {(Object.keys(EXPENSE_LABEL) as ExpenseCategory[]).map((c) => (
            <button key={c} type="button" onClick={() => setE({ ...e, category: c })} className={`rounded-lg border-2 px-1 py-2 text-center text-[11px] font-medium ${e.category === c ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600'}`}>
              <span className="block text-lg">{ICON[c]}</span>{EXPENSE_LABEL[c]}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field required label="Date"><Input type="date" value={e.date} max={toDateInput(new Date())} onChange={(x) => setE({ ...e, date: x.target.value })} /></Field>
          <Field required label="Paid via"><Select value={e.method} onChange={(x) => setE({ ...e, method: x.target.value as PaymentMethod })}>{me!.business.billing.paymentMethods.filter((m) => m !== 'credit' && m !== 'bank').map((m) => <option key={m} value={m}>{PAYMENT_LABEL[m]}</option>)}<option value="bank">Bank Transfer</option></Select></Field>
        </div>
        <Field label="Notes"><Input value={e.notes} onChange={(x) => setE({ ...e, notes: x.target.value })} placeholder="e.g. Vegetables from market" /></Field>
        {me?.isAll && (
          <Field label="Branch"><Select value={e.branchId} onChange={(x) => setE({ ...e, branchId: x.target.value })}>{me.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        )}
      </div>
    </Modal>
  )
}
