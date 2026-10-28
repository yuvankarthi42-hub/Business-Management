// One square for a category's picture: tap it for a drop-down with Upload photo / Take photo, the emoji
// suggestions for this business type, and "Other" to type any emoji. Dropping an image on the square uploads it.
import clsx from 'clsx'
import { Camera, ChevronDown, ImagePlus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { CategoryEmoji } from '@/core/categoryEmojis'
import { api } from '@/data'
import { Thumb } from './Thumb'

export interface PictureValue { emoji?: string; imageUrl?: string | null; thumbUrl?: string | null }

export function CategoryPicturePicker({ emoji, imageUrl, options, typeLabel, onChange }: {
  emoji: string; imageUrl: string | null | undefined; options: CategoryEmoji[]; typeLabel?: string
  /** `label`: the picked suggestion's name (for the name box hint), '' otherwise. */
  onChange: (v: PictureValue, label: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) return
    const out = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    // Escape closes only this drop-down, not the window around it.
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setOpen(false) } }
    document.addEventListener('mousedown', out)
    window.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('mousedown', out); window.removeEventListener('keydown', esc, true) }
  }, [open])

  const upload = async (f?: File) => {
    if (!f) return
    setError(''); setBusy(true); setOpen(false)
    // The original goes to the upload API, which compresses it (≤ 50 KB) before storing.
    try { const r = await api.media.upload(f); onChange({ imageUrl: r.url, thumbUrl: r.thumbUrl }, '') } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  // An emoji replaces the photo (the square shows what was picked last).
  const pickEmoji = (value: string, label = '') => { onChange({ emoji: value, imageUrl: null, thumbUrl: null }, label); setOpen(false) }

  return (
    <div ref={box} className="relative shrink-0">
      <button type="button" aria-label="Choose a photo or emoji" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files[0]) }}
        className={clsx('relative h-16 w-16 rounded-xl border-2 bg-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
          open ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:border-brand-300')}>
        <span className="absolute inset-0 overflow-hidden rounded-[10px]"><Thumb item={{ emoji, imageUrl }} className="h-full w-full text-3xl" /></span>
        {busy && <span className="absolute inset-0 flex items-center justify-center rounded-[10px] bg-white/75 text-xs text-slate-500">…</span>}
        <span className="absolute -bottom-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 bg-white"><ChevronDown className="h-3 w-3 text-slate-500" /></span>
      </button>
      <input ref={file} type="file" accept="image/*" className="hidden" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = '' }} />
      <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = '' }} />
      {error && <p className="absolute left-0 top-[4.5rem] w-56 text-xs text-red-600">{error}</p>}

      {open && (
        <div className="absolute left-0 top-[4.6rem] z-30 w-72 rounded-xl border border-slate-200 bg-white p-2.5 shadow-lg" role="dialog" aria-label="Photo or emoji">
          <div className="grid grid-cols-2 gap-1.5">
            <button type="button" onClick={() => file.current?.click()} className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50">
              <ImagePlus className="h-4 w-4" />{imageUrl ? 'Change photo' : 'Upload photo'}
            </button>
            <button type="button" onClick={() => camera.current?.click()} className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50">
              <Camera className="h-4 w-4" />Take photo
            </button>
          </div>
          {imageUrl && (
            <button type="button" onClick={() => { onChange({ imageUrl: null, thumbUrl: null }, ''); setOpen(false) }} className="mt-1.5 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-red-600 hover:bg-red-50">
              <Trash2 className="h-3.5 w-3.5" />Remove photo
            </button>
          )}
          <p className="mb-1 mt-2.5 text-[11px] text-slate-400">Or pick an emoji{typeLabel ? ` · ${typeLabel}` : ''}</p>
          <div className="grid max-h-56 grid-cols-6 gap-1 overflow-y-auto" role="listbox" aria-label="Emoji">
            {options.map((o) => (
              <button key={o.emoji + o.label} type="button" role="option" aria-selected={!imageUrl && o.emoji === emoji} title={o.label} aria-label={o.label} onClick={() => pickEmoji(o.emoji, o.label)}
                className={clsx('flex h-10 items-center justify-center rounded-lg text-xl hover:bg-slate-100', !imageUrl && o.emoji === emoji && 'bg-brand-50 ring-1 ring-brand-300')}>
                {o.emoji}
              </button>
            ))}
          </div>
          <label className="mt-2 flex items-center gap-2 border-t border-slate-100 pt-2 text-xs text-slate-500">
            Other
            <input defaultValue="" maxLength={4} placeholder="Type or paste" aria-label="Any other emoji"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const v = e.currentTarget.value.trim(); if (v) pickEmoji(v) } }}
              onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v && v !== emoji) onChange({ emoji: v, imageUrl: null, thumbUrl: null }, '') }}
              className="h-8 w-full rounded-md border border-slate-200 px-2 text-center text-base focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </label>
        </div>
      )}
    </div>
  )
}
