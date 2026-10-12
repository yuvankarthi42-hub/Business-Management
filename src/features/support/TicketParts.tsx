import clsx from 'clsx'
import { Camera, ImagePlus, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { Badge, Button, Modal, useToast } from '@/components/ui'
import type { TicketCategory, TicketMessage, TicketPriority, TicketStatus } from '@/core/types'

export const CATEGORY: Record<TicketCategory, string> = { billing: 'Billing / bills', printer: 'Printer / scanner', stock: 'Stock / products', whatsapp: 'WhatsApp', account: 'Account / subscription', other: 'Something else' }
export const PRIORITY: Record<TicketPriority, { label: string; tone: 'slate' | 'blue' | 'amber' | 'red' }> = { low: { label: 'Low', tone: 'slate' }, normal: { label: 'Normal', tone: 'blue' }, high: { label: 'High', tone: 'amber' }, urgent: { label: 'Urgent — billing stopped', tone: 'red' } }
export const STATUS: Record<TicketStatus, { label: string; tone: 'blue' | 'violet' | 'amber' | 'green' | 'slate' }> = { open: { label: 'Open', tone: 'blue' }, in_progress: { label: 'In progress', tone: 'violet' }, waiting: { label: 'Waiting for reply', tone: 'amber' }, resolved: { label: 'Resolved', tone: 'green' }, closed: { label: 'Closed', tone: 'slate' } }
export const StatusBadge = ({ s }: { s: TicketStatus }) => <Badge tone={STATUS[s].tone} dot>{STATUS[s].label}</Badge>
export const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

/** Screenshot picker: attach image files or capture the page behind the dialog. */
export function ScreenshotPicker({ images, onChange, upload, onHide }: {
  images: string[]; onChange: (v: string[]) => void; upload: (b: Blob) => Promise<string>
  /** Shows "Capture this screen". Dialogs render outside #root, so the capture shows the page behind them. */
  onHide?: (hidden: boolean) => void
}) {
  const toast = useToast()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const add = async (files: Blob[]) => {
    if (images.length + files.length > 5) { toast('Up to 5 screenshots', 'error'); return }
    setBusy(true)
    try { const urls: string[] = []; for (const f of files) urls.push(await upload(f)); onChange([...images, ...urls]) } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }
  const capture = async () => {
    setBusy(true); onHide?.(true)
    try {
      await new Promise((r) => setTimeout(r, 250))
      const { default: html2canvas } = await import('html2canvas')
      const root = document.getElementById('root')!
      const canvas = await html2canvas(root, { scale: Math.min(2, window.devicePixelRatio || 1), logging: false, useCORS: true, backgroundColor: '#ffffff', windowWidth: document.documentElement.clientWidth, height: window.innerHeight, y: window.scrollY })
      const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Capture failed'))), 'image/png'))
      onHide?.(false)
      await add([blob])
    } catch (e) { onHide?.(false); toast((e as Error).message || 'Could not capture the screen — attach a screenshot instead', 'error'); setBusy(false) }
  }
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {onHide && <Button type="button" size="sm" variant="secondary" icon={Camera} write={false} disabled={busy} onClick={capture}>Capture this screen</Button>}
        <Button type="button" size="sm" variant="secondary" icon={ImagePlus} write={false} disabled={busy} onClick={() => input.current?.click()}>Attach screenshot</Button>
        {busy && <span className="self-center text-xs text-slate-500">Adding…</span>}
      </div>
      <input ref={input} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) void add(f) }} />
      {images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {images.map((src, i) => (
            <span key={i} className="relative">
              <img src={src} alt={`Screenshot ${i + 1}`} className="h-16 w-24 rounded-lg border border-slate-200 object-cover object-top" />
              <button type="button" aria-label="Remove screenshot" onClick={() => onChange(images.filter((_, j) => j !== i))} className="absolute -right-1.5 -top-1.5 rounded-full bg-slate-900 p-0.5 text-white"><X className="h-3 w-3" /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** Conversation between the shop and the BillPoodum team. `me` = which side is "us". */
export function Thread({ messages, me }: { messages: TicketMessage[]; me: 'customer' | 'admin' }) {
  const [zoom, setZoom] = useState<string | null>(null)
  return (
    <>
      <ul className="space-y-3">
        {messages.map((m) => {
          const mine = m.from === me
          return (
            <li key={m.id} className={clsx('flex', mine ? 'justify-end' : 'justify-start')}>
              <div className={clsx('max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm', mine ? 'rounded-br-md bg-brand-600 text-white' : 'rounded-bl-md bg-slate-100 text-slate-800')}>
                <p className={clsx('mb-0.5 text-[11px] font-semibold', mine ? 'text-white/80' : 'text-slate-500')}>{m.from === 'admin' ? `${m.authorName} · BillPoodum team` : m.authorName} · {when(m.at)}</p>
                {m.text && <p className="whitespace-pre-wrap break-words" data-no-i18n>{m.text}</p>}
                {m.images.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {m.images.map((src, i) => <button key={i} type="button" onClick={() => setZoom(src)} className="overflow-hidden rounded-lg ring-1 ring-black/10"><img src={src} alt={`Screenshot ${i + 1}`} className="h-20 w-32 object-cover object-top" /></button>)}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {zoom && <Modal open onClose={() => setZoom(null)} size="xl" title="Screenshot"><img src={zoom} alt="Screenshot" className="mx-auto max-h-[75vh] rounded-lg" /></Modal>}
    </>
  )
}
