// Gzip for the customers' QR menu answers (public.menu, public.menuItems, public.specials): mostly phones on mobile
// data, and the same saved menu goes to every scan — so each answer is compressed once per server instance and the
// bytes are reused (a small memory list), not compressed on every scan. Staff answers are sent as before.
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type { Request, Response } from 'express'

/** Actions whose answers are sent gzipped (when the browser accepts it). */
export const GZIP_ACTIONS = new Set(['public.menu', 'public.menuItems', 'public.specials'])
/** Smaller answers are sent as they are (gzip would save next to nothing). */
const MIN_BYTES = 1024
/** Compressed answers kept (newest last): enough for every branch's menu and its pages on a busy instance. */
const KEEP = 200
const kept = new Map<string, Buffer>()

const acceptsGzip = (req: Request) => /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''))

/** Sends this JSON text — gzipped when the action is one of GZIP_ACTIONS, the browser accepts it and it is big enough. */
export function sendJsonText(req: Request, res: Response, name: string, text: string) {
  res.type('application/json')
  if (!GZIP_ACTIONS.has(name) || text.length < MIN_BYTES || !acceptsGzip(req)) { res.send(text); return }
  // The same text (a saved menu) → the same bytes, compressed once.
  const key = createHash('sha1').update(text).digest('base64')
  let gz = kept.get(key)
  if (gz) { kept.delete(key); kept.set(key, gz) } // most recently used last
  else {
    gz = gzipSync(text, { level: 6 })
    kept.set(key, gz)
    if (kept.size > KEEP) kept.delete(kept.keys().next().value as string)
  }
  res.setHeader('Content-Encoding', 'gzip')
  res.setHeader('Vary', 'Accept-Encoding')
  res.send(gz)
}
