import { useMemo, useState } from 'react'
import { useApp } from '@/app/AppContext'
import { makeItem, mergeInto } from '@/core/orderItem'
import { computeTotals, r2 } from '@/core/pricing'
import type { BillingSettings, OrderItem, Product } from '@/core/types'

/** Shared cart state for POS, table orders and mobile ordering. */
export function useCart(initial: OrderItem[] = [], initialDiscount = 0, billingOverride?: BillingSettings) {
  const { me } = useApp()
  const [items, setItems] = useState<OrderItem[]>(initial)
  const [discount, setDiscount] = useState(initialDiscount)
  const billing = billingOverride ?? me!.business.billing
  const totals = useMemo(() => computeTotals(items, discount, billing), [items, discount, billing])
  const count = useMemo(() => r2(items.reduce((a, i) => a + i.qty, 0)), [items])

  return {
    items, discount, totals, count,
    setItems, setDiscount,
    add: (item: OrderItem) => setItems((x) => mergeInto(x, item)),
    addProduct: (p: Product) => setItems((x) => mergeInto(x, makeItem(p, billing))),
    setQty: (id: string, qty: number) => setItems((x) => (qty <= 0 ? x.filter((i) => i.id !== id) : x.map((i) => (i.id === id ? { ...i, qty } : i)))),
    remove: (id: string) => setItems((x) => x.filter((i) => i.id !== id)),
    qtyOf: (productId: string) => items.filter((i) => i.productId === productId).reduce((a, i) => a + i.qty, 0),
    reset: (next: OrderItem[] = [], d = 0) => { setItems(next); setDiscount(d) },
  }
}
export type Cart = ReturnType<typeof useCart>
