import { CreditCard } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { Badge, Card, EmptyState, PageHeader, Segmented, Select, Table, Td, Th } from '@/components/ui'
import { PAYMENT_LABEL } from '@/core/config'
import type { PaymentMethod } from '@/core/types'
import { api } from '@/data'
import { fmtDateTime, money, rangeFor, type RangeKey } from '@/lib/format'
import { METHOD_COLOR } from '@/lib/chart'
import { OrderDetail } from './Orders'

export default function Payments() {
  const { t, me } = useApp()
  const showBranch = !!me?.isAll
  const [range, setRange] = useState<RangeKey>('today')
  const [method, setMethod] = useState<'all' | PaymentMethod>('all')
  const [open, setOpen] = useState<string | null>(null)
  const r = rangeFor(range)
  const { data: pays } = useData(() => api.payments.list(r.from, r.to), [range])
  const { data: orders = [] } = useData(() => api.orders.list())
  const { data: customers = [] } = useData(() => api.customers.list())
  const list = useMemo(() => (pays ?? []).filter((p) => method === 'all' || p.method === method), [pays, method])
  const totals = useMemo(() => {
    const m: Partial<Record<PaymentMethod, number>> = {}
    for (const p of pays ?? []) if (!p.voided) m[p.method] = (m[p.method] ?? 0) + p.amount
    return m
  }, [pays])
  const grand = Object.values(totals).reduce((a, v) => a + (v ?? 0), 0)

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title={t('payment', true)} subtitle={`${money(grand)} received`}
        actions={<Segmented value={range} onChange={setRange} options={[{ value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: 'week', label: 'This Week' }, { value: 'month', label: 'This Month' }]} />} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {(['cash', 'upi', 'card', 'bank'] as PaymentMethod[]).map((m) => (
          <Card key={m} className="p-4">
            <p className="flex items-center gap-2 text-xs font-medium text-slate-500"><span className="h-2.5 w-2.5 rounded-full" style={{ background: METHOD_COLOR[m] }} />{PAYMENT_LABEL[m]}</p>
            <p className="mt-1 text-xl font-semibold tabular">{money(totals[m] ?? 0)}</p>
          </Card>
        ))}
      </div>
      <Card>
        <div className="border-b border-slate-100 p-3">
          <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)} className="sm:w-48">
            <option value="all">All methods</option>{(['cash', 'upi', 'card', 'bank'] as PaymentMethod[]).map((m) => <option key={m} value={m}>{PAYMENT_LABEL[m]}</option>)}
          </Select>
        </div>
        {pays && !list.length ? <EmptyState icon={CreditCard} title="No payments in this period" /> : (
          <Table>
            <thead><tr><Th>Time</Th>{showBranch && <Th>Branch</Th>}<Th>{t('invoice')}</Th><Th className="hidden sm:table-cell">{t('customer')}</Th><Th>Method</Th><Th className="hidden md:table-cell">Type</Th><Th className="text-right">Amount</Th></tr></thead>
            <tbody>
              {list.slice(0, 300).map((p) => {
                const o = orders.find((x) => x.id === p.orderId)
                return (
                  <tr key={p.id} onClick={() => p.orderId && setOpen(p.orderId)} className="cursor-pointer hover:bg-slate-50">
                    <Td className="whitespace-nowrap text-slate-500">{fmtDateTime(p.createdAt)}</Td>
                    {showBranch && <Td><Badge>{me?.branches.find((b) => b.id === p.branchId)?.name ?? '—'}</Badge></Td>}
                    <Td className="font-medium">{o?.invoiceNumber ?? o?.number ?? '—'}</Td>
                    <Td className="hidden sm:table-cell">{customers.find((c) => c.id === p.customerId)?.name ?? <span className="text-slate-400">Walk-in</span>}</Td>
                    <Td><Badge>{PAYMENT_LABEL[p.method]}</Badge>{p.reference && <span className="ml-1.5 text-xs text-slate-400">{p.reference}</span>}</Td>
                    <Td className="hidden md:table-cell">{p.voided ? <Badge tone="red">Voided</Badge> : p.kind === 'due_collection' ? <Badge tone="violet">Due collected</Badge> : <Badge tone="green">Sale</Badge>}</Td>
                    <Td className={`text-right font-semibold tabular ${p.voided ? 'text-slate-400 line-through' : ''}`}>{money(p.amount)}</Td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </Card>
      {open && <OrderDetail id={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
