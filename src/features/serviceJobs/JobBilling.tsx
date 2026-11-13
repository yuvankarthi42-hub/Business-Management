import clsx from 'clsx'
import { Banknote, CreditCard, Lock, MoreHorizontal, Smartphone, Wrench, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '@/app/AppContext'
import { Button, Chips, EmptyState, SearchInput, useToast } from '@/components/ui'
import { r2 } from '@/core/pricing'
import { formatPhone } from '@/core/phone'
import type { ServiceJob } from '@/core/serviceJobs'
import type { PaymentMethod, Product } from '@/core/types'
import { api, type PaymentInput } from '@/data'
import { money } from '@/lib/format'
import { useSaveOnce } from '@/features/billKey'
import { useCart } from '@/features/cart'
import { ProductGrid, useCatalog } from '@/features/Catalog'
import { CartLines, ClearButton, TotalsBlock } from '@/features/CartView'
import { ItemOptionsModal, needsOptions } from '@/features/ItemOptions'
import { BillSuccessModal, PaymentModal } from '@/features/Payment'

/**
 * Billing → a service job's bill (opened from Service Jobs as /billing?job=…). The same catalogue, cart, totals,
 * payment and bill print as the counter, with the job's customer fixed and its advance taken off. Paying calls
 * serviceJobs.deliver: the bill, the advance put on it, the payment and the job marked delivered are one transaction.
 * The counter's own billing screens are not used or changed; its cart is kept apart from the counter's.
 */
export default function JobBilling({ id }: { id: string }) {
  const { me, t, can } = useApp()
  const nav = useNavigate()
  const toast = useToast()
  const cat = useCatalog()
  const cart = useCart()
  const billing = me!.business.billing
  const [job, setJob] = useState<ServiceJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [options, setOptions] = useState<Product | null>(null)
  const [payOpen, setPayOpen] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const { once, saving } = useSaveOnce() // one bill, even if Pay is tapped again after a dropped connection

  useEffect(() => {
    let alive = true
    api.serviceJobs.get(id).then((j) => alive && setJob(j)).catch((e) => alive && setError((e as Error).message))
    return () => { alive = false }
  }, [id])

  const pick = useCallback((p: Product) => { if (needsOptions(p)) setOptions(p); else cart.addProduct(p) }, [cart])
  const advance = job?.advance ?? 0
  const total = cart.totals.total
  const toCollect = Math.max(0, r2(total - advance))
  const belowAdvance = cart.items.length > 0 && total + 0.001 < advance
  const back = () => nav('/service-jobs')

  const deliver = async (pays: PaymentInput[]) => {
    if (!job) return false
    if (cart.discountOver) { toast('Discount can’t be more than the bill', 'error'); return false }
    if (belowAdvance) { toast(`The bill is less than the advance (${money(advance)}). Add the charges, or cancel the job and give the advance back.`, 'error'); return false }
    const bill = { items: cart.items, discount: cart.discount, notes: `Job ${job.number}` }
    const r = await once({ job: job.id, bill, pays }, async () => {
      try {
        const done = await api.serviceJobs.deliver(job.id, bill, pays)
        setJob(done.job); setSuccess(done.order.id); setPayOpen(false)
        toast(`${job.number} delivered`)
        return true
      } catch (e) { toast((e as Error).message || 'Something went wrong', 'error'); return false }
    })
    return r ?? false
  }
  const quickPay = () => {
    if (!cart.items.length) return toast('Add the parts or labour for this job', 'error')
    void deliver(toCollect > 0 ? [{ method, amount: toCollect }] : [])
  }

  if (error) return <EmptyState icon={Wrench} title={error} action={<Button onClick={back}>Back to Service Jobs</Button>} />
  if (!job) return <p className="py-10 text-center text-sm text-slate-400">Loading…</p>
  if (job.stage !== 'delivered' && ['cancelled', 'returned'].includes(job.stage)) return <EmptyState icon={Wrench} title={`${job.number} is closed`} description="A cancelled or returned job has no bill." action={<Button onClick={back}>Back to Service Jobs</Button>} />
  if (job.stage === 'delivered' && !success) return <EmptyState icon={Wrench} title={`${job.number} is already delivered`} description={job.invoiceNumber ? `Bill ${job.invoiceNumber} · ${money(job.total ?? 0)}` : undefined} action={<Button onClick={back}>Back to Service Jobs</Button>} />

  const payButtons = ([{ m: 'cash', icon: Banknote }, { m: 'upi', icon: Smartphone }, { m: 'card', icon: CreditCard }] as const).filter((x) => billing.paymentMethods.includes(x.m))

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-brand-100 bg-brand-50 px-4 py-2 text-sm text-brand-800">
        <Wrench className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          <b>Job {job.number}</b> · {job.item}{job.brandModel && ` · ${job.brandModel}`} · {job.customerName}{job.customerPhone && ` (${formatPhone(job.customerPhone)})`}
          {advance > 0 && <> · Advance paid <b>{money(advance)}</b></>}{job.estimate != null && <> · Estimate {money(job.estimate)}</>}
        </span>
        <Button size="sm" variant="ghost" icon={X} onClick={back}>Leave job</Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="space-y-3 border-b border-slate-200 bg-white px-4 py-3">
            <SearchInput ref={searchRef} autoFocus value={cat.q} onChange={(e) => cat.setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && cat.q.trim()) {
                  const q = cat.q.trim()
                  const hit = cat.products.find((p) => p.barcode && p.barcode === q) ?? cat.products.find((p) => p.sku.toLowerCase() === q.toLowerCase()) ?? cat.visible[0]
                  if (hit) { pick(hit); cat.setQ('') }
                }
                if (e.key === 'Escape') cat.setQ('')
              }}
              placeholder={`Add parts or labour — search ${t('product', true).toLowerCase()} or scan barcode…`} />
            <Chips value={cat.q ? '' : cat.cat} onChange={(v) => { cat.setQ(''); cat.setCat(v) }} options={cat.chips} />
          </div>
          <div className="flex-1 overflow-y-auto p-4"><ProductGrid products={cat.visible} onPick={pick} qtyOf={cart.qtyOf} /></div>
        </section>

        <aside className="flex max-h-[60%] shrink-0 flex-col border-t border-slate-200 bg-white lg:max-h-none lg:w-[400px] lg:border-l lg:border-t-0">
          <div className="space-y-2 border-b border-slate-100 p-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold">Bill for {job.number}</h2>
                <p className="text-xs text-slate-500">{cart.count} item{cart.count === 1 ? '' : 's'}</p>
              </div>
              {cart.items.length > 0 && <ClearButton onClick={() => cart.reset()} />}
            </div>
            <p className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm"><Lock className="h-4 w-4 text-slate-400" />{job.customerName}{job.customerPhone && <span className="text-slate-400"> · {formatPhone(job.customerPhone)}</span>}</p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto"><CartLines cart={cart} /></div>
          <div className="space-y-3 border-t border-slate-100 bg-slate-50/60 p-4">
            <TotalsBlock totals={cart.totals} cart={cart} allowDiscount={can('billing.discount')} big />
            {advance > 0 && (
              <dl className="space-y-1 text-sm">
                <div className="flex justify-between text-emerald-700"><dt>Advance paid</dt><dd className="tabular">− {money(advance)}</dd></div>
                <div className="flex justify-between text-base font-semibold"><dt>To collect</dt><dd className="tabular">{money(toCollect)}</dd></div>
              </dl>
            )}
            {belowAdvance && <p className="text-xs text-red-600">The bill is less than the advance ({money(advance)}). Add the charges, or cancel the job from Service Jobs and give the advance back.</p>}
            {toCollect > 0 && (
              <div className="grid grid-cols-4 gap-2">
                {payButtons.map(({ m, icon: I }) => (
                  <button key={m} onClick={() => setMethod(m)} className={clsx('flex h-10 items-center justify-center gap-1.5 rounded-lg border text-sm font-semibold transition',
                    method === m ? 'border-brand-600 bg-brand-600 text-white shadow-sm' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300')}>
                    <I className="h-4 w-4" />{m === 'upi' ? 'UPI' : m[0].toUpperCase() + m.slice(1)}
                  </button>
                ))}
                <button onClick={() => cart.items.length && !belowAdvance && setPayOpen(true)} title="Split, credit, change" className="flex h-10 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:border-slate-300"><MoreHorizontal className="h-4 w-4" />More</button>
              </div>
            )}
            <Button variant="success" size="lg" block onClick={quickPay} disabled={!cart.items.length || saving || cart.discountOver || belowAdvance}>
              {saving ? 'Saving…' : toCollect > 0 ? <>Collect {money(toCollect)} and deliver</> : 'Deliver'}
            </Button>
          </div>
        </aside>
      </div>

      <ItemOptionsModal product={options} onClose={() => setOptions(null)} onAdd={cart.add} />
      <PaymentModal open={payOpen} onClose={() => setPayOpen(false)} total={toCollect} customerId={job.customerId} onCustomerChange={() => undefined}
        title={`Collect · ${job.number}`} onConfirm={deliver} />
      <BillSuccessModal orderId={success} onClose={back} onNew={back} />
    </div>
  )
}
