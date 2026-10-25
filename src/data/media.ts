// Mock "server" image pipeline. Every photo is compressed HERE (in the API layer), never by the screens.
// The real backend does the same with `sharp` (see server/README.md → Image uploads).
//
//   any JPG / PNG / WebP / GIF (and HEIC where the browser can read it), up to 50 MB / 200 megapixels
//   → turned upright, metadata removed → longest side ≤ 800 px → WebP (JPEG if WebP can't be made)
//   → highest quality that keeps the file ≤ 50 KB (smaller size steps if needed)
//   → plus a 320 px thumbnail for lists and billing tiles.

export const MAX_IMAGE_BYTES = 50 * 1024
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
/** Shop logo: sharp enough for the bill header and the QR menu. */
export const LOGO_IMAGE = { maxBytes: 80 * 1024, maxSide: 512 } as const
const MAX_PIXELS = 200_000_000
/** Very large photos are scaled down while decoding, so a 200 MP photo doesn't need gigabytes of memory. */
const DECODE_SIDE = 1600
const SIDES = [800, 640, 512, 400, 320, 240]
const THUMB_SIDE = 320
const Q_MIN = 0.4, Q_MAX = 0.92

export interface StoredImage {
  /** Compressed image (data URL in the mock; a file URL on the real server). */
  url: string
  thumbUrl: string
  bytes: number
  thumbBytes: number
  width: number
  height: number
  quality: number
  format: 'webp' | 'jpeg'
  originalBytes: number
}

export class ImageError extends Error {}

/** What the file really is, from its first bytes (the extension can lie). */
function sniff(b: Uint8Array): 'jpeg' | 'png' | 'webp' | 'gif' | 'heic' | 'bmp' | null {
  const s = (o: number, n: number) => String.fromCharCode(...b.slice(o, o + n))
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b[0] === 0x89 && s(1, 3) === 'PNG') return 'png'
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return 'webp'
  if (s(0, 3) === 'GIF') return 'gif'
  if (s(0, 2) === 'BM') return 'bmp'
  if (s(4, 4) === 'ftyp' && /hei|hev|mif1|msf1|avif/.test(s(8, 4))) return 'heic'
  return null
}

/** Width × height (upright) without decoding every pixel. */
async function measure(blob: Blob): Promise<{ w: number; h: number; el: HTMLImageElement }> {
  const url = URL.createObjectURL(blob)
  try {
    const el = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.decoding = 'async'; i.onload = () => res(i); i.onerror = rej; i.src = url })
    return { w: el.naturalWidth, h: el.naturalHeight, el }
  } finally { URL.revokeObjectURL(url) }
}

async function decode(blob: Blob, w: number, h: number, side = DECODE_SIDE): Promise<ImageBitmap | null> {
  // Honours the EXIF orientation (phone photos come out upright) and scales big photos down while decoding.
  // Never scales up: a small photo stays its own size.
  const s = Math.min(1, side / Math.max(w, h))
  const opts: ImageBitmapOptions = { imageOrientation: 'from-image', ...(s < 1 ? { resizeWidth: Math.round(w * s), resizeHeight: Math.round(h * s), resizeQuality: 'high' as const } : {}) }
  try { return await createImageBitmap(blob, opts) } catch { return null }
}
const dims = (img: ImageBitmap | HTMLImageElement) => ('naturalWidth' in img ? { w: img.naturalWidth, h: img.naturalHeight } : { w: img.width, h: img.height })

/** Draw at the given size and encode. Re-encoding drops all metadata (EXIF, GPS location). */
function encode(img: ImageBitmap | HTMLImageElement, w: number, h: number, type: 'image/webp' | 'image/jpeg', q: number): Promise<Blob> {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  if (type === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h) } // JPEG has no transparency
  ctx.drawImage(img, 0, 0, w, h)
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new ImageError('Could not process that image'))), type, q))
}
const fit = (w: number, h: number, side: number) => { const s = Math.min(1, side / Math.max(w, h)); return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) } }
const toDataUrl = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = rej; r.readAsDataURL(b) })

let webpOk: boolean | null = null
async function bestType(img: ImageBitmap | HTMLImageElement): Promise<'image/webp' | 'image/jpeg'> {
  if (webpOk === null) { try { webpOk = (await encode(img, 2, 2, 'image/webp', 0.8)).type === 'image/webp' } catch { webpOk = false } }
  return webpOk ? 'image/webp' : 'image/jpeg'
}

/** Highest quality at this size that fits the limit, or null if even the lowest quality is too big. */
async function search(img: ImageBitmap | HTMLImageElement, w: number, h: number, type: 'image/webp' | 'image/jpeg', limit: number) {
  const top = await encode(img, w, h, type, Q_MAX)
  if (top.size <= limit) return { blob: top, q: Q_MAX }
  const low = await encode(img, w, h, type, Q_MIN)
  if (low.size > limit) return null
  let lo = Q_MIN, hi = Q_MAX, best = { blob: low, q: Q_MIN }
  for (let i = 0; i < 6; i++) { // binary search on quality
    const mid = (lo + hi) / 2
    const b = await encode(img, w, h, type, mid)
    if (b.size <= limit) { best = { blob: b, q: mid }; lo = mid } else hi = mid
  }
  return best
}

/** Compress any supported photo to ≤ 50 KB at the best quality we can keep. */
export interface CompressOptions {
  /** Default 50 KB. Support screenshots use more so text stays readable. */
  maxBytes?: number
  /** Longest side for the stored image (default 800 px). */
  maxSide?: number
}

export async function compressImage(src: Blob, opts: CompressOptions = {}): Promise<StoredImage> {
  const limit = opts.maxBytes ?? MAX_IMAGE_BYTES
  const sides = opts.maxSide ? [opts.maxSide, ...SIDES.filter((x) => x < opts.maxSide!)] : SIDES
  if (!src.size) throw new ImageError('The file is empty')
  if (src.size > MAX_UPLOAD_BYTES) throw new ImageError('That photo is bigger than 50 MB')
  const kind = sniff(new Uint8Array(await src.slice(0, 16).arrayBuffer()))
  if (!kind) throw new ImageError('That file isn’t a photo. Choose a JPG, PNG or WebP image.')
  let size: { w: number; h: number; el: HTMLImageElement }
  try { size = await measure(src) } catch {
    throw new ImageError(kind === 'heic'
      ? 'This browser can’t read iPhone HEIC photos. On the iPhone, share the photo as JPG (or set Camera → Formats → Most Compatible).'
      : 'Could not read that image — it may be damaged')
  }
  if (size.w * size.h > MAX_PIXELS) throw new ImageError('That photo has too many pixels (over 200 megapixels)')
  // Decoded copy, already scaled to ≤ 1600 px for big photos (falls back to the <img> if the browser can't).
  const img: ImageBitmap | HTMLImageElement = (await decode(src, size.w, size.h, Math.max(DECODE_SIDE, Math.round((opts.maxSide ?? 0) * 1.25)))) ?? size.el
  const { w, h } = dims(img)
  const type = await bestType(img)

  let out: { blob: Blob; q: number; w: number; h: number } | null = null
  for (const side of sides) {
    const d = fit(w, h, side)
    const r = await search(img, d.w, d.h, type, limit)
    if (r) { out = { ...r, ...d }; break }
  }
  if (!out) throw new ImageError('Could not make this photo small enough — try a simpler photo')
  const t = fit(w, h, THUMB_SIDE)
  const thumb = (await search(img, t.w, t.h, type, 16 * 1024)) ?? { blob: await encode(img, t.w, t.h, type, Q_MIN), q: Q_MIN }
  if ('close' in img) img.close()
  return {
    url: await toDataUrl(out.blob), thumbUrl: await toDataUrl(thumb.blob), bytes: out.blob.size, thumbBytes: thumb.blob.size,
    width: out.w, height: out.h, quality: Math.round(out.q * 100), format: type === 'image/webp' ? 'webp' : 'jpeg', originalBytes: src.size,
  }
}

/** Size in bytes of a data: URL's payload. */
export const dataUrlBytes = (u: string) => { const i = u.indexOf(','); const b64 = u.slice(i + 1); return Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0) }

/**
 * Applied by the save APIs: whatever image a client sends, store only a compressed one.
 *  - our own upload result (≤ 50 KB WebP / JPEG) → kept
 *  - any other data: URL → compressed now
 *  - http(s) link (CSV import) → downloaded and compressed; if the site blocks it, the link is kept
 */
export async function ensureStoredImage(imageUrl: string | null | undefined, thumbUrl?: string | null): Promise<{ imageUrl: string | null; thumbUrl: string | null; linked?: boolean } | undefined> {
  if (imageUrl === undefined) return undefined
  if (!imageUrl) return { imageUrl: null, thumbUrl: null }
  if (imageUrl.startsWith('data:')) {
    const ok = /^data:image\/(webp|jpeg);/.test(imageUrl) && dataUrlBytes(imageUrl) <= MAX_IMAGE_BYTES
    if (ok && thumbUrl) return { imageUrl, thumbUrl }
    const blob = await (await fetch(imageUrl)).blob()
    const r = await compressImage(blob)
    return { imageUrl: ok ? imageUrl : r.url, thumbUrl: r.thumbUrl }
  }
  if (/^https?:\/\//i.test(imageUrl)) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000)
      const res = await fetch(imageUrl, { signal: ctl.signal, mode: 'cors' }); clearTimeout(t)
      if (!res.ok) throw new Error(String(res.status))
      const r = await compressImage(await res.blob())
      return { imageUrl: r.url, thumbUrl: r.thumbUrl }
    } catch {
      return { imageUrl, thumbUrl: null, linked: true } // the real server downloads it (no browser CORS limits)
    }
  }
  throw new ImageError('Unsupported image')
}
