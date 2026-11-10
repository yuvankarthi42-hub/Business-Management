// A large shop's products come from the light index (core/catalogIndex.ts): sizes, add-ons, textile details and the
// full photo are read only when an item is opened. These give the full product — at once for a full one (small
// shops: nothing changes), with one small read for a light one.
import { useEffect, useState } from 'react'
import type { Product } from '@/core/types'
import { api } from '@/data'

/** The full product (one read, cached, for a light one). */
export async function fullProduct(p: Product): Promise<Product> {
  if (!p.light) return p
  const [full] = await api.products.full([p.id])
  return full ? { ...full, stock: p.stock, stockByBranch: p.stockByBranch } : p // stock: the list's (patched after each bill)
}
/** Several at once (≤ 100 per read). */
export async function fullProducts(list: Product[]): Promise<Product[]> {
  const light = list.filter((p) => p.light)
  if (!light.length) return list
  const got = new Map<string, Product>()
  for (let i = 0; i < light.length; i += 100) for (const f of await api.products.full(light.slice(i, i + 100).map((p) => p.id))) got.set(f.id, f)
  return list.map((p) => { const f = got.get(p.id); return p.light && f ? { ...f, stock: p.stock, stockByBranch: p.stockByBranch } : p })
}

/** For a screen holding a product that may be light: the full one (null while it is read). */
export function useFullProduct(p: Product | null): Product | null {
  const [full, setFull] = useState<Product | null>(p && !p.light ? p : null)
  useEffect(() => {
    if (!p) { setFull(null); return }
    if (!p.light) { setFull(p); return }
    let on = true
    setFull(null)
    fullProduct(p).then((x) => { if (on) setFull(x) }).catch(() => { if (on) setFull(p) })
    return () => { on = false }
  }, [p])
  return full
}

/**
 * For screens that pick items from the list and then need their details (labels, offers): the full products of
 * `ids` (read once, ≤ 100 per read), falling back to the list's row while they come.
 */
export function useFullLookup(products: Product[], ids: string[]): (id: string) => Product | undefined {
  const [fulls, setFulls] = useState<Map<string, Product>>(new Map())
  const want = ids.filter((id) => products.find((p) => p.id === id)?.light && !fulls.has(id))
  const key = want.join(',')
  useEffect(() => {
    if (!want.length) return
    let on = true
    fullProducts(want.map((id) => products.find((p) => p.id === id)!).filter(Boolean))
      .then((got) => { if (on) setFulls((m) => { const n = new Map(m); for (const g of got) n.set(g.id, g); return n }) })
      .catch(() => { /* the list's rows stay */ })
    return () => { on = false }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return (id: string) => fulls.get(id) ?? products.find((p) => p.id === id)
}
