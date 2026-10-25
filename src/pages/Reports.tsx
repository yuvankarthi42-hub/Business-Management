import { Download, Printer } from 'lucide-react'
import clsx from 'clsx'
import { Thumb } from '@/components/Thumb'
import { useState } from 'react'
import { GstReportView } from '@/features/gst/GstReport'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useApp, useData } from '@/app/AppContext'
import { Badge, Button, Card, CardHeader, Input, PageHeader, Segmented, Skeleton, Table, Td, Th } from '@/components/ui'
import { EXPENSE_LABEL, ORDER_TYPE_LABEL, PAYMENT_LABEL } from '@/core/config'
import type { ExpenseCategory, OrderType, PaymentMethod } from '@/core/types'
import { api, type Summary } from '@/data'
import { addDays, fmtDate, money, num, rangeFor, toDateInput, type RangeKey } from '@/lib/format'
import { AXIS, METHOD_COLOR, SERIES } from '@/lib/chart'
import { formatPhone } from '@/core/phone'

type Tab = 'income' | 'sales' | 'products' | 'customers' | 'inventory' | 'gst'

function downloadCsv(name: string, rows: (string | number)[][]) {
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  a.download = `${name}.csv`
  a.click()
}

export default function Reports() {
  const { t, mod, can, me } = useApp()
  const [range, setRange] = useState<RangeKey>('today')
  const [custom, setCustom] = useState({ from: toDateInput(addDays(new Date(), -6)), to: toDateInput(new Date()) })
  const [tab, setTab] = useState<Tab>('income')
  const r = rangeFor(range, custom)
  const { data: s } = useData(() => api.reports.summary(r.from, r.to), [range, custom.from, custom.to])
  const tabs: { value: Tab; label: string }[] = [
    { value: 'income', label: 'Daily Income' },
    { value: 'sales', label: 'Sales' },
    { value: 'products', label: t('product', true) },
    ...(mod('customers') ? [{ value: 'customers' as Tab, label: t('customer', true) }] : []),
    ...(mod('inventory') ? [{ value: 'inventory' as Tab, label: 'Inventory' }] : []),
    ...(me?.business.billing.taxEnabled ? [{ value: 'gst' as Tab, label: 'GST returns' }] : []),
  ]
  const period = range === 'custom' ? `${fmtDate(r.from)} – ${fmtDate(r.to)}` : range === 'today' || range === 'yesterday' ? fmtDate(r.from) : `${fmtDate(r.from)} – ${fmtDate(r.to)}`

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Reports" subtitle={period} actions={<Button variant="secondary" icon={Printer} onClick={() => window.print()} className="hidden sm:inline-flex">Print</Button>} />
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Segmented value={tab} onChange={setTab} options={tabs} />
        <div className={clsx('flex flex-wrap items-center gap-2', tab === 'gst' && 'hidden')}>
          <Segmented size="sm" value={range} onChange={setRange} options={[{ value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: 'week', label: 'This Week' }, { value: 'month', label: 'This Month' }, { value: 'custom', label: 'Custom' }]} />
          {range === 'custom' && (
            <div className="flex items-center gap-1.5">
              <Input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className="h-8 w-36 text-xs" />
              <span className="text-slate-400">–</span>
              <Input type="date" value={custom.to} min={custom.from} max={toDateInput(new Date())} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className="h-8 w-36 text-xs" />
            </div>
          )}
        </div>
      </div>
      {tab === 'gst' ? <GstReportView /> : !s ? <Skeleton className="h-96" /> : (
        <>
          {tab === 'income' && <Income s={s} showNet={can('reports.profit')} showExp={mod('expenses')} />}
          {tab === 'sales' && <Sales s={s} />}
          {tab === 'products' && <ProductsReport s={s} showProfit={can('reports.profit')} />}
          {tab === 'customers' && <CustomersReport />}
          {tab === 'inventory' && <InventoryReport />}
        </>
      )}
    </div>
  )
}

function Income({ s, showNet, showExp }: { s: Summary; showNet: boolean; showExp: boolean }) {
  const { t } = useApp()
  const methods: PaymentMethod[] = ['cash', 'upi', 'card', 'bank', 'credit']
  const cats = Object.entries(s.expensesByCategory).sort((a, b) => b[1] - a[1]) as [ExpenseCategory, number][]
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Sales breakdown" subtitle={`${num(s.orderCount)} ${t('invoice', true).toLowerCase()}`} />
          <ul className="space-y-3 px-5 pb-5 pt-4">
            {methods.map((m) => (
              <li key={m} className="flex items-center gap-3 text-sm">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: METHOD_COLOR[m] }} />
                <span className="flex-1 text-slate-600">{PAYMENT_LABEL[m]}</span>
                <span className="w-12 text-right text-xs text-slate-400">{s.sales ? Math.round((s.salesByMethod[m] / s.sales) * 100) : 0}%</span>
                <span className="w-24 text-right font-semibold tabular">{money(s.salesByMethod[m])}</span>
              </li>
            ))}
          </ul>
        </Card>
        {showExp && (
          <Card>
            <CardHeader title={`${t('expense')} breakdown`} />
            <ul className="space-y-3 px-5 pb-5 pt-4">
              {cats.map(([c, v]) => (
                <li key={c} className="flex items-center gap-3 text-sm">
                  <span className="h-2.5 w-2.5 rounded-full bg-orange-500" />
                  <span className="flex-1 text-slate-600">{EXPENSE_LABEL[c]}</span>
                  <span className="w-12 text-right text-xs text-slate-400">{s.expenses ? Math.round((v / s.expenses) * 100) : 0}%</span>
                  <span className="w-24 text-right font-semibold tabular">{money(v)}</span>
                </li>
              ))}
              {!cats.length && <li className="py-4 text-center text-sm text-slate-400">No expenses in this period</li>}
            </ul>
          </Card>
        )}
      </div>
      <div className={clsx('grid gap-3', showExp ? 'sm:grid-cols-4' : 'sm:grid-cols-3')}>
        <SummaryBox label="Total Sales" value={s.sales} />
        {showExp && <SummaryBox label={`Total ${t('expense', true)}`} value={-s.expenses} />}
        {showExp && <SummaryBox label="Staff salary" value={-s.salary} />}
        {showNet && <SummaryBox label="Net Income" value={s.net} highlight />}
      </div>
      <div className="grid gap-3 sm:grid-cols-5">
        <SummaryBox small label={`Returns (${s.returnCount})`} value={-s.returns} />
        <SummaryBox small label="Payments received" value={s.paymentsReceived} />
        <SummaryBox small label="Credit given (unpaid)" value={s.outstanding} />
        <SummaryBox small label="Tax collected" value={s.tax} />
        <SummaryBox small label="Discounts given" value={s.discount} />
      </div>
    </div>
  )
}

function SummaryBox({ label, value, highlight, small }: { label: string; value: number; highlight?: boolean; small?: boolean }) {
  const tone = highlight ? (value < 0 ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700') : ''
  return (
    <Card className={`p-4 ${tone}`}>
      <p className={`text-xs font-medium ${highlight ? '' : 'text-slate-500'}`}>{label}</p>
      <p className={`mt-1 font-semibold tabular ${small ? 'text-lg' : 'text-2xl'} ${highlight ? '' : 'text-slate-900'}`}>{value < 0 ? `− ${money(-value)}` : money(value)}</p>
    </Card>
  )
}

function Sales({ s }: { s: Summary }) {
  const { t } = useApp()
  const single = s.series.length && s.series[0].key.length <= 2
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={single ? 'Sales by hour' : 'Sales by day'} subtitle={`${money(s.sales)} · ${num(s.orderCount)} ${t('invoice', true).toLowerCase()} · avg ${money(s.avgOrder)}`}
          action={<Button size="sm" variant="ghost" icon={Download} onClick={() => downloadCsv('sales', [['Period', 'Sales', 'Bills', 'Expenses'], ...s.series.map((r) => [r.label, r.sales, r.orders, r.expenses])])}>CSV</Button>} />
        <div className="h-72 px-2 pb-3 pt-4">
          <ResponsiveContainer>
            <BarChart data={s.series} margin={{ right: 8 }}>
              <CartesianGrid vertical={false} stroke={AXIS.grid} />
              <XAxis dataKey="label" tick={AXIS.tick} axisLine={false} tickLine={false} minTickGap={8} />
              <YAxis tick={AXIS.tick} axisLine={false} tickLine={false} width={48} tickFormatter={(v) => (v >= 1000 ? `${v / 1000}k` : v)} />
              <Tooltip cursor={{ fill: '#f1f5f9' }} formatter={(v) => [money(Number(v)), 'Sales']} contentStyle={{ borderRadius: 10, fontSize: 12 }} />
              <Bar dataKey="sales" fill={SERIES.current} radius={[4, 4, 0, 0]} maxBarSize={24} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title={`By ${t('order').toLowerCase()} type`} />
          <Table className="mt-2">
            <thead><tr><Th>Type</Th><Th className="text-right">{t('invoice', true)}</Th><Th className="text-right">Amount</Th></tr></thead>
            <tbody>{(Object.entries(s.byType) as [OrderType, { count: number; amount: number }][]).map(([k, v]) => <tr key={k}><Td>{ORDER_TYPE_LABEL[k]}</Td><Td className="text-right tabular">{v.count}</Td><Td className="text-right font-medium tabular">{money(v.amount)}</Td></tr>)}</tbody>
          </Table>
        </Card>
        <Card className="p-5">
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div><dt className="text-slate-500">Average {t('invoice').toLowerCase()}</dt><dd className="mt-1 text-lg font-semibold">{money(s.avgOrder)}</dd></div>
            <div><dt className="text-slate-500">Cancelled</dt><dd className="mt-1 text-lg font-semibold">{s.cancelled}</dd></div>
            <div><dt className="text-slate-500">Tax collected</dt><dd className="mt-1 text-lg font-semibold">{money(s.tax)}</dd></div>
            <div><dt className="text-slate-500">Discounts</dt><dd className="mt-1 text-lg font-semibold">{money(s.discount)}</dd></div>
          </dl>
        </Card>
      </div>
    </div>
  )
}

function ProductsReport({ s, showProfit }: { s: Summary; showProfit: boolean }) {
  const { t } = useApp()
  const { data: products = [] } = useData(() => api.products.list())
  const rows = s.topProducts.map((x) => {
    const cost = (products.find((p) => p.id === x.productId)?.costPrice ?? 0) * x.qty
    return { ...x, profit: x.revenue - cost }
  })
  return (
    <Card>
      <CardHeader title={`Top-selling ${t('product', true).toLowerCase()}`} subtitle="Revenue before discount & tax"
        action={<Button size="sm" variant="ghost" icon={Download} onClick={() => downloadCsv('products', [['Item', 'Qty', 'Revenue', ...(showProfit ? ['Gross profit'] : [])], ...rows.map((r) => [r.name, r.qty, r.revenue, ...(showProfit ? [r.profit] : [])])])}>CSV</Button>} />
      <Table className="mt-2">
        <thead><tr><Th>#</Th><Th>{t('product')}</Th><Th className="text-right">Qty sold</Th><Th className="text-right">Revenue</Th>{showProfit && <Th className="hidden text-right sm:table-cell">Gross profit</Th>}<Th className="hidden w-48 md:table-cell">Share</Th></tr></thead>
        <tbody>
          {rows.map((x, i) => (
            <tr key={x.productId}>
              <Td className="text-slate-400">{i + 1}</Td>
              <Td className="font-medium"><span className="flex items-center gap-2"><Thumb item={x} className="h-7 w-7 rounded-md text-base" />{x.name}</span></Td>
              <Td className="text-right tabular">{num(x.qty)}</Td>
              <Td className="text-right font-semibold tabular">{money(x.revenue)}</Td>
              {showProfit && <Td className="hidden text-right tabular text-emerald-700 sm:table-cell">{money(x.profit)}</Td>}
              <Td className="hidden md:table-cell"><div className="h-1.5 rounded-full bg-slate-100"><div className="h-full rounded-full bg-brand-500" style={{ width: `${(x.revenue / (rows[0]?.revenue || 1)) * 100}%` }} /></div></Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  )
}

function CustomersReport() {
  const { t } = useApp()
  const { data: rows = [] } = useData(() => api.reports.receivables())
  const { data: all = [] } = useData(() => api.customers.list())
  const top = [...all].sort((a, b) => b.stats.totalPurchases - a.stats.totalPurchases).slice(0, 10)
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Outstanding balances" subtitle={`${money(rows.reduce((a, r) => a + r.outstanding, 0))} to collect`} />
        <Table className="mt-2">
          <thead><tr><Th>{t('customer')}</Th><Th>Phone</Th><Th className="text-right">Outstanding</Th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.customer.id}><Td className="font-medium">{r.customer.name}</Td><Td className="whitespace-nowrap text-slate-500">{formatPhone(r.customer.phone)}</Td><Td className="text-right font-semibold text-amber-700 tabular">{money(r.outstanding)}</Td></tr>)}</tbody>
        </Table>
      </Card>
      <Card>
        <CardHeader title={`Top ${t('customer', true).toLowerCase()}`} subtitle="All-time purchases" />
        <Table className="mt-2">
          <thead><tr><Th>{t('customer')}</Th><Th className="text-right">{t('order', true)}</Th><Th className="text-right">Purchases</Th></tr></thead>
          <tbody>{top.map((c) => <tr key={c.id}><Td className="font-medium">{c.name}</Td><Td className="text-right tabular">{c.stats.orderCount}</Td><Td className="text-right font-semibold tabular">{money(c.stats.totalPurchases)}</Td></tr>)}</tbody>
        </Table>
      </Card>
    </div>
  )
}

function InventoryReport() {
  const { data: products = [] } = useData(() => api.products.list())
  const { data: moves = [] } = useData(() => api.inventory.movements())
  const tracked = products.filter((p) => p.trackStock)
  return (
    <Card>
      <CardHeader title="Current stock & movement" subtitle="Last 7 days movement" />
      <Table className="mt-2">
        <thead><tr><Th>Item</Th><Th className="text-right">In stock</Th><Th className="text-right">Purchased</Th><Th className="text-right">Sold</Th><Th className="text-right">Wasted / damaged</Th><Th>Status</Th></tr></thead>
        <tbody>
          {tracked.map((p) => {
            const since = addDays(new Date(), -7).toISOString()
            const m = moves.filter((x) => x.productId === p.id && x.createdAt >= since)
            const sum = (types: string[]) => Math.abs(m.filter((x) => types.includes(x.type)).reduce((a, x) => a + x.qty, 0))
            return (
              <tr key={p.id}>
                <Td className="font-medium"><span className="flex items-center gap-2"><Thumb item={p} className="h-7 w-7 rounded-md text-base" />{p.name}</span></Td>
                <Td className="text-right font-semibold tabular">{p.stock} {p.unit}</Td>
                <Td className="text-right tabular text-emerald-700">{sum(['purchase'])}</Td>
                <Td className="text-right tabular">{sum(['sale'])}</Td>
                <Td className="text-right tabular text-red-600">{sum(['wastage', 'damage'])}</Td>
                <Td>{p.stock <= 0 ? <Badge tone="red">Out</Badge> : p.stock <= p.lowStockAt ? <Badge tone="amber">Low</Badge> : <Badge tone="green">OK</Badge>}</Td>
              </tr>
            )
          })}
        </tbody>
      </Table>
    </Card>
  )
}
