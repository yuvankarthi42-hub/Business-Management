// Settings → Printer and bill → Printer: how this branch prints its bills. The choices are kept as a draft and saved
// with the page's Save bar; Connect / Forget / Print test bill act at once (they talk to the device).
import clsx from 'clsx'
import { Bluetooth, Cable, Check, ChevronDown, CircleAlert, CircleCheck, FileText, Info, Printer, Unplug, Usb } from 'lucide-react'
import { useState } from 'react'
import { Button, Field, Segmented, Select, Toggle } from '@/components/ui'
import type { BranchPrinter } from '@/core/types'
import type { Paper } from './doc'
import { choosePrinter, forgetPrinter, isConnected, support, type PrinterSettings, type Transport } from './printer'

const TRANSPORTS: { key: Transport; label: string; sub: string; icon: typeof Usb; hint: string }[] = [
  { key: 'usb', label: 'USB cable', sub: 'Plugged in', icon: Usb, hint: 'Thermal printer plugged into this computer or Android tablet (OTG).' },
  { key: 'bluetooth', label: 'Bluetooth', sub: 'Phone, tablet', icon: Bluetooth, hint: 'Handheld Bluetooth printers, mostly with Android phones and tablets.' },
  { key: 'serial', label: 'COM port', sub: 'Older printers', icon: Cable, hint: 'COM-port printers, and Bluetooth printers paired in Windows (they show as a COM port).' },
  { key: 'browser', label: 'Normal print', sub: 'Any printer', icon: FileText, hint: 'Opens the print window and uses the printer installed on this computer.' },
]

/** What the Printer tab edits (paper always has a value: the branch's own, else the shop's). */
export type PrinterDraft = Pick<BranchPrinter, 'transport' | 'mode' | 'autoPrint' | 'copies' | 'cut' | 'drawer' | 'baudRate'> & { paper: Paper }
export const printerDraftOf = (s: PrinterSettings, shopPaper: Paper): PrinterDraft =>
  ({ transport: s.transport, paper: s.paper ?? shopPaper, mode: s.mode, autoPrint: s.autoPrint, copies: s.copies, cut: s.cut, drawer: s.drawer, baudRate: s.baudRate })
/** Only what changed, so a branch that follows the shop's paper keeps following it until the paper is changed here. */
export function printerChanges(from: PrinterDraft, to: PrinterDraft): Partial<BranchPrinter> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(to) as (keyof PrinterDraft)[]) if (to[k] !== from[k]) out[k] = to[k]
  return out as Partial<BranchPrinter>
}

export function PrinterSetup({ branchId, saved, draft, set, onTest, act, busy }: {
  branchId: string
  /** The setup as saved (with this device's paired printer). */
  saved: PrinterSettings
  draft: PrinterDraft
  set: (patch: Partial<PrinterDraft>) => void
  onTest: () => void
  /** Runs a device action (connect, forget) with the page's busy state and error message. */
  act: (fn: () => Promise<unknown>, ok?: string) => void
  busy: boolean
}) {
  const sup = support()
  const [more, setMore] = useState(false)
  const direct = draft.transport !== 'browser'
  const t = TRANSPORTS.find((x) => x.key === draft.transport)!
  const available = (k: Transport) => k === 'browser' || sup[k]
  // The paired printer belongs to the saved way of printing; a different choice needs Connect first.
  const paired = direct && draft.transport === saved.transport && !!saved.deviceName
  const live = paired && isConnected(branchId)
  const connect = () => act(() => choosePrinter(branchId, { ...saved, ...draft }, draft.transport as Exclude<Transport, 'browser'>), 'Printer connected')

  return (
    <div className="space-y-6">
      <div className={clsx('flex flex-wrap items-center gap-3 rounded-xl p-3', !direct ? 'bg-slate-50' : paired ? 'bg-emerald-50' : 'bg-amber-50')}>
        {!direct ? <Printer className="h-5 w-5 shrink-0 text-slate-500" /> : paired ? <CircleCheck className="h-5 w-5 shrink-0 text-emerald-600" /> : <CircleAlert className="h-5 w-5 shrink-0 text-amber-600" />}
        <div className="min-w-0 flex-1">
          <p className={clsx('truncate text-sm font-medium', !direct ? 'text-slate-800' : paired ? 'text-emerald-800' : 'text-amber-800')}>
            {!direct ? 'Normal print' : paired ? `${saved.deviceName} (${t.label})` : 'Printer not connected yet'}
          </p>
          <p className={clsx('text-xs', !direct ? 'text-slate-500' : paired ? 'text-emerald-700' : 'text-amber-700')}>
            {!direct ? 'Each bill opens the print window.' : paired ? (live ? 'Connected. Bills print straight away.' : 'Remembered on this device. It connects on the next bill.') : 'Switch the printer on, press Connect and pick it from the list.'}
          </p>
        </div>
        <Button size="sm" variant="secondary" icon={Printer} disabled={busy} onClick={onTest}>Print test bill</Button>
        {direct && <Button size="sm" variant={paired ? 'secondary' : 'primary'} disabled={busy || !available(draft.transport)} onClick={connect}>{paired ? 'Change printer' : 'Connect'}</Button>}
        {paired && <Button size="sm" variant="ghost" icon={Unplug} disabled={busy} onClick={() => act(async () => { await forgetPrinter(branchId); set({ transport: 'browser' }) }, 'Printer removed')} className="!text-red-600">Forget</Button>}
      </div>

      <section>
        <h3 className="mb-2 text-sm font-semibold">How do you print?</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {TRANSPORTS.map((x) => (
            <button key={x.key} type="button" disabled={!available(x.key)} onClick={() => set({ transport: x.key })}
              className={clsx('relative flex flex-col items-start gap-0.5 rounded-xl border-2 p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50',
                draft.transport === x.key ? 'border-brand-600 bg-brand-50/50' : 'border-slate-200 hover:border-slate-300')}>
              {draft.transport === x.key && <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-white"><Check className="h-3 w-3" /></span>}
              <x.icon className="mb-1 h-5 w-5 text-slate-600" />
              <span className="text-sm font-semibold">{x.label}</span>
              <span className="text-xs text-slate-500">{available(x.key) ? x.sub : 'Needs Chrome or Edge'}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">{t.hint}</p>
      </section>

      <section id="paper-size">
        <h3 className="mb-2 text-sm font-semibold">Paper size</h3>
        <div className="grid grid-cols-2 gap-3 sm:max-w-md" role="radiogroup" aria-label="Paper size">
          {([['58mm', '58 mm', '2 inch roll'], ['80mm', '80 mm', '3 inch roll']] as const).map(([v, l, sub]) => {
            const on = draft.paper === v
            return (
              <button key={v} type="button" role="radio" aria-checked={on} onClick={() => set({ paper: v })}
                className={clsx('relative flex cursor-pointer items-center gap-3 rounded-xl border-2 px-3 py-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300',
                  on ? 'border-brand-600 bg-brand-50' : 'border-slate-200 bg-white hover:border-brand-300 hover:bg-slate-50')}>
                <span className={clsx('flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2', on ? 'border-brand-600' : 'border-slate-300')} aria-hidden>
                  {on && <span className="h-2.5 w-2.5 rounded-full bg-brand-600" />}
                </span>
                <span className={clsx('h-9 shrink-0 rounded-sm border-2', v === '58mm' ? 'w-5' : 'w-7', on ? 'border-brand-600 bg-brand-100' : 'border-slate-300 bg-white')} aria-hidden />
                <span className="min-w-0">
                  <span className={clsx('block text-sm font-semibold', on ? 'text-brand-800' : 'text-slate-800')}>{l}</span>
                  <span className="block text-xs text-slate-500">{sub}</span>
                </span>
                {on && <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-white"><Check className="h-3 w-3" /></span>}
              </button>
            )
          })}
        </div>
        <p className="mt-2 text-xs text-slate-500">Choose the roll width your printer takes. The sample bill changes to match.</p>
      </section>

      <section className="divide-y divide-slate-100 rounded-xl border border-slate-200">
        <Row title="Print automatically after payment" desc={direct ? 'The bill prints the moment payment is saved.' : 'The print window opens right after each bill.'}>
          <Toggle checked={draft.autoPrint} onChange={(v) => set({ autoPrint: v })} label="Auto print" />
        </Row>
        {direct && <>
          <Row title="Cut paper after each bill" desc="For printers with an auto-cutter."><Toggle checked={draft.cut} onChange={(v) => set({ cut: v })} label="Cut paper" /></Row>
          <Row title="Open cash drawer on cash bills" desc="Drawer plugged into the printer."><Toggle checked={draft.drawer} onChange={(v) => set({ drawer: v })} label="Cash drawer" /></Row>
          <Row title="Copies per bill" desc="Extra copies print one after another.">
            <Segmented size="sm" value={String(draft.copies)} onChange={(v) => set({ copies: Number(v) })} options={['1', '2', '3'].map((v) => ({ value: v, label: v }))} />
          </Row>
        </>}
      </section>

      <section className="rounded-xl border border-slate-200">
        <button type="button" onClick={() => setMore(!more)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-slate-600">
          <Info className="h-4 w-4 text-slate-400" /><span className="flex-1">More options and help</span>
          <ChevronDown className={clsx('h-4 w-4 transition', more && 'rotate-180')} />
        </button>
        {more && (
          <div className="space-y-4 border-t border-slate-100 px-4 py-4">
            {direct && (
              <Field label="Tamil and other languages" hint={draft.mode === 'auto' ? 'Fast for English bills; switches by itself when a bill has Tamil names.' : draft.mode === 'image' ? 'Prints any language. A little slower on old printers.' : 'Fastest, but English only.'}>
                <Segmented size="sm" value={draft.mode} onChange={(v) => set({ mode: v })} options={[{ value: 'auto', label: 'Automatic' }, { value: 'image', label: 'Always picture' }, { value: 'text', label: 'English only' }]} />
              </Field>
            )}
            {draft.transport === 'serial' && (
              <Field label="Port speed (baud rate)" hint="Usually 9600 or 115200 — printed on the printer's self-test page." className="sm:w-64">
                <Select value={draft.baudRate} onChange={(e) => set({ baudRate: Number(e.target.value) })}>
                  {[9600, 19200, 38400, 57600, 115200].map((b) => <option key={b} value={b}>{b}</option>)}
                </Select>
              </Field>
            )}
            <div className="space-y-1 text-xs leading-relaxed text-slate-600">
              {draft.transport === 'browser' && <p>To print without the window: start Chrome with <code className="rounded bg-slate-100 px-1">--kiosk-printing</code> and set the thermal printer as the default printer.</p>}
              {draft.transport === 'usb' && <p>Windows: if the printer doesn't show or says “in use”, install the WinUSB driver for it (Zadig). Mac, Linux and Android work as they are.</p>}
              {draft.transport === 'serial' && <p>Pair Bluetooth printers in Windows Settings first; they show up here as a COM port.</p>}
              {draft.transport === 'bluetooth' && <p>Turn on Bluetooth and Location on the phone. The printer must be on and not connected to another phone.</p>}
              <p>Works with most 58 / 80 mm receipt printers — TVS, Epson, Everycom, Rugtek, Posiflex, Xprinter.</p>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

const Row = ({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) => (
  <div className="flex items-center gap-4 px-4 py-3">
    <div className="min-w-0 flex-1"><p className="text-sm font-medium">{title}</p><p className="text-xs text-slate-500">{desc}</p></div>
    {children}
  </div>
)
