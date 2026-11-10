// Weighing scale on this counter, through the browser's serial port (Chrome / Edge: USB-to-RS232 adapter or COM port).
// The scale keeps sending its weight ("continuous" output); each line is read with parseScaleLine. Which scale a
// counter is paired with stays on this device (the browser's permission is per device), per branch, like the printer.
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Branch } from '@/core/types'
import { parseScaleLine, SCALE_DEFAULTS, type BranchScale } from '@/core/scale'

/* eslint-disable @typescript-eslint/no-explicit-any */
const serial = (): any => (typeof navigator !== 'undefined' ? (navigator as any).serial : undefined)
export const scaleSupported = () => !!serial()

export type ScaleStatus = 'off' | 'unsupported' | 'not-paired' | 'disconnected' | 'connecting' | 'connected' | 'silent' | 'error'
interface Live { kg: number; flag: boolean | null; changedAt: number; seenAt: number }
interface Conn { port: any; reader: any; closed: boolean; branchId: string }
interface Saved { name: string; usbVendorId?: number; usbProductId?: number }

const key = (branchId: string) => `billpoodum.scale.device:${branchId}`
const listeners = new Set<() => void>()
let version = 0
const emit = () => { version++; listeners.forEach((l) => l()) }
const conns = new Map<string, Conn>()
const live = new Map<string, Live>()
const errors = new Map<string, string>()
const connecting = new Set<string>()

function savedOf(branchId: string): Saved | null {
  try { return JSON.parse(localStorage.getItem(key(branchId)) || 'null') } catch { return null }
}
function save(branchId: string, v: Saved | null) {
  try { if (v) localStorage.setItem(key(branchId), JSON.stringify(v)); else localStorage.removeItem(key(branchId)) } catch { /* private mode */ }
}
const nameOf = (info: { usbVendorId?: number; usbProductId?: number }) =>
  info.usbVendorId ? `USB serial (${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId ?? 0).toString(16).padStart(4, '0')})` : 'COM port'

async function close(branchId: string) {
  const c = conns.get(branchId)
  if (!c) return
  c.closed = true
  conns.delete(branchId)
  try { await c.reader?.cancel() } catch { /* already gone */ }
  try { await c.port.close() } catch { /* already closed */ }
}

/** Opens the port and keeps reading lines until it is closed or the cable is pulled. */
async function open(branchId: string, port: any, baudRate: number) {
  // One scale per counter: free it from another branch's connection first.
  for (const id of [...conns.keys()]) if (id !== branchId) await close(id)
  await close(branchId)
  if (!port.readable) await port.open({ baudRate })
  const c: Conn = { port, reader: null, closed: false, branchId }
  conns.set(branchId, c)
  errors.delete(branchId)
  emit()
  void (async () => {
    const dec = new TextDecoder()
    let buf = ''
    try {
      while (!c.closed && port.readable) {
        c.reader = port.readable.getReader()
        try {
          for (;;) {
            const { value, done } = await c.reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            // Lines end with CR / LF; some scales frame each reading with STX … ETX.
            const parts = buf.split(/[\r\n\x02\x03]+/)
            buf = parts.pop() ?? ''
            if (buf.length > 200) buf = ''
            const now = Date.now()
            for (const p of parts) {
              const r = parseScaleLine(p)
              if (!r) continue
              const prev = live.get(branchId)
              const same = prev && Math.abs(prev.kg - r.kg) < 0.0005
              live.set(branchId, { kg: r.kg, flag: r.stable, changedAt: same ? prev!.changedAt : now, seenAt: now })
              emit()
            }
          }
        } finally { try { c.reader.releaseLock() } catch { /* released */ } }
      }
    } catch (e) {
      if (!c.closed) { errors.set(branchId, e instanceof Error ? e.message : 'The scale stopped sending'); conns.delete(branchId); emit() }
    }
  })()
}

/** Pick the scale's port (the browser shows the list) and remember it for this branch on this device. */
export async function pairScale(branchId: string, baudRate: number) {
  const s = serial()
  if (!s) throw new Error('This browser can’t connect a scale. Use Chrome or Edge on a computer.')
  const port = await s.requestPort()
  const info = port.getInfo?.() ?? {}
  await open(branchId, port, baudRate)
  save(branchId, { name: nameOf(info), usbVendorId: info.usbVendorId, usbProductId: info.usbProductId })
  emit()
}

/** Reconnect to the scale paired before (no list shown: the browser already allowed it). */
export async function reconnectScale(branchId: string, baudRate: number) {
  const s = serial()
  const want = savedOf(branchId)
  if (!s || !want || conns.has(branchId) || connecting.has(branchId)) return
  connecting.add(branchId); emit()
  try {
    const ports: any[] = await s.getPorts()
    const port = ports.find((p) => { const i = p.getInfo?.() ?? {}; return want.usbVendorId ? i.usbVendorId === want.usbVendorId && i.usbProductId === want.usbProductId : true })
    if (port) await open(branchId, port, baudRate)
  } catch (e) { errors.set(branchId, e instanceof Error ? e.message : 'Could not open the scale') } finally { connecting.delete(branchId); emit() }
}

/** Forget this counter's scale for the branch. */
export async function forgetScale(branchId: string) {
  await close(branchId)
  live.delete(branchId); errors.delete(branchId)
  save(branchId, null)
  emit()
}

/** Re-open with another port speed (after the setting changed). */
export async function restartScale(branchId: string, baudRate: number) {
  const c = conns.get(branchId)
  if (!c) return
  const port = c.port
  await close(branchId)
  await open(branchId, port, baudRate).catch((e) => { errors.set(branchId, e instanceof Error ? e.message : 'Could not open the scale'); emit() })
}

if (typeof navigator !== 'undefined') serial()?.addEventListener?.('disconnect', () => { for (const id of [...conns.keys()]) void close(id); emit() })

export interface ScaleState {
  status: ScaleStatus
  /** Last weight read (kg), or null when nothing has come yet. */
  kg: number | null
  /** The scale says it is steady, or (when it doesn't say) the weight hasn't changed for a moment. */
  stable: boolean
  device: string | null
  error: string | null
  settings: BranchScale
}

/** Live weight for a branch's scale on this counter. Connects to a paired scale by itself while the screen is open. */
export function useScale(branch: Pick<Branch, 'id' | 'scale'> | null | undefined, settingsOverride?: BranchScale): ScaleState {
  useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb) }, () => version)
  const [now, setNow] = useState(() => Date.now())
  const id = branch?.id ?? ''
  const settings = settingsOverride ?? { ...SCALE_DEFAULTS, ...branch?.scale }
  const on = !!id && id !== 'all' && settings.enabled
  const paired = on ? savedOf(id) : null
  useEffect(() => { if (on && paired) void reconnectScale(id, settings.baudRate) }, [on, id, !!paired]) // eslint-disable-line react-hooks/exhaustive-deps
  // Steadiness and "no data" depend on time passing, not only on new readings.
  useEffect(() => { if (!on) return; const t = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(t) }, [on])
  if (!on) return { status: 'off', kg: null, stable: false, device: null, error: null, settings }
  if (!scaleSupported()) return { status: 'unsupported', kg: null, stable: false, device: null, error: null, settings }
  const l = live.get(id)
  const conn = conns.has(id)
  const status: ScaleStatus = conn ? (l && now - l.seenAt < 3000 ? 'connected' : 'silent') : connecting.has(id) ? 'connecting' : errors.has(id) ? 'error' : paired ? 'disconnected' : 'not-paired'
  const fresh = !!l && now - l.seenAt < 3000
  const stable = fresh && (l!.flag === null ? now - l!.changedAt >= 700 : l!.flag && now - l!.changedAt >= 300)
  return { status, kg: fresh ? l!.kg : null, stable, device: paired?.name ?? null, error: errors.get(id) ?? null, settings }
}
