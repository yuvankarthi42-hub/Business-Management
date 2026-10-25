// "Notify me when ready" on the customer's tracking screen: browser push through the app's service worker.
import { api } from '@/data'

export type PushState = 'on' | 'off' | 'denied' | 'unsupported'

const key = (orderId: string) => `billpoodum.push.${orderId}`

/** Push needs a service worker (installed in the live app) and the Push API (Android, desktop; iPhone only from the home screen). */
export function pushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && import.meta.env.PROD
}

export function pushStateFor(orderId: string): PushState {
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  try { return localStorage.getItem(key(orderId)) ? 'on' : 'off' } catch { return 'off' }
}

const toBytes = (b64: string) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

/** Asks for permission, subscribes this browser and tells the server which order to follow. */
export async function enablePush(businessId: string, orderId: string, publicKey: string): Promise<PushState> {
  if (!pushSupported()) return 'unsupported'
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off'
  const reg = (await navigator.serviceWorker.getRegistration()) ?? await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' })
  await navigator.serviceWorker.ready
  const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(publicKey) })
  await api.public.subscribePush(businessId, orderId, sub.toJSON())
  try { localStorage.setItem(key(orderId), '1') } catch { /* private mode: works for this visit */ }
  return 'on'
}

/** The service worker tells open tracking pages when a push arrives, so they refresh at once. */
export function onPushMessage(fn: (orderId: string) => void) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {}
  const h = (e: MessageEvent) => { if (e.data?.type === 'order-status') fn(String(e.data.orderId)) }
  navigator.serviceWorker.addEventListener('message', h)
  return () => navigator.serviceWorker.removeEventListener('message', h)
}
