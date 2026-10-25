// Saving a bill exactly once.
//  • While a bill is being saved, another tap on Pay / Collect is ignored (and the button shows it's busy).
//  • The bill keeps one request id until it is saved: if the connection drops after the server saved it, tapping
//    Pay again sends the same id and the server returns that bill instead of making a second one.
//  • If the bill is changed (items, customer, discount, payment), it gets a new id — it's a different bill.
import { useCallback, useRef, useState } from 'react'
import { newRequestId, withRequestId } from '@/data'

export function useSaveOnce() {
  const key = useRef<{ fp: string; id: string } | null>(null)
  const busy = useRef(false)
  const [saving, setSaving] = useState(false)
  /**
   * `fn` returns false when it failed (the id is kept for a retry). Returns undefined when a save is already running.
   * Its first server call uses the bill's id; a second call (e.g. settle after save) can use `withRequestId(`${id}s`, …)`.
   */
  const once = useCallback(async <T,>(bill: unknown, fn: (id: string) => Promise<T>): Promise<T | undefined> => {
    if (busy.current) return undefined
    const fp = JSON.stringify(bill)
    if (!key.current || key.current.fp !== fp) key.current = { fp, id: newRequestId() }
    busy.current = true
    setSaving(true)
    try {
      const id = key.current.id
      const r = await withRequestId(id, () => fn(id))
      if (r !== false) key.current = null // saved: the next bill gets a new id
      return r
    } finally { busy.current = false; setSaving(false) }
  }, [])
  return { once, saving }
}
