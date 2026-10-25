import clsx from 'clsx'
import { ImagePlus, Loader2, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { useApp } from '@/app/AppContext'
import { Button, useAction, useReadOnly } from '@/components/ui'
import { ShopLogo } from '@/components/ShopLogo'
import { BRAND } from '@/core/brand'
import { api } from '@/data'

/** Settings → Business profile: upload / change / remove the shop logo. Without one, the Kadai Kalanjiyam logo is used. */
export function ShopLogoUpload() {
  const { me, refresh } = useApp()
  const run = useAction()
  const readOnly = useReadOnly()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const b = me!.business
  const own = !!b.logoUrl

  const save = async (file: File | null) => {
    setBusy(true)
    await run(async () => { await api.business.setLogo(file); await refresh() }, file ? 'Logo saved' : 'Logo removed')
    setBusy(false)
  }
  const pick = (files: FileList | null) => { const f = files?.[0]; if (f) void save(f) }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-slate-200 p-4 sm:flex-row sm:items-center">
      <div
        role="button" tabIndex={0} aria-label={own ? 'Change logo' : 'Upload logo'}
        onClick={() => !busy && !readOnly && input.current?.click()}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !readOnly) { e.preventDefault(); input.current?.click() } }}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (!readOnly) pick(e.dataTransfer.files) }}
        className={clsx('relative mx-auto flex h-24 w-24 shrink-0 cursor-pointer items-center justify-center rounded-2xl sm:mx-0',
          over ? 'bg-brand-50 ring-2 ring-brand-500' : 'bg-slate-50 ring-1 ring-slate-200 hover:ring-brand-300')}
      >
        <ShopLogo business={b} className="h-20 w-20 !rounded-xl" />
        {busy && <span className="absolute inset-0 flex items-center justify-center rounded-2xl bg-white/70"><Loader2 className="h-6 w-6 animate-spin text-brand-600" /></span>}
      </div>
      <div className="min-w-0 flex-1 text-center sm:text-left">
        <p className="text-sm font-semibold text-slate-900">Shop logo</p>
        <p className="mt-0.5 text-xs text-slate-500">
          {own ? 'Shown on the QR menu, the offers screen and the top bar.' : `No logo yet — the ${BRAND.name} logo is shown. Upload yours to show it on the QR menu and the top bar.`}
        </p>
        <p className="mt-0.5 text-[11px] text-slate-400">PNG, JPG or WebP. A square logo on a white or clear background looks best.</p>
        <div className="mt-2.5 flex flex-wrap justify-center gap-2 sm:justify-start">
          <Button type="button" size="sm" variant="secondary" icon={ImagePlus} disabled={busy || !!readOnly} onClick={() => input.current?.click()}>{own ? 'Change logo' : 'Upload logo'}</Button>
          {own && <Button type="button" size="sm" variant="ghost" icon={Trash2} className="!text-red-600" disabled={busy || !!readOnly} onClick={() => save(null)}>Remove</Button>}
        </div>
      </div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { pick(e.target.files); e.target.value = '' }} />
    </div>
  )
}
