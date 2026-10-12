import { AlertTriangle, ArrowDownRight, ArrowUpRight, Clock, QrCode, TrendingDown } from 'lucide-react'
import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useApp, useData } from '@/app/AppContext'
import { Card, CardHeader, Skeleton, Table, Td, Th, useAction } from '@/components/ui'
import { api } from '@/data'
import { AXIS } from '@/lib/chart'
import { money, num, pctChange } from '@/lib/format'

// Fixed categorical order (validated palette) — a branch keeps its colour on every chart.
export const BRANCH_COLORS = ['#1f55eb', '#0d9488', '#d97706', '#9333ea', '#e11d48']

/** Multi-branch section of the dashboard: shown in the "All branches" view. */
export function BranchOverview({ from, to, prevFrom, prevTo, hourly }: { from: Date; to: Date; prevFrom: Date; prevTo: Date; hourly: boolean }) {
  const { t, can } = useApp()
  const run = useAction()
  const key = `${from.toISOString()}|${to.toISOString()}`
  const { data: rows } = useData(() => api.reports.byBranch(from, to), [key])
  const { data: prev } = useData(() => api.reports.byBranch(prevFrom, prevTo), [key])
  const showNet = can('reports.profit')

  const total = rows?.reduce((a, r) => a + r.summary.sales, 0) ?? 0
  const colorOf = (i: number) => BRANCH_COLORS[i % BRANCH_COLORS.length]

  const chart = useMemo(() => {
    if (!rows?.length) return []
    return rows[0].summary.series.map((pt, i) => {
      const row: Record<string, string | number> = { label: pt.label }
      rows.forEach((r) => { row[r.branch.id] = r.summary.series[i]?.sales ?? 0 })
      return row
    })
  }, [rows])

  const topItems = useMemo(() => {
    const m = new Map<string, { name: string; qty: number; revenue: number; best: { branch: string; qty: number; i: number } }>()
    rows?.forEach((r, bi) => r.summary.topProducts.forEach((p) => {
      const cur = m.get(p.productId) ?? { name: p.name, qty: 0, revenue: 0, best: { branch: r.branch.name, qty: 0, i: bi } }
      cur.qty += p.qty; cur.revenue += p.revenue
      if (p.qty > cur.best.qty) cur.best = { branch: r.branch.name, qty: p.qty, i: bi }
      m.set(p.productId, cur)
    }))
    return [...m.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5)
  }, [rows])

  const alerts = useMemo(() => (rows ?? []).flatMap((r) => [
    ...r.lowStock.slice(0, 2).map((x) => ({ icon: AlertTriangle, tone: 'text-amber-500', branch: r.branch.name, text: x.stock <= 0 ? `${x.name} out of stock` : `${x.name} · ${x.stock} ${x.unit} left` })),
    ...(r.pendingQr ? [{ icon: QrCode, tone: 'text-violet-600', branch: r.branch.name, text: `${r.pendingQr} QR order${r.pendingQr > 1 ? 's' : ''} waiting` }] : []),
    ...r.lateKots.slice(0, 1).map((k) => ({ icon: Clock, tone: 'text-red-500', branch: r.branch.name, text: `${k.number} waiting ${k.minutes}m in kitchen` })),
    ...(() => { const p = prev?.find((x) => x.branch.id === r.branch.id); const ch = p ? pctChange(r.summary.sales, p.summary.sales) : 0; return p && p.summary.sales > 0 && ch <= -10 ? [{ icon: TrendingDown, tone: 'text-red-500', branch: r.branch.name, text: `Sales down ${Math.abs(ch).toFixed(0)}%` }] : [] })(),
  ]), [rows, prev])

  if (!rows) return <Skeleton className="mt-4 h-72" />

  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardHeader title="Branch comparison" subtitle="Click a branch to open its own dashboard" />
        <Table className="mt-3">
          <thead>
            <tr>
              <Th>Branch</Th><Th className="text-right">Sales</Th><Th className="text-right">{t('invoice', true)}</Th><Th className="hidden text-right md:table-cell">Avg bill</Th>
              <Th className="hidden text-right sm:table-cell">{t('expense', true)}</Th>{showNet && <Th className="text-right">Net</Th>}<Th className="text-right">vs previous</Th><Th className="hidden w-36 lg:table-cell">Share</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const p = prev?.find((x) => x.branch.id === r.branch.id)
              const ch = p ? pctChange(r.summary.sales, p.summary.sales) : 0
              return (
                <tr key={r.branch.id} onClick={() => run(() => api.auth.switchBranch(r.branch.id))} className="cursor-pointer hover:bg-slate-50">
                  <Td className="font-medium text-slate-900">
                    <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm" style={{ background: colorOf(i) }} />{r.branch.name}
                    {r.branch.active === false && <span className="ml-1.5 text-xs text-slate-400">closed</span>}
                    {r.running > 0 && <span className="ml-2 text-xs font-normal text-slate-400">{r.running} running</span>}
                  </Td>
                  <Td className="text-right font-semibold tabular">{money(r.summary.sales)}</Td>
                  <Td className="text-right tabular">{num(r.summary.orderCount)}</Td>
                  <Td className="hidden text-right tabular md:table-cell">{money(Math.round(r.summary.avgOrder))}</Td>
                  <Td className="hidden text-right tabular sm:table-cell">{money(r.summary.expenses + r.summary.salary)}</Td>
                  {showNet && <Td className="text-right tabular">{money(r.summary.net)}</Td>}
                  <Td className={`text-right text-xs font-semibold tabular ${ch >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    <span className="inline-flex items-center gap-0.5">{ch >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}{Math.abs(ch).toFixed(0)}%</span>
                  </Td>
                  <Td className="hidden lg:table-cell">
                    <div className="h-1.5 rounded-full bg-slate-100"><div className="h-full rounded-full" style={{ width: `${total ? (r.summary.sales / total) * 100 : 0}%`, background: colorOf(i) }} /></div>
                  </Td>
                </tr>
              )
            })}
            <tr className="bg-slate-50/60 font-semibold">
              <Td>Total</Td>
              <Td className="text-right tabular">{money(total)}</Td>
              <Td className="text-right tabular">{num(rows.reduce((a, r) => a + r.summary.orderCount, 0))}</Td>
              <Td className="hidden text-right tabular md:table-cell">{money(rows.reduce((a, r) => a + r.summary.orderCount, 0) ? Math.round(total / rows.reduce((a, r) => a + r.summary.orderCount, 0)) : 0)}</Td>
              <Td className="hidden text-right tabular sm:table-cell">{money(rows.reduce((a, r) => a + r.summary.expenses + r.summary.salary, 0))}</Td>
              {showNet && <Td className="text-right tabular">{money(rows.reduce((a, r) => a + r.summary.net, 0))}</Td>}
              <Td /><Td className="hidden lg:table-cell" />
            </tr>
          </tbody>
        </Table>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title={hourly ? 'Sales by hour' : 'Sales by day'} subtitle="Each branch in its own colour"
            action={<div className="flex flex-wrap justify-end gap-3 text-xs text-slate-500">{rows.map((r, i) => <span key={r.branch.id} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: colorOf(i) }} />{r.branch.name}</span>)}</div>} />
          <div className="h-64 px-2 pb-3 pt-4">
            <ResponsiveContainer>
              <BarChart data={chart} barGap={1} margin={{ right: 8 }}>
                <CartesianGrid vertical={false} stroke={AXIS.grid} />
                <XAxis dataKey="label" tick={AXIS.tick} axisLine={false} tickLine={false} minTickGap={8} />
                <YAxis tick={AXIS.tick} axisLine={false} tickLine={false} width={48} tickFormatter={(v) => (v >= 1000 ? `${v / 1000}k` : v)} />
                <Tooltip cursor={{ fill: '#f1f5f9' }} formatter={(v, id) => [money(Number(v)), rows.find((r) => r.branch.id === id)?.branch.name ?? '']} contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12 }} />
                {rows.map((r, i) => <Bar key={r.branch.id} dataKey={r.branch.id} fill={colorOf(i)} radius={[4, 4, 0, 0]} maxBarSize={12} />)}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card>
          <CardHeader title="Needs attention" subtitle={alerts.length ? `${alerts.length} across branches` : undefined} />
          <ul className="space-y-2.5 px-5 pb-5 pt-3">
            {alerts.slice(0, 8).map((a, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm">
                <a.icon className={`mt-0.5 h-4 w-4 shrink-0 ${a.tone}`} />
                <span><b className="font-semibold">{a.branch}</b> · {a.text}</span>
              </li>
            ))}
            {!alerts.length && <li className="py-6 text-center text-sm text-slate-400">All branches look good</li>}
          </ul>
        </Card>
      </div>

      <Card>
        <CardHeader title={`Top ${t('product', true).toLowerCase()} · all branches`} />
        <Table className="mt-3">
          <thead><tr><Th>{t('product')}</Th><Th className="text-right">Sold</Th><Th className="text-right">Revenue</Th><Th>Best branch</Th></tr></thead>
          <tbody>
            {topItems.map((x) => (
              <tr key={x.name}>
                <Td className="font-medium">{x.name}</Td>
                <Td className="text-right tabular">{num(x.qty)}</Td>
                <Td className="text-right font-semibold tabular">{money(x.revenue)}</Td>
                <Td><span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm" style={{ background: colorOf(x.best.i) }} />{x.best.branch} · {num(x.best.qty)}</Td>
              </tr>
            ))}
            {!topItems.length && <tr><Td colSpan={4} className="py-6 text-center text-slate-400">No sales in this period</Td></tr>}
          </tbody>
        </Table>
      </Card>
    </div>
  )
}
