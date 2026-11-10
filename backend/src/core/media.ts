// Signed links for private files (support screenshots): "media/<key>?e=<expiry>&s=<signature>", served by
// GET /media/… (app.ts) from the private store. The app puts its API address in front. A link works for 30–60
// minutes (expiry rounded to the half hour, so a screen shows the same link — and the browser's copy — while open).
import { signedFor, signFor } from './tokens'

/** Private keys start with "p/" (a key in the public bucket never does). */
export const PRIVATE_PREFIX = 'p/'
const KEY = /^p\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\/[A-Za-z0-9_-]+\.(webp|jpg|png)$/
export const isPrivateKey = (key: string) => KEY.test(key)
const HALF_HOUR = 1800

export function mediaLink(key: string, now = Date.now()): string {
  const e = (Math.floor(now / 1000 / HALF_HOUR) + 2) * HALF_HOUR
  return `media/${key}?e=${e}&s=${signFor('media', `${key}|${e}`).toString('base64url')}`
}
/** The key a link is for, when the link is genuine and not expired. */
export function checkMediaLink(key: string, e: unknown, s: unknown, now = Date.now()): boolean {
  const exp = Number(e)
  return isPrivateKey(key) && Number.isSafeInteger(exp) && exp * 1000 > now && signedFor('media', `${key}|${exp}`, String(s ?? ''))
}
/** The private key inside one of our links (with or without the API address in front); null otherwise. */
export function mediaKeyOf(url: string): string | null {
  const m = /(?:^|\/)media\/(p\/[^?#]+)(?:[?#]|$)/.exec(String(url ?? ''))
  return m && isPrivateKey(m[1]) ? m[1] : null
}
export const contentTypeOf = (key: string) => key.endsWith('.png') ? 'image/png' : key.endsWith('.jpg') ? 'image/jpeg' : 'image/webp'
