import { useEffect, useState } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { api } from '@/data'

export type WaStatus = Awaited<ReturnType<typeof api.whatsapp.status>>

// "Check now" (e.g. while Meta reviews a template): one read for every screen showing the status.
let rechecks = 0
const listeners = new Set<() => void>()
export function recheckWhatsApp() { rechecks++; listeners.forEach((l) => l()) }

/**
 * WhatsApp integration status for this business, or null when the product admin hasn't released it.
 * Read when the screen opens and after any change (no timer). Template review: the "Check now" button.
 * (`live` is kept for the callers; it no longer polls.)
 */
export function useWhatsApp(_live = false) {
  const { me } = useApp()
  const on = !!me?.features.whatsapp
  const [n, setN] = useState(rechecks)
  useEffect(() => { const l = () => setN(rechecks); listeners.add(l); return () => { listeners.delete(l) } }, [])
  const { data } = useData(() => (on ? api.whatsapp.status() : Promise.resolve(null)), [on, n])
  return on ? data ?? null : null
}
