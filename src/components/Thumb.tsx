import clsx from 'clsx'
import { ImagePlus, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { api } from '@/data'
import { Button, Input } from './ui'

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)

const initials = (name: string) => name.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w[0] ?? '')).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '•'

/**
 * Product / category picture: the photo when there is one, otherwise the emoji.
 * `className` sizes the box (e.g. "h-12 w-12 rounded-lg text-2xl").
 */
export function Thumb({ item, className, alt, full }: {
  item: { emoji: string; imageUrl?: string | null; thumbUrl?: string | null; name?: string }; className?: string; alt?: string
  /** Large tiles use the full photo (≤ 50 KB, 800 px); small icons use the 320 px thumbnail. */
  full?: boolean
}) {
  const src = full ? item.imageUrl : item.thumbUrl || item.imageUrl
  return (
    <span className={clsx('inline-flex shrink-0 items-center justify-center overflow-hidden', className)}>
      {src
        ? <img src={src} alt={alt ?? item.name ?? ''} className="h-full w-full object-cover" loading="lazy" draggable={false} />
        : item.emoji
          ? <span aria-hidden="true">{item.emoji}</span>
          : <span aria-hidden="true" className="text-[0.55em] font-semibold tracking-wide text-slate-600">{initials(item.name ?? alt ?? '')}</span>}
    </span>
  )
}

/** Photo upload with emoji fallback, used in the item and category forms. */
export function ImagePicker({ imageUrl, emoji, onChange, compact }: {
  imageUrl: string | null | undefined; emoji: string; onChange: (v: { imageUrl?: string | null; thumbUrl?: string | null; emoji?: string }) => void; compact?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pick = async (file?: File) => {
    if (!file) return
    setError(''); setBusy(true)
    // The original goes to the upload API, which compresses it (≤ 50 KB) before storing.
    try { const r = await api.media.upload(file); onChange({ imageUrl: r.url, thumbUrl: r.thumbUrl }) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className={clsx('flex gap-3', compact ? 'items-center' : 'items-start')}>
      <button
        type="button" onClick={() => input.current?.click()} aria-label="Upload photo"
        onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files[0]) }}
        className={clsx('group relative shrink-0 overflow-hidden rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 transition hover:border-brand-400',
          compact ? 'h-12 w-12' : 'h-24 w-24')}
      >
        <Thumb item={{ emoji, imageUrl }} className={clsx('h-full w-full', compact ? 'text-2xl' : 'text-4xl')} />
        <span className="absolute inset-0 flex items-center justify-center bg-slate-900/45 text-white opacity-0 transition group-hover:opacity-100"><ImagePlus className="h-5 w-5" /></span>
        {busy && <span className="absolute inset-0 flex items-center justify-center bg-white/70 text-xs">…</span>}
      </button>
      <input ref={input} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = '' }} />
      {!compact && (
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="secondary" icon={ImagePlus} onClick={() => input.current?.click()}>{imageUrl ? 'Change photo' : 'Upload photo'}</Button>
            {imageUrl && <Button type="button" size="sm" variant="ghost" icon={Trash2} className="!text-red-600" onClick={() => onChange({ imageUrl: null, thumbUrl: null })}>Remove</Button>}
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="whitespace-nowrap">{imageUrl ? 'Fallback emoji' : 'Or emoji'}</span>
            <Input value={emoji} onChange={(e) => onChange({ emoji: e.target.value })} className="h-8 w-14 text-center text-lg" maxLength={4} aria-label="Emoji" />
          </div>
          {error ? <p className="text-xs text-red-600">{error}</p> : <p className="text-[11px] text-slate-400">Any JPG, PNG or WebP up to 50 MB — saved small (under 50 KB). Drag & drop supported.</p>}
        </div>
      )}
      {compact && error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}

/** Category chip label with its photo or emoji. */
export function CategoryLabel({ c }: { c: { name: string; emoji: string; imageUrl?: string | null } }) {
  return <span className="inline-flex items-center gap-1.5"><Thumb item={c} className="h-4 w-4 rounded-full text-[13px]" />{c.name}</span>
}

/** Large square photo drop zone for the item form (no emoji fallback). */
export function PhotoDrop({ imageUrl, onChange, size = 176 }: { imageUrl: string | null | undefined; onChange: (img: { imageUrl: string; thumbUrl: string } | null) => void; size?: number }) {
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const [info, setInfo] = useState('')
  const pick = async (file?: File) => {
    if (!file) return
    setError(''); setInfo(''); setBusy(true)
    // The original goes to the upload API, which compresses it (≤ 50 KB) before storing.
    try {
      const r = await api.media.upload(file)
      onChange({ imageUrl: r.url, thumbUrl: r.thumbUrl })
      setInfo(`${kb(r.originalBytes)} → ${kb(r.bytes)} · ${r.width}×${r.height}`)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div style={{ width: size }}>
      <div
        role="button" tabIndex={0} aria-label={imageUrl ? 'Change photo' : 'Add photo'}
        onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click() } }}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files[0]) }}
        style={{ height: size }}
        className={clsx('group relative cursor-pointer overflow-hidden rounded-2xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
          imageUrl ? 'border border-slate-200' : 'border-2 border-dashed',
          over ? 'border-brand-500 bg-brand-50' : !imageUrl && 'border-slate-300 bg-slate-50 hover:border-brand-400 hover:bg-brand-50/40')}
      >
        {imageUrl ? (
          <>
            <img src={imageUrl} alt="Item photo" className="h-full w-full object-cover" />
            <div className="absolute inset-x-0 bottom-0 flex gap-1.5 bg-gradient-to-t from-slate-900/70 to-transparent p-2 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
              <button type="button" onClick={(e) => { e.stopPropagation(); input.current?.click() }} className="flex-1 rounded-lg bg-white/95 py-1.5 text-xs font-semibold text-slate-800 hover:bg-white">Change</button>
              <button type="button" onClick={(e) => { e.stopPropagation(); onChange(null); setInfo('') }} className="rounded-lg bg-white/95 px-2.5 py-1.5 text-red-600 hover:bg-white" aria-label="Remove photo"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-3 text-center">
            <ImagePlus className="h-7 w-7 text-brand-600" />
            <span className="text-sm font-semibold text-brand-700">Add photo</span>
            <span className="text-xs leading-snug text-slate-500">Drag here or click<br />JPG, PNG, WebP · any size</span>
          </div>
        )}
        {busy && <div className="absolute inset-0 flex items-center justify-center bg-white/75 text-xs font-medium text-slate-600">Compressing…</div>}
      </div>
      <input ref={input} type="file" accept="image/*" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = '' }} />
      {error ? <p className="mt-1.5 text-center text-xs text-red-600">{error}</p>
        : <p className="mt-1.5 text-center text-xs text-slate-400" data-no-i18n={info ? true : undefined}>{info ? `Saved ${info}` : imageUrl ? 'Hover to change' : 'Optional'}</p>}
    </div>
  )
}
