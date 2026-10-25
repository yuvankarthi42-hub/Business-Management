import { useEffect, useState } from 'react'
import { useData } from '@/app/AppContext'
import { Button, Card, Field, Input, useAction } from '@/components/ui'
import { api } from '@/data'
import { rupees } from './shared'

/** Pricing is per branch: a customer pays branches × months × this price. */
export default function AdminSettings() {
  const run = useAction()
  const { data } = useData(() => api.admin.settings())
  const [price, setPrice] = useState('')
  useEffect(() => { if (data) setPrice(String(data.pricePerBranchMonth)) }, [data])
  const p = Number(price) || 0
  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold">Pricing</h1>
      <p className="mb-5 text-sm text-slate-500">The price of a customer depends on how many branches you allow them.</p>
      <Card className="p-5">
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); await run(() => api.admin.updateSettings({ pricePerBranchMonth: p }), 'Price saved') }}>
          <Field required label="Price per branch per month (₹)" hint="Used for new subscriptions and renewals. Past payments keep their price.">
            <Input type="number" min={0} inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} className="max-w-[200px]" />
          </Field>
          <div className="overflow-hidden rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-3 py-2 text-left font-medium">Branches</th><th className="px-3 py-2 text-right font-medium">1 month</th><th className="px-3 py-2 text-right font-medium">6 months</th><th className="px-3 py-2 text-right font-medium">1 year</th></tr></thead>
              <tbody className="divide-y divide-slate-100 tabular">
                {[1, 2, 3, 5].map((b) => <tr key={b}><td className="px-3 py-2">{b}</td><td className="px-3 py-2 text-right">{rupees(b * p)}</td><td className="px-3 py-2 text-right">{rupees(b * p * 6)}</td><td className="px-3 py-2 text-right">{rupees(b * p * 12)}</td></tr>)}
              </tbody>
            </table>
          </div>
          <Button type="submit" disabled={!data || p === data.pricePerBranchMonth}>Save</Button>
        </form>
      </Card>
    </div>
  )
}
