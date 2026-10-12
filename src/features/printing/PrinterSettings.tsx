import clsx from 'clsx'
import { Bluetooth, Cable, Check, Info, Printer, Unplug, Usb } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useApp } from '@/app/AppContext'
import { Button, Card, Field, Segmented, Select, Toggle, useToast } from '@/components/ui'
import { testDoc, type Paper } from './doc'
import { drawerOnly, encodeImage, encodeText, renderCanvas } from './escpos'
import { choosePrinter, forgetPrinter, isConnected, savePrinter, sendToPrinter, support, usePrinterSettings, type PrinterSettings, type Transport } from './printer'

const TRANSPORTS: { key: Transport; label: string; icon: typeof Usb; hint: string }[] = [
  { key: 'browser', label: 'Print dialog', icon: Printer, hint: 'Uses the computer’s installed printer driver. Works in every browser.' },
  { key: 'usb', label: 'USB', icon: Usb, hint: 'Thermal printer plugged into this computer or Android tablet (OTG). Chrome / Edge.' },
  { key: 'serial', label: 'Serial / COM', icon: Cable, hint: 'COM-port printers and Bluetooth printers paired in Windows (they appear as a COM port).' },
  { key: 'bluetooth', label: 'Bluetooth', icon: Bluetooth, hint: 'Handheld Bluetooth (BLE) printers, mostly with Android phones and tablets.' },
]

/** Receipt printer for one branch. Each branch sets up its own; the paired printer stays on this device. */
export function PrinterSettingsPanel() {
  const { me } = useApp()
  const toast = useToast()
  const branches = (me?.branches ?? []).filter((b) => b.active !== false)
  const [picked, setPicked] = useState(me?.isAll ? branches[0]?.id ?? '' : me?.branch.id ?? '')
  const branchId = branches.some((b) => b.id === picked) ? picked : me?.isAll ? branches[0]?.id ?? '' : me?.branch.id ?? ''
  const branch = branches.find((b) => b.id === branchId)
  const s = usePrinterSettings(branchId)
  const set = (patch: Partial<PrinterSettings>) => { savePrinter(branchId, patch).catch((e) => toast((e as Error).message, 'error')) }
  const sup = support()
  const [busy, setBusy] = useState(false)
  const paper: Paper = s.paper ?? me?.business.billing.paperWidth ?? '80mm'
  const preview = useMemo(() => { try { return renderCanvas(testDoc(me?.business.name ?? 'My shop', paper), paper).toDataURL() } catch { return '' } }, [paper, me?.business.name])
  const t = TRANSPORTS.find((x) => x.key === s.transport)!
  const available = (k: Transport) => k === 'browser' || sup[k]

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try { await fn(); if (ok) toast(ok) }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/No device selected|cancelled|User cancelled|No port selected/i.test(msg)) toast(msg, 'error')
    } finally { setBusy(false) }
  }
  const test = () => act(async () => {
    const doc = testDoc(me?.business.name ?? 'My shop', paper)
    const image = s.mode !== 'text'
    await sendToPrinter(branchId, s, image ? encodeImage(doc, paper, { cut: s.cut }) : encodeText(doc, paper, { cut: s.cut }))
  }, 'Test page sent')

  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Printer</h2>
          <p className="text-sm text-slate-500">Receipt printer for the <b>{branch?.name ?? 'selected'}</b> branch. Each branch sets up its own — every counter in this branch uses this setup.</p>
        </div>
        {branches.length > 1 && (
          <Field label="Branch" className="w-56">
            <Select value={branchId} onChange={(e) => setPicked(e.target.value)}>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}{b.id === me?.branch.id ? ' (current)' : ''}</option>)}
            </Select>
          </Field>
        )}
      </div>

      <Field label="How do you print bills?">
        <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
          {TRANSPORTS.map((x) => (
            <button key={x.key} type="button" disabled={!available(x.key)} onClick={() => set({ transport: x.key })}
              className={clsx('relative flex flex-col items-start gap-1 rounded-xl border-2 p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50',
                s.transport === x.key ? 'border-brand-600 bg-brand-50/50' : 'border-slate-200 hover:border-slate-300')}>
              {s.transport === x.key && <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-white"><Check className="h-3 w-3" /></span>}
              <x.icon className="h-5 w-5 text-slate-600" />
              <span className="text-sm font-semibold">{x.label}</span>
              {!available(x.key) && <span className="text-[11px] text-slate-500">Needs Chrome or Edge</span>}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">{t.hint}</p>
      </Field>

      {s.transport !== 'browser' && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <span className={clsx('h-2.5 w-2.5 rounded-full', s.deviceName ? (isConnected(branchId) ? 'bg-emerald-500' : 'bg-amber-500') : 'bg-slate-300')} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{s.deviceName || 'No printer chosen yet'}</p>
            <p className="text-xs text-slate-500">{s.deviceName ? (isConnected(branchId) ? 'Connected' : 'Remembered — connects on the next print') : 'Switch the printer on, then press Connect and pick it from the list.'} Each device pairs with its own printer.</p>
          </div>
          <Button size="sm" variant={s.deviceName ? 'secondary' : 'primary'} disabled={busy} onClick={() => act(() => choosePrinter(branchId, s, s.transport as Exclude<Transport, 'browser'>), 'Printer connected')}>{s.deviceName ? 'Change' : 'Connect'}</Button>
          {s.deviceName && <Button size="sm" variant="secondary" icon={Printer} disabled={busy} onClick={test}>Test print</Button>}
          {s.deviceName && s.drawer && <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => sendToPrinter(branchId, s, drawerOnly()), 'Drawer opened')}>Open drawer</Button>}
          {s.deviceName && <Button size="sm" variant="ghost" icon={Unplug} disabled={busy} onClick={() => act(() => forgetPrinter(branchId), 'Printer removed')} className="!text-red-600">Forget</Button>}
        </div>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_260px]">
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Paper width">
              <Select value={s.paper ?? ''} onChange={(e) => set({ paper: (e.target.value || null) as Paper | null })}>
                <option value="">Same as Billing settings ({me?.business.billing.paperWidth ?? '80mm'})</option>
                <option value="58mm">58 mm (2 inch)</option>
                <option value="80mm">80 mm (3 inch)</option>
              </Select>
            </Field>
            {s.transport !== 'browser' && (
              <Field label="Print style" hint={s.mode === 'auto' ? 'Text for English bills; image when a bill has Tamil or other script names.' : s.mode === 'image' ? 'Any language. A little slower on old printers.' : 'Fastest. English only — other scripts print as “?”.'}>
                <Segmented size="sm" block value={s.mode} onChange={(v) => set({ mode: v })} options={[{ value: 'auto', label: 'Auto' }, { value: 'text', label: 'Text' }, { value: 'image', label: 'Image' }]} />
              </Field>
            )}
            {s.transport === 'serial' && (
              <Field label="Baud rate" hint="Usually 9600 or 115200 — see the printer’s self-test page.">
                <Select value={s.baudRate} onChange={(e) => set({ baudRate: Number(e.target.value) })}>
                  {[9600, 19200, 38400, 57600, 115200].map((b) => <option key={b} value={b}>{b}</option>)}
                </Select>
              </Field>
            )}
            {s.transport !== 'browser' && (
              <Field label="Copies per bill">
                <Segmented size="sm" block value={String(s.copies)} onChange={(v) => set({ copies: Number(v) })} options={['1', '2', '3'].map((v) => ({ value: v, label: v }))} />
              </Field>
            )}
          </div>
          <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            <Row title="Print automatically after payment" desc={s.transport === 'browser' ? 'Opens the print dialog right after each bill.' : 'The bill prints the moment payment is saved — no clicks.'}>
              <Toggle checked={s.autoPrint} onChange={(v) => set({ autoPrint: v })} label="Auto print" />
            </Row>
            {s.transport !== 'browser' && <>
              <Row title="Cut paper after each bill" desc="For printers with an auto-cutter."><Toggle checked={s.cut} onChange={(v) => set({ cut: v })} label="Cut paper" /></Row>
              <Row title="Open cash drawer on cash bills" desc="Drawer plugged into the printer’s RJ11 port."><Toggle checked={s.drawer} onChange={(v) => set({ drawer: v })} label="Cash drawer" /></Row>
            </>}
          </div>
          <div className="flex gap-2.5 rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
            <div className="space-y-1">
              {s.transport === 'browser' && <p>For silent printing with the dialog, start Chrome with <code className="rounded bg-white px-1">--kiosk-printing</code> and set the thermal printer as default.</p>}
              {s.transport === 'usb' && <p>Windows: if the printer doesn’t appear or says “in use”, install the WinUSB driver for it (Zadig). Mac, Linux and Android work as is.</p>}
              {s.transport === 'serial' && <p>Pair Bluetooth printers in Windows Settings first; they show up here as a COM port.</p>}
              {s.transport === 'bluetooth' && <p>Turn on Bluetooth and Location on the phone. The printer must be switched on and not connected to another phone.</p>}
              <p>Works with ESC/POS printers — TVS, Epson, Everycom, Rugtek, Posiflex, Xprinter and most 58 / 80 mm printers.</p>
            </div>
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium text-slate-600">Test page preview ({paper})</p>
          <div className="rounded-xl bg-slate-100 p-3" data-no-i18n>{preview && <img src={preview} alt="Test page preview" className="mx-auto w-full max-w-[240px] bg-white shadow ring-1 ring-slate-200" />}</div>
        </div>
      </div>
    </Card>
  )
}

const Row = ({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) => (
  <div className="flex items-center gap-4 px-4 py-3">
    <div className="min-w-0 flex-1"><p className="text-sm font-medium">{title}</p><p className="text-xs text-slate-500">{desc}</p></div>
    {children}
  </div>
)
