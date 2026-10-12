// Direct printing from Chrome / Edge to a thermal printer, without the print dialog.
//  • USB      — WebUSB (printer plugged into this computer / Android tablet with OTG)
//  • Serial   — Web Serial (COM-port printers, USB-serial adapters, paired Bluetooth printers on Windows)
//  • Bluetooth — Web Bluetooth (BLE handheld printers, mostly on Android)
// Setup is per branch (saved with the branch, so every counter in it gets the same setup). Which physical
// printer a device is paired with stays on that device (the browser's permission is per device), per branch too.
import { useSyncExternalStore } from 'react'
import { useApp } from '@/app/AppContext'
import type { Branch, BranchPrinter } from '@/core/types'
import { api } from '@/data'
import type { Paper } from './doc'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Nav = Navigator & { usb?: any; serial?: any; bluetooth?: any }
const nav = () => navigator as Nav

export type Transport = BranchPrinter['transport']
interface DeviceInfo { deviceName: string; usb?: { vendorId: number; productId: number; serialNumber?: string } }
export interface PrinterSettings extends BranchPrinter, DeviceInfo { paper: Paper | null }
const DEFAULTS: BranchPrinter = { transport: 'browser', paper: null, mode: 'auto', autoPrint: false, copies: 1, cut: true, drawer: false, baudRate: 9600 }
const LEGACY_KEY = 'billpoodum.printer' // before per-branch setup: one setup for the whole device
const deviceKey = (branchId: string) => `billpoodum.printer.device:${branchId}`

const listeners = new Set<() => void>()
const emit = () => { version++; listeners.forEach((l) => l()) }
let version = 0
const devices = new Map<string, DeviceInfo>()
function deviceOf(branchId: string): DeviceInfo {
  if (!devices.has(branchId)) {
    let v: DeviceInfo = { deviceName: '' }
    try { v = { ...v, ...JSON.parse(localStorage.getItem(deviceKey(branchId)) || '{}') } } catch { /* blocked storage */ }
    devices.set(branchId, v)
  }
  return devices.get(branchId)!
}
function saveDevice(branchId: string, patch: Partial<DeviceInfo>) {
  const next = { ...deviceOf(branchId), ...patch }
  devices.set(branchId, next)
  try { localStorage.setItem(deviceKey(branchId), JSON.stringify(next)) } catch { /* private mode: keep for this session */ }
  emit()
}

/** The setup that applies to a branch on this device. */
export function printerFor(branch: Pick<Branch, 'id' | 'printer'> | null | undefined): PrinterSettings {
  if (!branch || branch.id === 'all') return { ...DEFAULTS, deviceName: '' }
  return { ...DEFAULTS, ...branch.printer, ...deviceOf(branch.id) } as PrinterSettings
}

/** Save part of a branch's setup: device pairing locally, everything else on the branch. */
export async function savePrinter(branchId: string, patch: Partial<PrinterSettings>) {
  const { deviceName, usb, ...rest } = patch
  if (deviceName !== undefined || 'usb' in patch) saveDevice(branchId, { ...(deviceName !== undefined && { deviceName }), ...('usb' in patch && { usb }) })
  if (Object.keys(rest).length) await api.branches.savePrinter(branchId, rest)
}

/**
 * Move the old device-wide setup (one for all branches) to the branch this device works in, once.
 * Other branches start fresh so each one is set up on its own.
 */
export async function migrateLegacyPrinter(branch: Branch) {
  let old: (Partial<PrinterSettings> & { deviceName?: string }) | null = null
  try { old = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null') } catch { return }
  if (!old || branch.id === 'all') return
  try { localStorage.removeItem(LEGACY_KEY) } catch { /* ignore */ }
  if (old.deviceName) saveDevice(branch.id, { deviceName: old.deviceName, usb: old.usb })
  if (!branch.printer) { const { deviceName: _n, usb: _u, ...rest } = old; void _n; void _u; await api.branches.savePrinter(branch.id, rest).catch(() => {}) }
}

/** Printer setup for a branch (default: the branch you're working in). Re-renders when it changes. */
export function usePrinterSettings(branchId?: string): PrinterSettings {
  const { me } = useApp()
  useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb) }, () => version)
  const id = branchId ?? me?.branch.id
  return printerFor(me?.branches.find((b) => b.id === id) ?? null)
}

export const support = () => ({
  usb: typeof navigator !== 'undefined' && !!nav().usb,
  serial: typeof navigator !== 'undefined' && !!nav().serial,
  bluetooth: typeof navigator !== 'undefined' && !!nav().bluetooth,
})

// ---------- Connections (kept open while the page is open) ----------

interface Conn { write(data: Uint8Array): Promise<void>; close(): Promise<void>; name: string }
/** Open connections, one per branch (kept open while the page is open). */
const conns = new Map<string, Conn>()
/** A device normally has one printer: free it from another branch's connection before using it here. */
async function closeOthers(branchId: string) {
  for (const [id, c] of conns) if (id !== branchId) { await c.close(); conns.delete(id) }
}

async function openUsb(dev: any): Promise<Conn> {
  if (!dev.opened) await dev.open()
  if (dev.configuration === null) await dev.selectConfiguration(1)
  let iface: any = null, ep: any = null
  for (const i of dev.configuration.interfaces) {
    for (const alt of i.alternates) {
      const out = alt.endpoints.find((e: any) => e.direction === 'out' && e.type === 'bulk')
      if (out && (!ep || alt.interfaceClass === 7)) { iface = i; ep = out }
    }
  }
  if (!iface || !ep) throw new Error('This USB device has no printer output. Pick the receipt printer.')
  try { await dev.claimInterface(iface.interfaceNumber) } catch {
    throw new Error('The printer is in use by another program or driver. Close other print software and try again (Windows: install the WinUSB driver).')
  }
  return {
    name: dev.productName || 'USB printer',
    async write(data) { for (let i = 0; i < data.length; i += 16384) await dev.transferOut(ep.endpointNumber, data.slice(i, i + 16384)) },
    async close() { try { await dev.close() } catch { /* already closed */ } },
  }
}

async function openSerial(port: any, baudRate: number): Promise<Conn> {
  if (!port.writable) await port.open({ baudRate })
  return {
    name: 'Serial printer',
    async write(data) { const w = port.writable.getWriter(); try { await w.write(data) } finally { w.releaseLock() } },
    async close() { try { await port.close() } catch { /* already closed */ } },
  }
}

// Common BLE "serial" services used by handheld thermal printers.
const BLE_SERVICES = ['000018f0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb', '0000ffe0-0000-1000-8000-00805f9b34fb',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455']
const bleDevices = new Map<string, any>()
async function openBle(dev: any): Promise<Conn> {
  const server = dev.gatt.connected ? dev.gatt : await dev.gatt.connect()
  let ch: any = null
  for (const s of await server.getPrimaryServices()) {
    for (const c of await s.getCharacteristics()) if (c.properties.write || c.properties.writeWithoutResponse) { ch = c; break }
    if (ch) break
  }
  if (!ch) throw new Error('Could not find the printer channel on this Bluetooth device.')
  return {
    name: dev.name || 'Bluetooth printer',
    async write(data) {
      for (let i = 0; i < data.length; i += 180) {
        const part = data.slice(i, i + 180)
        if (ch.properties.writeWithoutResponse) await ch.writeValueWithoutResponse(part); else await ch.writeValue(part)
      }
    },
    async close() { try { dev.gatt.disconnect() } catch { /* gone */ } },
  }
}

/** Ask the browser to pick a printer (needs a click). Remembers it on this device for this branch. */
export async function choosePrinter(branchId: string, s: PrinterSettings, transport: Exclude<Transport, 'browser'>) {
  await closeOthers(branchId)
  await conns.get(branchId)?.close(); conns.delete(branchId)
  let conn: Conn
  if (transport === 'usb') {
    const dev = await nav().usb.requestDevice({ filters: [] })
    conn = await openUsb(dev)
    await savePrinter(branchId, { transport, deviceName: conn.name, usb: { vendorId: dev.vendorId, productId: dev.productId, serialNumber: dev.serialNumber } })
  } else if (transport === 'serial') {
    const port = await nav().serial.requestPort()
    conn = await openSerial(port, s.baudRate)
    const info = port.getInfo?.() ?? {}
    await savePrinter(branchId, { transport, deviceName: info.usbVendorId ? `Serial printer (${info.usbVendorId.toString(16)}:${info.usbProductId?.toString(16)})` : 'Serial / Bluetooth COM printer' })
  } else {
    const dev = await nav().bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES })
    bleDevices.set(branchId, dev)
    conn = await openBle(dev)
    await savePrinter(branchId, { transport, deviceName: conn.name })
  }
  conns.set(branchId, conn)
  emit()
  return conn.name
}

/** Reconnect to the remembered printer without a prompt (the browser already has permission). */
async function reconnect(branchId: string, s: PrinterSettings): Promise<Conn> {
  const open = conns.get(branchId)
  if (open) return open
  await closeOthers(branchId)
  let conn: Conn
  if (s.transport === 'usb') {
    const list: any[] = await nav().usb?.getDevices() ?? []
    const dev = list.find((d) => d.vendorId === s.usb?.vendorId && d.productId === s.usb?.productId && (!s.usb?.serialNumber || d.serialNumber === s.usb.serialNumber)) ?? list[0]
    if (!dev) throw new Error('Printer not found. Check the USB cable and power, then press “Connect” in Settings → Printer.')
    conn = await openUsb(dev)
  } else if (s.transport === 'serial') {
    const ports: any[] = await nav().serial?.getPorts() ?? []
    if (!ports[0]) throw new Error('Printer not found. Reconnect it in Settings → Printer.')
    conn = await openSerial(ports[0], s.baudRate)
  } else if (s.transport === 'bluetooth') {
    let dev = bleDevices.get(branchId)
    if (!dev && nav().bluetooth?.getDevices) dev = (await nav().bluetooth.getDevices()).find((d: any) => d.name === s.deviceName)
    if (!dev) throw new Error('Bluetooth printer disconnected. Reconnect it in Settings → Printer.')
    bleDevices.set(branchId, dev)
    conn = await openBle(dev)
  } else throw new Error('No direct printer set up')
  conns.set(branchId, conn)
  emit()
  return conn
}

export async function sendToPrinter(branchId: string, s: PrinterSettings, data: Uint8Array) {
  try { await (await reconnect(branchId, s)).write(data) }
  catch (e) {
    // The connection may have gone stale (printer switched off, cable pulled): retry once fresh.
    await conns.get(branchId)?.close(); conns.delete(branchId)
    if (e instanceof Error && /not found|disconnected|No direct/.test(e.message)) throw e
    await (await reconnect(branchId, s)).write(data)
  }
}

export async function forgetPrinter(branchId: string) {
  await conns.get(branchId)?.close(); conns.delete(branchId); bleDevices.delete(branchId)
  saveDevice(branchId, { deviceName: '', usb: undefined })
  await savePrinter(branchId, { transport: 'browser' })
}

export const isConnected = (branchId: string) => conns.has(branchId)

if (typeof navigator !== 'undefined') {
  nav().usb?.addEventListener?.('disconnect', () => { conns.clear(); emit() })
  nav().serial?.addEventListener?.('disconnect', () => { conns.clear(); emit() })
}
