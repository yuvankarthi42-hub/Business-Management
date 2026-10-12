// ESC/POS byte builder — the command set used by almost every receipt printer
// (Epson, TVS, Posiflex, Everycom, Rugtek, Xprinter, generic 58/80 mm).
import { CHARS, DOTS, type Line, type Paper } from './doc'

const ESC = 0x1b, GS = 0x1d
const bytes = (...n: number[]) => n

/** Printer fonts are ASCII: map the few symbols we use, drop the rest. */
export const ascii = (s: string) => s
  .replace(/₹\s?/g, 'Rs.').replace(/[·•]/g, '-').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[^\x20-\x7E]/g, '?')

/** Break text into lines of at most `w` characters, on spaces where possible. */
export function wrapChars(s: string, w: number): string[] {
  if (w <= 0) return [s]
  const out: string[] = []
  let cur = ''
  for (const word of s.split(/\s+/).filter(Boolean)) {
    if (!cur) cur = word
    else if (cur.length + 1 + word.length <= w) cur += ` ${word}`
    else { out.push(cur); cur = word }
    while (cur.length > w) { out.push(cur.slice(0, w)); cur = cur.slice(w) }
  }
  if (cur || !out.length) out.push(cur)
  return out
}

/** Lay a row out in `width` characters: first cell wraps, the rest are right-aligned columns. */
export function rowLines(cells: string[], widths: number[] | undefined, width: number): string[] {
  const rest = cells.slice(1)
  const ws = rest.map((c, i) => Math.max(widths?.[i] ?? c.length, c.length))
  const tail = rest.map((c, i) => c.padStart(ws[i])).join(' ')
  const first = Math.max(4, width - tail.length - (rest.length ? 1 : 0))
  const lines = wrapChars(cells[0], first)
  return lines.map((l, i) => (i === 0 ? `${l.padEnd(first)}${rest.length ? ' ' : ''}${tail}` : l))
}

export interface JobOptions { cut?: boolean; drawer?: boolean; feed?: number }

const start = () => bytes(ESC, 0x40, ESC, 0x74, 0x00) // initialise, code page PC437
function finish(out: number[], o: JobOptions) {
  out.push(ESC, 0x64, o.feed ?? 4) // feed so the last line clears the cutter
  if (o.cut !== false) out.push(GS, 0x56, 0x42, 0x00) // partial cut
  if (o.drawer) out.push(ESC, 0x70, 0x00, 0x19, 0xfa) // kick cash drawer (pin 2)
}

/** Fast text mode: printer's own font, English only. */
export function encodeText(doc: Line[], paper: Paper, o: JobOptions = {}): Uint8Array {
  const width = CHARS[paper]
  const out: number[] = start()
  const enc = (s: string) => { for (const ch of ascii(s)) out.push(ch.charCodeAt(0)) }
  const align = (a: 'left' | 'center' | 'right' = 'left') => out.push(ESC, 0x61, a === 'center' ? 1 : a === 'right' ? 2 : 0)
  const style = (bold?: boolean, big?: boolean) => { out.push(ESC, 0x45, bold ? 1 : 0); out.push(GS, 0x21, big ? 0x11 : 0x00) }
  for (const l of doc) {
    if (l.k === 'feed') { out.push(ESC, 0x64, l.n); continue }
    if (l.k === 'hr') { align('left'); style(false, false); enc((l.strong ? '=' : '-').repeat(width)); out.push(0x0a); continue }
    if (l.k === 'text') {
      align(l.align); style(l.bold, l.big)
      for (const s of wrapChars(ascii(l.s), l.big ? width / 2 : width)) { enc(s); out.push(0x0a) }
      continue
    }
    align('left'); style(l.bold, l.big)
    for (const s of rowLines(l.cells.map(ascii), l.widths, l.big ? width / 2 : width)) { enc(s); out.push(0x0a) }
  }
  style(false, false); align('left')
  finish(out, o)
  return new Uint8Array(out)
}

// ---------- Image mode (any language) ----------

const FONT = '"Noto Sans Tamil", "Tamil Sangam MN", "Latha", "Nirmala UI", "Courier New", monospace'

/** Draw the receipt on a canvas exactly as wide as the print head. */
export function renderCanvas(doc: Line[], paper: Paper): HTMLCanvasElement {
  const W = DOTS[paper]
  const pad = 4
  const base = 19 // ≈ the printer's own 12-dot font, so 32 / 48 characters fit a line
  const cv = document.createElement('canvas')
  const ctx = cv.getContext('2d')!
  const font = (bold?: boolean, big?: boolean, small?: boolean) => `${bold ? 'bold ' : ''}${big ? base * 1.45 : small ? base * 0.85 : base}px ${FONT}`
  const charW = (W - pad * 2) / CHARS[paper]

  type Op = (y: number) => void
  const ops: { h: number; draw: Op }[] = []
  const fit = (s: string, maxW: number) => {
    const words = s.split(/\s+/).filter(Boolean); const lines: string[] = []; let cur = ''
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w
      if (ctx.measureText(next).width <= maxW || !cur) cur = next
      else { lines.push(cur); cur = w }
    }
    lines.push(cur)
    return lines
  }
  for (const l of doc) {
    if (l.k === 'feed') { ops.push({ h: base * l.n, draw: () => {} }); continue }
    if (l.k === 'hr') {
      ops.push({ h: base * 0.8, draw: (y) => {
        ctx.fillStyle = '#000'
        if (l.strong) ctx.fillRect(pad, y + base * 0.35, W - pad * 2, 3)
        else for (let x = pad; x < W - pad; x += 10) ctx.fillRect(x, y + base * 0.4, 6, 2)
      } })
      continue
    }
    const size = l.k === 'text' ? font(l.bold, l.big, l.small) : font(l.bold, l.big)
    ctx.font = size
    const lh = (l.big ? base * 1.45 : l.k === 'text' && l.small ? base * 0.85 : base) * 1.3
    if (l.k === 'text') {
      for (const s of fit(l.s, W - pad * 2)) {
        ops.push({ h: lh, draw: (y) => {
          ctx.font = size; ctx.fillStyle = '#000'; ctx.textBaseline = 'top'
          ctx.textAlign = l.align === 'center' ? 'center' : l.align === 'right' ? 'right' : 'left'
          ctx.fillText(s, l.align === 'center' ? W / 2 : l.align === 'right' ? W - pad : pad, y + 2)
        } })
      }
      continue
    }
    // Row: right-aligned columns measured in character cells, first cell wraps in the rest.
    const rest = l.cells.slice(1)
    const ws = rest.map((c, i) => Math.max(l.widths?.[i] ?? c.length, c.length) * charW * (l.big ? 1.45 : 1))
    const tailW = ws.reduce((a, b) => a + b + charW, 0)
    const lines = fit(l.cells[0], W - pad * 2 - tailW)
    lines.forEach((s, li) => {
      ops.push({ h: lh, draw: (y) => {
        ctx.font = size; ctx.fillStyle = '#000'; ctx.textBaseline = 'top'
        ctx.textAlign = 'left'; ctx.fillText(s, pad, y + 2)
        if (li) return
        ctx.textAlign = 'right'
        let x = W - pad
        for (let i = rest.length - 1; i >= 0; i--) { ctx.fillText(rest[i], x, y + 2); x -= ws[i] + charW }
      } })
    })
  }
  const H = Math.ceil(ops.reduce((a, o) => a + o.h, 0) + 8)
  cv.width = W; cv.height = H
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H)
  let y = 4
  for (const o of ops) { o.draw(y); y += o.h }
  return cv
}

/** Canvas → GS v 0 raster bit image, in bands so small printer buffers don't overflow. */
export function encodeImage(doc: Line[], paper: Paper, o: JobOptions = {}): Uint8Array {
  const cv = renderCanvas(doc, paper)
  const { width: W, height: H } = cv
  const px = cv.getContext('2d')!.getImageData(0, 0, W, H).data
  const rowBytes = Math.ceil(W / 8)
  const out: number[] = start()
  out.push(ESC, 0x61, 0)
  const BAND = 128
  for (let y0 = 0; y0 < H; y0 += BAND) {
    const h = Math.min(BAND, H - y0)
    out.push(GS, 0x76, 0x30, 0x00, rowBytes & 0xff, rowBytes >> 8, h & 0xff, h >> 8)
    for (let y = y0; y < y0 + h; y++) {
      for (let bx = 0; bx < rowBytes; bx++) {
        let byte = 0
        for (let bit = 0; bit < 8; bit++) {
          const x = bx * 8 + bit
          if (x >= W) continue
          const i = (y * W + x) * 4
          const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
          if (lum < 150) byte |= 0x80 >> bit
        }
        out.push(byte)
      }
    }
  }
  finish(out, o)
  return new Uint8Array(out)
}

/** Only the drawer kick, for a "No sale" open. */
export const drawerOnly = () => new Uint8Array([...start(), ESC, 0x70, 0x00, 0x19, 0xfa])
