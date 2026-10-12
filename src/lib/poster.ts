// Draws a square "Today's specials" poster (1080×1080 PNG) for WhatsApp Status / groups.

export interface PosterItem { name: string; price: string; was?: string; tag?: string; emoji: string; imageUrl?: string | null }

const loadImage = (src: string) => new Promise<HTMLImageElement | null>((resolve) => {
  const img = new Image()
  img.onload = () => resolve(img)
  img.onerror = () => resolve(null)
  img.src = src
})

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text
  let t = text
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1)
  return `${t}…`
}

export async function drawSpecialsPoster(input: { business: string; subtitle: string; date: string; items: PosterItem[]; footer: string }): Promise<Blob> {
  const S = 1080
  const c = document.createElement('canvas')
  c.width = c.height = S
  const ctx = c.getContext('2d')!
  const font = (w: number, px: number) => `${w} ${px}px Inter, system-ui, -apple-system, 'Segoe UI', sans-serif`

  ctx.fillStyle = '#0f1f3d'; ctx.fillRect(0, 0, S, S)
  ctx.fillStyle = '#f97316'; ctx.fillRect(0, 0, S, 14)

  ctx.fillStyle = '#ffffff'; ctx.font = font(700, 58); ctx.textBaseline = 'top'
  ctx.fillText(fit(ctx, input.business, S - 120), 60, 60)
  ctx.fillStyle = '#cbd5e1'; ctx.font = font(400, 30)
  ctx.fillText(`${input.subtitle} · ${input.date}`, 60, 132)
  ctx.fillStyle = '#fdba74'; ctx.font = font(800, 84)
  ctx.fillText('Today’s Specials', 60, 196)

  const items = input.items.slice(0, 5)
  const top = 330, gap = 18, rowH = Math.min(132, (S - top - 120 - gap * (items.length - 1)) / Math.max(1, items.length))
  for (const [i, it] of items.entries()) {
    const y = top + i * (rowH + gap)
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; roundRect(ctx, 60, y, S - 120, rowH, 24); ctx.fill()
    const pic = rowH - 28
    const img = it.imageUrl ? await loadImage(it.imageUrl) : null
    ctx.save(); roundRect(ctx, 76, y + 14, pic, pic, 18); ctx.clip()
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(76, y + 14, pic, pic)
    if (img) ctx.drawImage(img, 76, y + 14, pic, pic)
    else { ctx.font = font(400, pic * 0.62); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.fillText(it.emoji || it.name.slice(0, 2).toUpperCase(), 76 + pic / 2, y + 14 + pic / 2 + 4) }
    ctx.restore(); ctx.textAlign = 'left'; ctx.textBaseline = 'top'

    const tx = 76 + pic + 28
    if (it.tag) {
      ctx.font = font(700, 22); const tw = ctx.measureText(it.tag.toUpperCase()).width + 24
      ctx.fillStyle = '#f97316'; roundRect(ctx, tx, y + 18, tw, 34, 17); ctx.fill()
      ctx.fillStyle = '#fff'; ctx.fillText(it.tag.toUpperCase(), tx + 12, y + 24)
    }
    ctx.fillStyle = '#ffffff'; ctx.font = font(700, 40)
    ctx.fillText(fit(ctx, it.name, S - tx - 300), tx, y + (it.tag ? 60 : rowH / 2 - 22))
    ctx.textAlign = 'right'; ctx.fillStyle = '#fdba74'; ctx.font = font(800, 48)
    ctx.fillText(it.price, S - 90, y + rowH / 2 - (it.was ? 34 : 24))
    if (it.was) {
      ctx.fillStyle = '#94a3b8'; ctx.font = font(400, 30)
      const w = ctx.measureText(it.was).width
      ctx.fillText(it.was, S - 90, y + rowH / 2 + 20)
      ctx.fillRect(S - 90 - w, y + rowH / 2 + 37, w, 3)
    }
    ctx.textAlign = 'left'
  }

  ctx.fillStyle = '#e2e8f0'; ctx.font = font(600, 32); ctx.textAlign = 'center'
  ctx.fillText(fit(ctx, input.footer, S - 120), S / 2, S - 84)
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create poster'))), 'image/png'))
}
