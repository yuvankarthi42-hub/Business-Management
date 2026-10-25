import clsx from 'clsx'
import { Check, Download, Flame, ImageDown, Send, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApp, useData } from '@/app/AppContext'
import { Button, Checkbox, Drawer, Input, Segmented, useAction } from '@/components/ui'
import { Thumb } from '@/components/Thumb'
import { applySpecials } from '@/core/specials'
import { renderTemplate, waCopyFor } from '@/core/whatsapp'
import { isValidPhone, formatPhone } from '@/core/phone'
import { api } from '@/data'
import { fmtTime, money } from '@/lib/format'
import { drawSpecialsPoster } from '@/lib/poster'
import { MsgStatusOf } from './whatsapp/Integrations'
import { useWhatsApp } from './whatsapp/useWhatsApp'

type Base = 'all' | 'recent' | 'top' | 'due'

/**
 * Send today's offer through the WhatsApp Business integration — one click for everyone selected.
 * Only reachable when the offer template is approved (see Customers page).
 */
export function OfferShareDrawer({ onClose }: { onClose: () => void }) {
  const { me, mod } = useApp()
  const run = useAction()
  const wa = useWhatsApp(true)
  const b = me!.business
  const { data: specials = [] } = useData(() => (mod('specials') ? api.specials.list() : Promise.resolve([])))
  const { data: products = [] } = useData(() => api.products.list())
  const { data: customers = [] } = useData(() => api.customers.list())
  // Only today's offer messages (who already got today's offer) — read once; a send refreshes it.
  const dayStart = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString() }, [])
  const { data: messages = [] } = useData(() => api.whatsapp.messages({ kind: 'offer', since: dayStart, limit: 1000 }), [dayStart])
  const sp = useMemo(() => applySpecials(products, specials), [products, specials])

  const [picked, setPicked] = useState<string[] | null>(null) // null = all specials
  const [details, setDetails] = useState('')
  const [edited, setEdited] = useState(false)
  const [base, setBase] = useState<Base>('recent')
  const [poster, setPoster] = useState<{ url: string; blob: Blob } | null>(null)
  const [withPoster, setWithPoster] = useState(true)
  const [result, setResult] = useState<{ sent: number; skipped: number } | null>(null)

  const chosen = picked ?? sp.specials.map((p) => p.id)
  const autoDetails = () => sp.specials.filter((p) => chosen.includes(p.id)).map((p) => {
    const info = sp.info.get(p.id)!
    const offer = info.special.specialPrice != null && !p.variants.length && info.special.specialPrice < info.originalPrice
    const price = p.variants.length ? `from ${money(Math.min(...p.variants.map((v) => v.price)))}` : money(p.price)
    return `${p.name} ${price}${offer ? ` (was ${money(info.originalPrice)})` : ''}`
  }).join(', ')
  // WhatsApp fields are one line, so the offer is a comma-separated list. Kept in sync until edited.
  useEffect(() => { if (!edited) setDetails(autoDetails()) }, [chosen.join(','), sp, edited]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- audience ----------
  const today = new Date().toISOString().slice(0, 10)
  const sentToday = useMemo(() => new Map(messages.filter((m) => m.kind === 'offer' && m.createdAt.slice(0, 10) === today && m.customerId).map((m) => [m.customerId!, m])), [messages, today])
  const withPhone = customers.filter((c) => isValidPhone(c.phone))
  const top10 = new Set([...withPhone].sort((a, x) => x.stats.totalPurchases - a.stats.totalPurchases).slice(0, 10).map((c) => c.id))
  const monthAgo = Date.now() - 30 * 86400000
  const inBase = (c: (typeof customers)[number]) =>
    base === 'all' ? true : base === 'recent' ? !!c.stats.lastPurchase && new Date(c.stats.lastPurchase).getTime() >= monthAgo
      : base === 'top' ? top10.has(c.id) : c.stats.outstanding > 0
  const audience = withPhone.filter(inBase)
  const optedOut = audience.filter((c) => c.marketingOptIn === false).length
  const recipients = audience.filter((c) => c.marketingOptIn !== false && !sentToday.has(c.id))
  const alreadySent = audience.filter((c) => sentToday.has(c.id))

  const makePoster = async () => {
    const items = sp.specials.filter((p) => chosen.includes(p.id)).map((p) => {
      const info = sp.info.get(p.id)!
      const offer = info.special.specialPrice != null && !p.variants.length && info.special.specialPrice < info.originalPrice
      return { name: p.name, emoji: p.emoji, imageUrl: p.imageUrl, tag: info.special.tag, price: p.variants.length ? `${money(Math.min(...p.variants.map((v) => v.price)))}+` : money(p.price), was: offer ? money(info.originalPrice) : undefined }
    })
    const blob = await drawSpecialsPoster({ business: b.name, subtitle: b.subType, date: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), items, footer: b.phone || b.address })
    if (poster) URL.revokeObjectURL(poster.url)
    setPoster({ url: URL.createObjectURL(blob), blob })
    return blob
  }
  const downloadPoster = async () => {
    const blob = poster?.blob ?? await makePoster()
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `offer-${today}.png`; a.click()
  }
  useEffect(() => () => { if (poster) URL.revokeObjectURL(poster.url) }, [poster])

  const t = wa?.config?.templates.offer
  const preview = t ? renderTemplate(t.body, { customer_name: recipients[0]?.name.split(' ')[0] ?? 'Kumar', shop_name: b.name, offer_details: details || '…' }) : ''
  const send = () => run(async () => {
    setResult(await api.whatsapp.sendOffer({ details, customerIds: recipients.map((c) => c.id), productIds: chosen, poster: withPoster }))
  }, undefined)

  return (
    <Drawer open onClose={onClose} width="max-w-3xl" title="Send offer on WhatsApp" subtitle={`From your WhatsApp Business number${wa?.config?.verified ? ` ${formatPhone(wa.config.verified.number)}` : ''} · sent directly to everyone selected`}>
      <div className="space-y-5 p-5">
        <section className="rounded-xl border border-slate-200">
          <Head n={1} title="Offer" />
          <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_260px]">
            <div className="min-w-0 space-y-3">
              {sp.specials.length ? (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-slate-600">Include today’s specials</p>
                  <div className="flex flex-wrap gap-1.5">
                    {sp.specials.map((p) => {
                      const on = chosen.includes(p.id)
                      return (
                        <button key={p.id} type="button" onClick={() => { setPicked(on ? chosen.filter((x) => x !== p.id) : [...chosen, p.id]); setEdited(false) }}
                          className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition', on ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-500')}>
                          {on ? <Check className="h-3 w-3" /> : <Thumb item={p} className="h-4 w-4 rounded-full text-[11px]" />}{p.name}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ) : (
                <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800"><Flame className="h-4 w-4" />{mod('specials') ? <>No specials set for today. <Link to="/specials" className="font-semibold underline" onClick={onClose}>Add specials</Link> or write the offer below.</> : 'Write today’s offer below.'}</p>
              )}
              <div>
                <p className="mb-1.5 text-xs font-medium text-slate-600">Offer details <span className="font-normal text-slate-400">· fills the “Offer details” part of your approved template</span></p>
                <Input value={details} onChange={(e) => { setDetails(e.target.value); setEdited(true) }} maxLength={300} placeholder={waCopyFor(b).offerSample} />
                <p className="mt-1 text-[11px] text-slate-400">{details.length}/300 · one line (WhatsApp doesn’t allow new lines here)</p>
              </div>
              {t?.attach && (
                <div className="flex flex-wrap items-center gap-2">
                  <Checkbox checked={withPoster} onChange={setWithPoster} label="Attach offer poster" />
                  <Button size="sm" variant="ghost" icon={ImageDown} write={false} onClick={makePoster}>{poster ? 'Refresh poster' : 'Make poster'}</Button>
                  <Button size="sm" variant="ghost" icon={Download} onClick={downloadPoster}>Download poster</Button>
                </div>
              )}
            </div>
            <div className="rounded-xl bg-[#e5ddd5] p-3" data-no-i18n>
              <p className="mb-2 text-[11px] font-medium text-slate-600">Preview</p>
              <div className="ml-auto max-w-[240px] overflow-hidden rounded-lg rounded-tr-none bg-[#dcf8c6] shadow-sm">
                {t?.attach && withPoster && (poster ? <img src={poster.url} alt="Offer poster" className="w-full" /> : <div className="flex h-20 items-center justify-center bg-amber-100 text-xs text-amber-800">Offer poster</div>)}
                <p className="whitespace-pre-wrap break-words px-2.5 py-2 text-[12.5px] leading-snug text-slate-800">{preview}</p>
                <p className="px-2.5 pb-1.5 text-right text-[10px] text-slate-500">{fmtTime(new Date())}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200">
          <Head n={2} title="Who gets it" right={<span className="text-sm text-slate-500"><b className="text-slate-900">{recipients.length}</b> customers</span>} />
          <div className="space-y-2 p-4">
            <Segmented value={base} onChange={setBase} options={[
              { value: 'recent', label: 'Visited in 30 days' },
              { value: 'all', label: 'All with mobile', count: withPhone.length },
              { value: 'top', label: 'Top 10 spenders' },
              { value: 'due', label: 'Has outstanding' },
            ]} />
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1"><ShieldCheck className="h-4 w-4 text-emerald-600" />Only customers OK with offers (WhatsApp rule)</span>
              {optedOut > 0 && <span>{optedOut} said no to offers</span>}
              {alreadySent.length > 0 && <span>{alreadySent.length} already got today’s offer</span>}
            </p>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200">
          <Head n={3} title="Send" />
          <div className="p-4">
            {result && <p className="mb-3 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800"><Check className="h-4 w-4" />Sent to {result.sent} customer{result.sent === 1 ? '' : 's'}{result.skipped ? ` · ${result.skipped} skipped` : ''}</p>}
            <Button icon={Send} disabled={!recipients.length || details.trim().length < 3} onClick={send}>Send to {recipients.length} customer{recipients.length === 1 ? '' : 's'}</Button>
            <p className="mt-2 text-xs text-slate-500">Meta charges your WhatsApp Business account for each marketing message.</p>
          </div>
          {alreadySent.length > 0 && (
            <ul className="max-h-[280px] divide-y divide-slate-100 overflow-y-auto border-t border-slate-100">
              {alreadySent.map((c) => {
                const m = sentToday.get(c.id)!
                return (
                  <li key={c.id} className="flex items-center gap-3 px-4 py-2">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">{c.name[0]}</span>
                    <span className="min-w-0 flex-1 truncate text-sm">{c.name} <span className="text-xs text-slate-500">· {formatPhone(c.phone)}</span></span>
                    <span className="text-xs"><MsgStatusOf m={m} /> <span className="text-slate-400">{fmtTime(m.createdAt)}</span></span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  )
}

function Head({ n, title, right }: { n: number; title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5">
      <p className="flex items-center gap-2 text-sm font-semibold"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-900 text-[11px] text-white">{n}</span>{title}</p>
      {right}
    </div>
  )
}
