import { useMemo, useState } from 'react'
import { useApp } from '@/app/AppContext'
import { makeItem, mergeInto } from '@/core/orderItem'
import { loyaltyOf, pointsValue } from '@/core/loyalty'
import { computeTotals, r2 } from '@/core/pricing'
import type { BillingSettings, OrderItem, Product } from '@/core/types'

/** Shared cart state for POS, table orders and mobile ordering. */
export function useCart(initial: OrderItem[] = [], initialDiscount = 0, billingOverride?: BillingSettings) {
  const { me } = useApp()
  const [items, setItems] = useState<OrderItem[]>(initial)
  const [discount, setDiscount] = useState(initialDiscount)
  // Loyalty points used on this bill: their value is a discount before GST (the server checks the rules again).
  const [points, setPoints] = useState(0)
  const billing = billingOverride ?? me!.business.billing
  const pointsOff = points > 0 && me ? pointsValue(loyaltyOf(me.business), points) : 0
  const totals = useMemo(() => computeTotals(items, r2(discount + pointsOff), billing), [items, discount, pointsOff, billing])
  /** Total before points — what the points limit (% of the bill) is worked out on. */
  const totalBeforePoints = useMemo(() => (pointsOff ? computeTotals(items, discount, billing).total : totals.total), [items, discount, pointsOff, billing, totals.total])
  const count = useMemo(() => r2(items.reduce((a, i) => a + i.qty, 0)), [items])

  return {
    items, discount, totals, count, points, pointsOff, totalBeforePoints,
    setItems, setDiscount, setPoints,
    add: (item: OrderItem) => setItems((x) => mergeInto(x, item)),
    addProduct: (p: Product) => setItems((x) => mergeInto(x, makeItem(p, billing))),
    setQty: (id: string, qty: number) => setItems((x) => (qty <= 0 ? x.filter((i) => i.id !== id) : x.map((i) => (i.id === id ? { ...i, qty } : i)))),
    remove: (id: string) => setItems((x) => x.filter((i) => i.id !== id)),
    qtyOf: (productId: string) => items.filter((i) => i.productId === productId).reduce((a, i) => a + i.qty, 0),
    reset: (next: OrderItem[] = [], d = 0) => { setItems(next); setDiscount(d); setPoints(0) },
  }
}
export type Cart = ReturnType<typeof useCart>
