// Gzip for the customers' QR menu answers (public.menu, public.menuItems, public.specials): mostly phones on mobile
// data, and the same saved menu goes to every scan — so each answer is compressed once per server instance and the
// bytes are reused (a small memory list), not compressed on every scan. Staff answers are sent as before.
// The compressor comes from the host (Node's zlib on Catalyst; the Worker's CompressionStream on Cloudflare).
import { createHash } from 'node:crypto'

/** Actions whose answers are sent gzipped (when the browser accepts it). */
export const GZIP_ACTIONS = new Set(['public.menu', 'public.menuItems', 'public.specials'])
/** Smaller answers are sent as they are (gzip would save next to nothing). */
const MIN_BYTES = 1024
/** Compressed answers kept (newest last): enough for every branch's menu and its pages on a busy instance. */
const KEEP = 200
const kept = new Map<string, Uint8Array>()

export type Gzip = (text: string) => Uint8Array | Promise<Uint8Array>

const acceptsGzip = (acceptEncoding: string | undefined) => /\bgzip\b/i.test(String(acceptEncoding ?? ''))

/**
 * This JSON text as it goes out: gzipped (`gz` true) when the action is one of GZIP_ACTIONS, the browser accepts it
 * and it is big enough; otherwise the text as it is. The same text (a saved menu) → the same bytes, compressed once.
 */
export async function jsonTextReply(acceptEncoding: string | undefined, name: string, text: string, gzip: Gzip): Promise<{ body: string | Uint8Array; gz: boolean }> {
  if (!GZIP_ACTIONS.has(name) || text.length < MIN_BYTES || !acceptsGzip(acceptEncoding)) return { body: text, gz: false }
  const key = createHash('sha1').update(text).digest('base64')
  let gz = kept.get(key)
  if (gz) { kept.delete(key); kept.set(key, gz) } // most recently used last
  else {
    gz = await gzip(text)
    kept.set(key, gz)
    if (kept.size > KEEP) kept.delete(kept.keys().next().value as string)
  }
  return { body: gz, gz: true }
}
