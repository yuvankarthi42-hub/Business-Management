// Settings → Printer, scale and bill → Weighing scale: this branch's scale. The choices are a draft saved with the
// page's Save bar; Connect / Forget act at once (they talk to the device). Off until the branch switches it on.
import clsx from 'clsx'
import { Cable, Check, ChevronDown, CircleAlert, CircleCheck, Info, Scale, Unplug } from 'lucide-react'
import { useState } from 'react'
import { Button, Select, Toggle } from '@/components/ui'
import { BAUD_RATES, SCALE_BRANDS, billWeight, type BranchScale } from '@/core/scale'
import type { Branch } from '@/core/types'
import { forgetScale, pairScale, reconnectScale, scaleSupported, useScale } from './scaleDevice'

/** Shops that sell loose items by weight get the Weighing scale tab. */
export const sellsByWeight = (b: { category: string; subType: string }) => b.category === 'retail' || /bakery|sweet/i.test(b.subType)

/** "0.500 kg" / "750 g" for people. */
export const fmtWeight = (kg: number) => (Math.abs(kg) < 1 ? `${Math.round(kg * 1000)} g` : `${kg.toFixed(3)} kg`)

export function ScaleSetup({ branch, draft, set, act, busy }: {
  branch: Branch
  draft: BranchScale
  set: (patch: Partial<BranchScale>) => void
  act: (fn: () => Promise<unknown>, ok?: string) => void
  busy: boolean
}) {
  const [help, setHelp] = useState(!draft.enabled)
  // Live reading with the settings being edited (so a new port speed can be tried before saving).
  const sc = useScale(branch, { ...draft, enabled: true })
  const supported = scaleSupported()
  const connected = sc.status === 'connected' || sc.status === 'silent'
  const weight = sc.kg !== null ? billWeight(sc.kg, draft) : null

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 rounded-xl border border-slate-200 p-4">
        <Scale className="h-6 w-6 shrink-0 text-slate-500" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Use a weighing scale at this branch</p>
          <p className="text-xs text-slate-500">Loose items (kg) take the weight from the scale and the amount is worked out. Off: weights are typed as today.</p>
        </div>
        <Toggle checked={draft.enabled} onChange={(v) => set({ enabled: v })} label="Use a weighing scale" />
      </div>

      <div className={clsx('space-y-6', !draft.enabled && 'opacity-60')}>
        {!supported ? (
          <div className="flex items-start gap-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
            <CircleAlert className="mt-0.5 h-5 w-5 shrink-0" />
            <p>This browser can't connect a scale. Open the app in <b>Chrome</b> or <b>Edge</b> on the counter computer (Windows or Mac).</p>
          </div>
        ) : (
          <div className={clsx('flex flex-wrap items-center gap-3 rounded-xl p-3', connected ? 'bg-emerald-50' : 'bg-amber-50')}>
            {connected ? <CircleCheck className="h-5 w-5 shrink-0 text-emerald-600" /> : <CircleAlert className="h-5 w-5 shrink-0 text-amber-600" />}
            <div className="min-w-0 flex-1">
              <p className={clsx('truncate text-sm font-medium', connected ? 'text-emerald-800' : 'text-amber-800')}>
                {connected ? `Scale connected · ${sc.device ?? 'COM port'}` : sc.status === 'disconnected' ? `Scale not found · ${sc.device}` : sc.status === 'connecting' ? 'Connecting…' : 'Scale not connected on this computer'}
              </p>
              <p className={clsx('text-xs', connected ? 'text-emerald-700' : 'text-amber-700')}>
                {sc.status === 'silent' ? 'Connected, but the scale is not sending its weight. Set its output to “continuous” and check the port speed.'
                  : connected ? 'The weight below changes as you put things on the scale.'
                  : sc.status === 'disconnected' ? 'Check the cable and that the scale is on, then press Reconnect.'
                  : sc.error ?? 'Switch the scale on, press Connect and pick its port from the list.'}
              </p>
            </div>
            {sc.status === 'disconnected' && <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => reconnectScale(branch.id, draft.baudRate))}>Reconnect</Button>}
            <Button size="sm" variant={connected ? 'secondary' : 'primary'} icon={Cable} disabled={busy} onClick={() => act(() => pairScale(branch.id, draft.baudRate), 'Scale connected')}>{connected || sc.device ? 'Change scale' : 'Connect'}</Button>
            {sc.device && <Button size="sm" variant="ghost" icon={Unplug} disabled={busy} onClick={() => act(() => forgetScale(branch.id), 'Scale removed from this computer')} className="!text-red-600">Forget</Button>}
          </div>
        )}

        {connected && (
          <div className="rounded-xl border border-slate-200 p-4 text-center">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Live weight</p>
            <p className="mt-1 font-mono text-4xl font-semibold tabular-nums" data-no-i18n>{weight === null ? '—' : weight === 0 ? '0 g' : fmtWeight(weight)}</p>
            <p className={clsx('mt-1 text-xs font-medium', sc.stable ? 'text-emerald-600' : 'text-amber-600')}>{sc.kg === null ? 'Waiting for the scale…' : sc.stable ? '● Steady' : '● Moving'}</p>
          </div>
        )}

        <section>
          <h3 className="mb-2 text-sm font-semibold">Scale brand</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Scale brand">
            {SCALE_BRANDS.map((x) => {
              const on = draft.brand === x.key
              return (
                <button key={x.key} type="button" role="radio" aria-checked={on} onClick={() => set({ brand: x.key, baudRate: x.baud })}
                  className={clsx('relative rounded-xl border-2 px-3 py-2.5 text-left text-sm font-semibold transition', on ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-200 hover:border-brand-300')}>
                  {x.label}
                  {on && <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-white"><Check className="h-3 w-3" /></span>}
                </button>
              )
            })}
          </div>
          <p className="mt-2 text-xs text-slate-500">Not in the list? Choose Other — any scale with a computer (RS-232 / USB) output works.</p>
        </section>

        <section className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          <Row title="Add to the bill when the weight is steady" desc="On: the item goes on the bill by itself a moment after the weight stops moving. Off: press Enter or Add.">
            <Toggle checked={draft.autoAdd} onChange={(v) => set({ autoAdd: v })} label="Add automatically" />
          </Row>
          <Row title="Ignore weights below" desc="An empty pan or a light touch isn't billed.">
            <Select className="w-28" value={draft.minGrams} onChange={(e) => set({ minGrams: Number(e.target.value) })}>
              {[5, 10, 20, 50].map((g) => <option key={g} value={g}>{g} g</option>)}
            </Select>
          </Row>
          <Row title="Round the weight" desc="Bill the weight as the scale reads, or to the nearest 5 / 10 g.">
            <Select className="w-36" value={draft.roundGrams} onChange={(e) => set({ roundGrams: Number(e.target.value) as 0 | 5 | 10 })}>
              <option value={0}>As the scale reads</option><option value={5}>Nearest 5 g</option><option value={10}>Nearest 10 g</option>
            </Select>
          </Row>
          <Row title="Port speed (baud rate)" desc="Must match the scale's own setting. Most scales use 9600.">
            <Select className="w-28" value={draft.baudRate} onChange={(e) => set({ baudRate: Number(e.target.value) })}>
              {BAUD_RATES.map((b) => <option key={b} value={b}>{b}</option>)}
            </Select>
          </Row>
        </section>
      </div>

      <section className="rounded-xl border border-slate-200">
        <button type="button" onClick={() => setHelp(!help)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-slate-600">
          <Info className="h-4 w-4 text-slate-400" /><span className="flex-1">How to connect the scale</span>
          <ChevronDown className={clsx('h-4 w-4 transition', help && 'rotate-180')} />
        </button>
        {help && (
          <ol className="list-decimal space-y-1.5 border-t border-slate-100 px-8 py-4 text-xs leading-relaxed text-slate-600">
            <li>The scale needs a <b>computer output</b>: a 9-pin port marked RS-232 / PC / Data (on the back, underneath, or on the display box of a platform scale). No port? Ask the dealer for the RS-232 option.</li>
            <li>Connect: scale's 9-pin cable → <b>USB-to-RS232 adapter</b> → the computer's USB port. Install the adapter's driver once.</li>
            <li>On the scale, ask the dealer to set the output to <b>continuous</b>, speed <b>9600</b>, unit <b>kg</b>. Don't open the stamped (Legal Metrology) seal.</li>
            <li>Here: switch on <b>Use a weighing scale</b>, choose the brand, press <b>Connect</b> and pick the port. Put something on the scale — the live weight shows. Then Save.</li>
            <li>Each counter computer connects its own scale once; the settings above are shared by the whole branch.</li>
          </ol>
        )}
      </section>
    </div>
  )
}

const Row = ({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) => (
  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
    <div className="min-w-0 flex-1"><p className="text-sm font-medium">{title}</p><p className="text-xs text-slate-500">{desc}</p></div>
    {children}
  </div>
)
