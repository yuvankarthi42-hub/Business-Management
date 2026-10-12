import clsx from 'clsx'
import { BarChart3 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useData } from '@/app/AppContext'
import { Card, Chips, EmptyState, Table, Td, Th } from '@/components/ui'
import { AXIS, SERIES } from '@/lib/chart'
import { api } from '@/data'
import { fmtDate, fmtDateTime, rupees, StateBadge } from './shared'

type Sort = 'lastBill' | 'bills30' | 'lastLogin' | 'name'
const DAY = 86_400_000
const ago = (iso: string | null) => {
  if (!iso) return 'Never'
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / DAY)
  return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : `${d} days ago`
}

/** Who is really using BillPoodum, and the subscription money coming in. */
export default function AdminReports() {
  const { data, error } = useData(() => api.admin.usage())
  const [sort, setSort] = useState<Sort>('lastBill')
  const rows = useMemo(() => {
    const r = [...(data?.rows ?? [])]
    const t = (s: string | null) => (s ? new Date(s).getTime() : 0)
    if (sort === 'name') r.sort((a, b) => a.name.localeCompare(b.name))
    if (sort === 'bills30') r.sort((a, b) => b.bills30 - a.bills30)
    if (sort === 'lastBill') r.sort((a, b) => t(b.lastBillAt) - t(a.lastBillAt))
    if (sort === 'lastLogin') r.sort((a, b) => t(b.lastLoginAt) - t(a.lastLoginAt))
    return r
  }, [data, sort])
  if (error) return <EmptyState icon={BarChart3} title="Your role can’t see reports" />
  if (!data) return null
  const s = data.summary
  return (
    <div>
      <h1 className="text-xl font-semibold">Usage</h1>
      <p className="mb-5 text-sm text-slate-500">Which customers are billing, when they last signed in, and subscription revenue.</p>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Billing in last 7 days" value={`${s.billing7} of ${s.customers}`} hint="made at least one bill" />
        <Stat label="Inactive 14+ days" value={s.inactive14} hint="no bill in 2 weeks" tone={s.inactive14 ? 'text-amber-700' : undefined} />
        <Stat label="Signed in last 7 days" value={s.logins7} hint="customers" />
        <Stat label="Monthly value" value={rupees(s.mrr)} hint="active plans × price" />
        <Stat label="Revenue this month" value={rupees(s.thisMonth)} hint="subscriptions recorded" />
        <Stat label="Last 12 months" value={rupees(s.last12)} hint="subscriptions recorded" />
      </div>

      <Card className="mb-5 p-5">
        <h2 className="font-semibold">Subscription revenue by month</h2>
        <p className="mb-3 text-xs text-slate-500">New accounts, renewals and extensions, by the month they were recorded</p>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.months} margin={{ right: 8, left: 0 }}>
              <CartesianGrid vertical={false} stroke={AXIS.grid} />
              <XAxis dataKey="label" tick={AXIS.tick} axisLine={false} tickLine={false} minTickGap={4} />
              <YAxis tick={AXIS.tick} axisLine={false} tickLine={false} width={52} tickFormatter={(v) => (v >= 1000 ? `₹${Math.round(v / 100) / 10}k` : `₹${v}`)} />
              <Tooltip cursor={{ fill: '#f1f5f9' }} formatter={(v, _n, item) => [rupees(Number(v)), `Revenue · ${(item?.payload as { customers: number }).customers} new customer(s)`]} contentStyle={{ borderRadius: 10, fontSize: 12 }} />
              <Bar dataKey="amount" fill={SERIES.current} radius={[4, 4, 0, 0]} maxBarSize={32} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-xs text-slate-500">Show as table</summary>
          <table className="mt-2 w-full max-w-md text-sm tabular">
            <tbody className="divide-y divide-slate-100">{data.months.map((m) => <tr key={m.key}><td className="py-1">{m.label}</td><td className="py-1 text-right">{rupees(m.amount)}</td><td className="py-1 text-right text-slate-500">{m.customers} new</td></tr>)}</tbody>
          </table>
        </details>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-3">
          <h2 className="px-1 font-semibold">Customer activity</h2>
          <Chips value={sort} onChange={setSort} options={[{ value: 'lastBill', label: 'Last bill' }, { value: 'bills30', label: 'Most bills' }, { value: 'lastLogin', label: 'Last login' }, { value: 'name', label: 'Name' }]} />
        </div>
        <Table>
          <thead><tr><Th>Customer</Th><Th>Status</Th><Th className="text-right">Bills 7 days</Th><Th className="text-right">Bills 30 days</Th><Th className="text-right">Sales 30 days</Th><Th>Last bill</Th><Th>Last login</Th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const idle = !r.lastBillAt || Date.now() - new Date(r.lastBillAt).getTime() > 14 * DAY
              return (
                <tr key={r.id} className="hover:bg-slate-50">
                  <Td><Link to={`/admin/customers/${r.id}`} className="font-medium text-slate-900 hover:text-brand-700 hover:underline">{r.name}</Link><p className="text-xs text-slate-500">{r.subType} · {r.branches} branch{r.branches === 1 ? '' : 'es'}</p></Td>
                  <Td><StateBadge state={r.state} /></Td>
                  <Td className="text-right tabular">{r.bills7}</Td>
                  <Td className="text-right tabular">{r.bills30}</Td>
                  <Td className="text-right tabular">{rupees(r.sales30)}</Td>
                  <Td className={clsx('text-sm', idle ? 'font-medium text-amber-700' : 'text-slate-600')} title={r.lastBillAt ? fmtDateTime(r.lastBillAt) : undefined}>{ago(r.lastBillAt)}{r.lastBillAt && <span className="block text-xs font-normal text-slate-400">{fmtDate(r.lastBillAt)}</span>}</Td>
                  <Td className="text-sm text-slate-600" title={r.lastLoginAt ? fmtDateTime(r.lastLoginAt) : undefined}>{ago(r.lastLoginAt)}</Td>
                </tr>
              )
            })}
          </tbody>
        </Table>
      </Card>
    </div>
  )
}

function Stat({ label, value, hint, tone }: { label: string; value: number | string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-card">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={clsx('mt-1 text-2xl font-semibold tabular', tone ?? 'text-slate-900')}>{value}</p>
      {hint && <p className="text-[11px] text-slate-400">{hint}</p>}
    </div>
  )
}
