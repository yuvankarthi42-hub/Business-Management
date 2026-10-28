import { useEffect, useState } from 'react'
import { useData } from '@/app/AppContext'
import { Button, Card, Input, useAction } from '@/components/ui'
import { cleanPlanPrice, monthlyValue, PLAN_KEYS, PLAN_LABEL, planAmount, type PlanKey, type PlanPrice } from '@/core/plans'
import { api } from '@/data'
import { rupees } from './shared'

type Draft = Record<PlanKey, { month: string; year: string; extraBranch: string }>
const toDraft = (p: Record<PlanKey, PlanPrice>): Draft => Object.fromEntries(PLAN_KEYS.map((k) => [k, { month: String(p[k].month), year: String(p[k].year), extraBranch: String(p[k].extraBranch) }])) as Draft
const fromDraft = (d: Draft[PlanKey]) => cleanPlanPrice({ month: Number(d.month), year: Number(d.year), extraBranch: Number(d.extraBranch) })

/** Prices by business type. A customer with their own price (Customer → Price) is not affected by these. */
export default function AdminSettings() {
  const run = useAction()
  const { data } = useData(() => api.admin.settings())
  const [draft, setDraft] = useState<Draft | null>(null)
  useEffect(() => { if (data?.plans) setDraft(toDraft(data.plans)) }, [data])
  if (!data?.plans || !draft) return null
  const saved = data.plans
  const parsed = Object.fromEntries(PLAN_KEYS.map((k) => [k, fromDraft(draft[k])])) as Record<PlanKey, PlanPrice | null>
  const bad = PLAN_KEYS.filter((k) => !parsed[k])
  const dirty = PLAN_KEYS.some((k) => JSON.stringify(parsed[k]) !== JSON.stringify(saved[k]))
  const set = (k: PlanKey, f: keyof Draft[PlanKey], v: string) => setDraft({ ...draft, [k]: { ...draft[k], [f]: v.replace(/[^\d]/g, '').slice(0, 7) } })
  const save = () => run(() => api.admin.updateSettings({ plans: Object.fromEntries(PLAN_KEYS.map((k) => [k, parsed[k]!])) as Record<PlanKey, PlanPrice> }), 'Prices saved')

  return (
    <div className="max-w-4xl">
      <h1 className="text-xl font-semibold">Pricing</h1>
      <p className="mb-5 text-sm text-slate-500">
        Price by business type. Used for new subscriptions and renewals — past payments keep their price.
        {data.customPrices ? ` ${data.customPrices} customer${data.customPrices === 1 ? ' has' : 's have'} their own price (not changed by this).` : ' To give one customer a different price, open the customer → Price.'}
      </p>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">Business type</th>
                <th className="px-2 py-2.5 text-left font-medium">Monthly (₹)</th>
                <th className="px-2 py-2.5 text-left font-medium">Yearly (₹)</th>
                <th className="px-2 py-2.5 text-left font-medium">Extra branch / month (₹)</th>
                <th className="px-4 py-2.5 text-right font-medium">2 branches · 1 year</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {PLAN_KEYS.map((k) => {
                const p = parsed[k]
                const free = p && p.month ? Math.round((p.month * 12 - p.year) / p.month * 10) / 10 : 0
                return (
                  <tr key={k} className="align-top">
                    <td className="px-4 py-3"><p className="font-medium">{PLAN_LABEL[k].name}</p><p className="text-xs text-slate-400">{PLAN_LABEL[k].hint}</p></td>
                    <td className="px-2 py-3"><Input inputMode="numeric" aria-label={`${PLAN_LABEL[k].name} monthly`} value={draft[k].month} onChange={(e) => set(k, 'month', e.target.value)} className="h-9 w-28 tabular" /></td>
                    <td className="px-2 py-3">
                      <Input inputMode="numeric" aria-label={`${PLAN_LABEL[k].name} yearly`} value={draft[k].year} onChange={(e) => set(k, 'year', e.target.value)} className="h-9 w-28 tabular" />
                      {p && free > 0 && <p className="mt-1 text-[11px] text-emerald-600">{free} month{free === 1 ? '' : 's'} free</p>}
                    </td>
                    <td className="px-2 py-3"><Input inputMode="numeric" aria-label={`${PLAN_LABEL[k].name} extra branch`} value={draft[k].extraBranch} onChange={(e) => set(k, 'extraBranch', e.target.value)} className="h-9 w-28 tabular" /></td>
                    <td className="px-4 py-3 text-right tabular">
                      {p ? <><p className="font-medium">{rupees(planAmount(p, 2, 12, '', ''))}</p><p className="text-[11px] text-slate-400">{rupees(monthlyValue(p, 2))}/month</p></> : <span className="text-xs text-red-600">Enter all three</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
          <p className="text-xs text-slate-500">A year = the yearly price; each extra branch for a year = 10 × its monthly price (2 months free). Custom dates are charged per day.</p>
          <div className="flex gap-2">
            {dirty && <Button variant="ghost" onClick={() => setDraft(toDraft(saved))}>Undo</Button>}
            <Button disabled={!dirty || !!bad.length} onClick={save}>Save prices</Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
