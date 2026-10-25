import clsx from 'clsx'
import { CategoryLabel, Thumb } from '@/components/Thumb'
import { PackageSearch } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { EmptyState, VegMark } from '@/components/ui'
import type { Product } from '@/core/types'
import { api } from '@/data'
import { money } from '@/lib/format'
import { applySpecials, type SpecialInfo } from '@/core/specials'
import { optionsJustClosed } from './ItemOptions'

const TINTS = ['bg-orange-50', 'bg-amber-50', 'bg-rose-50', 'bg-emerald-50', 'bg-sky-50', 'bg-violet-50', 'bg-lime-50', 'bg-pink-50']
export const tintFor = (id: string) => TINTS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % TINTS.length]

export const priceLabel = (p: Product) =>
  p.variants.length ? `${money(Math.min(...p.variants.map((v) => v.price)))}${p.variants.length > 1 ? '+' : ''}` : money(p.price)

/** Active catalogue + category/search filtering + "Popular" (best sellers in the last 7 days). */
export function useCatalog() {
  const { mod } = useApp()
  const { data: rawProducts = [] } = useData(() => api.products.list())
  const { data: todays = [] } = useData(() => (mod('specials') ? api.specials.list() : Promise.resolve([])))
  const sp = useMemo(() => applySpecials(rawProducts, todays), [rawProducts, todays])
  const products = sp.products
  const { data: categories = [] } = useData(() => api.categories.list())
  // Quick picks: last 7 finished days' best sellers (cached on the server; no sales figures needed).
  const { data: popular = [] } = useData(() => api.reports.topProducts(7, 12).then((t) => t.map((p) => p.productId)))
  const [cat, setCat] = useState<string>('all')
  const [q, setQ] = useState('')
  const active = useMemo(() => products.filter((p) => p.active), [products])
  const visible = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (s) return active.filter((p) => p.name.toLowerCase().includes(s) || p.sku.toLowerCase() === s || (p.barcode && p.barcode === s))
    if (cat === 'specials') return sp.specials.filter((p) => p.active)
    if (cat === 'popular') return popular.map((id) => active.find((p) => p.id === id)).filter(Boolean) as Product[]
    return cat === 'all' ? active : active.filter((p) => p.categoryId === cat)
  }, [active, cat, q, popular, sp])
  const chips = [
    { value: 'all', label: 'All' },
    ...(sp.specials.length ? [{ value: 'specials', label: '🔥 Today’s Special' }] : []),
    ...(popular.length ? [{ value: 'popular', label: '⭐ Popular' }] : []),
    ...categories.filter((c) => active.some((p) => p.categoryId === c.id)).map((c) => ({ value: c.id, label: <CategoryLabel c={c} /> })),
  ]
  return { products: active, categories, visible, cat, setCat, q, setQ, chips, specialInfo: sp.info }
}

export function ProductGrid({ products, onPick, qtyOf, dense, specials }: { products: Product[]; onPick: (p: Product) => void; qtyOf?: (id: string) => number; dense?: boolean; specials?: Map<string, SpecialInfo> }) {
  const { t, mod, me } = useApp()
  const food = me?.business.category === 'food' || me?.business.category === 'restaurant'
  if (!products.length) return <EmptyState icon={PackageSearch} title={`No ${t('product', true).toLowerCase()} found`} description="Try another search or category." />
  return (
    <div className={clsx('grid gap-2.5', dense ? 'grid-cols-[repeat(auto-fill,minmax(118px,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(132px,1fr))]')}>
      {products.map((p) => {
        const inCart = qtyOf?.(p.id) ?? 0
        const out = mod('inventory') && p.trackStock && p.stock <= 0
        const low = mod('inventory') && p.trackStock && !out && p.stock <= p.lowStockAt
        const special = specials?.get(p.id)
        return (
          <button
            key={p.id} onClick={() => { if (!optionsJustClosed()) onPick(p) }} disabled={out}
            className={clsx('group relative flex flex-col rounded-xl border bg-white p-2 text-left transition active:scale-[.98] disabled:opacity-50',
              inCart ? 'border-brand-500 ring-2 ring-brand-500/15' : 'border-slate-200 hover:border-slate-300 hover:shadow-card')}
          >
            <Thumb full item={p} className={clsx('aspect-[4/3] w-full rounded-lg text-4xl transition group-hover:scale-[1.02]', tintFor(p.id))} />
            <div className="mt-2 flex items-start gap-1.5 px-0.5">
              {food && p.kind === 'goods' && <span className="mt-[3px]"><VegMark veg={p.isVeg} /></span>}
              <span className="line-clamp-2 text-[13px] font-medium leading-tight text-slate-800">{p.name}</span>
            </div>
            <div className="mt-auto flex items-center justify-between px-0.5 pt-1">
              <span className="text-[13px] font-semibold text-slate-900">
                {priceLabel(p)}
                {special && special.special.specialPrice != null && !p.variants.length && <span className="ml-1 text-[11px] font-normal text-slate-400 line-through">{money(special.originalPrice)}</span>}
              </span>
              {out ? <span className="text-[10px] font-semibold text-red-600">Out</span> : low ? <span className="text-[10px] font-semibold text-amber-600">{p.stock} left</span> : null}
            </div>
            {special && <span className="absolute left-1.5 top-1.5 rounded-md bg-orange-500 px-1.5 py-0.5 text-[10px] font-bold text-white shadow">🔥 {special.special.tag || 'Special'}</span>}
            {inCart > 0 && <span className="absolute right-1.5 top-1.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-brand-600 px-1.5 text-xs font-bold text-white shadow">{inCart}</span>}
          </button>
        )
      })}
    </div>
  )
}
