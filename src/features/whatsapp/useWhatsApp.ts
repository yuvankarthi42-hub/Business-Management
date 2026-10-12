import { useApp, useData, useNow } from '@/app/AppContext'
import { api } from '@/data'

export type WaStatus = Awaited<ReturnType<typeof api.whatsapp.status>>

/**
 * WhatsApp integration status for this business, or null when the product admin hasn't released it.
 * `live` re-checks every few seconds (template approval and delivery receipts change over time).
 */
export function useWhatsApp(live = false) {
  const { me } = useApp()
  const on = !!me?.features.whatsapp
  const tick = useNow(live ? 5000 : 3_600_000)
  const { data } = useData(() => (on ? api.whatsapp.status() : Promise.resolve(null)), [on, live ? tick : 0])
  return on ? data ?? null : null
}
