// Loyalty points: Settings panel, the customer's points card + history, and the "Use points" switch on bills.
import clsx from 'clsx'
import { Gift, Minus, Plus, Star } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { Button, Field, Input, Modal, Toggle, useAction } from '@/components/ui'
import { DEFAULT_LOYALTY, loyaltyOf, maxRedeemable, pointsToEarn, pointsValue } from '@/core/loyalty'
import type { Customer, LoyaltySettings, PointsKind } from '@/core/types'
import { api } from '@/data'
import { fmtDate, fmtDateTime, money } from '@/lib/format'

const KIND: Record<PointsKind, string> = { earn: 'Earned', redeem: 'Used', return: 'Return', cancel: 'Bill cancelled', expire: 'Expired', adjust: 'Changed by hand' }

/** Settings → Loyalty points. */
export function LoyaltySettingsPanel({ Section }: { Section: (p: { title: string; subtitle?: string; children: ReactNode; onSave?: () => void; dirty?: boolean }) => ReactNode }) {
  const { me } = useApp()
  const run = useAction()
  const saved = loyaltyOf(me!.business)
  const [l, setL] = useState<LoyaltySettings>(saved)
  const original = JSON.stringify(saved)
  useEffect(() => { setL(loyaltyOf(me!.business)) }, [original]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = <K extends keyof LoyaltySettings>(k: K, v: LoyaltySettings[K]) => setL((x) => ({ ...x, [k]: v }))
  const num = (v: string) => (v === '' ? NaN : Number(v))
  const sample = 4080
  const earn = pointsToEarn({ ...l, enabled: true }, sample)
  return (
    <Section title="Loyalty points" subtitle="Customers earn points on every bill and use them as a discount on a later visit" onSave={() => run(() => api.business.update({ loyalty: l }), 'Loyalty settings saved')} dirty={JSON.stringify(l) !== original}>
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 px-4 py-3">
          <div><p className="text-sm font-medium">Give points to customers</p><p className="text-xs text-slate-500">Only bills with a customer (chosen by mobile number) earn points.</p></div>
          <Toggle checked={l.enabled} onChange={(v) => set('enabled', v)} label="Give points to customers" />
        </div>
        <div className={clsx('grid gap-4 sm:grid-cols-3', !l.enabled && 'opacity-60')}>
          <Field required label="Earn 1 point for every"><Rupee value={l.spendPerPoint} onChange={(v) => set('spendPerPoint', num(v))} /></Field>
          <Field required label="1 point is worth"><Rupee value={l.pointValue} onChange={(v) => set('pointValue', num(v))} step="0.01" /></Field>
          <Field required label="Use from" hint="Points needed before they can be used"><Suffix value={l.minRedeem} onChange={(v) => set('minRedeem', num(v))} suffix="points" /></Field>
          <Field required label="Points can pay up to" hint="Of one bill"><Suffix value={l.maxBillPct} onChange={(v) => set('maxBillPct', num(v))} suffix="%" /></Field>
          <Field required label="Points expire after" hint="0 = never"><Suffix value={l.expiryMonths} onChange={(v) => set('expiryMonths', num(v))} suffix="months" /></Field>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-4 py-3 sm:col-span-3">
            <span className="text-sm">Earn on items sold below MRP</span>
            <Toggle checked={l.earnOnDiscounted} onChange={(v) => set('earnOnDiscounted', v)} label="Earn on items sold below MRP" />
          </div>
        </div>
        <div className="rounded-xl bg-violet-50 px-4 py-3 text-sm text-violet-900">
          <p className="font-medium">How it works with these settings</p>
          <p className="mt-0.5">A {money(sample)} bill earns <b>{earn} points</b> (worth {money(pointsValue(l, earn))}). Once a customer has {l.minRedeem} points, they can use them for up to {l.maxBillPct}% of a bill. Points used come off the bill before GST.{l.expiryMonths ? ` Points expire ${l.expiryMonths} months after they’re earned.` : ' Points never expire.'}</p>
        </div>
        {JSON.stringify({ ...DEFAULT_LOYALTY, enabled: l.enabled }) !== JSON.stringify(l) && (
          <button type="button" className="text-xs font-medium text-brand-600 hover:underline" onClick={() => setL({ ...DEFAULT_LOYALTY, enabled: l.enabled })}>Use the suggested settings</button>
        )}
      </div>
    </Section>
  )
}
function Rupee({ value, onChange, step = '1' }: { value: number; onChange: (v: string) => void; step?: string }) {
  return <div className="relative"><span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">₹</span><Input type="number" inputMode="decimal" step={step} min={0} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value)} className="pl-7" /></div>
}
function Suffix({ value, onChange, suffix }: { value: number; onChange: (v: string) => void; suffix: string }) {
  return <div className="relative"><Input type="number" inputMode="numeric" min={0} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value)} className="pr-16" /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">{suffix}</span></div>
}

/** Customer page: balance, what it's worth, history, and (owner) add / remove. */
export function CustomerPoints({ customer }: { customer: Customer }) {
  const { me, can } = useApp()
  const s = loyaltyOf(me!.business)
  const { data: hist = [] } = useData(() => api.customers.points(customer.id), [customer.id])
  const [adjust, setAdjust] = useState(false)
  const bal = customer.pointsBalance ?? 0
  if (!s.enabled && !bal && !hist.length) return null
  const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Loyalty points</h4>
        {can('settings.manage') && <Button size="sm" variant="ghost" icon={Gift} onClick={() => setAdjust(true)}>Add / remove</Button>}
      </div>
      <div className="mb-3 flex items-center gap-4 rounded-xl border border-violet-200 bg-violet-50 p-4">
        <Star className="h-7 w-7 text-violet-500" />
        <div className="flex-1"><p className="text-2xl font-bold text-violet-900">{bal} <span className="text-sm font-medium">points</span></p><p className="text-xs text-violet-700">Worth {money(pointsValue(s, bal))}{bal < s.minRedeem ? ` · can be used from ${s.minRedeem} points` : ''}</p></div>
        {hist.some((h) => h.kind === 'earn' && h.expiresOn && h.expiresOn <= soon) && <span className="text-right text-[11px] text-amber-700">Some points expire<br />within 30 days</span>}
      </div>
      <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 text-sm">
        {hist.map((h) => (
          <li key={h.id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate">{KIND[h.kind]}{h.ref ? ` · ${h.ref}` : ''}{h.kind === 'adjust' && h.note ? ` — ${h.note}` : ''}</p>
              <p className="text-[11px] text-slate-400">{fmtDateTime(h.createdAt)}{h.kind === 'earn' && h.expiresOn ? ` · expires ${fmtDate(h.expiresOn)}` : ''}</p>
            </div>
            <span className={clsx('w-14 text-right font-semibold tabular', h.points > 0 ? 'text-emerald-700' : 'text-red-600')}>{h.points > 0 ? '+' : '−'}{Math.abs(h.points)}</span>
            <span className="w-12 text-right text-xs text-slate-400 tabular">{h.balanceAfter}</span>
          </li>
        ))}
        {!hist.length && <li className="px-3 py-6 text-center text-slate-400">No points yet — they’re added on every bill for this customer.</li>}
      </ul>
      {adjust && <AdjustPointsModal customer={customer} onClose={() => setAdjust(false)} />}
    </section>
  )
}

function AdjustPointsModal({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const run = useAction()
  const [dir, setDir] = useState<1 | -1>(1)
  const [pts, setPts] = useState('')
  const [reason, setReason] = useState('')
  const n = Math.floor(Number(pts)) || 0
  return (
    <Modal open onClose={onClose} size="sm" title="Add or remove points" subtitle={`${customer.name} · ${customer.pointsBalance ?? 0} points now`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!n || !reason.trim()} onClick={async () => { if (await run(() => api.customers.adjustPoints(customer.id, dir * n, reason), dir > 0 ? `${n} points added` : `${n} points removed`)) onClose() }}>{dir > 0 ? `Add ${n || ''} points` : `Remove ${n || ''} points`}</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {([[1, Plus, 'Add'], [-1, Minus, 'Remove']] as const).map(([v, I, l]) => (
            <button key={v} type="button" onClick={() => setDir(v)} className={clsx('flex items-center justify-center gap-2 rounded-lg border py-2 text-sm font-medium', dir === v ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600')}><I className="h-4 w-4" />{l}</button>
          ))}
        </div>
        <Field required label="Points"><Input autoFocus type="number" inputMode="numeric" min={1} value={pts} onChange={(e) => setPts(e.target.value)} placeholder="50" /></Field>
        <Field required label="Reason" hint="Shown in the points history"><Input value={reason} maxLength={150} onChange={(e) => setReason(e.target.value)} placeholder="Diwali gift" /></Field>
      </div>
    </Modal>
  )
}

/**
 * Billing: the customer's points and a switch to use them on this bill. Calls onChange with the points to use
 * (0 = none). `billTotal` is the total before points.
 */
export function UsePoints({ customer, billTotal, points, onChange }: { customer: Customer | null | undefined; billTotal: number; points: number; onChange: (n: number) => void }) {
  const { me } = useApp()
  const s = loyaltyOf(me!.business)
  const bal = customer?.pointsBalance ?? 0
  const max = customer ? maxRedeemable(s, bal, billTotal) : 0
  // Keep the chosen points valid when the bill or customer changes.
  useEffect(() => { if (points > max) onChange(max) }, [max]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!s.enabled || !customer) return null
  const on = points > 0
  return (
    <div className={clsx('flex items-center gap-3 rounded-lg border px-3 py-2', on ? 'border-violet-300 bg-violet-50' : 'border-slate-200')}>
      <Star className={clsx('h-4 w-4 shrink-0', on ? 'text-violet-600' : 'text-slate-400')} />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{bal} points <span className="font-normal text-slate-500">· {money(pointsValue(s, bal))}</span></p>
        <p className="text-[11px] text-slate-500">{max ? (on ? `Using ${points} (−${money(pointsValue(s, points))})` : `Use up to ${max} on this bill`) : bal < s.minRedeem ? `Can be used from ${s.minRedeem} points` : 'Add items to use points'}</p>
      </div>
      {max > 0 && <Toggle checked={on} onChange={(v) => onChange(v ? max : 0)} label="Use points" />}
    </div>
  )
}
