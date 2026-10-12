import { AlertTriangle, CalendarClock, ArrowDownRight, ArrowUpRight, ChefHat, Clock, IndianRupee, ReceiptText, Sparkles, TrendingUp, Wallet, WalletCards } from 'lucide-react'
import { Thumb } from '@/components/Thumb'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import clsx from 'clsx'
import { useMemo, useState } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { Badge, Card, CardHeader, PageHeader, Segmented, Skeleton, Stat } from '@/components/ui'
import { ORDER_TYPE_LABEL, PAYMENT_LABEL } from '@/core/config'
import type { PaymentMethod } from '@/core/types'
import { api } from '@/data'
import { addDays, money, num, pctChange, rangeFor, timeAgo, type RangeKey } from '@/lib/format'
import { AXIS, METHOD_COLOR, SERIES } from '@/lib/chart'
import { BranchOverview } from '@/features/BranchOverview'

function previousRange(key: RangeKey) {
  const cur = rangeFor(key)
  if (key === 'today') {
    // Compare with yesterday up to the same time of day — a fair "vs yesterday".
    return { from: addDays(cur.from, -1), to: addDays(new Date(), -1) }
  }
  const len = cur.to.getTime() - cur.from.getTime()
  return { from: new Date(cur.from.getTime() - len - 1), to: new Date(cur.from.getTime() - 1) }
}

function Delta({ cur, prev, label, invert }: { cur: number; prev: number; label: string; invert?: boolean }) {
  const d = pctChange(cur, prev)
  const good = invert ? d <= 0 : d >= 0
  const Icon = d >= 0 ? ArrowUpRight : ArrowDownRight
  return (
    <span className={clsx('inline-flex flex-wrap items-center gap-x-0.5 font-medium', good ? 'text-emerald-600' : 'text-red-600')}>
      <span className="inline-flex items-center whitespace-nowrap"><Icon className="h-3.5 w-3.5" />{Math.abs(d).toFixed(0)}%</span> <span className="ml-0.5 font-normal text-slate-400">{label}</span>
    </span>
  )
}

export default function Dashboard() {
  const { me, can, mod, t } = useApp()
  const [range, setRange] = useState<RangeKey>('today')
  // Stable per range so child queries don't refetch on every render.
  const cur = useMemo(() => rangeFor(range), [range])
  const prev = useMemo(() => previousRange(range), [range])
  const { data: s } = useData(() => api.reports.summary(cur.from, cur.to), [range])
  const { data: p } = useData(() => api.reports.summary(prev.from, prev.to), [range])
  const { data: y } = useData(() => (range === 'today' ? api.reports.summary(rangeFor('yesterday').from, rangeFor('yesterday').to) : Promise.resolve(null)), [range])
  const { data: running = [] } = useData(() => api.orders.running())
  const { data: kots = [] } = useData(() => (mod('kitchen') ? api.kitchen.list() : Promise.resolve([])))
  const { data: products = [] } = useData(() => api.products.list())
  const { data: recent = [] } = useData(() => api.orders.list({ status: 'completed' }).then((o) => o.slice(0, 6)))
  const vsLabel = range === 'today' ? 'vs yesterday' : range === 'yesterday' ? 'vs day before' : 'vs last period'
  const low = mod('inventory') ? products.filter((x) => x.active && x.trackStock && x.stock <= x.lowStockAt) : []
  const { data: batches = [] } = useData(() => (mod('inventory') ? api.inventory.batches() : Promise.resolve([])))
  const expiring = batches.filter((b) => b.daysLeft !== null && b.daysLeft <= 7)
  const showProfit = can('reports.profit')

  const hourly = s?.series.map((r, i) => ({ ...r, prev: y?.series[i]?.sales ?? 0 })) ?? []
  const methods = s ? (Object.entries(s.salesByMethod) as [PaymentMethod, number][]).filter(([, v]) => v > 0) : []
  const top = s?.topProducts[0]

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Dashboard"
        subtitle={<>{me?.business.name}{me?.isAll ? ' (all branches)' : me && me.branches.length > 1 ? ` · ${me.branch.name}` : ''} — <span>{range === 'today' ? 'Here’s how today is going' : range === 'yesterday' ? 'Here’s how yesterday went' : range === 'week' ? 'Here’s how this week is going' : 'Here’s how this month is going'}</span></>}
        actions={<Segmented value={range} onChange={setRange} options={[{ value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: 'week', label: 'This Week' }, { value: 'month', label: 'This Month' }]} />}
      />

      {s && p && top && (
        <div className="mb-5 flex items-start gap-3 rounded-xl border border-brand-100 bg-gradient-to-r from-brand-50 to-white px-4 py-3">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
          <p className="text-sm text-slate-700">
            Sales are <b>{money(s.sales)}</b>, {pctChange(s.sales, p.sales) >= 0 ? 'up' : 'down'} <b>{Math.abs(pctChange(s.sales, p.sales)).toFixed(0)}%</b> {vsLabel}.
            {' '}<b>{top.name}</b> is your best seller ({num(top.qty)} sold).
            {low.length > 0 && <> {low.length} item{low.length > 1 ? 's are' : ' is'} running low on stock.</>}
          </p>
        </div>
      )}

      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
        {!s || !p ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[96px]" />) : <>
          <Stat icon={IndianRupee} tone="green" label="Total Sales" value={money(s.sales)} sub={<Delta cur={s.sales} prev={p.sales} label={vsLabel} />} />
          <Stat icon={ReceiptText} tone="blue" label={`Total ${t('order', true)}`} value={num(s.orderCount)} sub={<Delta cur={s.orderCount} prev={p.orderCount} label={vsLabel} />} />
          <Stat icon={WalletCards} tone="violet" label="Payments Received" value={money(s.paymentsReceived)} sub={<Delta cur={s.paymentsReceived} prev={p.paymentsReceived} label={vsLabel} />} />
          {mod('expenses') && <Stat icon={Wallet} tone="orange" label={t('expense', true)} value={money(s.expenses + s.salary)} sub={<Delta cur={s.expenses + s.salary} prev={p.expenses + p.salary} label={vsLabel} invert />} />}
          <Stat icon={Clock} tone="amber" label="Outstanding" value={money(s.outstanding)} sub={<span className="text-slate-400">credit given</span>} />
          {showProfit && <Stat icon={TrendingUp} tone="green" label="Net Income" value={money(s.net)} sub={<span className="text-slate-400">sales − {t('expense', true).toLowerCase()}</span>} />}
        </>}
      </div>

      {me?.isAll && me.branches.length > 1 && (
        <BranchOverview from={cur.from} to={cur.to} prevFrom={prev.from} prevTo={prev.to} hourly={range === 'today' || range === 'yesterday'} />
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {/* Sales overview */}
        <Card className="lg:col-span-2">
          <CardHeader title="Sales Overview" subtitle={range === 'today' ? 'Sales by hour' : 'Sales by day'}
            action={range === 'today' && (
              <div className="flex items-center gap-3 text-xs text-slate-500">
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: SERIES.current }} />Today</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: SERIES.previous }} />Yesterday</span>
              </div>
            )} />
          <div className="h-64 px-2 pb-3 pt-4">
            {s ? (
              <ResponsiveContainer>
                <BarChart data={range === 'today' ? hourly : s.series} barGap={2} margin={{ left: 0, right: 8 }}>
                  <CartesianGrid vertical={false} stroke={AXIS.grid} />
                  <XAxis dataKey="label" tick={AXIS.tick} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={8} />
                  <YAxis tick={AXIS.tick} axisLine={false} tickLine={false} width={48} tickFormatter={(v) => (v >= 1000 ? `${v / 1000}k` : v)} />
                  <Tooltip cursor={{ fill: '#f1f5f9' }} formatter={(v, n) => [money(Number(v)), n === 'prev' ? 'Yesterday' : 'Sales']} contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12 }} />
                  {range === 'today' && <Bar dataKey="prev" fill={SERIES.previous} radius={[4, 4, 0, 0]} maxBarSize={14} />}
                  <Bar dataKey="sales" fill={SERIES.current} radius={[4, 4, 0, 0]} maxBarSize={range === 'today' ? 14 : 22} />
                </BarChart>
              </ResponsiveContainer>
            ) : <Skeleton className="h-full" />}
          </div>
        </Card>

        {/* Payment split */}
        <Card>
          <CardHeader title="Sales by Payment Method" />
          {s && (
            <div className="flex items-center gap-4 px-5 pb-5 pt-2">
              <div className="relative h-40 w-40 shrink-0">
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={methods.map(([m, v]) => ({ name: PAYMENT_LABEL[m], value: v, m }))} dataKey="value" innerRadius={52} outerRadius={72} paddingAngle={2} stroke="#fff" strokeWidth={2}>
                      {methods.map(([m]) => <Cell key={m} fill={METHOD_COLOR[m]} />)}
                    </Pie>
                    <Tooltip formatter={(v) => money(Number(v))} contentStyle={{ borderRadius: 10, fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-base font-bold">{money(s.sales)}</span>
                  <span className="text-[10px] text-slate-500">Total Sales</span>
                </div>
              </div>
              <ul className="flex-1 space-y-2.5">
                {methods.map(([m, v]) => (
                  <li key={m} className="flex items-center gap-2 text-sm">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: METHOD_COLOR[m] }} />
                    <span className="flex-1 text-slate-600">{PAYMENT_LABEL[m]}</span>
                    <span className="font-medium tabular">{s.sales ? Math.round((v / s.sales) * 100) : 0}%</span>
                  </li>
                ))}
                {!methods.length && <li className="text-sm text-slate-400">No sales yet</li>}
              </ul>
            </div>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {/* Top items */}
        <Card>
          <CardHeader title={`Top ${t('product', true)}`} action={mod('reports') && <Link to="/reports" className="text-xs font-medium text-brand-600 hover:underline">View report</Link>} />
          <ul className="px-5 pb-4 pt-3">
            {s?.topProducts.slice(0, 5).map((x, i) => {
              const max = s.topProducts[0].revenue || 1
              return (
                <li key={x.productId} className="py-2">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="w-4 text-xs text-slate-400">{i + 1}</span>
                    <Thumb item={x} className="h-7 w-7 rounded-md text-lg" />
                    <span className="flex-1 truncate font-medium">{x.name}</span>
                    <span className="text-xs text-slate-500">{num(x.qty)} sold</span>
                    <span className="w-20 text-right font-semibold tabular">{money(x.revenue)}</span>
                  </div>
                  <div className="ml-6 mt-1.5 h-1.5 rounded-full bg-slate-100"><div className="h-full rounded-full bg-brand-500" style={{ width: `${(x.revenue / max) * 100}%` }} /></div>
                </li>
              )
            })}
            {s && !s.topProducts.length && <li className="py-6 text-center text-sm text-slate-400">No sales in this period</li>}
          </ul>
        </Card>

        {/* Live operations */}
        <Card>
          <CardHeader title="Live right now" subtitle={`${running.length} running ${t('order', true).toLowerCase()}`} action={mod('tables') && <Link to="/tables" className="text-xs font-medium text-brand-600 hover:underline">{t('table', true)}</Link>} />
          <div className="grid grid-cols-3 gap-2 px-5 pt-3">
            {(['new', 'preparing', 'ready'] as const).map((st) => (
              <Link to="/kitchen" key={st} className="rounded-lg border border-slate-100 bg-slate-50 p-2.5 text-center hover:border-slate-200">
                <p className="text-lg font-bold">{kots.filter((k) => k.status === st).length}</p>
                <p className="text-[11px] capitalize text-slate-500">{st}</p>
              </Link>
            ))}
          </div>
          <ul className="divide-y divide-slate-100 px-5 pb-3 pt-2">
            {running.slice(0, 4).map((o) => (
              <li key={o.id} className="flex items-center gap-2 py-2 text-sm">
                <ChefHat className="h-4 w-4 text-slate-400" />
                <span className="font-medium">{o.number}</span>
                <Badge tone={o.type === 'dine_in' ? 'violet' : 'blue'}>{ORDER_TYPE_LABEL[o.type]}</Badge>
                <span className="flex-1 text-right text-xs text-slate-400">{timeAgo(o.createdAt)}</span>
                <span className="w-16 text-right font-semibold tabular">{money(o.total)}</span>
              </li>
            ))}
          </ul>
        </Card>

        {/* Alerts + recent */}
        <Card>
          {low.length > 0 && (
            <>
              <CardHeader title={<span className="flex items-center gap-1.5"><AlertTriangle className="h-4 w-4 text-amber-500" />Low stock</span>} action={<Link to="/inventory" className="text-xs font-medium text-brand-600 hover:underline">Inventory</Link>} />
              <ul className="px-5 pb-2 pt-2">
                {low.slice(0, 3).map((x) => (
                  <li key={x.id} className="flex items-center gap-2 py-1.5 text-sm">
                    <Thumb item={x} className="h-6 w-6 rounded text-base" /><span className="flex-1 truncate">{x.name}</span>
                    <Badge tone={x.stock <= 0 ? 'red' : 'amber'}>{x.stock <= 0 ? 'Out of stock' : `${x.stock} ${x.unit} left`}</Badge>
                  </li>
                ))}
              </ul>
            </>
          )}
          {expiring.length > 0 && (
            <>
              <CardHeader className={low.length ? 'border-t border-slate-100 pt-3' : ''} title={<span className="flex items-center gap-1.5"><CalendarClock className="h-4 w-4 text-orange-500" />Expiring soon</span>} action={<Link to="/inventory" className="text-xs font-medium text-brand-600 hover:underline">Expiry</Link>} />
              <ul className="px-5 pb-2 pt-2">
                {expiring.slice(0, 3).map((b) => (
                  <li key={b.id} className="flex items-center gap-2 py-1.5 text-sm">
                    {b.product && <Thumb item={b.product} className="h-6 w-6 rounded text-base" />}<span className="flex-1 truncate">{b.product?.name}</span>
                    <Badge tone={(b.daysLeft ?? 0) < 0 ? 'red' : 'orange'}>{(b.daysLeft ?? 0) < 0 ? 'Expired' : b.daysLeft === 0 ? 'Today' : `${b.daysLeft}d`} · {b.qty} {b.product?.unit}</Badge>
                  </li>
                ))}
              </ul>
            </>
          )}
          <CardHeader title={`Recent ${t('invoice', true)}`} action={mod('orders') && <Link to="/orders" className="text-xs font-medium text-brand-600 hover:underline">View all</Link>} className={low.length || expiring.length ? 'border-t border-slate-100 pt-3' : ''} />
          <ul className="px-5 pb-3 pt-1">
            {recent.map((o) => (
              <li key={o.id} className="flex items-center gap-2 py-1.5 text-sm">
                <span className="font-medium text-slate-700">{o.invoiceNumber}</span>
                <span className="flex-1 truncate text-xs text-slate-400">{timeAgo(o.billedAt!)}</span>
                {o.balance > 0 && <Badge tone="amber">Credit</Badge>}
                <span className="font-semibold tabular">{money(o.total)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
