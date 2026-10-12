import clsx from 'clsx'
import { Thumb } from '@/components/Thumb'
import { Flame, Maximize2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useData, useNow } from '@/app/AppContext'
import { QrImage } from '@/components/Qr'
import { api } from '@/data'
import { money, setCurrencySymbol } from '@/lib/format'
import { priceLabel } from '@/features/Catalog'

const PAGE = 6

/** Full-screen "Today's Specials" board for a TV at the counter. No login needed. */
export default function SpecialsDisplay() {
  const { businessId = '' } = useParams()
  const now = useNow(1000)
  const { data, error } = useData(() => api.public.specials(businessId), [businessId])
  const [page, setPage] = useState(0)
  const pages = Math.max(1, Math.ceil((data?.items.length ?? 0) / PAGE))
  useEffect(() => { const id = setInterval(() => setPage((p) => (p + 1) % pages), 8000); return () => clearInterval(id) }, [pages])
  useEffect(() => { if (data) setCurrencySymbol(data.business.currencySymbol) }, [data])

  if (error) return <div className="flex h-[100dvh] items-center justify-center bg-navy-900 text-slate-300">Display not available on this device.</div>
  if (!data) return <div className="h-[100dvh] bg-navy-900" />
  const items = data.items.slice((page % pages) * PAGE, (page % pages) * PAGE + PAGE)
  const orderUrl = `${data.business.qr.baseUrl}/q/${businessId}`

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-gradient-to-br from-navy-900 via-navy-800 to-[#2a1a0e] text-white">
      <header className="flex items-center gap-4 px-8 py-6">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10 text-3xl">{data.business.logoEmoji}</span>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight lg:text-3xl">{data.business.name}</h1>
          <p className="text-sm text-slate-300">{data.business.subType}</p>
        </div>
        <div className="text-right">
          <p className="text-3xl font-semibold tabular lg:text-4xl">{new Date(now).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</p>
          <p className="text-sm text-slate-300">{new Date(now).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
        <button onClick={() => document.documentElement.requestFullscreen?.()} className="rounded-lg p-2 text-slate-400 hover:bg-white/10" aria-label="Full screen"><Maximize2 className="h-5 w-5" /></button>
      </header>

      <div className="flex items-center gap-3 px-8">
        <Flame className="h-8 w-8 text-orange-400" />
        <h2 className="text-3xl font-bold lg:text-5xl">Today’s Specials</h2>
        {pages > 1 && <div className="ml-auto flex gap-1.5">{Array.from({ length: pages }).map((_, i) => <span key={i} className={clsx('h-2 w-8 rounded-full', i === page % pages ? 'bg-orange-400' : 'bg-white/20')} />)}</div>}
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto px-8 py-6 no-scrollbar">
        {!items.length ? (
          <div className="flex h-full items-center justify-center text-2xl text-slate-400">Specials will be announced soon</div>
        ) : (
          <div key={page} className="grid grid-cols-1 content-start gap-5 animate-fade sm:grid-cols-2 xl:grid-cols-3">
            {items.map(({ product: p, special, originalPrice }) => {
              const offer = special.specialPrice != null && !p.variants.length && special.specialPrice < originalPrice
              return (
                <article key={p.id} className="relative flex items-center gap-5 overflow-hidden rounded-3xl bg-white/[.07] p-6 ring-1 ring-white/10">
                  <Thumb full item={p} className="h-28 w-28 rounded-full bg-white/10 text-7xl" />
                  <div className="min-w-0">
                    {special.tag && <span className="inline-block rounded-full bg-orange-500 px-3 py-1 text-xs font-bold uppercase tracking-wide">{special.tag}</span>}
                    <h3 className="mt-2 text-2xl font-bold leading-tight lg:text-3xl">{p.name}</h3>
                    <p className="mt-1 flex items-center gap-2 text-sm text-slate-300">
                      <span className={clsx('inline-block h-3 w-3 rounded-sm border-2', p.isVeg ? 'border-emerald-400' : 'border-red-400')} />{p.isVeg ? 'Veg' : 'Non-veg'}
                    </p>
                    <p className="mt-2 flex items-baseline gap-3">
                      <span className="text-3xl font-extrabold text-orange-300 lg:text-4xl">{priceLabel(p)}</span>
                      {offer && <span className="text-xl text-slate-400 line-through">{money(originalPrice)}</span>}
                    </p>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </main>

      {data.business.qrOn && (
        <footer className="flex items-center justify-end gap-4 px-8 pb-6">
          <div className="text-right">
            <p className="text-lg font-semibold">Scan to order</p>
            <p className="text-sm text-slate-300">Takeaway & delivery</p>
          </div>
          <div className="rounded-xl bg-white p-2"><QrImage value={orderUrl} size={96} /></div>
        </footer>
      )}
    </div>
  )
}
